/**
 * inbox.js — 发起方的**自动收件箱**：把"我关心的事件"在会话下一轮送进上下文。
 *
 * 这次踩到的坑就是这个文件存在的理由：对端把活做完了，但它**没有主动发消息**，
 * 于是发起方完全不知道 —— 投递成功、任务完成、发起方知情，是三件不同的事。
 *
 * 设计要点，每条都对应一个具体的失败方式：
 *
 * 1. **游标存在板上，进程重启不丢。** 主键是 (instanceId, sessionId)，
 *    天然按客户端隔离。放在内存里的话，DSH 一重启就重复刷屏或漏读。
 *
 * 2. **游标前移用"实际看过的最后一条 seq"，不是 max(seq)。**
 *    如果用全表最大 seq，会跳过尚未取出的中间事件（永久丢失）。
 *
 * 3. **不重复注入。** 每轮只取 seq > cursor 的；注入成功后 cursor 前移；
 *    第二轮自然只剩新增的。
 *
 * 4. **注入失败不动游标。** 宁可下一轮补上，也不要"以为读过了"。
 *
 * 5. **摘要必须短。** 模型上下文很贵，这里只给"发生了什么事 + 哪个任务 + 现在什么状态"。
 *
 * 6. **噪声必须被过滤，但过滤不能让它们堵住队头。**（v3）
 *    多台机器都开着时，`peer.event`（别处会话的 created/disposed/running）会占满
 *    采集窗口，把真正关心的 task/evidence/gate 事件饿死在 20 条之后 —— 这是实测到的真问题。
 *    所以：默认排除 `peer.event`；**被排除的事件也算"看过"，游标照常越过它们**；
 *    单轮取 limit×5 并在需要时继续向后翻页，避免"过滤完一条不剩"时白等一轮。
 */

import { formatInboxDigest } from './domain.js';

export const DEFAULT_INBOX_LIMIT = 20;

/**
 * 默认排除的事件种类。
 * `peer.event` 是对端实例推送的会话生命周期事件（agent/status 等），
 * 量大且与"我派出去的任务进展如何"无关。要看它们用 mesh_events 显式查。
 */
export const DEFAULT_INBOX_EXCLUDE_KINDS = ['peer.event'];

/** 单轮最多向后翻几页（防止极端刷屏时一次读太多）。 */
const MAX_SCAN_ROUNDS = 8;

/**
 * 计算本轮要注入什么（**不改游标**，便于测试与"注入失败不动游标"）。
 *
 * @param {object} board Board 或 RemoteBoard
 * @param {{instanceId:string, sessionId:string, limit?:number, excludeKinds?:string[]}} who
 * @returns {Promise<{text:string, sinceSeq:number, nextSeq:number, count:number, maxSeq:number, skipped:number}>}
 */
export async function collectInbox(board, who) {
  const limit = Number(who?.limit ?? DEFAULT_INBOX_LIMIT);
  const instanceId = who?.instanceId ?? 'unknown';
  const sessionId = who?.sessionId ?? 'unknown';
  // 显式传 [] 表示"不过滤"（验收 c）；不传 / 传 undefined 用默认值
  const excludeKinds = Array.isArray(who?.excludeKinds)
    ? who.excludeKinds
    : DEFAULT_INBOX_EXCLUDE_KINDS;
  const exclude = new Set(excludeKinds);

  // 先扫一次过期的 ack / 租约：保证注入的是"现在"的真相，而不是上一轮的样子。
  // 失败不影响注入（扫描是增强，不是前提）。
  if (typeof board.sweepAll === 'function') {
    try {
      await board.sweepAll();
    } catch {
      /* 扫描失败就按当前状态注入 */
    }
  }

  const storedCursor = await board.getCursor(instanceId, sessionId);
  const fetchLimit = Math.max(limit * 5, limit + 1);

  // ── 翻页收集：噪声多的时候要往后多翻几页，否则真实事件永远浮不上来 ──
  const fetched = [];
  let scanFrom = storedCursor;
  let maxSeq = storedCursor;
  for (let round = 0; round < MAX_SCAN_ROUNDS; round += 1) {
    const page = await board.pendingEvents(instanceId, sessionId, fetchLimit, scanFrom);
    maxSeq = Number(page.max_seq ?? maxSeq);
    if (page.events.length === 0) break;
    fetched.push(...page.events);
    scanFrom = Number(page.events[page.events.length - 1].seq);
    // 已经攒够可显示的，就不用再往后翻
    if (fetched.filter((e) => !exclude.has(e.kind)).length >= limit) break;
    // 这页没取满 => 后面没有更多了
    if (page.events.length < fetchLimit) break;
    if (scanFrom >= maxSeq) break;
  }

  if (fetched.length === 0) {
    // 没有新事件：游标不动（也不该动到 maxSeq，那会跳过未来事件）
    return { text: '', sinceSeq: storedCursor, nextSeq: storedCursor, count: 0, maxSeq, skipped: 0 };
  }

  const lastFetchedSeq = Number(fetched[fetched.length - 1].seq);
  const kept = fetched.filter((e) => !exclude.has(e.kind));
  const skipped = fetched.length - kept.length;
  const displayed = kept.slice(0, limit);

  // ── 游标前移规则（这是整个过滤功能正确性的关键）──
  //   kept ≤ limit：所有取出的事件都"看过"了（留下的显示、排除的判为噪声），
  //                 可以直接越过全部 fetched —— 噪声不会堵在队头。
  //   kept >  limit：有真实事件被 limit 截掉了，绝不能越过它们，
  //                 只能停在本轮实际显示的最后一条，否则那些事件永不出现。
  const nextSeq = kept.length > limit
    ? Number(displayed[displayed.length - 1].seq)
    : lastFetchedSeq;

  // 防御：游标绝不后退
  const safeNext = Math.max(nextSeq, storedCursor);

  if (displayed.length === 0) {
    // 全部是噪声：不注入内容，但游标照样前进（否则会永久堵死）
    return { text: '', sinceSeq: storedCursor, nextSeq: safeNext, count: 0, maxSeq, skipped };
  }

  // 顺便把这些事件涉及的任务的**当前状态**带上：
  // 光说"有个 done 事件"不如直接说"t-xxxx 现在是 done"，模型立刻能用。
  const taskIds = [...new Set(displayed.map((e) => e.task_id).filter((x) => x !== null && x !== undefined))];
  const tasks = [];
  for (const id of taskIds.slice(0, 10)) {
    try {
      const t = await board.getTask(id);
      if (t !== null && t !== undefined) {
        tasks.push({ task_id: t.task_id, lifecycle: t.lifecycle, stale: t.stale, ack_state: t.ack_state });
      }
    } catch {
      /* 单个任务读不到不该让整次注入失败 */
    }
  }

  const text = formatInboxDigest(displayed, {
    sinceSeq: storedCursor,
    nextSeq: safeNext,
    tasks,
    skipped,
  });
  return { text, sinceSeq: storedCursor, nextSeq: safeNext, count: displayed.length, maxSeq, skipped };
}

/**
 * 采集 + 注入 + 前移游标，一步到位。
 *
 * 注意"全部是噪声"的情形：**要前移游标，但不注入任何内容**。
 * 这时 injected 为 false（没有内容可注入），但游标确实动了 —— 两者不是一回事。
 *
 * @param {object} board
 * @param {{instanceId:string, sessionId:string, limit?:number, excludeKinds?:string[]}} who
 * @param {(text:string)=>void} emit 真正把文本送进上下文的手段
 * @returns {Promise<{injected:boolean, count:number, sinceSeq:number, nextSeq:number, skipped:number}>}
 */
export async function deliverInbox(board, who, emit) {
  const got = await collectInbox(board, who);

  // 没有内容可注入，但可能有一批纯噪声被看过 —— 游标必须照样前进
  if (got.count === 0 || got.text === '') {
    if (got.nextSeq > got.sinceSeq) {
      await board.advanceCursor(who.instanceId, who.sessionId, got.nextSeq);
    }
    return {
      injected: false,
      count: 0,
      sinceSeq: got.sinceSeq,
      nextSeq: got.nextSeq,
      skipped: got.skipped,
    };
  }

  // 注入失败会抛出去，游标不前移 —— 下一轮还能补上
  emit(got.text);
  await board.advanceCursor(who.instanceId, who.sessionId, got.nextSeq);
  return {
    injected: true,
    count: got.count,
    sinceSeq: got.sinceSeq,
    nextSeq: got.nextSeq,
    skipped: got.skipped,
  };
}

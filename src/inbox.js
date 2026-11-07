/**
 * inbox.js — 发起方的**自动收件箱**：把"我关心的事件"在会话下一轮送进上下文。
 *
 * 这次踩到的坑就是这个文件存在的理由：对端把活做完了，但它**没有主动发消息**，
 * 于是发起方完全不知道 —— 投递成功、任务完成、发起方知情，是三件不同的事。
 * 前两件 v1 做了，第三件没做。这里补的就是第三件。
 *
 * 设计要点，每条都对应一个具体的失败方式：
 *
 * 1. **游标存在板上，进程重启不丢。** 主键是 (instanceId, sessionId)，
 *    天然按客户端隔离。放在内存里的话，DSH 一重启就重复刷屏或漏读。
 *
 * 2. **先注入后前移，且前移用"实际读到的最大 seq"，不是 max(seq)。**
 *    如果用全表最大 seq，会跳过尚未取出的中间事件（永久丢失）。
 *    limit 截断时也必须只前移到已读的那一条。
 *
 * 3. **不重复注入。** 每轮只取 seq > cursor 的；注入成功后 cursor 前移；
 *    第二轮自然只剩新增的。这条有专门的验收（d）。
 *
 * 4. **注入失败不动游标。** 宁可下一轮补上，也不要"以为读过了"。
 *
 * 5. **摘要必须短。** 模型上下文很贵，这里只给"发生了什么事 + 哪个任务 + 现在什么状态"，
 *    要看全文让它自己调 mesh_events。
 */

import { formatInboxDigest } from './domain.js';

export const DEFAULT_INBOX_LIMIT = 20;

/**
 * 计算本轮要注入什么（**不改游标**，便于测试与"注入失败不动游标"）。
 *
 * @param {object} board Board 或 RemoteBoard
 * @param {{instanceId:string, sessionId:string, limit?:number}} who
 * @returns {Promise<{text:string, sinceSeq:number, nextSeq:number, count:number, maxSeq:number}>}
 */
export async function collectInbox(board, who) {
  const limit = Number(who?.limit ?? DEFAULT_INBOX_LIMIT);
  const instanceId = who?.instanceId ?? 'unknown';
  const sessionId = who?.sessionId ?? 'unknown';

  // 先扫一次过期的 ack / 租约：保证注入的是"现在"的真相，而不是上一轮的样子。
  // 失败不影响注入（扫描是增强，不是前提）。
  if (typeof board.sweepAll === 'function') {
    try {
      await board.sweepAll();
    } catch {
      /* 扫描失败就按当前状态注入 */
    }
  }

  const { since_seq: sinceSeq, events, max_seq: maxSeq } = await board.pendingEvents(
    instanceId,
    sessionId,
    limit,
  );

  if (events.length === 0) {
    return { text: '', sinceSeq, nextSeq: sinceSeq, count: 0, maxSeq };
  }

  // 前移目标 = 本轮实际取到的最后一条的 seq（不是 maxSeq：maxSeq 可能包含没取出的）
  const lastFetched = Number(events[events.length - 1].seq);

  // 顺便把这些事件涉及的任务的**当前状态**带上：
  // 光说"有个 done 事件"不如直接说"t-xxxx 现在是 done"，模型立刻能用。
  const taskIds = [...new Set(events.map((e) => e.task_id).filter((x) => x !== null && x !== undefined))];
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

  const text = formatInboxDigest(events, { sinceSeq, nextSeq: lastFetched, tasks });
  return { text, sinceSeq, nextSeq: lastFetched, count: events.length, maxSeq };
}

/**
 * 采集 + 注入 + 前移游标，一步到位。
 *
 * @param {object} board
 * @param {{instanceId:string, sessionId:string, limit?:number}} who
 * @param {(text:string)=>void} emit 真正把文本送进上下文的手段
 * @returns {Promise<{injected:boolean, count:number, sinceSeq:number, nextSeq:number}>}
 */
export async function deliverInbox(board, who, emit) {
  const got = await collectInbox(board, who);
  if (got.count === 0 || got.text === '') {
    return { injected: false, count: 0, sinceSeq: got.sinceSeq, nextSeq: got.sinceSeq };
  }
  // 注入失败会抛出去，游标不前移 —— 下一轮还能补上
  emit(got.text);
  await board.advanceCursor(who.instanceId, who.sessionId, got.nextSeq);
  return { injected: true, count: got.count, sinceSeq: got.sinceSeq, nextSeq: got.nextSeq };
}

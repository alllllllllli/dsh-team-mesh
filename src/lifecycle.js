/**
 * lifecycle.js — 0.5：派发之后的两件事（都是"派发方"这一侧的功能）。
 *
 * 1. **stale 自动重派**（`autoRedispatch`，**默认 false**）：本实例派出去、后来租约过期被标
 *    `stale` 的任务，在原 target（instance + session）上再投一次任务卡。默认关着 = 与 0.4 一字不差。
 * 2. **完成通知**（`notifyOnComplete`，默认 true）：本实例派出去的任务在板上变成 `done` /
 *    `canceled` 时，给**原派发方会话**推一条 ≤200 字的短消息（任务号 / 标题 / 状态 / 耗时 / 证据数），
 *    不发整段 payload。
 *
 * 两件事共用一份**进程内登记表**与**一个轮询定时器**：
 *   - 登记表只在 `mesh_dispatch` 真的投递成功时写入（"本实例经手过" = 本进程发过且送到了）；
 *   - 重派次数按板上 `task.redispatched` 事件计数；通知去重按板上 `task.notify_*` 事件 ——
 *     **不新增数据库字段、不做 schema 迁移**（schema_version 保持 4）。
 *
 * 已知边界（写进 README / CHANGELOG）：
 *   - 登记表在内存里：插件重启后"本进程经手过"这件事就没了，重启前派出的任务不会被自动重派 /
 *     主动通知（板上事件仍可人工查）。这是不新增字段的代价，不是隐藏行为。
 *   - 远端板上客户端**不能写审计**（REMOTE_AUDIT_READONLY）：`task.redispatched` / `task.notify_*`
 *     只在本地板可写时落盘；远端模式下降级为本机 warn，重派次数用进程内计数兜底（仍受
 *     `maxRedispatch` 约束，不会每轮重复重派）。
 *   - 通知**优先直投本机会话**（0.6）：落点在本实例时走宿主 `sessionController.prompt`，
 *     不依赖 interconnect 的 `self` 路由；会话不活跃/宿主没有该服务时才降级到
 *     `ctx.interconnect.send`（0.5 路径），都失败如实落 `task.notify_skipped`。
 *     `channel` 字段标明实际走的是 `local-session` / `interconnect` / `none`。
 *   - 直投路径依赖宿主 `sessionController.prompt(request, signal)` 的签名（与 dispatcher.js
 *     建子会话同一套）；**没有在真实 DSH 宿主里跑过本轮**，单测用假 sessionController 锁形。
 */
import { randomUUID } from 'node:crypto';

import { formatTaskCard } from './domain.js';
import { appendAudit, payloadOf } from './dispatcher.js';

/** 派发后生命周期默认轮询间隔。15s：比 ack 窗口（60s）密，又不至于空转打满板。 */
export const DEFAULT_REDISPATCH_POLL_MS = 15_000;
/** 默认最多重派几次。1 = 只补投一次；设 0 等于关（但 autoRedispatch 本身仍是关的默认）。 */
export const DEFAULT_MAX_REDISPATCH = 1;

/** 生命周期会写下的审计事件（沿用 `模块.动作` 命名，与 task.* / lease.* 一致）。 */
export const LIFECYCLE_EVENT_KINDS = Object.freeze({
  redispatched: 'task.redispatched',
  redispatchFailed: 'task.redispatch_failed',
  notifySent: 'task.notify_sent',
  notifyFailed: 'task.notify_failed',
  notifySkipped: 'task.notify_skipped',
});

/** 通知的"已尝试"判据：这三种事件任意一条存在就说明这条任务不必再通知。 */
const NOTIFY_ATTEMPT_KINDS = new Set([
  LIFECYCLE_EVENT_KINDS.notifySent,
  LIFECYCLE_EVENT_KINDS.notifyFailed,
  LIFECYCLE_EVENT_KINDS.notifySkipped,
]);

/** 读板上事件时的单页上限（板接口上限就是 100）。 */
const EVENT_SCAN_LIMIT = 100;
/** 通知正文上限：需求是"≤200 字"，这里按字符数硬截断。 */
export const NOTIFY_TEXT_LIMIT = 200;

/**
 * 本实例派出过的任务登记表（进程内，`Map<taskId, entry>`）。
 *
 * 为什么不落板：需求明确"不新增数据库字段、不做 schema 迁移"。板上事件能证明"这条任务被派过"，
 * 但证明不了"是本实例派的"；所以"本实例经手过"只能靠进程内登记。
 */
export function createDispatchRegistry() {
  const entries = new Map();
  return {
    /**
     * @param {string} taskId
     * @param {{peerInstance?:string, peerSession?:string, dispatcherInstance?:string,
     *          dispatcherSession?:string, dispatchedAt?:number}} [entry]
     * @returns {boolean} 登记成功才 true（taskId 非法直接忽略，不抛）
     */
    record(taskId, entry = {}) {
      if (typeof taskId !== 'string' || taskId.length === 0) return false;
      entries.set(taskId, {
        taskId,
        peerInstance: typeof entry.peerInstance === 'string' ? entry.peerInstance : null,
        peerSession: typeof entry.peerSession === 'string' ? entry.peerSession : null,
        dispatcherInstance: typeof entry.dispatcherInstance === 'string' ? entry.dispatcherInstance : null,
        dispatcherSession: typeof entry.dispatcherSession === 'string' ? entry.dispatcherSession : null,
        dispatchedAt: Number.isFinite(Number(entry.dispatchedAt)) ? Number(entry.dispatchedAt) : Date.now(),
      });
      return true;
    },
    get(taskId) {
      return entries.get(taskId) ?? null;
    },
    remove(taskId) {
      return entries.delete(taskId);
    },
    list() {
      return [...entries.values()];
    },
    get size() {
      return entries.size;
    },
    clear() {
      entries.clear();
    },
  };
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/** 毫秒 → 给人看的短时长（通知正文用，越短越好）。 */
export function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 60_000) return `${Math.round(n / 1000)}s`;
  const minutes = Math.floor(n / 60_000);
  const seconds = Math.round((n % 60_000) / 1000);
  return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
}

function truncate(text, max) {
  const s = typeof text === 'string' ? text : String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, Math.max(max - 1, 0))}…`;
}

/**
 * 生成给派发方会话的**短**通知（任务号 / 标题 / 最终状态 / 耗时 / 证据数量）。
 * 硬上限 {@link NOTIFY_TEXT_LIMIT} 字符；超了截断并加省略号，不把 payload 整段塞过去。
 *
 * @param {{task:object, lifecycle:string, durationMs:number|null, evidenceCount:number|null,
 *          peerInstance?:string|null}} opts
 * @returns {string}
 */
export function buildNotifyText(opts) {
  const task = opts.task ?? {};
  const status = opts.lifecycle === 'done' ? '已完成' : opts.lifecycle === 'canceled' ? '已取消' : String(opts.lifecycle);
  const title = truncate(task.title ?? '', 60);
  const head = `[mesh] ${task.task_id ?? '?'} ${title} ${status}`;
  const meta = [];
  if (Number.isFinite(Number(opts.durationMs)) && Number(opts.durationMs) >= 0) {
    meta.push(`耗时 ${formatDuration(opts.durationMs)}`);
  }
  if (Number.isInteger(opts.evidenceCount) && opts.evidenceCount >= 0) {
    meta.push(`证据 ${opts.evidenceCount} 条`);
  }
  if (typeof opts.peerInstance === 'string' && opts.peerInstance.length > 0) {
    meta.push(`目标 ${opts.peerInstance}`);
  }
  const text = meta.length === 0 ? head : `${head}\n${meta.join('｜')}`;
  return text.length <= NOTIFY_TEXT_LIMIT ? text : `${text.slice(0, NOTIFY_TEXT_LIMIT - 1)}…`;
}

/** 读某任务的全部事件（失败返回 null，调用方必须把"读不到"与"没有"分开）。 */
async function readTaskEvents(board, taskId) {
  if (typeof board?.recentEvents !== 'function') return null;
  try {
    const got = await board.recentEvents(EVENT_SCAN_LIMIT, taskId);
    return Array.isArray(got) ? got : null;
  } catch {
    return null;
  }
}

function countKind(events, kind) {
  if (!Array.isArray(events)) return 0;
  let n = 0;
  for (const event of events) if (event?.kind === kind) n += 1;
  return n;
}

function findLatestKind(events, kinds) {
  if (!Array.isArray(events)) return null;
  // recentEvents 是"新的在前"，第一条匹配就是最近一次
  for (const event of events) if (kinds.has(event?.kind)) return event;
  return null;
}

/**
 * 终态细节：耗时 + 证据数量。**算不出来就给 null**，不编 0 假装"没有证据"。
 */
async function terminalDetail(board, task) {
  const events = await readTaskEvents(board, task.task_id);
  const terminal = findLatestKind(events, new Set(['task.done', 'task.canceled']));
  const payload = terminal === null ? {} : payloadOf(terminal);

  let evidenceCount = Number.isInteger(payload.evidence_count) ? payload.evidence_count : null;
  if (evidenceCount === null && typeof board?.listEvidence === 'function') {
    try {
      const list = await board.listEvidence(task.task_id);
      if (Array.isArray(list)) evidenceCount = list.length;
    } catch {
      evidenceCount = null;
    }
  }

  const startedAt = Number(task.created_at);
  const finishedAt = terminal === null ? NaN : Number(terminal.created_at);
  const durationMs = Number.isFinite(startedAt) && Number.isFinite(finishedAt) && finishedAt >= startedAt
    ? finishedAt - startedAt
    : null;
  return { durationMs, evidenceCount };
}

function usableInterconnect(interconnect) {
  return interconnect !== null && typeof interconnect === 'object' && typeof interconnect.send === 'function';
}

/**
 * 会话直投能力是否存在。宿主没注入 sessionController 时返回 null ——
 * **不猜**其它入口，直接降级到 interconnect（与 0.5 行为一致）。
 */
function sessionControllerOf(getSessionController) {
  if (typeof getSessionController !== 'function') return null;
  try {
    const sc = getSessionController();
    return sc !== null && typeof sc === 'object' ? sc : null;
  } catch {
    return null;
  }
}

/**
 * 0.6：**本会话直投**——把完成通知直接 prompt 给本机上原派发方会话。
 *
 * 为什么需要它：0.5 的完成通知用 `interconnect.send` 发给"原派发方会话"；
 * 但派发方通常就在**本实例**，本实例要寻址自己的会话，interconnect 的 peers 里
 * 必须有以自己 instanceId 为键的 self 路由（本机 profile 没配），真实环境会落
 * `delivered:false` → `task.notify_failed`。宿主的 sessionController 本来就能给
 * **活着的本地会话**投消息，这条路径不依赖任何网络配置。
 *
 * 会话不活跃怎么办：`sc.prompt` 内部会 `resolveAgent(sessionId)`，对不存在/已销毁的
 * 会话会抛稳定错误 —— 这里接住、标成 `attempted:true`，由调用方降级到 interconnect。
 * **绝不**因为投递失败就假装通知成功。
 *
 * @returns {Promise<{ok:boolean, attempted:boolean, reason:string|null}>}
 *   `attempted=false` 表示"这条通道根本不存在/不适用"，用于区分
 *   "试了没成"（both-failed → skipped）与"没试"（interconnect 没送到 → failed，0.5 语义）。
 */
async function deliverLocalSession({ sc, sessionId, text }) {
  if (sc === null || typeof sc.prompt !== 'function') {
    return { ok: false, attempted: false, reason: 'no-session-controller' };
  }
  try {
    await sc.prompt(
      {
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      },
      // 宿主 `prompt(request, signal)` 的第二个参数是**必填 AbortSignal**
      // （与 dispatcher.js 里建子会话用的是同一个签名）；少传在真实宿主里必炸。
      new AbortController().signal,
    );
    return { ok: true, attempted: true, reason: null };
  } catch (err) {
    const code = typeof err?.code === 'string' && err.code.length > 0 ? err.code : null;
    const message = err?.message ?? String(err);
    return { ok: false, attempted: true, reason: code === null ? message : `${code}: ${message}` };
  }
}

function warn(logger, message) {
  try {
    logger?.warn?.(`[dsh-team-mesh] ${message}`);
  } catch {
    /* 日志写不了不影响判定 */
  }
}

/**
 * 完成通知（同一任务**只通知一次**）。
 *
 * 去重分两层：先看板上 `task.notify_*` 事件（跨进程/跨轮次都算数），再用进程内 state 兜底
 * （远端板写不了审计时，板上事件这条依据不存在，不兜底就会每轮重复通知）。
 *
 * 0.6 起投递顺序（每步都如实落 `channel`）：
 *   ① 落点在本实例（`entry.dispatcherInstance === 本实例 id`）→ 用宿主 `sessionController.prompt`
 *      直投本机会话 → `notify_sent`（channel=local-session）；
 *      会话不活跃/没有 sessionController → 降级（不抛、不假装成功）；
 *   ② 降级 `ctx.interconnect.send` → `notify_sent`（channel=interconnect）；
 *   ③ 本地试过但失败 **且** interconnect 也没成 → `notify_skipped`（channel=none，reason 写清两边）；
 *      本地通道不存在（远端落点 / 没 sessionController）而 interconnect 没送到 → 仍按 0.5 语义
 *      落 `notify_failed`（channel=interconnect），保持"没送到"与"根本没法投"可区分。
 */
async function notifyCompletion(opts) {
  const { board, entry, task, state, getInterconnect, getSessionController, logger, actor } = opts;
  const taskId = task.task_id;
  if (state.notified.has(taskId)) return { skipped: 'already-attempted' };

  const events = await readTaskEvents(board, taskId);
  if (Array.isArray(events) && findLatestKind(events, NOTIFY_ATTEMPT_KINDS) !== null) {
    state.notified.add(taskId);
    return { deduped: true };
  }

  const dispatcherInstance = entry.dispatcherInstance;
  const dispatcherSession = entry.dispatcherSession;
  const base = {
    lifecycle: task.lifecycle,
    dispatcher_instance: dispatcherInstance,
    dispatcher_session: dispatcherSession,
  };

  // 先占位：即使下面写审计失败，本进程也不会对同一任务重复通知（"只通知一次"是硬要求）
  state.notified.add(taskId);

  if (typeof dispatcherSession !== 'string' || dispatcherSession.length === 0
    || typeof dispatcherInstance !== 'string' || dispatcherInstance.length === 0) {
    await appendAudit(board, LIFECYCLE_EVENT_KINDS.notifySkipped, taskId, actor, {
      ...base,
      channel: 'none',
      reason: 'no-dispatcher-target',
    });
    return { skipped: 'no-dispatcher-target' };
  }

  const detail = await terminalDetail(board, task);
  const text = buildNotifyText({
    task,
    lifecycle: task.lifecycle,
    durationMs: detail.durationMs,
    evidenceCount: detail.evidenceCount,
    peerInstance: entry.peerInstance,
  });

  // ── ① 本实例直投（只有在"落点就是本实例"时才走）──
  const selfId = typeof actor === 'string' && actor.length > 0 ? actor : 'unknown';
  const localTarget = selfId !== 'unknown' && dispatcherInstance === selfId;
  let localAttempt = { ok: false, attempted: false, reason: 'not-local-target' };
  if (localTarget) {
    localAttempt = await deliverLocalSession({
      sc: sessionControllerOf(getSessionController),
      sessionId: dispatcherSession,
      text,
    });
  }
  if (localAttempt.ok) {
    await appendAudit(board, LIFECYCLE_EVENT_KINDS.notifySent, taskId, actor, {
      ...base,
      channel: 'local-session',
      delivered: true,
      reason: null,
      duration_ms: detail.durationMs,
      evidence_count: detail.evidenceCount,
      chars: text.length,
    });
    return { notified: { taskId, lifecycle: task.lifecycle, channel: 'local-session' } };
  }

  // ── ② 降级 interconnect（0.5 路径）──
  const interconnect = getInterconnect();
  const interconnectUsable = usableInterconnect(interconnect);
  let sent = { delivered: false, reason: 'no-interconnect' };
  if (interconnectUsable) {
    try {
      sent = await interconnect.send({
        instanceId: dispatcherInstance,
        sessionId: dispatcherSession,
        text,
      });
    } catch (err) {
      sent = { delivered: false, reason: `exception: ${err?.message ?? String(err)}` };
    }
  }
  const interconnectReason = sent?.reason ?? (interconnectUsable ? 'undelivered' : 'no-interconnect');
  const interconnectPayload = {
    ...base,
    delivered: sent?.delivered === true,
    reason: interconnectReason,
    duration_ms: detail.durationMs,
    evidence_count: detail.evidenceCount,
    chars: text.length,
  };

  if (sent?.delivered === true) {
    await appendAudit(board, LIFECYCLE_EVENT_KINDS.notifySent, taskId, actor, {
      ...interconnectPayload,
      channel: 'interconnect',
    });
    return { notified: { taskId, lifecycle: task.lifecycle, channel: 'interconnect' } };
  }

  // ── ③ 都不成 ──
  // ③a 本实例直投**真的试过**（会话不活跃/宿主报错）且 interconnect 也没成 → 两条路都断了
  if (localAttempt.attempted) {
    const reason = `all-channels-failed: local-session=${localAttempt.reason}; interconnect=${interconnectReason}`;
    warn(logger, `任务 ${taskId} 完成通知两条通道都失败：${reason}`);
    await appendAudit(board, LIFECYCLE_EVENT_KINDS.notifySkipped, taskId, actor, {
      ...interconnectPayload,
      channel: 'none',
      local_reason: localAttempt.reason,
      interconnect_reason: interconnectReason,
      reason,
    });
    return { skipped: reason };
  }

  // ③b 本实例通道不存在（远端落点 / 没 sessionController）且没有 interconnect：
  //     这是 0.5 的既有降级语义，reason 保持 no-interconnect（不改变旧行为）。
  if (!interconnectUsable) {
    await appendAudit(board, LIFECYCLE_EVENT_KINDS.notifySkipped, taskId, actor, {
      ...interconnectPayload,
      channel: 'none',
      reason: 'no-interconnect',
    });
    return { skipped: 'no-interconnect' };
  }

  // ③c interconnect 试了但没送到（本实例通道不存在或远端落点）→ 0.5 的 notify_failed
  warn(logger, `任务 ${taskId} 完成通知没送到：${interconnectReason}`);
  await appendAudit(board, LIFECYCLE_EVENT_KINDS.notifyFailed, taskId, actor, {
    ...interconnectPayload,
    channel: 'interconnect',
  });
  return { failed: { taskId, reason: interconnectReason } };
}

/**
 * stale 自动重派（一次）。
 *
 * 重派 = 把同一张任务卡再投给**原 target**（instance + session），再 `recordDispatch` 开一个新的
 * ack 窗口 —— 与一次普通派发完全同义，不偷偷改投别的会话。
 * 次数按板上 `task.redispatched` 事件计；进程内 state 里的尝试数兜底（远端板写不了审计时）。
 * 失败不写 `task.redispatched`（那是"重派成功"的证据），只写 `task.redispatch_failed` + reason。
 */
async function redispatchOnce(opts) {
  const { board, entry, task, state, getInterconnect, logger, actor, maxRedispatch } = opts;
  const taskId = task.task_id;

  if (state.redispatchFailed.has(taskId)) return { skipped: 'previous-attempt-failed' };
  if (typeof entry.peerInstance !== 'string' || entry.peerInstance.length === 0
    || typeof entry.peerSession !== 'string' || entry.peerSession.length === 0) {
    return { skipped: 'no-original-target' };
  }

  const events = await readTaskEvents(board, taskId);
  const boardAttempts = countKind(events, LIFECYCLE_EVENT_KINDS.redispatched);
  const localAttempts = state.redispatchAttempts.get(taskId) ?? 0;
  const attempts = Math.max(boardAttempts, localAttempts);
  if (attempts >= maxRedispatch) return { skipped: 'max-redispatch-reached' };

  const attempt = attempts + 1;
  state.redispatchAttempts.set(taskId, attempt);

  const original = {
    original_instance: entry.peerInstance,
    original_session: entry.peerSession,
    dispatcher_instance: entry.dispatcherInstance,
    dispatcher_session: entry.dispatcherSession,
  };
  const interconnect = getInterconnect();
  if (!usableInterconnect(interconnect)) {
    state.redispatchFailed.add(taskId);
    warn(logger, `任务 ${taskId} 是 stale，但没有 interconnect，无法重派`);
    await appendAudit(board, LIFECYCLE_EVENT_KINDS.redispatchFailed, taskId, actor, {
      reason: 'no-interconnect',
      attempt,
      delivered: false,
      ...original,
    });
    return { failed: { taskId, reason: 'no-interconnect' } };
  }

  let sent;
  try {
    sent = await interconnect.send({
      instanceId: entry.peerInstance,
      sessionId: entry.peerSession,
      text: formatTaskCard(task, {
        fromInstance: typeof entry.dispatcherInstance === 'string' ? entry.dispatcherInstance : undefined,
      }),
    });
  } catch (err) {
    sent = { delivered: false, reason: `exception: ${err?.message ?? String(err)}` };
  }

  if (sent?.delivered !== true) {
    state.redispatchFailed.add(taskId);
    const reason = sent?.reason ?? 'undelivered';
    warn(logger, `任务 ${taskId} 重派失败：${reason}`);
    await appendAudit(board, LIFECYCLE_EVENT_KINDS.redispatchFailed, taskId, actor, {
      reason,
      attempt,
      delivered: false,
      ...original,
    });
    return { failed: { taskId, reason } };
  }

  // 送到了：必须按一次真实派发落库（开新 ack 窗口），否则"重派了但没人等回执"会变成假象
  let ackState = null;
  try {
    const recorded = await board.recordDispatch(taskId, entry.peerInstance, entry.peerSession, {
      delivered: true,
      reason: sent.reason ?? null,
    });
    ackState = recorded?.ack_state ?? null;
  } catch (err) {
    warn(logger, `任务 ${taskId} 重派已送到，但记录派发失败：${err?.message ?? err}`);
  }

  await appendAudit(board, LIFECYCLE_EVENT_KINDS.redispatched, taskId, actor, {
    reason: 'lease-stale',
    attempt,
    delivered: true,
    ack_state: ackState,
    ...original,
  });
  return { redispatched: { taskId, attempt, ack_state: ackState } };
}

/**
 * 扫一轮（**不启动定时器**，测试直接调它）。
 *
 * 对登记表里每条任务：
 *   - 板上找不到 → 移出登记表（不再轮询一个不存在的任务）；
 *   - 已终结 → 需要时发一次完成通知，然后移出登记表（终态之后既不用重派也不用再通知）；
 *   - 未终结且 stale → `autoRedispatch` 开着才重派一次。
 *
 * @param {object} deps
 * @param {object} deps.board
 * @param {ReturnType<typeof createDispatchRegistry>} deps.registry
 * @param {() => object|null} [deps.getInterconnect]
 * @param {{autoRedispatch?:boolean, maxRedispatch?:number, notifyOnComplete?:boolean}} [deps.config]
 * @param {{notified:Set<string>, redispatchFailed:Set<string>, redispatchAttempts:Map<string,number>}} [deps.state]
 * @param {string} [deps.instanceId] - 审计用的 actor（本实例 id）
 * @param {object} [deps.logger]
 * @returns {Promise<object>} 本轮统计（测试与日志都看它）
 */
export async function serviceLifecycle(deps = {}) {
  const result = {
    scanned: 0,
    removed: [],
    redispatched: [],
    redispatchFailed: [],
    notifySkipped: [],
    notified: [],
    notifyFailed: [],
    errors: [],
  };
  const board = deps.board;
  const registry = deps.registry;
  if (board === undefined || board === null || registry === undefined || registry === null) {
    result.errors.push('缺少 board 或 registry');
    return result;
  }
  const entries = typeof registry.list === 'function' ? registry.list() : [];
  if (entries.length === 0) return result;

  const config = deps.config ?? {};
  const autoRedispatch = config.autoRedispatch === true;
  const notifyOnComplete = config.notifyOnComplete !== false;
  const maxRedispatch = clampInt(config.maxRedispatch, 0, 10, DEFAULT_MAX_REDISPATCH);
  const state = deps.state ?? {
    notified: new Set(),
    redispatchFailed: new Set(),
    redispatchAttempts: new Map(),
  };
  const getInterconnect = typeof deps.getInterconnect === 'function' ? deps.getInterconnect : () => null;
  // 0.6：本实例直投能力（宿主 sessionController）。拿不到就 null → 降级 interconnect。
  const getSessionController = typeof deps.getSessionController === 'function'
    ? deps.getSessionController
    : () => null;
  const logger = deps.logger;
  const actor = typeof deps.instanceId === 'string' && deps.instanceId.length > 0 ? deps.instanceId : 'unknown';

  for (const entry of entries) {
    const taskId = entry?.taskId;
    if (typeof taskId !== 'string' || taskId.length === 0) continue;
    result.scanned += 1;

    let task;
    try {
      task = await board.getTask(taskId);
    } catch (err) {
      // 读板失败是暂时的（网络/锁），**不把登记项删掉**，下一轮再试
      result.errors.push({ taskId, reason: `getTask-failed: ${err?.message ?? err}` });
      continue;
    }
    if (task === null || task === undefined) {
      registry.remove(taskId);
      result.removed.push({ taskId, reason: 'task-not-found' });
      continue;
    }

    const terminal = task.lifecycle === 'done' || task.lifecycle === 'canceled';
    if (terminal) {
      if (notifyOnComplete) {
        const outcome = await notifyCompletion({
          board, entry, task, state, getInterconnect, getSessionController, logger, actor,
        });
        if (outcome.skipped !== undefined) result.notifySkipped.push({ taskId, reason: outcome.skipped });
        if (outcome.notified !== undefined) result.notified.push(outcome.notified);
        if (outcome.failed !== undefined) result.notifyFailed.push(outcome.failed);
      }
      registry.remove(taskId);
      continue;
    }

    if (autoRedispatch && Number(task.stale) === 1) {
      const outcome = await redispatchOnce({
        board, entry, task, state, getInterconnect, logger, actor, maxRedispatch,
      });
      if (outcome.redispatched !== undefined) result.redispatched.push(outcome.redispatched);
      if (outcome.failed !== undefined) result.redispatchFailed.push(outcome.failed);
    }
  }
  return result;
}

/**
 * 启动派发后生命周期的定时轮询（disposer 里会清掉定时器）。
 *
 * 与 dispatcher 同一个思路：定时器而不是 `agent/pre-step` —— 派发方可能一整天不跑一轮，
 * 而"对端挂在 stale"和"任务做完了"都该由插件主动发现，不该等某个会话刚好在动。
 * 重叠保护：上一轮没回来就不开新的一轮。
 *
 * @param {object} deps - 同 serviceLifecycle，另加 pollMs
 * @returns {{pollMs:number, serviceOnce:()=>Promise<object|null>, dispose:()=>void}}
 */
export function startLifecycle(deps = {}) {
  const pollMs = clampInt(deps.pollMs, 1_000, 300_000, DEFAULT_REDISPATCH_POLL_MS);
  const logger = deps.logger ?? deps.ctx?.logger;
  const state = {
    notified: new Set(),
    redispatchFailed: new Set(),
    redispatchAttempts: new Map(),
  };
  let disposed = false;
  let running = false;

  const serviceOnce = async () => {
    if (disposed) return null;
    if (running) return null;
    running = true;
    try {
      const got = await serviceLifecycle({ ...deps, state });
      for (const err of got?.errors ?? []) {
        warn(logger, `派发后生命周期本轮未完成（${err.taskId}）：${err.reason}`);
      }
      return got;
    } catch (err) {
      warn(logger, `派发后生命周期异常：${err?.message ?? err}`);
      return null;
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void serviceOnce();
  }, pollMs);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    pollMs,
    serviceOnce,
    dispose() {
      disposed = true;
      clearInterval(timer);
    },
  };
}

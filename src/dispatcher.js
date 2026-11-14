/**
 * dispatcher.js — "总管"角色：把派给总管的活**分流**给一个刚建出来的子会话，并代签回执。
 *
 * 为什么要有这个角色（真实病灶）：对端常常只有一个活会话，所有任务都堵进它，
 * 于是前一个任务没干完，后一个任务卡在同一个上下文里排队，表现为 ack_timeout。
 * 总管负责"接信 + 分流"：新会话专属这条任务，互不抢上下文；总管自己**永不动手**。
 *
 * 三条硬约束，分别对应一种会被误判成"正常"的失败：
 *
 * 1. **一次派发只 spawn 一次，去重点必须在板上（重启后不重复）。**
 *    这里用板的 `cursor` 表当持久去重点：键是 `dispatcher@<总管会话id>`（合成 session_id，
 *    与真会话的收件箱游标隔离）。**先推进游标、再建会话** —— 顺序反过来会留下
 *    "建完会话但没记上，重启又建一个"的窗口；宁可"游标过了但会话没建成"这种能靠
 *    ack_timeout 暴露的失败，也不要重复烧对端额度。
 *    为什么不直接用审计事件当去重点：远端板明令禁止客户端写审计（REMOTE_AUDIT_READONLY），
 *    而 cursor 的读写两端都支持。审计事件是本机可写时的**附加证据**，不是去重依据。
 *
 * 2. **spawn 失败不许假装受理。** 顺序固定为 create/prompt 成功之后才 ack；
 *    任何一步失败：落 `dispatcher.failed` 事件（本机板可写时）、**不 ack**，
 *    让那条派发保持 pending 直到 ack_timeout —— "送到了没人管"是诚实的结论，
 *    比"已回执但没人干"轻得多。
 *
 * 3. **deep 依赖只走宿主公开入口。** 建会话走 `ctx.sessionController.create()`，
 *    给新会话派活走 `sessionController.prompt(request, signal)`。这两个签名是对着装好的 app.asar
 *    （`@deepseek-ai/dsh-api-session-controller`）逐行核过的：
 *      - `lib/types/index.js:264`  构造函数 `super(ctx, 'sessionController', …)` → 服务名
 *      - `lib/types/index.js:538`  `async prompt(request, signal)`，539 行 `signal.throwIfAborted()`
 *        → **第二个参数是必填 AbortSignal**，少传真机必炸
 *      - `lib/types/index.js:396`  `create` 转 `lib/types/commands.js:120`，接受字段只有
 *        `workspaceId / cwd / sessionId / agentPreset`（121 行 workspaceId 与 cwd 互斥）
 *      - `create` **不接受 prompt**，所以任务书必须走 prompt（新会话是空白会话）
 *    但这也只是读源码核对 + 单测锁形，**没在真实宿主里跑过**（见报告"未验证"）。
 */
import { randomUUID } from 'node:crypto';

/** 默认轮询间隔。3s：比 60s 的 ack 窗口密得多，又不会空转把板打满。 */
export const DEFAULT_DISPATCHER_POLL_MS = 3000;

/**
 * 去重游标的合成 session_id 前缀。
 * 用 `dispatcher@<sessionId>` 而不是复用总管会话自己的 id：真会话的 id 下面挂的是
 * 它自己的收件箱游标，混用会让总管永远看不到自己的团队动态。
 */
export const DISPATCHER_CURSOR_PREFIX = 'dispatcher@';

/** 总管分流过程中会写下的审计事件（一律 `模块.动作` 形态，与现有 task.* / lease.* 一致）。 */
export const DISPATCHER_EVENT_KINDS = Object.freeze({
  /** 建会话之前先落一条"我要处理这条派发"：崩溃时能看出它处理到哪一步 */
  intent: 'dispatcher.spawn_intent',
  /** 新会话真的建出来、任务书也投进去了 */
  spawned: 'dispatcher.spawned',
  /** 建会话/投任务书失败：不 ack，让派发方拿到 ack_timeout */
  failed: 'dispatcher.failed',
  /** 会话建出来了但代签回执失败（极少；派发方会看到 ack_timeout） */
  ackFailed: 'dispatcher.ack_failed',
  /** 这条派发不归总管处理（任务已终结 / 已有人接手 / 没送到） */
  skipped: 'dispatcher.skipped',
});

/** 一次扫描最多取多少条事件（板接口单页上限就是 100）。 */
const DEFAULT_EVENT_BATCH = 100;
/** 一次轮询最多向后翻几页：冷启动要从历史末尾追，但必须有界，不能一轮把全表读完。 */
const DEFAULT_MAX_PAGES = 5;

/**
 * 把配置里的 dispatcherSessions 规整成去重后的非空字符串数组。
 * 配置项写错（不是数组 / 混了空串）不该让插件挂掉，只该"这个功能不生效"。
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function normalizeDispatcherSessions(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (id.length === 0 || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/** 总管自己的去重游标键。 */
export function dispatcherCursorKey(sessionId) {
  return `${DISPATCHER_CURSOR_PREFIX}${sessionId}`;
}

/**
 * 事件 payload 可能是对象（本地板 recentEvents 已解析）也可能是 JSON 字符串
 * （pendingEvents 原样返回，远端板上还是字符串）。两种都要能读。
 */
function payloadOf(event) {
  const raw = event?.payload;
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'string') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 写一条审计事件。**尽力而为，绝不因为写不上而改变分流结论。**
 * 远端板会抛 REMOTE_AUDIT_READONLY（审计由板服务在操作内部生成），这不是错误。
 *
 * @returns {Promise<boolean>} 真的写上了才 true
 */
async function appendAudit(board, kind, taskId, actor, payload) {
  if (typeof board?.appendEvent !== 'function') return false;
  try {
    await board.appendEvent(kind, taskId, actor, payload);
    return true;
  } catch {
    return false;
  }
}

/**
 * 生成交给子会话的完整任务书。**自包含**：子会话看不到总管上下文，也没有任务卡原文。
 *
 * 为什么把执行顺序写死在 prompt 里：子会话 Agent 的第一轮行为几乎完全由这段文字决定，
 * 少写一步就会漏（最常见的漏是"只报告不完成"或"没认领就干活"）。
 *
 * @param {{task: object, dispatcherSession: string, fromInstance?: string}} opts
 * @returns {string}
 */
export function buildDispatcherPrompt({ task, dispatcherSession, fromInstance }) {
  const taskId = task.task_id;
  const brief = typeof task.brief === 'string' && task.brief.trim().length > 0
    ? task.brief.trim()
    : '（任务书没有 brief，按标题与验收标准执行）';
  const acceptance = typeof task.acceptance === 'string' && task.acceptance.trim().length > 0
    ? task.acceptance.trim()
    : '（没有单独的验收标准，以任务书为准）';
  const lines = [
    `【总管分流任务 ${taskId}】${task.title}`,
    '',
    `这个会话由总管（${dispatcherSession}）自动创建，只负责这一条任务。`,
    '总管不执行任务 —— 它只负责分流和代签回执（回执已代签，你不用再调 mesh_task_ack）。',
    '',
    '— 任务书 —',
    brief,
    '',
    `验收标准：${acceptance}`,
  ];
  if (typeof fromInstance === 'string' && fromInstance.length > 0) {
    lines.push(`派发方实例：${fromInstance}`);
  }
  lines.push(
    '',
    '— 执行顺序（照做，别跳步）—',
    `1. mesh_task_claim({ taskId: "${taskId}" })   // 认领并拿租约`,
    '2. 干活：按任务书执行，产物必须真的落盘（没有产物就如实说明）',
    '3. 超过 5 分钟：mesh_task_heartbeat 续租，别让租约过期被别人接管',
    `4. mesh_task_report({ taskId: "${taskId}", executed: true, outcome: "pass" | "fail" | "unknown",`,
    `                    note: "做了什么", evidenceRef: "<真实产物的绝对路径>" })`,
    '   // outcome 必须诚实：没做成就 fail，不确定就 unknown，不要为了过门禁写 pass',
    `5. mesh_task_complete({ taskId: "${taskId}" })`,
    '   // 被门禁拒就补可采信证据再试，不要换个说法重试同一次调用',
  );
  return lines.join('\n');
}

/**
 * 通过宿主入口建一个子会话，并把任务书作为它的第一条 prompt 投进去。
 *
 * **这是全插件唯一为"总管分流"建会话的地方**，一次调用 = 一次 create（不重试、不降级）。
 * 失败如实返回原因，由调用方决定"不 ack、落失败事件"。
 *
 * @param {object} deps
 * @param {object} deps.ctx - 宿主上下文
 * @param {object} deps.task - 板上的任务行
 * @param {string} deps.dispatcherSession - 总管会话 id（写进 prompt，便于子会话知道谁派的）
 * @param {string} [deps.fromInstance]
 * @param {string} [deps.cwd]
 * @param {string} [deps.agentPreset]
 * @returns {Promise<{ok:true, sessionId:string, promptChars:number} | {ok:false, stage:string, reason:string, message:string, sessionId?:string}>}
 */
export async function spawnDispatcherChild(deps) {
  const { ctx, task, dispatcherSession } = deps;
  const sc = ctx?.get?.('sessionController') ?? ctx?.sessionController;
  if (sc === null || sc === undefined || typeof sc.create !== 'function') {
    return {
      ok: false,
      stage: 'create',
      reason: 'create-unsupported',
      message: '宿主没有 sessionController.create 服务，总管无法建子会话',
    };
  }

  // create 只接受 cwd / agentPreset / workspaceId / sessionId；缺省就交给宿主默认，
  // 绝不在这里猜一个路径（猜错会在别处建出一个诡异的空目录）。
  const createPayload = {};
  if (typeof deps.cwd === 'string' && deps.cwd.trim().length > 0) createPayload.cwd = deps.cwd.trim();
  if (typeof deps.agentPreset === 'string' && deps.agentPreset.trim().length > 0) {
    createPayload.agentPreset = deps.agentPreset.trim();
  }

  let created;
  try {
    created = await sc.create(createPayload);
  } catch (err) {
    const code = typeof err?.code === 'string' ? err.code : undefined;
    return {
      ok: false,
      stage: 'create',
      reason: 'create-failed',
      message: `${code === undefined ? '' : `${code}: `}${err?.message ?? String(err)}`,
    };
  }
  const sessionId = created?.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return {
      ok: false,
      stage: 'create',
      reason: 'create-failed',
      message: `宿主 create() 返回了空 sessionId（${JSON.stringify(created)}）`,
    };
  }

  const prompt = buildDispatcherPrompt({
    task,
    dispatcherSession,
    fromInstance: deps.fromInstance,
  });
  // 新会话是"空白会话"，不会自己知道要干什么 —— 必须把任务书作为第一条 prompt 投进去。
  if (typeof sc.prompt !== 'function') {
    return {
      ok: false,
      stage: 'prompt',
      reason: 'prompt-unsupported',
      message: '宿主 sessionController 没有 prompt 方法：子会话建出来了，但没法把任务书交给它',
      sessionId,
    };
  }
  // prompt 的第二个参数是**必填的 AbortSignal**：宿主实现第一行就是 `signal.throwIfAborted()`
  // （app.asar 里 dsh-api-session-controller/lib/types/index.js:538-539）。
  // 少传这一个参数在真实宿主里必然 TypeError，而桩测试不会报 —— 这就是"单测全绿、真机必炸"的典型。
  // 每次都新建一个 controller：不复用同一个 signal（一次 spawn 一次取消域，长跑互不牵连）。
  const signal = new AbortController().signal;
  try {
    await sc.prompt(
      {
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
      },
      signal,
    );
  } catch (err) {
    const code = typeof err?.code === 'string' ? err.code : undefined;
    return {
      ok: false,
      stage: 'prompt',
      reason: 'prompt-failed',
      message: `${code === undefined ? '' : `${code}: `}${err?.message ?? String(err)}`,
      sessionId,
    };
  }
  return { ok: true, sessionId, promptChars: prompt.length };
}

/**
 * 这条事件是不是"派给本实例某个总管会话"的派发记录？
 * 不是就返回 null；是就返回提炼后的候选信息。
 *
 * 注意 `peer_instance` 是**目标**实例（recordDispatch 的第二个参数），不是派发方。
 */
function matchDispatcherDispatch(event, { sessionId, instanceId }) {
  if (event?.kind !== 'task.dispatched') return null;
  const payload = payloadOf(event);
  // 没送到就没有回执窗口，也就轮不到总管"代签回执"；这种派发由派发方自己收尾。
  if (payload.delivered !== true) return null;
  if (payload.peer_session !== sessionId) return null;
  // 别的实例的总管不归我处理（同一块板上可能配了多个实例的总管）
  if (instanceId !== 'unknown' && payload.peer_instance !== instanceId) return null;
  const taskId = event.task_id;
  if (typeof taskId !== 'string' || taskId.length === 0) return null;
  return { taskId, payload };
}

/**
 * 处理一轮总管分流（**单次扫描，不启动定时器**，方便测试直接调）。
 *
 * 每个总管会话各自一条游标，互不影响。对每条候选派发：
 *   落 intent 事件 → **推进游标（去重提交点）** → 建会话 → 投任务书 → 落 spawned 事件 → 代签 ack
 * 任何一步失败：落 failed 事件、不 ack，保持 pending 让它超时。
 *
 * @param {object} deps
 * @param {object} deps.board - 板（Board 或 RemoteBoard）
 * @param {object} deps.ctx - 宿主上下文（要 sessionController）
 * @param {string} [deps.instanceId] - 本实例 id
 * @param {string[]} [deps.sessions] - dispatcherSessions
 * @param {string} [deps.cwd] - dispatcherCwd
 * @param {string} [deps.agentPreset] - dispatcherAgentPreset
 * @param {number} [deps.eventBatch]
 * @param {number} [deps.maxPages]
 * @returns {Promise<{scanned:number, spawned:Array, failed:Array, skipped:Array, error?:string}>}
 */
export async function serviceDispatchRequests(deps = {}) {
  const { board, ctx } = deps;
  const sessions = normalizeDispatcherSessions(deps.sessions);
  const result = { scanned: 0, spawned: [], failed: [], skipped: [] };
  if (sessions.length === 0) return result;
  if (typeof board?.pendingEvents !== 'function') {
    result.error = '板不支持 pendingEvents，总管分流不可用';
    return result;
  }
  const instanceId = typeof deps.instanceId === 'string' && deps.instanceId.length > 0
    ? deps.instanceId
    : 'unknown';
  const eventBatch = clampInt(deps.eventBatch, 1, 100, DEFAULT_EVENT_BATCH);
  const maxPages = clampInt(deps.maxPages, 1, 20, DEFAULT_MAX_PAGES);

  try {
    for (const sessionId of sessions) {
      const cursorKey = dispatcherCursorKey(sessionId);
      let since;
      try {
        since = Number(await board.getCursor(instanceId, cursorKey));
      } catch {
        since = 0;
      }
      if (!Number.isFinite(since)) since = 0;

      for (let page = 0; page < maxPages; page += 1) {
        let got;
        try {
          got = await board.pendingEvents(instanceId, cursorKey, eventBatch, since);
        } catch (err) {
          result.error = `读板失败：${err?.message ?? String(err)}`;
          return result;
        }
        const events = Array.isArray(got?.events) ? got.events : [];
        if (events.length === 0) break;

        for (const event of events) {
          result.scanned += 1;
          const seq = Number(event.seq);
          if (!Number.isFinite(seq)) continue;
          const hit = matchDispatcherDispatch(event, { sessionId, instanceId });
          if (hit === null) {
            since = Math.max(since, seq);
            continue;
          }

          // ── 去重提交点：先把游标推过这条派发，再谈建会话 ──
          // 板写失败就这一轮什么都不做（下一轮重新看到它），绝不在"没记上"的情况下 spawn。
          try {
            await board.advanceCursor(instanceId, cursorKey, seq);
          } catch (err) {
            result.skipped.push({ taskId: hit.taskId, sessionId, reason: 'cursor-advance-failed' });
            result.error = `推进总管游标失败：${err?.message ?? String(err)}`;
            return result;
          }
          since = Math.max(since, seq);
          const outcome = await handleOneDispatch({
            board,
            ctx,
            instanceId,
            sessionId,
            taskId: hit.taskId,
            payload: hit.payload,
            seq,
            cwd: deps.cwd,
            agentPreset: deps.agentPreset,
          });
          if (outcome.spawned !== undefined) result.spawned.push(outcome.spawned);
          if (outcome.failed !== undefined) result.failed.push(outcome.failed);
          if (outcome.skipped !== undefined) result.skipped.push(outcome.skipped);
        }

        // 本页里非候选事件也"看过"了：把游标推到本页扫到的最大 seq。
        // 失败不算错（下一轮重扫这些事件，非候选事件是幂等的），但不能因此中断。
        try {
          const lastSeq = Number(events[events.length - 1].seq);
          if (Number.isFinite(lastSeq) && lastSeq > since) {
            await board.advanceCursor(instanceId, cursorKey, lastSeq);
            since = lastSeq;
          }
        } catch {
          /* 下一轮重扫即可 */
        }
        if (events.length < eventBatch) break;
      }
    }
  } catch (err) {
    result.error = err?.message ?? String(err);
  }
  return result;
}

/**
 * 处理一条已经"提交"（游标已越过）的派发。
 * 只返回三种结果之一：spawned / failed / skipped，便于测试与统计。
 */
async function handleOneDispatch(opts) {
  const { board, ctx, sessionId, taskId, payload, seq } = opts;
  const actor = sessionId; // 代签回执用总管身份
  const identity = {
    dispatch_seq: seq,
    task_id: taskId,
    peer_instance: payload.peer_instance,
    peer_session: payload.peer_session,
    ack_deadline_at: payload.ack_deadline_at ?? null,
  };

  let task = null;
  try {
    task = await board.getTask(taskId);
  } catch {
    task = null;
  }
  if (task === null) {
    await appendAudit(board, DISPATCHER_EVENT_KINDS.skipped, taskId, actor, {
      ...identity,
      reason: 'task-not-found',
    });
    return { skipped: { taskId, sessionId, reason: 'task-not-found' } };
  }
  if (task.lifecycle === 'done' || task.lifecycle === 'canceled') {
    await appendAudit(board, DISPATCHER_EVENT_KINDS.skipped, taskId, actor, {
      ...identity,
      reason: 'task-closed',
      lifecycle: task.lifecycle,
    });
    return { skipped: { taskId, sessionId, reason: 'task-closed' } };
  }
  // 已经没有待回执的派发（已 ack / 已超时）：不归总管，不 spawn。
  if (task.ack_state !== 'pending') {
    return { skipped: { taskId, sessionId, reason: `ack-${task.ack_state}` } };
  }
  // 已经有人接手：不再建第二个子会话（同一任务双开工只会互相抢租约），只代签回执。
  if (typeof task.owner_session === 'string' && task.owner_session.length > 0) {
    let acked = false;
    try {
      acked = (await board.ackTask(taskId, actor))?.acked === true;
    } catch {
      acked = false;
    }
    await appendAudit(board, DISPATCHER_EVENT_KINDS.skipped, taskId, actor, {
      ...identity,
      reason: 'task-already-owned',
      owner_session: task.owner_session,
      acked,
    });
    return { skipped: { taskId, sessionId, reason: 'task-already-owned' } };
  }

  // ① 先落"我要处理这条派发"的意图（本机板可写时）。崩在建会话中间时能看出处理到哪一步。
  await appendAudit(board, DISPATCHER_EVENT_KINDS.intent, taskId, actor, identity);

  // ② 建会话 + 投任务书。失败就如实落事件、**不 ack**。
  const spawned = await spawnDispatcherChild({
    ctx,
    task,
    dispatcherSession: sessionId,
    fromInstance: payload.peer_instance,
    cwd: opts.cwd,
    agentPreset: opts.agentPreset,
  });
  if (spawned.ok !== true) {
    await appendAudit(board, DISPATCHER_EVENT_KINDS.failed, taskId, actor, {
      ...identity,
      stage: spawned.stage,
      reason: spawned.reason,
      message: spawned.message,
      ...(spawned.sessionId === undefined ? {} : { child_session: spawned.sessionId }),
    });
    return {
      failed: {
        taskId,
        sessionId,
        stage: spawned.stage,
        reason: spawned.reason,
        message: spawned.message,
        ...(spawned.sessionId === undefined ? {} : { childSessionId: spawned.sessionId }),
      },
    };
  }

  // ③ 会话真的建出来了：落 spawned 事件（含子会话 id，出问题时能顺着查），然后代签回执。
  await appendAudit(board, DISPATCHER_EVENT_KINDS.spawned, taskId, actor, {
    ...identity,
    child_session: spawned.sessionId,
    prompt_chars: spawned.promptChars,
  });

  let ack = null;
  let ackError = null;
  try {
    ack = await board.ackTask(taskId, actor);
  } catch (err) {
    ackError = err?.message ?? String(err);
  }
  if (ackError !== null) {
    // 会话已经建出来、活也交代了；但回执没签上（多半已超时）。如实记，不假装成功。
    await appendAudit(board, DISPATCHER_EVENT_KINDS.ackFailed, taskId, actor, {
      ...identity,
      child_session: spawned.sessionId,
      error: ackError,
    });
    return {
      failed: {
        taskId,
        sessionId,
        stage: 'ack',
        reason: 'ack-failed',
        message: ackError,
        childSessionId: spawned.sessionId,
      },
    };
  }
  return {
    spawned: {
      taskId,
      sessionId,
      childSessionId: spawned.sessionId,
      acked: ack?.acked === true,
      deduped: ack?.deduped === true,
    },
  };
}

/**
 * 启动总管分流的定时轮询（disposer 里会清掉定时器）。
 *
 * 为什么用定时器而不是挂 `agent/pre-step`：总管会话可能一整天都不跑一轮，
 * 而派发随时会来；轮询是唯一不依赖"某个会话刚好在动"的做法（与建会话服务的定时器同思路）。
 * 重叠保护：上一轮还没回来就不开新的一轮，避免同一批事件被两个回合同时处理。
 *
 * @param {object} deps - 同 serviceDispatchRequests，另加 pollMs / logger
 * @returns {{pollMs:number, serviceOnce:()=>Promise<object|null>, dispose:()=>void}}
 */
export function startDispatcher(deps = {}) {
  const pollMs = clampInt(deps.pollMs, 250, 60_000, DEFAULT_DISPATCHER_POLL_MS);
  const logger = deps.logger ?? deps.ctx?.logger;
  let disposed = false;
  let running = false;

  const serviceOnce = async () => {
    if (disposed) return null;
    if (running) return null;
    running = true;
    try {
      const got = await serviceDispatchRequests(deps);
      if (got?.error !== undefined) {
        try {
          logger?.warn?.(`[dsh-team-mesh] 总管分流本轮未完成：${got.error}`);
        } catch {
          /* 日志写不了就算了 */
        }
      }
      return got;
    } catch (err) {
      try {
        logger?.warn?.(`[dsh-team-mesh] 总管分流异常：${err?.message ?? err}`);
      } catch {
        /* ignore */
      }
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

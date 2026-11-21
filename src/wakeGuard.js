/**
 * wakeGuard.js — 0.6：入站唤醒限速（四道闸）。
 *
 * 动机（调研报告里的真实事故）：我们只限了**派发方**的重派次数（maxRedispatch），
 * 没限**接收方**被反复唤醒。peng456 实测过 2.5 小时 / 54 个会话 / 800 万 token 的循环。
 *
 * 四道闸（全部默认关闭/零值 = **不改变现有行为**）：
 *   1. `wakeNoWake`（默认 false）      → 命中 `WAKE_SILENT`：完全不唤醒，只落审计事件；
 *   2. `wakeMinTaskChars`（默认 0）    → 命中 `WAKE_TOO_SHORT`：任务正文太短（寒暄/空壳）不唤醒；
 *   3. `wakeThreadCooldownMs`（默认 0）→ 命中 `WAKE_COOLDOWN`：同一目标冷却期内不再唤醒；
 *   4. `wakeMaxPerThread`（默认 0）    → 命中 `WAKE_LIMIT`：同一目标累计唤醒次数超上限。
 *
 * 计数与时间戳只存在**进程内表**里：不新增 schema 字段、不改 schema_version、不做迁移。
 * 代价是插件重启后计数清零 —— 这与"唤醒是即时风险、重启后重新计数可接受"的取舍一致，
 * 已写进 README 的已知限制。
 *
 * 闸门顺序固定为：SILENT → TOO_SHORT → COOLDOWN → LIMIT。
 * 为什么 SILENT 排第一：它是运维显式的"这条链路别唤醒"总开关，不该被别的闸的措辞盖住。
 *
 * 边界：`newSession` 派发没有"既有 thread"（会话还没建出来），冷却/上限两道闸不适用；
 * `WAKE_SILENT` 与 `WAKE_TOO_SHORT` 仍然生效 —— 它们在投递/建会话之前就能判定。
 */

/** 稳定拒绝码（进事件 payload 与返回文本，模型可据此分流）。 */
export const WAKE_GUARD_CODES = Object.freeze({
  tooShort: 'WAKE_TOO_SHORT',
  cooldown: 'WAKE_COOLDOWN',
  limit: 'WAKE_LIMIT',
  silent: 'WAKE_SILENT',
});

/** 审计事件名（`模块.动作`，与 task.* / lease.* / dispatcher.* 同一风格）。 */
export const DISPATCH_SUPPRESSED_EVENT = 'dispatch.suppressed';

/** 默认配置：全部"不改变现有行为"。 */
export const WAKE_GUARD_DEFAULTS = Object.freeze({
  wakeGuard: false,
  wakeMinTaskChars: 0,
  wakeThreadCooldownMs: 0,
  wakeMaxPerThread: 0,
  wakeNoWake: false,
});

/** 上限只做防呆：配置写错不该让派发入口抛错。 */
const MAX_MIN_TASK_CHARS = 100_000;
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1_000;
const MAX_PER_THREAD = 10_000;

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/**
 * 把外部配置规整成内部结构。非对象/缺字段/写错类型都退回默认值 ——
 * 配置错误只该"这道闸不生效"，不该让 mesh_dispatch 起不来。
 *
 * @param {unknown} raw
 * @returns {{wakeGuard:boolean, wakeMinTaskChars:number, wakeThreadCooldownMs:number,
 *            wakeMaxPerThread:number, wakeNoWake:boolean}}
 */
export function normalizeWakeConfig(raw) {
  const cfg = raw !== null && typeof raw === 'object' ? raw : {};
  return {
    wakeGuard: cfg.wakeGuard === true,
    wakeMinTaskChars: clampInt(cfg.wakeMinTaskChars, 0, MAX_MIN_TASK_CHARS, 0),
    wakeThreadCooldownMs: clampInt(cfg.wakeThreadCooldownMs, 0, MAX_COOLDOWN_MS, 0),
    wakeMaxPerThread: clampInt(cfg.wakeMaxPerThread, 0, MAX_PER_THREAD, 0),
    wakeNoWake: cfg.wakeNoWake === true,
  };
}

/** 进程内表的键：目标实例 + 目标会话（"thread" 的最小可用定义）。 */
export function threadKey(instanceId, sessionId) {
  return `${String(instanceId ?? '')}\u0000${String(sessionId ?? '')}`;
}

/**
 * 任务正文长度：只数**任务内容**（title + brief + acceptance），不数任务卡的固定模板文字。
 *
 * 为什么不用 `formatTaskCard()` 的长度：模板本身就有 ~200 字，
 * 一条标题"在吗"的空壳任务也会被判成 200+ 字，minTaskChars 就完全失去意义。
 */
export function taskTextChars(task) {
  let total = 0;
  for (const field of [task?.title, task?.brief, task?.acceptance]) {
    if (typeof field === 'string') total += field.trim().length;
  }
  return total;
}

/**
 * 进程内唤醒账本：`threadKey → {lastWakeAt, count}`。
 * 只有**真的投递成功**的派发才会 `note()`，没送到的派发不算唤醒。
 */
export function createWakeLedger() {
  const entries = new Map();
  return {
    note(instanceId, sessionId, now = Date.now()) {
      if (!Number.isFinite(now)) return false;
      const key = threadKey(instanceId, sessionId);
      const prev = entries.get(key);
      entries.set(key, { lastWakeAt: now, count: prev === undefined ? 1 : prev.count + 1 });
      return true;
    },
    get(instanceId, sessionId) {
      return entries.get(threadKey(instanceId, sessionId)) ?? null;
    },
    get size() {
      return entries.size;
    },
    clear() {
      entries.clear();
    },
  };
}

/**
 * 依次过四道闸。返回 `null` 表示放行；否则返回命中信息（含稳定码与可读原因）。
 *
 * @param {object} input
 * @param {object} input.task - 板上的任务行（读 title/brief/acceptance）
 * @param {string} input.instanceId - 目标实例
 * @param {string|null} input.sessionId - 目标会话；`newSession` 派发传 null/undefined
 * @param {number} [input.now]
 * @param {object} input.config - {@link normalizeWakeConfig} 的结果
 * @param {object} input.ledger - {@link createWakeLedger} 的实例
 * @param {boolean} [input.newSession] - 新建会话派发：冷却/上限闸不适用
 * @returns {null | {code:string, reason:string, chars:number, [k:string]:unknown}}
 */
export function evaluateWakeGate(input) {
  const config = input?.config ?? WAKE_GUARD_DEFAULTS;
  if (config.wakeGuard !== true) return null; // 默认关：与 0.5 完全一致
  const chars = taskTextChars(input?.task);

  // ① SILENT：显式"静默只落板"
  if (config.wakeNoWake === true) {
    return {
      code: WAKE_GUARD_CODES.silent,
      reason: 'wakeNoWake=true：本实例不唤醒任何接收方，只落审计事件',
      chars,
    };
  }

  // ② TOO_SHORT：正文太短（寒暄 / 空壳任务）
  if (config.wakeMinTaskChars > 0 && chars < config.wakeMinTaskChars) {
    return {
      code: WAKE_GUARD_CODES.tooShort,
      reason: `任务正文 ${chars} 字 < wakeMinTaskChars=${config.wakeMinTaskChars}，不唤醒`,
      chars,
      min_chars: config.wakeMinTaskChars,
    };
  }

  // 没有既有 thread（newSession）时，后两道闸没有判定对象
  if (input?.newSession === true) return null;
  const instanceId = input?.instanceId;
  const sessionId = input?.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  const entry = input?.ledger?.get?.(instanceId, sessionId) ?? null;
  const now = Number.isFinite(input?.now) ? Number(input.now) : Date.now();

  // ③ COOLDOWN：同一目标冷却期内不再唤醒
  if (config.wakeThreadCooldownMs > 0 && entry !== null) {
    const elapsed = now - entry.lastWakeAt;
    if (elapsed >= 0 && elapsed < config.wakeThreadCooldownMs) {
      return {
        code: WAKE_GUARD_CODES.cooldown,
        reason: `距上次唤醒仅 ${elapsed}ms，冷却期 ${config.wakeThreadCooldownMs}ms 未过（还剩 ${config.wakeThreadCooldownMs - elapsed}ms）`,
        chars,
        remaining_ms: config.wakeThreadCooldownMs - elapsed,
        last_wake_at: entry.lastWakeAt,
      };
    }
  }

  // ④ LIMIT：同一目标累计唤醒次数到顶
  if (config.wakeMaxPerThread > 0 && entry !== null && entry.count >= config.wakeMaxPerThread) {
    return {
      code: WAKE_GUARD_CODES.limit,
      reason: `该目标已累计唤醒 ${entry.count} 次，达到 wakeMaxPerThread=${config.wakeMaxPerThread}`,
      chars,
      wake_count: entry.count,
      max_wakes: config.wakeMaxPerThread,
    };
  }
  return null;
}

/** 命中闸门后给模型的稳定回执文本（不投递、不建会话、不开 ack 窗口）。 */
export function renderSuppressedText(hit) {
  const hints = {
    [WAKE_GUARD_CODES.silent]:
      '这是本实例的显式静默开关（wakeNoWake）。要恢复唤醒，改配置或由运维处理 —— 重试本调用不会有效果。',
    [WAKE_GUARD_CODES.tooShort]:
      '把任务写具体（补 brief / acceptance），或由运维调低 wakeMinTaskChars。空壳任务不该花对方模型额度。',
    [WAKE_GUARD_CODES.cooldown]:
      '目标会话刚被唤醒过。等冷却期过去再派，或由运维调整 wakeThreadCooldownMs；不要原样重试。',
    [WAKE_GUARD_CODES.limit]:
      '这个目标在本进程内的唤醒次数已到上限。换目标会话、或由运维提高 wakeMaxPerThread；不要原样重试。',
  };
  return hints[hit?.code] ?? '按命中原因处理；不要原样重试。';
}

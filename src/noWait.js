/**
 * noWait.js — 0.7「禁等待守卫」：持有 mesh 任务的会话不许用长等待把墙钟烧掉。
 *
 * 为什么需要它（跨机派活的真实失败模式）：派出去的子会话常见写法是
 * `sleep 60` / 前台 `timeoutMs: 600000` / `job_output { wait: true, timeout_ms: 60000 }`。
 * 一次派活就白占 1~10 分钟，期间它还握着租约；发起方看到的只是"没动静"。
 * 官方 Agent Teams 的提示词用"长命令放后台、别轮询"来约束；本插件把这句**变成守卫**，
 * 因为跨机子会话不一定读到提示词。
 *
 * 作用面刻意保守：默认只作用于**正在持有 mesh 任务的会话**（`applyTo: 'mesh-workers'`），
 * 主人的普通长命令不受影响。`applyTo: 'all'` 才全局生效，`'off'` 完全关闭。
 *
 * 用的是宿主真实 API `ctx.tools.guard(fn)`（app.asar 的 dsh-tools：guard 在
 * pre-execute policy 之后对**每次工具调用**执行，返回字符串即拒绝，返回 undefined 放行）。
 * 宿主没有这个 API 时**降级为不装守卫**：这个功能再重要也不能让插件装载失败。
 */
import { sessionIdOf } from './session.js';

export const NO_WAIT_MODES = ['mesh-workers', 'all', 'off'];
/** 默认值：只作用于 mesh worker —— 保守值，宁可少拦也别误伤主人的长命令。 */
export const DEFAULT_NO_WAIT_MODE = 'mesh-workers';
/** 前台命令允许的最长 timeoutMs：超过就要求放后台。 */
export const FOREGROUND_TIMEOUT_LIMIT_MS = 30_000;
/** job_output 单次等待允许的最长毫秒数。 */
export const JOB_WAIT_LIMIT_MS = 5_000;
/** 宿主 job_output 的缺省等待（wait:true 不传 timeout_ms 时生效，30s > 5s 上限）。 */
const HOST_DEFAULT_JOB_WAIT_MS = 30_000;
/** 这些工具的 command 参数里出现 sleep 就拒绝（bash / pwsh 及其持久化变体）。 */
const COMMAND_TOOLS = new Set(['bash', 'pwsh', 'bash_persistent', 'pwsh_persistent']);

/**
 * 规整 `noWaitGuard` 配置：未设 → mesh-workers；只认三种取值；拼错按默认值并 WARN。
 * 配置笔误不该把插件打挂，但也不能静默当成"关"。
 * @param {unknown} raw
 * @param {{warn?:Function}|null} [logger]
 * @returns {'mesh-workers'|'all'|'off'}
 */
export function normalizeNoWaitMode(raw, logger) {
  if (raw === undefined || raw === null) return DEFAULT_NO_WAIT_MODE;
  const value = String(raw).trim().toLowerCase();
  if (value === '') return DEFAULT_NO_WAIT_MODE;
  if (NO_WAIT_MODES.includes(value)) return value;
  try {
    logger?.warn?.(
      `[dsh-team-mesh] noWaitGuard 取值 ${JSON.stringify(raw)} 不合法（只认 mesh-workers / all / off），` +
        `已按 ${DEFAULT_NO_WAIT_MODE} 处理 —— 检查是不是拼写错误`,
    );
  } catch {
    /* 日志不可用不影响守卫配置 */
  }
  return DEFAULT_NO_WAIT_MODE;
}

/**
 * 判一次工具调用该不该被拒。纯函数（不碰 ctx / 时钟），单测直接喂参数。
 * @param {string} toolName
 * @param {object|null|undefined} args
 * @returns {string|null} 拒绝原因（给人看）；null 表示放行。
 */
export function evaluateNoWaitCall(toolName, args) {
  const name = String(toolName ?? '');
  const a = args !== null && typeof args === 'object' ? args : {};

  if (COMMAND_TOOLS.has(name)) {
    const command = typeof a.command === 'string' ? a.command : '';
    // \b 对 `Start-Sleep` / `sleep 60` / `sleep(5)` 都能命中；不做语义解析（命令是任意 shell）
    if (/\bsleep\b/i.test(command)) {
      return (
        `[noWait] 拒绝：命令里包含 sleep（${name}）。你正在持有 mesh 任务，等待会把租约和发起方的等待一起拖长。\n` +
        '改法：把要等的事变成「短命令 + 后台任务」—— 长命令用 run_in_background=true，再用 job_output { wait: true, timeout_ms ≤ 5000 } 短轮询；' +
        '需要证明自己还活着就 mesh_task_heartbeat。'
      );
    }
    const background = a.run_in_background === true;
    const rawTimeout = a.timeoutMs ?? a.timeout_ms;
    const timeoutMs = rawTimeout === undefined || rawTimeout === null ? null : Number(rawTimeout);
    if (background !== true && timeoutMs !== null && Number.isFinite(timeoutMs) && timeoutMs > FOREGROUND_TIMEOUT_LIMIT_MS) {
      return (
        `[noWait] 拒绝：前台命令 timeoutMs=${timeoutMs} 超过 ${FOREGROUND_TIMEOUT_LIMIT_MS}。` +
        '长命令请用 run_in_background=true 起后台任务，别在前台等；' +
        '命令本身不长的，把 timeoutMs 调小。'
      );
    }
    return null;
  }

  if (name === 'job_output' && a.wait === true) {
    const raw = a.timeout_ms;
    const effective = raw === undefined || raw === null ? HOST_DEFAULT_JOB_WAIT_MS : Number(raw);
    if (!Number.isFinite(effective) || effective > JOB_WAIT_LIMIT_MS) {
      return (
        `[noWait] 拒绝：job_output wait 的有效等待 ${Number.isFinite(effective) ? `${effective}ms` : String(raw)} ` +
        `超过 ${JOB_WAIT_LIMIT_MS}。请传 timeout_ms: ${JOB_WAIT_LIMIT_MS}（或更小），没结果就先去干别的；` +
        '任务是否还活着用 mesh_task_heartbeat 声明，不要靠长 wait 占着。'
      );
    }
  }
  return null;
}

/**
 * 进程内登记表：哪些会话正持有 mesh 任务（会话 → 任务 id 集合）。
 *
 * 为什么用内存登记而不是每次查板：guard 必须是**同步**的（宿主调用链同步），
 * 而远端板查询是异步的。登记表由 handlers 在 claim/adopt 成功时写、complete/cancel 时删，
 * 只影响"守卫是否启用"，不影响任何任务语义 —— 重启后为空，等价于"暂时不拦"，是安全方向。
 * 已知边界（README 同）：别的实例认领/收养走不到本进程，本表不会自动回收。
 */
export function createWorkerRegistry() {
  const owned = new Map();
  const setOf = (sessionId) => {
    let set = owned.get(sessionId);
    if (set === undefined) {
      set = new Set();
      owned.set(sessionId, set);
    }
    return set;
  };
  return {
    /** 记下"该会话持有这个任务"（重复调用幂等）。 */
    mark(sessionId, taskId) {
      setOf(String(sessionId)).add(String(taskId));
    },
    /** 不再持有（完成/取消/明确放弃）。 */
    release(sessionId, taskId) {
      const set = owned.get(String(sessionId));
      if (set === undefined) return;
      set.delete(String(taskId));
      if (set.size === 0) owned.delete(String(sessionId));
    },
    /** 该会话当前是否持有至少一个 mesh 任务。 */
    has(sessionId) {
      const set = owned.get(String(sessionId));
      return set !== undefined && set.size > 0;
    },
    /** 排障用：当前登记的会话数。 */
    get size() {
      return owned.size;
    },
  };
}

/**
 * 装守卫。返回 disposer。
 *
 * @param {{ctx:object, mode:'mesh-workers'|'all'|'off', isMeshWorker?:(sessionId:string)=>boolean,
 *          logger?:object}} opts
 * @returns {() => void}
 */
export function installNoWaitGuard({ ctx, mode, isMeshWorker, logger }) {
  if (mode === 'off') return () => {};
  const tools = ctx?.tools;
  if (tools === null || tools === undefined || typeof tools.guard !== 'function') {
    // 宿主版本没有 guard（或服务未就绪）：**不装、不抛**，只留一条 WARN 说明能力缺失。
    try {
      logger?.warn?.('[dsh-team-mesh] 宿主没有 ctx.tools.guard()，noWait 禁等待守卫未启用（其它功能不受影响）');
    } catch {
      /* ignore */
    }
    return () => {};
  }
  const guard = (exec) => {
    try {
      if (mode === 'mesh-workers') {
        const sessionId = sessionIdOf(exec);
        if (typeof isMeshWorker !== 'function' || isMeshWorker(sessionId) !== true) return undefined;
      }
      const reason = evaluateNoWaitCall(exec?.name, exec?.arguments);
      return reason === null ? undefined : reason;
    } catch {
      // 守卫自身抛错会被宿主当成拒绝或更糟 —— 一律放行并保持静默（守卫不是安全边界）
      return undefined;
    }
  };
  const dispose = tools.guard(guard);
  return typeof dispose === 'function' ? dispose : () => {};
}

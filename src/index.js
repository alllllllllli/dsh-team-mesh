/**
 * index.js — DSH 插件入口。**只做装配**：解析依赖 → 开板 → 注册工具 → 订阅事件 → 返回 disposer。
 *
 * 两条来自真实事故的硬约束：
 *
 * 1. **apply 绝不能让应用起不来。** 插件坏了最坏是"这个插件不可用"，
 *    不该是"应用打不开"。所以这里整段 try/catch，失败时记日志并返回空 disposer；
 *    排查期把 `DSH_TEAM_DEBUG=1` 打开可以把错误抛出来（否则"插件静默不工作"极难查）。
 *
 *    0.5 起：**失败必须可发现**。吞异常的同时会在板库同目录写一份 `mesh-load-error.json`
 *    （含时间 / 版本 / 板地址 / 错误 message+stack 前 2000 字符 / 排查提示），日志里带上它的路径；
 *    装载成功会删掉上次遗留的这份文件。`DSH_TEAM_STRICT=1` 时改为**把异常抛出去**，
 *    让 DSH 启动失败 —— 运维至少看得见（默认仍是"插件坏了不拖垮宿主"）。
 *
 * 2. **disposers 必须最先声明。** 迟声明会撞上 const 的暂时性死区，抛 ReferenceError，
 *    又被自己的 catch 吞掉 —— 工具注册成功了、解绑函数却从来没登记，卸载时不会释放。
 *
 * 依赖解析沿用 dsh-video-storyboard 的做法：先裸包名 import，失败再看 `DSH_TOOLS_PATH`，
 * 这样本地开发和正式安装都能跑。
 */

import fs from 'node:fs';
import path from 'node:path';

import { serviceSessionRequests } from './createSession.js';
import { DEFAULT_DISPATCHER_POLL_MS, normalizeDispatcherSessions, startDispatcher } from './dispatcher.js';
import { createHandlers } from './handlers.js';
import { installInboxHook } from './inboxHook.js';
import { createDispatchRegistry, DEFAULT_REDISPATCH_POLL_MS, startLifecycle } from './lifecycle.js';
import { createWorkerRegistry, installNoWaitGuard, normalizeNoWaitMode } from './noWait.js';
import { RemoteBoard } from './remote.js';
import { allSpecs, TOOL_NAMES } from './spec.js';
import { defaultBoardPath, openBoard } from './store.js';

export const name = 'dsh-team-mesh';
/**
 * 依赖声明。
 *
 * `tools` 是硬依赖：没有注册表就没法注册工具。
 * `interconnect` 也**必须**写在这里——它是 cordis 的 Service（`ctx.interconnect`），
 * 不声明注入的话，`apply()` 执行时它可能还没挂到 ctx 上，`ctx.interconnect` 就读成 undefined。
 *
 * 这个 bug 是在真实宿主里抓到的：`peer.event` 事件能收到（说明 interconnect 明明在跑），
 * 但 `mesh_peers` 报"本实例上没有 interconnect 服务"。差别在于——订阅事件走 ctx.on，
 * 不要求注入；读 Service 要求注入。两者表现不一致，正好把它暴露出来。
 *
 * 声明注入不等于硬依赖：服务不存在时 apply 仍会被调用，只是 `ctx.interconnect` 为 undefined，
 * handler 已按"可选"处理（返回"跨实例派活不可用"，共享板照常能用）。
 */
export const inject = ['tools', 'interconnect'];

export const PLUGIN_VERSION = '0.7.0';

async function loadDefineTool() {
  try {
    const mod = await import('@deepseek-ai/dsh-tools');
    if (typeof mod?.defineTool === 'function') return mod.defineTool;
  } catch {
    /* 落到下面的环境变量 */
  }
  const override = process.env.DSH_TOOLS_PATH;
  if (override) {
    const { pathToFileURL } = await import('node:url');
    const mod = await import(pathToFileURL(override).href);
    if (typeof mod?.defineTool === 'function') return mod.defineTool;
  }
  throw new Error('无法解析 @deepseek-ai/dsh-tools（本地开发请设置 DSH_TOOLS_PATH 指向它的 lib/index.js）');
}

/**
 * 造一个 `interconnect/event` 监听器：把对端事件记进审计流。
 *
 * 两条硬约束，都是真实事故换来的：
 *
 * 1. **远端板不参与写入。** 远端板上的审计事件由板服务在操作内部生成，
 *    客户端写会被直接拒绝（`REMOTE_AUDIT_READONLY`）。
 * 2. **rejection 必须自己接住。** `RemoteBoard.appendEvent` 是 async，
 *    同步 try/catch 接不住它返回的 rejected promise；漏出去的未处理拒绝会被
 *    cordis 的并行派发当成致命错误，直接打死 host 进程（`fatal load failure`）。
 *
 * @param {{ctx: object, board: object}} opts
 * @returns {(notification: unknown, peer: unknown) => void}
 */
export function createPeerEventRecorder({ ctx, board }) {
  const warn = (err) => {
    try {
      ctx?.logger?.warn?.(`[dsh-team-mesh] 记录对端事件失败：${err?.message ?? err}`);
    } catch {
      /* 连日志都写不了就算了，绝不能再抛 */
    }
  };
  return (notification, peer) => {
    // 远端板的审计由板服务生成，客户端不参与
    if (board?.isRemote === true) return;
    try {
      Promise.resolve(
        board.appendEvent('peer.event', null, typeof peer === 'string' ? peer : 'unknown', notification),
      ).catch(warn);
    } catch (err) {
      warn(err);
    }
  };
}

/** 可选服务：interconnect 未启用时返回 null，而不是抛错。 */
function interconnectOf(ctx) {
  try {
    const svc = ctx?.interconnect;
    return svc ?? null;
  } catch {
    return null;
  }
}

/** 加载失败诊断文件名（写在板库同目录，`$DSH_HOME/team/` 是它的默认落点）。 */
export const LOAD_ERROR_FILENAME = 'mesh-load-error.json';

/**
 * 降级诊断文件名（0.6.1）：远端板连不上、但已被本地板接住时写。
 *
 * 与 `mesh-load-error.json` **同目录**：这两个文件是同一件事的两种结局（失败 / 降级），
 * 运维只需要知道一处位置，不必记两套规则。
 */
export const DEGRADED_FILENAME = 'mesh-degraded.json';

/** 诊断文件里 stack 只留前 2000 字符：够定位，又不至于把文件撑成日志。 */
const LOAD_ERROR_STACK_LIMIT = 2000;

/** 降级诊断里错误摘要的截断长度：够看出原因，又不至于把文件撑成日志。 */
const DEGRADED_REASON_LIMIT = 300;

/**
 * 诊断文件路径。**与板库同目录**：
 *   - 单机模式且配了 `boardPath` → 那个库所在目录；
 *   - 其余（远端板 / 没配）→ 与 `defaultBoardPath()` 同源的 `$DSH_HOME/team/`。
 * 绝不硬编码某个用户的绝对路径：板库换位置时诊断文件跟着走，运维只需要知道一处。
 */
export function resolveLoadErrorPath(config = {}) {
  const endpoint = typeof config?.boardEndpoint === 'string' ? config.boardEndpoint.trim() : '';
  const configured = typeof config?.boardPath === 'string' ? config.boardPath.trim() : '';
  const boardPath = endpoint === '' && configured.length > 0 ? configured : defaultBoardPath();
  return path.join(path.dirname(boardPath), LOAD_ERROR_FILENAME);
}

/** 降级诊断文件路径：与 load-error 同一个目录（见 resolveLoadErrorPath 的注释）。 */
export function resolveDegradedPath(config = {}) {
  return path.join(path.dirname(resolveLoadErrorPath(config)), DEGRADED_FILENAME);
}

/**
 * 把加载失败落成可发现的文件。写文件本身失败只 warn —— **诊断失败绝不能盖住原始错误**。
 *
 * @returns {string|null} 真的写上了才返回路径
 */
function writeLoadError(config, err, ctx) {
  const file = resolveLoadErrorPath(config);
  const endpoint = typeof config?.boardEndpoint === 'string' && config.boardEndpoint.trim().length > 0
    ? config.boardEndpoint.trim()
    : null;
  const body = {
    time: new Date().toISOString(),
    version: PLUGIN_VERSION,
    boardEndpoint: endpoint,
    error: {
      message: String(err?.message ?? err),
      stack: String(err?.stack ?? '').slice(0, LOAD_ERROR_STACK_LIMIT),
    },
    hint: '设 DSH_TEAM_DEBUG=1 可让启动失败以暴露错误',
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    return file;
  } catch (writeErr) {
    try {
      ctx?.logger?.warn?.(`[dsh-team-mesh] 加载失败诊断文件写不上（${file}）：${writeErr?.message ?? writeErr}`);
    } catch {
      /* ignore */
    }
    return null;
  }
}

/** 装载成功：删掉上次遗留的诊断文件。删不掉不影响装载（它只是证据，不是状态）。 */
function clearLoadError(config, ctx) {
  const file = resolveLoadErrorPath(config);
  try {
    fs.rmSync(file, { force: true });
  } catch (err) {
    try {
      ctx?.logger?.warn?.(`[dsh-team-mesh] 旧诊断文件删不掉（${file}）：${err?.message ?? err}`);
    } catch {
      /* ignore */
    }
  }
}

/**
 * 把"远端板连不上、已用本地板接住"落成可发现的文件。
 *
 * 与 load-error 的区别是**结论不同**：这里插件是**可用**的（工具都注册了），
 * 只是板换了。所以字段也换成 `mode: 'local-degraded'` + `endpoint` + 错误摘要。
 * 写文件本身失败只 warn —— 诊断失败绝不能盖住"已经降级成功"这个事实。
 *
 * @returns {string|null} 真的写上了才返回路径
 */
function writeDegraded(config, body, ctx) {
  const file = resolveDegradedPath(config);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    return file;
  } catch (err) {
    try {
      ctx?.logger?.warn?.(`[dsh-team-mesh] 降级诊断文件写不上（${file}）：${err?.message ?? err}`);
    } catch {
      /* ignore */
    }
    return null;
  }
}

/**
 * 非降级装载成功：删掉上次遗留的降级诊断。
 * 它只对"这次也降级"有参考价值；远端已连上 / 回到单机时留着会误导排障。
 */
function clearDegraded(config, ctx) {
  const file = resolveDegradedPath(config);
  try {
    fs.rmSync(file, { force: true });
  } catch (err) {
    try {
      ctx?.logger?.warn?.(`[dsh-team-mesh] 旧降级诊断删不掉（${file}）：${err?.message ?? err}`);
    } catch {
      /* ignore */
    }
  }
}

/**
 * 后台探活发现远端恢复：把 `remote_available_again: true` 补进诊断文件。
 *
 * **只补证据，不热切换板**：本地板上已经有降级期间的数据，中途换后端会让两边状态打架。
 * 提示也明确写"重启 DSH 才切回"，避免运维以为插件会自己换回去。
 */
function markDegradedRecovered(file, body, ctx) {
  const next = {
    ...body,
    remote_available_again: true,
    remote_available_at: new Date().toISOString(),
    hint: '远端板已恢复；重启 DSH 可切回远端板（当前仍是本地降级板，插件不热切换）',
  };
  try {
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return true;
  } catch (err) {
    try {
      ctx?.logger?.warn?.(`[dsh-team-mesh] 恢复证据写不进诊断文件（${file}）：${err?.message ?? err}`);
    } catch {
      /* ignore */
    }
    return false;
  }
}

/** 开关值解析与板服务同一口径：1/true/yes/on 才算开（trim + 小写）。 */
const ENV_FLAG_TRUTHY = new Set(['1', 'true', 'yes', 'on']);
function envFlagEnabled(name) {
  const raw = process.env[name];
  return typeof raw === 'string' && ENV_FLAG_TRUTHY.has(raw.trim().toLowerCase());
}

/**
 * `boardFallback` 的默认值。**默认降级**是刻意的：远端板是外部依赖（网络 / 隧道 / 对端主机），
 * 它坏掉不该等于"本机插件不可用"——2026-11-21 那次事故就是整插件没加载、团队任务工具全消失。
 */
export const BOARD_FALLBACK_DEFAULT = 'local';

/** boardFallback 合法值：只认这两个。 */
const BOARD_FALLBACK_KEYS = new Set([BOARD_FALLBACK_DEFAULT, 'fail']);

/**
 * 规整 `boardFallback`：未设 → local；只认 local / fail；其他值按 local 并提示拼写错误。
 * 配置笔误不该把插件打挂，但也不能静默当对——所以留一条 WARN。
 *
 * @returns {'local'|'fail'}
 */
export function normalizeBoardFallback(raw, ctx) {
  if (raw === undefined || raw === null) return BOARD_FALLBACK_DEFAULT;
  const value = String(raw).trim().toLowerCase();
  if (value === '') return BOARD_FALLBACK_DEFAULT;
  if (BOARD_FALLBACK_KEYS.has(value)) return /** @type {'local'|'fail'} */ (value);
  try {
    ctx?.logger?.warn?.(
      `[dsh-team-mesh] boardFallback 取值 ${JSON.stringify(raw)} 不合法（只认 local / fail），` +
        `已按 ${BOARD_FALLBACK_DEFAULT} 处理 —— 检查是不是拼写错误`,
    );
  } catch {
    /* 日志不可用不影响降级 */
  }
  return BOARD_FALLBACK_DEFAULT;
}

/**
 * 连板失败的错误摘要：带稳定码、压成一行、限长。
 *
 * `token` 参数用于**脱敏**：正常错误路径不会带密钥，但"输出里绝不出现 token"是红线，
 * 这里做一次兜底替换，成本两行。
 */
function summarizeConnectError(err, token) {
  const code = typeof err?.code === 'string' && err.code.length > 0 ? `${err.code}: ` : '';
  let text = `${code}${String(err?.message ?? err)}`.replace(/\s+/g, ' ').trim();
  if (typeof token === 'string' && token.length > 0) text = text.split(token).join('***');
  return text.slice(0, DEGRADED_REASON_LIMIT);
}

/**
 * 打开本地板（单机模式与降级模式共用**同一条路径**）。
 * 建目录 / 建表 / 锁都交给 openBoard —— 这里不另造一套，避免降级路径与单机路径漂移。
 */
function openLocalBoard(config) {
  const boardPath = typeof config.boardPath === 'string' && config.boardPath.length > 0
    ? config.boardPath
    : defaultBoardPath();
  fs.mkdirSync(boardPath.replace(/[\\/][^\\/]+$/, ''), { recursive: true });
  return openBoard(boardPath);
}

/** 后台恢复探活：默认 30s 一次、短超时 2s（不阻塞、不热切换、同一状态只记一次）。 */
export const DEFAULT_RECOVERY_PROBE_MS = 30_000;
const RECOVERY_PROBE_TIMEOUT_MS = 2_000;

/**
 * 降级后的后台探活。
 *
 * 三条硬约束：
 *   1. **只探、不换**：发现远端恢复只写日志/诊断 + 提示重启，绝不把 board 换回远端
 *      （本地板上已有降级期间的数据，中途换后端两边状态会打架）。
 *   2. **同一状态只记一次**：失败不刷日志；成功记一条 `remote_available_again: true` 后**停表**。
 *   3. **不拖住进程**：定时器 `unref()`，dispose 时清掉。
 *
 * @returns {() => void} disposer
 */
function startRemoteRecoveryProbe({ probe, endpoint, config, ctx, degradedBody, degradedFile }) {
  const rawRetry = Number(config?.boardRetryMs);
  const retryMs = Number.isFinite(rawRetry) && rawRetry > 0 ? rawRetry : DEFAULT_RECOVERY_PROBE_MS;
  let stopped = false;
  let timer = null;

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      timer = null;
      if (stopped) return;
      let available = false;
      try {
        await probe.health();
        available = true;
      } catch {
        available = false;
      }
      if (stopped) return;
      if (available) {
        try {
          ctx?.logger?.info?.(
            `[dsh-team-mesh] 远端板已恢复可用（remote_available_again: true）：${endpoint}。` +
              '当前仍是本地降级板，重启 DSH 可切回远端（插件不热切换）。',
          );
        } catch {
          /* ignore */
        }
        if (degradedFile !== null) markDegradedRecovered(degradedFile, degradedBody, ctx);
        return; // 恢复后停表：板不会自动切回，再探没有意义
      }
      schedule();
    }, retryMs);
    if (typeof timer.unref === 'function') timer.unref();
  };
  schedule();

  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}

export async function apply(ctx, config = {}) {
  const disposers = [];
  try {
    const dispose = await registerAll(ctx, config, disposers);
    // 装载成功 = 上次那份失败诊断已过时，必须删掉，否则排障会被旧证据误导
    clearLoadError(config, ctx);
    return dispose;
  } catch (err) {
    const diagnosticPath = writeLoadError(config, err, ctx);
    try {
      ctx?.logger?.error?.(
        `[dsh-team-mesh] 加载失败：${err?.stack ?? err}` +
          `（诊断文件：${diagnosticPath ?? '写不上'}；设 DSH_TEAM_STRICT=1 可让启动失败以暴露错误）`,
      );
    } catch {
      /* 连日志都写不了就算了 */
    }
    if (process.env.DSH_TEAM_DEBUG || envFlagEnabled('DSH_TEAM_STRICT')) throw err;
    return () => {};
  }
}

async function registerAll(ctx, config, disposers) {
  // 板有三种运行时形态（0.6.1 起）：
  //   boardEndpoint 有值且连得上 → 远端板（多设备共用一块板）
  //   boardEndpoint 有值但连不上 → 降级到本机 SQLite（boardFallback=local，默认）或加载失败（=fail）
  //   没配 boardEndpoint        → 本机 SQLite（单机默认，行为与原型完全一致）
  // 降级是 2026-11-21 事故的修复：远端板是外部依赖，它坏掉不该等于"整插件不可用"。
  const endpoint = typeof config.boardEndpoint === 'string' && config.boardEndpoint.trim().length > 0
    ? config.boardEndpoint.trim()
    : '';
  const fallback = normalizeBoardFallback(config.boardFallback, ctx);

  /** 当前板模式：给 mesh_peers / mesh_dispatch 做可诊断输出用（不参与任何判定）。 */
  let boardMode = { mode: 'local', dbPath: null };
  let board;

  if (endpoint !== '') {
    const token = typeof config.boardToken === 'string' ? config.boardToken : (process.env.DSH_TEAM_BOARD_TOKEN ?? '');
    let remote = null;
    let connectError = null;
    let healthInfo = null;
    // 启动自检：链路/密钥/服务任何一项不对，都在这里被点名，不拖到模型调用时才炸。
    try {
      remote = new RemoteBoard({ endpoint, token, timeoutMs: Number(config.boardTimeoutMs ?? 10000) });
      healthInfo = await remote.health();
    } catch (err) {
      connectError = err;
    }

    if (connectError === null) {
      // 日志单独兜：logger 自己抛错不能被误判成"远端连不上"而白白降级
      try {
        ctx?.logger?.info?.(
          `[dsh-team-mesh] 远端板已连上 ${endpoint}（service ${healthInfo?.version}，schema ${healthInfo?.schema_version}）`,
        );
      } catch {
        /* 日志不可用不影响装配 */
      }
      board = remote;
      boardMode = { mode: 'remote', endpoint };
      disposers.push(() => board.close());
    } else if (fallback === 'fail') {
      // 旧行为（0.6.0）：装配期就失败，写 load-error（要不要抛给宿主由 DSH_TEAM_STRICT/DEBUG 决定）
      throw new Error(
        `连不上远端板 ${endpoint}：${connectError?.message ?? connectError}。` +
          '板服务没起、隧道断了、或 boardToken 不对。要回单机模式请清掉 boardEndpoint；' +
          "或设 boardFallback: 'local'（0.6.1 起默认值）让它自动降级。",
      );
    } else {
      // ── 0.6.1：降级到本地板。远端失败不能拖垮整插件 ──
      const reason = summarizeConnectError(connectError, token);
      try {
        board = openLocalBoard(config);
      } catch (localErr) {
        // 降级路径的本地库也起不来（锁 / 权限 / 目录不可写）：如实报，**不假装成功**
        throw new Error(
          `连不上远端板 ${endpoint}（${reason}），且降级到本地板也失败：${localErr?.message ?? localErr}`,
        );
      }
      boardMode = { mode: 'local-degraded', endpoint, dbPath: board.dbPath, reason };
      disposers.push(() => board.close());
      const body = {
        time: new Date().toISOString(),
        version: PLUGIN_VERSION,
        mode: 'local-degraded',
        endpoint,
        error: { message: reason },
        hint: '远端板恢复后重启 DSH 可切回远端',
      };
      const degradedFile = writeDegraded(config, body, ctx);
      try {
        ctx?.logger?.warn?.(
          `[dsh-team-mesh] 远端板连不上，已降级到本地板（boardFallback=local）：${endpoint}；` +
            `原因：${reason}（诊断文件：${degradedFile ?? '写不上'}）`,
        );
      } catch {
        /* 日志不可用不影响降级 */
      }
      // 后台恢复探活：endpoint 非法时远端实例根本造不出来，探也没用 → 不排定时器
      let probe = null;
      try {
        probe = new RemoteBoard({ endpoint, token, timeoutMs: RECOVERY_PROBE_TIMEOUT_MS });
      } catch {
        probe = null;
      }
      if (probe !== null) {
        disposers.push(
          startRemoteRecoveryProbe({ probe, endpoint, config, ctx, degradedBody: body, degradedFile }),
        );
      }
    }
  } else {
    board = openLocalBoard(config);
    boardMode = { mode: 'local', dbPath: board.dbPath };
    disposers.push(() => board.close());
  }

  // 远端已连上 / 单机模式：上次遗留的降级诊断已过时，删掉（否则排障会被旧证据误导）
  if (boardMode.mode !== 'local-degraded') clearDegraded(config, ctx);

  // ── 总管（dispatcher）角色：配置在装配期就规整好 ──
  // 命中 dispatcherSessions 的会话收到派发时，由插件建一个新子会话去干活，总管自己不动手。
  // 空数组 = 这个角色不存在，行为与旧版一致。
  const dispatcherSessions = normalizeDispatcherSessions(config.dispatcherSessions);

  // 0.5：本进程"经手过哪些派发"的登记表。只有 mesh_dispatch 真的投递成功才登记；
  // stale 自动重派与完成通知都从它取候选（详见 lifecycle.js 顶部的已知边界）。
  const dispatchRegistry = createDispatchRegistry();

  // 0.7：mesh worker 登记表 + noWait 禁等待守卫。
  // 只登记"本进程认领/收养成功的会话"—— guard 必须是同步的，远端板查询是异步的，
  // 所以用进程内登记（重启清空 = 守卫暂时不拦，安全方向）。
  const workerRegistry = createWorkerRegistry();
  // 配置键：主名 noWaitGuard；同时接受 applyTo（任务书里的叫法）作为同义别名。
  const noWaitRaw = config.noWaitGuard !== undefined ? config.noWaitGuard : config.applyTo;
  const noWaitMode = normalizeNoWaitMode(noWaitRaw, ctx);
  if (noWaitMode !== 'off') {
    try {
      disposers.push(
        installNoWaitGuard({
          ctx,
          mode: noWaitMode,
          isMeshWorker: (sessionId) => workerRegistry.has(sessionId),
          logger: ctx?.logger,
        }),
      );
    } catch (err) {
      // 守卫装不上只影响"防长等待"，绝不能拖垮整插件 —— 与收件箱/总管同一口径
      try {
        ctx?.logger?.warn?.(`[dsh-team-mesh] noWait 守卫未安装：${err?.message ?? err}`);
      } catch {
        /* ignore */
      }
    }
  }

  const handlers = createHandlers({
    getBoard: () => board,
    // 0.6.1：板模式（远端 / 本地 / 本地降级）给诊断工具用；只读，不参与任何判定
    getBoardMode: () => boardMode,
    getInterconnect: () => interconnectOf(ctx),
    // 总管角色：命中这些会话的派发由插件自动建子会话分流，且这些会话自己不许认领任务。
    // 没配就是空数组 —— 旧行为（没有总管概念）一字不差。
    getDispatcherSessions: () => dispatcherSessions,
    // newSession 回执窗口下限（默认由 handlers 兜 180s；这里只负责把配置透进去）
    newSessionAckFloorMs: config.newSessionAckFloorMs,
    // 0.4：单机板上是否允许"未验证收养"（默认 false = 严格；远端板由板服务自己配置决定）
    allowUnverifiedAdoption: config.allowUnverifiedAdoption === true,
    // 0.5：派发成功后登记，给 stale 自动重派 / 完成通知用
    dispatchRegistry,
    // 0.7：mesh worker 登记表（noWait 守卫用它判断"这个会话是否正在持有任务"）
    workers: workerRegistry,
    // 0.6：入站唤醒限速（四道闸）。默认全关 —— 与 0.5 完全一致（不读表、不落事件）。
    wakeConfig: {
      wakeGuard: config.wakeGuard === true,
      wakeMinTaskChars: config.wakeMinTaskChars,
      wakeThreadCooldownMs: config.wakeThreadCooldownMs,
      wakeMaxPerThread: config.wakeMaxPerThread,
      wakeNoWake: config.wakeNoWake === true,
    },
  });

  const defineTool = await loadDefineTool();
  const specs = allSpecs();
  const tools = specs.map((spec) => {
    const handler = handlers[spec.name];
    if (typeof handler !== 'function') {
      // 契约与实现不一致要在装配期就炸，而不是等模型调用时才发现
      throw new Error(`spec ${spec.name} 没有对应的 handler`);
    }
    return defineTool({
      ...spec,
      // 第二个参数是宿主给的 exec（带 agent/signal），原样传给 handler 取调用者身份
      execute: (args, exec) => handler(args ?? {}, exec),
    });
  });
  disposers.push(...tools.map((tool) => ctx.tools.register(tool)));

  // 对端推来的生命周期事件：记进审计流。详见 createPeerEventRecorder 上的两条硬约束。
  const offEvent = ctx.on('interconnect/event', createPeerEventRecorder({ ctx, board }));
  if (typeof offEvent === 'function') disposers.push(offEvent);

  // ── v3：远端建会话（newSession）的服务端一半 ──
  // 派发方只会在板上留一条请求；**真正新建会话必须由接收端在本机执行**，
  // 因为只有接收端有宿主注册表。这条链路能凭空开进程、还会烧对端的模型额度，
  // 所以 allowCreate **默认 false**，和 interconnect 的 allowResume 同一套风格，
  // 但默认值相反 —— resume 只是唤醒已有会话，create 是造一个新的。
  //
  // 0.3.3：**开关关着也照样轮询**，只是不建会话、回写 `create-refused`。
  // 旧版关着就完全不读板，于是派发方要等到 TTL 才拿到 `create-timeout`，
  // 把"对端明确关了开关"说成"对端不在线"。读一次的成本远小于一次误判。
  const allowCreate = config.allowCreate === true;
  const selfInstance = (() => {
    try {
      return interconnectOf(ctx)?.selfSender?.('__probe__')?.instanceId ?? 'unknown';
    } catch {
      return 'unknown';
    }
  })();
  const serviceCreate = () =>
    serviceSessionRequests({
      board,
      ctx,
      instanceId: selfInstance,
      allowCreate,
      limit: Number(config.createBatchLimit ?? 5),
    });
  // 纯空闲兜底：没有新轮次时 pre-step 不会触发，但请求仍应被处理。
  // 周期取 3s：比 ack 窗口（60s）密得多，又不至于空转打满板。
  const periodMs = Number(config.createPollMs ?? 3000);
  const createTimer = setInterval(() => {
    void Promise.resolve()
      .then(() => serviceCreate())
      .catch((err) => {
        try {
          ctx?.logger?.warn?.(`[dsh-team-mesh] 建会话轮询失败：${err?.message ?? err}`);
        } catch {
          /* ignore */
        }
      });
  }, periodMs);
  if (typeof createTimer.unref === 'function') createTimer.unref();
  disposers.push(() => {
    if (createTimer !== null) clearInterval(createTimer);
  });

  // ── 0.5：派发后的生命周期（stale 自动重派 / 完成通知派发方）──
  // 两件事共用一份登记表与一个定时器：
  //   - autoRedispatch **默认 false**，关着时行为与 0.4 完全一致（不读、不写、不发）；
  //   - notifyOnComplete 默认 true，但只有"本进程真的投递成功过"的任务才会被轮询到，
  //     没派过活就等于零成本。失败只记 warn，不影响整棵插件树 —— 与建会话/总管同一口径。
  const lifecycleWanted = config.autoRedispatch === true || config.notifyOnComplete !== false;
  if (lifecycleWanted) {
    try {
      const lifecycle = startLifecycle({
        board,
        registry: dispatchRegistry,
        getInterconnect: () => interconnectOf(ctx),
        // 0.6：完成通知优先直投本机会话（不依赖 interconnect self 路由）。
        // 拿不到宿主服务时返回 null → lifecycle 自行降级到 interconnect。
        getSessionController: () => {
          try {
            return ctx?.get?.('sessionController') ?? ctx?.sessionController ?? null;
          } catch {
            return null;
          }
        },
        instanceId: selfInstance,
        config: {
          autoRedispatch: config.autoRedispatch === true,
          maxRedispatch: config.maxRedispatch,
          notifyOnComplete: config.notifyOnComplete !== false,
        },
        pollMs: Number(config.redispatchPollMs ?? DEFAULT_REDISPATCH_POLL_MS),
        logger: ctx?.logger,
      });
      disposers.push(() => lifecycle.dispose());
    } catch (err) {
      try {
        ctx?.logger?.warn?.(`[dsh-team-mesh] 派发后生命周期未启用：${err?.message ?? err}`);
      } catch {
        /* ignore */
      }
    }
  }

  // ── 总管分流：轮询共享板，看到"派给本实例某个总管会话"的派发就建子会话并代签回执 ──
  // 与建会话服务共用一套"定时器 + 板"的取数方式；失败只记 warn，不拖垮整棵插件树。
  if (dispatcherSessions.length > 0) {
    try {
      const dispatcher = startDispatcher({
        board,
        ctx,
        instanceId: selfInstance,
        sessions: dispatcherSessions,
        cwd: config.dispatcherCwd,
        agentPreset: config.dispatcherAgentPreset,
        pollMs: Number(config.dispatcherPollMs ?? DEFAULT_DISPATCHER_POLL_MS),
        logger: ctx?.logger,
      });
      disposers.push(() => dispatcher.dispose());
      try {
        ctx?.logger?.info?.(
          `[dsh-team-mesh] 总管分流已启用：${dispatcherSessions.join(', ')}（每 ${dispatcher.pollMs}ms 轮询一次）`,
        );
      } catch {
        /* 日志不可用不影响功能 */
      }
    } catch (err) {
      // 总管功能起不来只影响"自动分流"，共享板与其余工具照常可用
      try {
        ctx?.logger?.warn?.(`[dsh-team-mesh] 总管分流未启用：${err?.message ?? err}`);
      } catch {
        /* ignore */
      }
    }
  }

  // ── 自动收件箱：会话下一轮把新事件摘要注入上下文 ──
  // 这是"发起方知情"的实现。对端做完活不主动发消息，我也能看到 done 事件。
  // 注入走 agent/pre-step 中间件（宿主的官方扩展点，内置模型切换提示用的就是它）。
  // 默认开启；config.inbox === false 可关（排障时有用）。
  if (config.inbox !== false) {
    try {
      const offInbox = installInboxHook({
        ctx,
        board,
        limit: Number(config.inboxLimit ?? 20),
        // v3：顺手服务建会话请求。0.3.3 起开关关着也照样服务（回写 create-refused），
        // 所以这里不再传 null —— 只是 create 那一步会被跳过。
        serviceSessionRequests: serviceCreate,
        // 默认排除 peer.event：多机同开时这类会话生命周期事件会占满注入窗口，
        // 把真正关心的 task/evidence/gate 事件饿死在后面（实测过的真问题）。
        // 配成 [] 表示不过滤。
        excludeKinds: Array.isArray(config.inboxExcludeKinds)
          ? config.inboxExcludeKinds
          : undefined,
        resolveInstance: async (sessionId) => {
          try {
            const svc = interconnectOf(ctx);
            if (svc === null) return 'unknown';
            const self = svc.selfSender?.(sessionId);
            return typeof self?.instanceId === 'string' ? self.instanceId : 'unknown';
          } catch {
            return 'unknown';
          }
        },
      });
      if (typeof offInbox === 'function') disposers.push(offInbox);
    } catch (err) {
      // 挂不上钩子只影响"自动知情"，不该阻止插件其余部分工作
      try {
        ctx?.logger?.warn?.(`[dsh-team-mesh] 收件箱钩子未安装：${err?.message ?? err}`);
      } catch {
        /* ignore */
      }
    }
  }

  try {
    const boardLabel = boardMode.mode === 'remote'
      ? `远端 ${endpoint}`
      : boardMode.mode === 'local-degraded'
        ? `本地降级 ${board.dbPath}（远端 ${endpoint} 不可达，原因：${boardMode.reason}）`
        : board.dbPath;
    const caps = typeof board?.capabilities === 'function' ? board.capabilities() : null;
    const capsLabel = caps === null ? '' : `，板能力=${caps.legacy === true ? 'legacy(0.6.1)' : caps.features.join('/')}`;
    ctx?.logger?.info?.(
      `[dsh-team-mesh] ${PLUGIN_VERSION} 已加载：${tools.length} 个工具，板=${boardLabel}${capsLabel}，noWait=${noWaitMode}`,
    );
  } catch {
    /* 日志不可用不影响注册 */
  }

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose?.();
      } catch {
        /* 卸载阶段不抛 */
      }
    }
  };
}

/** 给测试与运维用：不启动 DSH 也能拿到工具名清单。 */
export function toolNames() {
  return Object.values(TOOL_NAMES);
}
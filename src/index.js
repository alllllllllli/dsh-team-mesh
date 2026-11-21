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

export const PLUGIN_VERSION = '0.5.0';

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

/** 诊断文件里 stack 只留前 2000 字符：够定位，又不至于把文件撑成日志。 */
const LOAD_ERROR_STACK_LIMIT = 2000;

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

/** 开关值解析与板服务同一口径：1/true/yes/on 才算开（trim + 小写）。 */
const ENV_FLAG_TRUTHY = new Set(['1', 'true', 'yes', 'on']);
function envFlagEnabled(name) {
  const raw = process.env[name];
  return typeof raw === 'string' && ENV_FLAG_TRUTHY.has(raw.trim().toLowerCase());
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
  // 板有两种：
  //   boardEndpoint 有值 → 连远端板服务（多设备共用一块板）
  //   否则             → 本机 SQLite（单机默认，行为与原型完全一致）
  // 远端不建本地库、不建目录，连不上时**装配期就报错**，不等到第一次调用才暴露。
  const endpoint = typeof config.boardEndpoint === 'string' && config.boardEndpoint.trim().length > 0
    ? config.boardEndpoint.trim()
    : '';

  let board;
  if (endpoint !== '') {
    const token = typeof config.boardToken === 'string' ? config.boardToken : (process.env.DSH_TEAM_BOARD_TOKEN ?? '');
    board = new RemoteBoard({
      endpoint,
      token,
      timeoutMs: Number(config.boardTimeoutMs ?? 10000),
    });
    // 启动自检：链路/密钥/服务任何一项不对，都在这里被点名，不拖到模型调用时才炸。
    try {
      const h = await board.health();
      ctx?.logger?.info?.(
        `[dsh-team-mesh] 远端板已连上 ${endpoint}（service ${h.version}，schema ${h.schema_version}）`,
      );
    } catch (err) {
      throw new Error(
        `连不上远端板 ${endpoint}：${err?.message ?? err}。` +
          '板服务没起、隧道断了、或 boardToken 不对。要回单机模式请清掉 boardEndpoint。',
      );
    }
    disposers.push(() => board.close());
  } else {
    const boardPath = typeof config.boardPath === 'string' && config.boardPath.length > 0
      ? config.boardPath
      : defaultBoardPath();
    fs.mkdirSync(boardPath.replace(/[\\/][^\\/]+$/, ''), { recursive: true });
    board = openBoard(boardPath);
    disposers.push(() => board.close());
  }

  // ── 总管（dispatcher）角色：配置在装配期就规整好 ──
  // 命中 dispatcherSessions 的会话收到派发时，由插件建一个新子会话去干活，总管自己不动手。
  // 空数组 = 这个角色不存在，行为与旧版一致。
  const dispatcherSessions = normalizeDispatcherSessions(config.dispatcherSessions);

  // 0.5：本进程"经手过哪些派发"的登记表。只有 mesh_dispatch 真的投递成功才登记；
  // stale 自动重派与完成通知都从它取候选（详见 lifecycle.js 顶部的已知边界）。
  const dispatchRegistry = createDispatchRegistry();

  const handlers = createHandlers({
    getBoard: () => board,
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
    ctx?.logger?.info?.(
      `[dsh-team-mesh] ${PLUGIN_VERSION} 已加载：${tools.length} 个工具，板=${
        endpoint !== '' ? `远端 ${endpoint}` : board.dbPath
      }`,
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
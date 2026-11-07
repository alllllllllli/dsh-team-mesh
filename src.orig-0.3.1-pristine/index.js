/**
 * index.js — DSH 插件入口。**只做装配**：解析依赖 → 开板 → 注册工具 → 订阅事件 → 返回 disposer。
 *
 * 两条来自真实事故的硬约束：
 *
 * 1. **apply 绝不能让应用起不来。** 插件坏了最坏是"这个插件不可用"，
 *    不该是"应用打不开"。所以这里整段 try/catch，失败时记日志并返回空 disposer；
 *    排查期把 `DSH_TEAM_DEBUG=1` 打开可以把错误抛出来（否则"插件静默不工作"极难查）。
 *
 * 2. **disposers 必须最先声明。** 迟声明会撞上 const 的暂时性死区，抛 ReferenceError，
 *    又被自己的 catch 吞掉 —— 工具注册成功了、解绑函数却从来没登记，卸载时不会释放。
 *
 * 依赖解析沿用 dsh-video-storyboard 的做法：先裸包名 import，失败再看 `DSH_TOOLS_PATH`，
 * 这样本地开发和正式安装都能跑。
 */

import fs from 'node:fs';

import { createHandlers } from './handlers.js';
import { installInboxHook } from './inboxHook.js';
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

export const PLUGIN_VERSION = '0.1.0-prototype';

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

export async function apply(ctx, config = {}) {
  const disposers = [];
  try {
    return await registerAll(ctx, config, disposers);
  } catch (err) {
    try {
      ctx?.logger?.error?.(`[dsh-team-mesh] 加载失败：${err?.stack ?? err}`);
    } catch {
      /* 连日志都写不了就算了 */
    }
    if (process.env.DSH_TEAM_DEBUG) throw err;
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

  const handlers = createHandlers({
    getBoard: () => board,
    getInterconnect: () => interconnectOf(ctx),
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
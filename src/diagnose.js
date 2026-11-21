/**
 * diagnose.js — 0.6：把「对端为什么 down」从一句 link 变成可排查的证据。
 *
 * 动机（真实事故）：SSH 隧道指错端口，mesh_peers 只显示 `[down]`，
 * 分不清是端口不通、隧道断了、token 不对还是 instanceId 不匹配 —— 排查了半小时。
 *
 * 本模块只做三件**可证伪**的事：
 *   1. `parseOrigin`：把 interconnect 配置的 origin 解析成 host / port（解析不了就如实说）；
 *   2. `probeTcp`：真的用 `node:net` 连一次，1s 超时，记录耗时与错误码；
 *   3. `diagnosePeer`：按「TCP 通不通 × 链路 up/down」给出**并列候选原因**，不瞎猜单一原因。
 *
 * 边界：**只读**。不改 interconnect 源码/配置，不写任何状态；探测完立即销毁 socket。
 */
import net from 'node:net';

/** TCP 探测超时。1s：足够发现本机/局域网的 refused，又不会让 mesh_peers 卡住。 */
export const PEER_PROBE_TIMEOUT_MS = 1_000;

/**
 * 解析 interconnect 的 origin（形如 `http://127.0.0.1:13080`）。
 *
 * interconnect 的 `peers()` 里 `origin` 可能是**函数**（self 路由的解析器），
 * 这时没有固定 host:port，TCP 探测无从谈起 —— 必须如实返回"无法探测"，不能编一个地址。
 *
 * @param {unknown} origin
 * @returns {{ok:true, origin:string, scheme:string, host:string, port:number}
 *          | {ok:false, reason:string}}
 */
export function parseOrigin(origin) {
  if (typeof origin === 'function') {
    return { ok: false, reason: 'origin 是 self 解析函数（没有固定 host:port），无法做 TCP 探测' };
  }
  if (typeof origin !== 'string' || origin.trim().length === 0) {
    return { ok: false, reason: 'origin 为空或不是字符串，无法解析 host/port' };
  }
  const raw = origin.trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    // 少数配置写 `10.0.0.2:13080`（无 scheme）：补一个 http:// 再解析，仍失败就如实说
    try {
      url = new URL(`http://${raw}`);
    } catch {
      return { ok: false, reason: `origin 不是合法 URL：${raw}` };
    }
  }
  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  const host = url.hostname;
  if (typeof host !== 'string' || host.length === 0) {
    return { ok: false, reason: `origin 里没有 host：${raw}` };
  }
  // 与 URL 语义一致：http/ws 默认 80，https/wss 默认 443
  const defaultPort = scheme === 'https' || scheme === 'wss' ? 443 : 80;
  const port = url.port === '' ? defaultPort : Number(url.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    return { ok: false, reason: `origin 端口不合法：${raw}` };
  }
  return { ok: true, origin: raw, scheme, host, port };
}

/**
 * 真的建立一次 TCP 连接（不握手、不发数据），返回可达性与耗时。
 *
 * 三种结局都要能区分：
 *   - 连通：`reachable:true, ms`；
 *   - 连接被拒/网络不可达：`reachable:false, error: 'ECONNREFUSED: ...'`；
 *   - 超时：`reachable:false, error: 'timeout 1000ms'`（黑洞端口/防火墙 drop 的典型表现）。
 *
 * @param {string} host
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<{reachable:boolean, ms:number, error:string|null}>}
 */
export function probeTcp(host, port, timeoutMs = PEER_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    let socket = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        socket?.destroy();
      } catch {
        /* socket 已经关了 */
      }
      resolve(result);
    };
    try {
      socket = net.connect({ host, port });
    } catch (err) {
      finish({ reachable: false, ms: Date.now() - startedAt, error: `connect-threw: ${err?.message ?? err}` });
      return;
    }
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ reachable: true, ms: Date.now() - startedAt, error: null }));
    socket.once('timeout', () => finish({ reachable: false, ms: Date.now() - startedAt, error: `timeout ${timeoutMs}ms` }));
    socket.once('error', (err) => {
      const code = typeof err?.code === 'string' && err.code.length > 0 ? err.code : null;
      const message = err?.message ?? String(err);
      finish({ reachable: false, ms: Date.now() - startedAt, error: code === null ? message : `${code}: ${message}` });
    });
  });
}

/**
 * 给一行 peer 探活（解析 origin + TCP 探测）。探测失败/无法探测都**不抛**。
 *
 * @param {{instanceId:string, origin:unknown, link:string}} peer
 * @param {number} [timeoutMs]
 * @returns {Promise<{peer:object, parsed:object, tcp:object}>}
 */
export async function probePeer(peer, timeoutMs = PEER_PROBE_TIMEOUT_MS) {
  const parsed = parseOrigin(peer?.origin);
  if (!parsed.ok) {
    return { peer, parsed, tcp: { reachable: false, ms: 0, error: parsed.reason, skipped: true } };
  }
  const tcp = await probeTcp(parsed.host, parsed.port, timeoutMs);
  return { peer, parsed, tcp };
}

/** 给人看的 TCP 结论（mesh_peers 一行 & probe 详情共用同一份措辞）。 */
export function renderTcp(tcp) {
  if (tcp === null || tcp === undefined) return '未探测';
  if (tcp.skipped === true) return `跳过（${tcp.error}）`;
  if (tcp.reachable === true) return `通（${tcp.ms}ms）`;
  return `不通（${tcp.error ?? 'unknown'}，耗时 ${tcp.ms}ms）`;
}

/**
 * down 时的候选原因。**区分不了就并列** —— 每一项都标注"本行的证据能排除/不能排除什么"，
 * 而不是挑一个听起来最像的写成结论。
 *
 * @param {{tcp:object, link:string}} input
 * @returns {string[]}
 */
export function peerCauseCandidates({ tcp, link }) {
  const tcpReachable = tcp?.reachable === true;
  const tcpSkipped = tcp?.skipped === true;
  if (link === 'up' && tcpReachable) return [];
  const causes = [];
  if (!tcpSkipped && !tcpReachable) {
    causes.push('端口不通：目标 host:port 没有监听 / 防火墙拦了 / SSH 隧道本地端口指错（TCP 已证实连不上）');
    causes.push('隧道断了：本地隧道进程退出，或对端 DSH 重启后换了端口（TCP 连不上，无法区分是这两种的哪一种）');
    causes.push('token 不一致：TCP 不通时此项**无法验证**，不能用它解释本次失败');
    causes.push('instanceId 不匹配：TCP 不通时此项**无法验证**，不能用它解释本次失败');
    return causes;
  }
  if (!tcpSkipped && tcpReachable) {
    causes.push('token 不一致：TCP 通但 WS 握手可能被拒 —— 检查两端 interconnect 的 token 是否同一个');
    causes.push('instanceId 不匹配：对端自报的实例名可能不等于 peers 里配置的键 —— 用对端 /health 或日志核对');
    causes.push('端口指错：TCP 通到的是**别的**服务（比如误连到 web GUI 或另一个 DSH 的端口），不是这个对端');
    return causes;
  }
  // 无法做 TCP 探测（self 解析函数 / 非法 origin）：只能说链路状态本身
  causes.push('链路 down，原因无法从配置里区分：可能是对端没起、token 不一致或 instanceId 不匹配');
  causes.push('origin 不是固定 host:port（self 解析函数），TCP 层无证据可查');
  return causes;
}

/**
 * 单点诊断建议（≤3 条，必须可执行）。按「TCP × link」的不同组合给不同的下一步。
 *
 * @param {{parsed:object, tcp:object, link:string}} input
 * @returns {string[]}
 */
export function peerProbeSuggestions({ parsed, tcp, link }) {
  const tcpReachable = tcp?.reachable === true;
  const tcpSkipped = tcp?.skipped === true;
  const host = parsed?.ok === true ? parsed.host : '<host>';
  const port = parsed?.ok === true ? parsed.port : '<port>';
  const target = parsed?.ok === true ? `${parsed.host}:${parsed.port}` : '（origin 无法解析成 host:port）';
  if (!tcpSkipped && !tcpReachable && link !== 'up') {
    return [
      `先确认 ${target} 真的有人在监听：PowerShell \`Test-NetConnection -ComputerName ${host} -Port ${port}\`。`,
      '若是 SSH 隧道：确认本地隧道端口 = 对端 DSH 的 origin 端口（隧道指错端口是已发生过的真实故障）。',
      '再核对对端 DSH 进程是否在跑、防火墙/安全组是否放行该端口。',
    ];
  }
  if (!tcpSkipped && tcpReachable && link !== 'up') {
    return [
      'TCP 通但链路 down：优先核对两端 interconnect token 是否一致（握手被拒多半是它）。',
      '再核对对端自报的 instanceId 是否等于 peers 里配置的键（不一致时连接会被认成别的实例）。',
      '还不行就看对端 DSH 日志里的 WebSocket 握手错误（端口可能通到了错误的 webServer）。',
    ];
  }
  if (link === 'up') {
    return [
      '链路 up 且 TCP 可达：peer 侧配置没问题；派发失败请看 mesh_dispatch 返回的 delivered/reason。',
      '若 list/send 偶发失败，再跑一次本工具确认链路是否抖动。',
    ];
  }
  return [
    'origin 无法做 TCP 探测（self 解析函数或非法 URL）：只能依赖链路状态与对端日志。',
    '若这是 self 路由：确认本实例 webServer 已监听、端口未被占用。',
  ];
}

/**
 * 把一行 peer 的探活结果压成结构化诊断（handlers 只负责排版，判定逻辑留在这里可单测）。
 *
 * @param {{peer:object, parsed:object, tcp:object}} probed
 * @returns {{instanceId:string, origin:unknown, link:string, tcp:object, causes:string[],
 *            suggestions:string[], lastError:string|null}}
 */
export function diagnosePeer({ peer, parsed, tcp }) {
  const link = typeof peer?.link === 'string' ? peer.link : 'unknown';
  const causes = link === 'up' && tcp?.reachable === true ? [] : peerCauseCandidates({ tcp, link });
  return {
    instanceId: peer?.instanceId,
    origin: peer?.origin,
    link,
    tcp,
    parsed,
    causes,
    suggestions: peerProbeSuggestions({ parsed, tcp, link }),
    // "最后错误信息（有就给）"：interconnect 的 peers() 不暴露最后错误字段，
    // 我们只把本轮 TCP 探测得到的**具体错误**当作最后错误；没有就如实说没有。
    lastError: typeof tcp?.error === 'string' && tcp.error.length > 0 ? tcp.error : null,
  };
}

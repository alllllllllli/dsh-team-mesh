/**
 * handlers.js — 每个工具的执行体。**只做编排**：校验 → 调 domain/store → 把结果写成给人看的文本。
 *
 * 约定：这里不自己判"能不能完成"（那是 domain 的纯函数），也不自己算哈希（那是 store 的事）。
 * 一旦把判定逻辑复制到这里，就出现了第二份会漂移的真相——agent-team 那边已经栽过一次。
 */

import {
  assertNonEmptyString,
  DEFAULT_ACK_TIMEOUT_MS,
  describeDelivery,
  formatTaskCard,
  SESSION_CREATE_REJECT_REASONS,
  TeamError,
  validateCreateInput,
} from './domain.js';
import { collectInbox } from './inbox.js';
import {
  diagnosePeer,
  peerCauseCandidates,
  probePeer,
  renderTcp,
} from './diagnose.js';
import { appendAudit } from './dispatcher.js';
import {
  createWakeLedger,
  DISPATCH_SUPPRESSED_EVENT,
  evaluateWakeGate,
  normalizeWakeConfig,
  renderSuppressedText,
} from './wakeGuard.js';
import { instanceIdOf, sessionIdOf } from './session.js';
import { NEW_SESSION_ACK_FLOOR_MS } from './spec.js';

const DELIVERY_MODES = ['followup', 'steer', 'inject'];

/** 建会话请求的轮询间隔：250ms。够密（60s 窗口内能问 240 次），又不至于把板打满。 */
const CREATE_POLL_INTERVAL_MS = 250;

/**
 * 默认等待建会话的时限（ackTimeoutMs 没给时）。与 domain 的默认 TTL 保持一致。
 *
 * **注意它和回执窗口的下限不是一回事**：这里等的是"对端把会话建出来"（轮询 3s、60s 够），
 * 而回执窗口等的是"对面新会话的模型起跑并 ack"（实测 99s）。把两者混成一件是本轮
 * 明确否掉的方案 —— 所以这个 fallback 保持 60s，不跟 `newSessionAckFloorMs` 走。
 */
const CREATE_TIMEOUT_FALLBACK_MS = 60_000;

/** 总管（dispatcher）会话不能执行任务的稳定错误码。 */
export const DISPATCHER_NOT_EXECUTOR = 'DISPATCHER_NOT_EXECUTOR';

/**
 * 计算一次派发**实际生效**的 ack 窗口（毫秒）。
 *
 * 规则（按 2026-11-14 拍板）：
 *   - 非 newSession：`ackTimeoutMs ?? 默认 60000`，行为与 0.3.x 完全一致 —— 下限**不**参与。
 *   - newSession：`max(ackTimeoutMs ?? 默认 60000, newSessionAckFloorMs ?? 180000)`。
 *     只影响 recordDispatch 的回执窗口；建会话等待仍由 requestRemoteSession 用原值。
 *
 * 显式传了非法值（NaN / 负数 / 0）按"没给"处理，避免把 ack_deadline_at 算成 NaN。
 *
 * @param {{ackTimeoutMs?: number, newSession?: boolean, floorMs?: number}} [opts]
 * @returns {number}
 */
export function resolveAckWindowMs(opts = {}) {
  const raw = opts.ackTimeoutMs === undefined || opts.ackTimeoutMs === null
    ? undefined
    : Number(opts.ackTimeoutMs);
  const wanted = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ACK_TIMEOUT_MS;
  if (opts.newSession !== true) return wanted;
  const rawFloor = opts.floorMs === undefined || opts.floorMs === null ? undefined : Number(opts.floorMs);
  const floor = Number.isFinite(rawFloor) && rawFloor > 0 ? rawFloor : NEW_SESSION_ACK_FLOOR_MS;
  return Math.max(wanted, floor);
}

/** 把毫秒渲染成秒（保留一位小数），给返回文本用。 */
function fmtSeconds(ms) {
  return `${Math.round((Number(ms) / 1000) * 10) / 10}s`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readRequest(board, requestId) {
  try {
    return await board.getSessionRequest(requestId);
  } catch {
    return null;
  }
}

/**
 * 把拒绝原因渲染成给模型/人看的一段话。
 *
 * 关键区别要讲清楚：
 *   - create-refused / create-unsupported → **对端能力/开关问题**，该去开开关或换对端
 *   - create-failed → 对端试了但失败，**换参数再试**有意义
 *   - create-timeout → 没人处理，可能没装新版或不在线
 * 这三种的处理方式完全不同，所以不能压成一句"失败了"。
 */
function renderRejected(instanceId, requestId, reason, message) {
  const known = SESSION_CREATE_REJECT_REASONS[reason];
  const lines = [
    `**未派发（对端没能新建会话）**：${instanceId}`,
    `  原因：${reason ?? 'unknown'}${known === undefined ? '' : ` —— ${known}`}`,
  ];
  if (typeof message === 'string' && message.length > 0) lines.push(`  对端说明：${message}`);
  lines.push(`  请求号：${requestId}`, '');

  if (reason === 'create-refused' || reason === 'create-unsupported') {
    lines.push(
      '这是**对端的能力/开关问题**，重试同样的调用没用。两条路：',
      '  1. 让对端在它的 profile 里把 dsh-team-mesh 的 allowCreate 打开（默认是关的）；',
      '  2. 或者改用现成会话：mesh_peers({ includeSessions: true }) 看对端有哪些活会话，',
      '     再用 mesh_dispatch({ instanceId, sessionId }) 投过去。',
    );
  } else if (reason === 'create-failed') {
    lines.push(
      '对端确实尝试建了，但建失败。按上面的对端说明改参数（常见是 cwd 不可写、agentPreset 不存在），再试。',
    );
  } else {
    lines.push(
      '对端在时限内没处理这条请求。可能是它没装支持 newSession 的版本、或那一刻不在线。',
      '现在也可以改用现成会话：mesh_peers({ includeSessions: true }) 挑一个，再 mesh_dispatch({ instanceId, sessionId })。',
    );
  }
  lines.push('', '**任务卡没有发出去**，也没有偷偷改投给别的会话。');
  return lines.join('\n');
}

/**
 * 派发侧：请对端建一个全新会话，等到拿回 sessionId 或一个诚实的失败原因。
 *
 * **不降级**：任何失败都原样返回一段给模型看的文本，由调用方直接回复用户；
 * 绝不退回"投给现成会话"。
 *
 * @returns {Promise<{ok:true, sessionId:string, note:string} | {ok:false, text:string}>}
 */
async function requestRemoteSession(deps) {
  const {
    board,
    instanceId,
    requesterInstance,
    requesterSession,
    cwd,
    title,
    agentPreset,
    ackTimeoutMs,
  } = deps;

  // 请求存活时限跟回执窗口对齐：两者都是"发出去等对方反应"，观感必须一致。
  const ttlMs = Number(ackTimeoutMs ?? CREATE_TIMEOUT_FALLBACK_MS);

  let registered;
  try {
    registered = await board.createSessionRequest({
      targetInstance: instanceId,
      requesterInstance,
      requesterSession,
      cwd,
      title,
      agentPreset,
      ttlMs,
    });
  } catch (err) {
    return {
      ok: false,
      text: [
        `**未派发（建会话请求没登记上）**：${instanceId}`,
        `  原因：${err?.code ?? 'BOARD_ERROR'}：${err?.message ?? String(err)}`,
        '',
        '任务卡没有发出去。这是共享板的问题，不是对端拒绝。',
      ].join('\n'),
    };
  }

  const requestId = registered.request_id;
  const deadlineAt = registered.deadline_at;

  // 轮询等结果。为什么不用长连接/回调：板只是一张表，两端都可能重装重启，
  // 轮询是唯一不需要额外生命周期的做法。
  for (;;) {
    const row = await readRequest(board, requestId);
    if (row !== null && row.state === 'claimed') {
      if (typeof row.session_id === 'string' && row.session_id.length > 0) {
        return {
          ok: true,
          sessionId: row.session_id,
          note: `对端已新建会话 ${row.session_id}（request ${requestId}）`,
        };
      }
      return { ok: false, text: renderRejected(instanceId, requestId, row.reject_reason, row.reject_message) };
    }
    if (row !== null && row.state === 'expired') {
      return { ok: false, text: renderRejected(instanceId, requestId, 'create-timeout', null) };
    }
    if (Date.now() >= deadlineAt) {
      // 板上还没被清扫成 expired，但我们已经等够了 —— 结论一样是超时。
      return { ok: false, text: renderRejected(instanceId, requestId, 'create-timeout', null) };
    }
    await sleep(CREATE_POLL_INTERVAL_MS);
  }
}

function requireTaskId(args) {
  return assertNonEmptyString(args?.taskId, 'taskId', 200);
}

function fmtTime(ms) {
  try {
    return new Date(Number(ms)).toISOString();
  } catch {
    return String(ms);
  }
}

/**
 * peer.origin 的展示值。
 * interconnect 的 `peers()` 里 `origin` 可能是 **self 路由的解析函数**（公开形态），
 * 直接 `${origin}` 会打出一段源码 —— 这里如实标成"无固定 host:port"。
 */
function describeOrigin(origin) {
  if (typeof origin === 'string') return origin;
  if (typeof origin === 'function') return '（self 解析函数，无固定 host:port）';
  return String(origin);
}

function lifecycleLabel(lifecycle) {
  const map = {
    open: '待认领',
    claimed: '已认领',
    working: '进行中',
    blocked: '受阻',
    done: '已完成',
    canceled: '已取消',
  };
  return `${lifecycle}（${map[lifecycle] ?? '未知状态'}）`;
}

/** 把可采信/不可采信分开显示：不为好看而抹平差别。 */
function fmtEvidenceLines(evidences) {
  if (evidences.length === 0) return ['  （没有任何证据）'];
  return evidences.map((e) => {
    const flag = e.admissible === 1 ? '可采信' : '不可采信';
    const ref = e.evidence_ref === null ? '' : ` ref=${e.evidence_ref}`;
    const sha = e.ref_sha256 === null ? '' : ` sha256=${String(e.ref_sha256).slice(0, 16)}…`;
    return `  #${e.evidence_id} ${flag} executed=${e.executed === 1} outcome=${e.outcome} @${fmtTime(e.created_at)}${ref}${sha}`;
  });
}

/** 收养的三类证据：分开显示，**不许合并成一句"通过"**。 */
function fmtAdoptionEvidence(ev) {
  const evidence = ev ?? {};
  const lines = [];
  const t = evidence.time;
  if (t !== undefined && t !== null) {
    const parts = [
      t.lease_until === null ? 'lease_until=NULL' : `lease_until=${fmtTime(t.lease_until)}`,
    ];
    if (t.stale === true) parts.push(`stale=1（标记于 ${t.stale_at === null ? '未知' : fmtTime(t.stale_at)}）`);
    if (t.expired === true) parts.push('租约已过期');
    if (typeof t.overrun_ms === 'number') {
      parts.push(
        t.overrun_ms >= 0
          ? `超期 ${t.overrun_ms}ms`
          : `时间上还有 ${-t.overrun_ms}ms 才到期（本次是 stale 标记放行）`,
      );
    }
    lines.push(`  时间：${parts.join('，')}`);
  }
  const id = evidence.identity;
  if (id !== undefined && id !== null) {
    lines.push(
      `  身份：${id.verdict ?? 'unknown'}（${id.reason ?? '-'}）` +
        `${id.checked_pid === true ? '，已在本机实际探测 pid' : '，未探测 pid'}` +
        `；持有者 pid=${id.lease_pid ?? 'NULL'} host=${id.lease_host ?? 'NULL'}；判定者 host=${id.judge_host ?? 'NULL'}`,
    );
  }
  const e = evidence.event;
  if (e !== undefined && e !== null) {
    lines.push(
      `  事件：最后一条租约活动 ${e.last_kind ?? '无'} @${e.last_at === null ? '-' : fmtTime(e.last_at)}` +
        `（seq #${e.last_seq ?? '-'}）；早于 lease_until=${e.last_before_lease_until === true}；` +
        `期限后续租痕迹 ${e.renewals_after_lease_until ?? 0} 条`,
    );
  }
  return lines;
}

/** 收养被拒时的回退建议：按稳定码分流，别让调用方把"拒绝"理解成"再试一次"。 */
function adoptionRejectHint(code) {
  switch (code) {
    case 'ADOPT_NOT_STALE':
      return '租约还在有效期内且没有 stale 标记。等它过期/被扫描标 stale 后再试；持有者自己还活着时应当 heartbeat。';
    case 'ADOPT_HOLDER_ALIVE':
      return '同机确认原持有者进程还活着 —— 这不是"死了的租约"。让它自己 heartbeat，或由有权限的人 cancel。';
    case 'ADOPT_EVIDENCE_INSUFFICIENT':
      return '审计流与租约记录对不上（或事件扫描被截断）。先 mesh_events 人工核对，不要换个说法重试。';
    case 'ADOPT_EVIDENCE_UNVERIFIABLE':
      return (
        '板服务无法验证原持有者进程是否真的死了（跨机 / 记录缺身份）。这是**能力边界**，不是重试能解决的。' +
        '确认持有者确实已死后，可显式放行：单机插件配置 allowUnverifiedAdoption: true，' +
        '或板服务设 DSH_TEAM_BOARD_ALLOW_UNVERIFIED_ADOPT=1（放行后审计记 unverified=true）。'
      );
    case 'ADOPT_NOT_CLAIMED':
      return '任务还没有负责人，直接 mesh_task_claim 即可。';
    default:
      return '按上面的原因处理；不要用同样的参数重复调用。';
  }
}

export function createHandlers(deps) {
  const { getBoard, getInterconnect } = deps;

  /**
   * 0.5：本实例派发登记表（可选依赖）。测试不传 → null，派发行为与 0.4 一字不差。
   */
  const dispatchRegistry = deps.dispatchRegistry ?? null;

  /**
   * 0.6：入站唤醒限速（四道闸）。默认全关 —— 不传配置时 normalize 出来的就是
   * "wakeGuard:false"，`mesh_dispatch` 行为与 0.5 完全一致（连一次闸门判断的开销都省在真值上）。
   * 计数只在**真的投递成功**后记，进程内 Map，不落板、不加字段。
   */
  const wakeConfig = normalizeWakeConfig(deps.wakeConfig);
  const wakeLedger = deps.wakeLedger ?? createWakeLedger();

  /**
   * 本实例配置的总管会话（可能为空）。
   * 测试直接构造 handlers 时不传这个依赖 → 空数组，旧的认领行为一字不差。
   */
  const dispatcherSessions = () => {
    if (typeof deps.getDispatcherSessions !== 'function') return [];
    try {
      const value = deps.getDispatcherSessions();
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  };

  /**
   * 总管只分流、不执行：认领入口直接拒，并给出可判定的错误码。
   * 为什么必须在这里拒，而不是靠提示词约束：模型真的会自己认领，
   * 于是总管既不该干活又占着租约，派出去的子会话反而认领不到。
   */
  const assertNotDispatcher = (actor) => {
    if (dispatcherSessions().includes(actor)) {
      throw new TeamError(
        DISPATCHER_NOT_EXECUTOR,
        `会话 ${actor} 是总管（dispatcher），只负责分流与代签回执，不执行任务。` +
          '任务应由总管自动建出的子会话认领；总管要推进任务请用 mesh_dispatch 派出去。',
      );
    }
  };

  /**
   * 单机板上的「未验证收养」策略。远端板模式下策略由**板服务**决定（只有它所在的主机
   * 才可能验 pid），客户端这一侧传的值不参与判定 —— spec 里已如实说明这一点。
   */
  const allowUnverifiedAdoption = () => deps.allowUnverifiedAdoption === true;

  return {
    async mesh_peers(args, exec) {
      const interconnect = getInterconnect();
      if (interconnect === null || typeof interconnect !== 'object') {
        return [
          '本实例上没有 interconnect 服务，跨实例派活不可用。',
          '（dsh-interconnect 插件未启用，或它的服务尚未激活。）',
          '共享任务板仍然可用：同一台机器上的其他 DSH 实例可以自己来认领任务。',
        ].join('\n');
      }

      let rows;
      try {
        rows = interconnect.peers();
      } catch (err) {
        return `读 peer 列表失败：${err?.message ?? String(err)}`;
      }
      if (!Array.isArray(rows) || rows.length === 0) {
        return [
          '本实例没有配置任何对端 DSH 实例（peers）。',
          '要跨实例派活，得先在 dsh-interconnect 的配置里加上对端的 instanceId 与 origin。',
        ].join('\n');
      }

      // 0.6：并行探活（每行 1s 上限，串行会把 N 个 down 的对端叠成 N 秒）。
      // 探测失败一律不抛：这是诊断信息，不能因此让整个工具失败。
      const probed = await Promise.all(rows.map((p) => probePeer(p)));

      const lines = [`本实例：${instanceIdOf(interconnect, sessionIdOf(exec))}`, `对端 ${rows.length} 个：`];
      for (let i = 0; i < rows.length; i += 1) {
        const p = rows[i];
        const got = probed[i];
        const link = typeof p?.link === 'string' ? p.link : 'unknown';
        lines.push(`  ${p.instanceId}  ${link}  ${describeOrigin(p.origin)}`);
        lines.push(`    TCP：${renderTcp(got.tcp)}｜链路：${link}（interconnect peers()）`);
        // down 或 TCP 不通时并列候选原因；**区分不了就并列**，不挑一个写成结论
        if (link !== 'up' || got.tcp?.reachable !== true) {
          const causes = peerCauseCandidates({ tcp: got.tcp, link });
          if (causes.length > 0) {
            lines.push('    可能原因（无法区分，以下并列）：');
            for (const cause of causes) lines.push(`      - ${cause}`);
            lines.push(`    单点详情：mesh_peer_probe({ instanceId: "${p.instanceId}" })`);
          }
        }
        if (args?.includeSessions === true) {
          if (p.link !== 'up') {
            lines.push('    链路未通，列不出会话');
            continue;
          }
          let listed;
          try {
            listed = await interconnect.list(p.instanceId);
          } catch (err) {
            lines.push(`    列会话失败：${err?.message ?? String(err)}`);
            continue;
          }
          if (listed === undefined) {
            lines.push('    对端没有回答（链路可能刚断）');
            continue;
          }
          const sessions = listed.sessions ?? [];
          lines.push(`    活会话 ${sessions.length} 个：`);
          for (const s of sessions) {
            const title = s.title === undefined ? '' : `  ${s.title}`;
            const status = s.status === undefined ? '' : `  [${s.status}]`;
            lines.push(`      ${s.sessionId}${status}${title}`);
          }
        }
      }
      return lines.join('\n');
    },

    async mesh_peer_probe(args) {
      const instanceId = assertNonEmptyString(args?.instanceId, 'instanceId', 256);
      const interconnect = getInterconnect();
      if (interconnect === null || typeof interconnect !== 'object') {
        return [
          '本实例上没有 interconnect 服务，无法探测对端。',
          '（dsh-interconnect 插件未启用，或它的服务尚未激活。）',
        ].join('\n');
      }

      let rows;
      try {
        rows = interconnect.peers();
      } catch (err) {
        return `读 peer 列表失败：${err?.message ?? String(err)}`;
      }
      const list = Array.isArray(rows) ? rows : [];
      const peer = list.find((p) => p?.instanceId === instanceId);
      if (peer === undefined) {
        // 稳定码：与 interconnect 的 send 失败码同名。这是**配置问题**，重试本工具没有意义。
        const configured = list.length === 0 ? '（peers 一个都没配）' : list.map((p) => p.instanceId).join(', ');
        throw new TeamError(
          'PEER_NOT_CONFIGURED',
          `peer-not-configured：本实例 peers 里没有 "${instanceId}"。已配置：${configured}。` +
            '先改 dsh-interconnect 的 peers 配置（键 = 对端 instanceId），再重试；不要重复调用本工具。',
        );
      }

      const probed = await probePeer(peer);
      const diagnosis = diagnosePeer(probed);
      const parsed = probed.parsed;
      const lines = [
        `对端探测：${instanceId}`,
        `  配置 origin：${describeOrigin(peer.origin)}`,
        `  解析 host/port：${
          parsed.ok === true ? `${parsed.host}:${parsed.port}（scheme=${parsed.scheme}）` : `无法解析 —— ${parsed.reason}`
        }`,
        `  TCP 可达性：${renderTcp(probed.tcp)}`,
        `  链路状态：${diagnosis.link}（来自 interconnect peers()）`,
        `  最后错误：${diagnosis.lastError ?? '无（interconnect 的 peers() 不暴露最后错误字段）'}`,
      ];
      if (diagnosis.causes.length > 0) {
        lines.push('', '可能原因（无法区分，以下并列）：');
        for (const cause of diagnosis.causes) lines.push(`  - ${cause}`);
      }
      lines.push('', '诊断建议：');
      diagnosis.suggestions.slice(0, 3).forEach((hint, i) => lines.push(`  ${i + 1}. ${hint}`));
      return lines.join('\n');
    },

    async mesh_task_create(args, exec) {
      const input = validateCreateInput(args ?? {});
      const actor = sessionIdOf(exec);
      const { task, deduped } = await getBoard().createTask(input, actor);
      const head = deduped
        ? `这个 requestId 已经建过任务，返回原任务（幂等，没有重复创建）：`
        : `已建任务：`;
      return [
        head,
        `  task_id: ${task.task_id}`,
        `  ${task.title}`,
        `  状态：${lifecycleLabel(task.lifecycle)}`,
        ...(task.require_independent_review === 1
          ? ['  独立复核：已开启（完成时须有一条 verifiedBy ≠ 上报人的可采信证据）']
          : []),
        '',
        '下一步：mesh_dispatch 派给别人，或自己 mesh_task_claim 后再动手。',
      ].join('\n');
    },

    async mesh_task_list(args) {
      const tasks = await getBoard().listTasks({
        lifecycle: args?.lifecycle,
        ownerSession: args?.ownerSession,
        limit: args?.limit,
      });
      if (tasks.length === 0) return '共享任务板上没有符合条件的任务。';
      const lines = [`共 ${tasks.length} 条（按最近更新排序）：`];
      for (const t of tasks) {
        const owner = t.owner_session === null ? '' : `  owner=${t.owner_session}`;
        // v2：把"可能需要人管"的状态显式标出来，别让人从一堆正常里自己找
        const flags = [];
        if (t.stale === 1) flags.push('STALE(负责人失联)');
        if (t.ack_state === 'timeout') flags.push('ACK_TIMEOUT(送到了没人管)');
        else if (t.ack_state === 'pending') flags.push('待回执');
        const flagText = flags.length > 0 ? `  ⚠ ${flags.join(' / ')}` : '';
        lines.push(`  ${t.task_id}  ${lifecycleLabel(t.lifecycle)}${owner}  ${t.title}${flagText}`);
      }
      return lines.join('\n');
    },

    async mesh_task_claim(args, exec) {
      const taskId = requireTaskId(args);
      const actor = sessionIdOf(exec);
      // 总管永不执行任务（硬要求）：认领直接拒，错误码固定，别让它变成"租约被占"的模糊失败
      assertNotDispatcher(actor);
      const { task, deduped } = await getBoard().claimTask(taskId, actor, { leaseMs: args?.leaseMs });
      const lease = task.lease_until === null
        ? ''
        : `\n  租约至：${fmtTime(task.lease_until)}（到期前请用 mesh_task_heartbeat 续租，建议 ≤5 分钟一次）`;
      return deduped
        ? `这个任务本来就在你名下（${task.task_id}），没有重复认领（租约已续）。${lease}`
        : [
            `已认领：${task.task_id}`,
            `  状态：${lifecycleLabel(task.lifecycle)}`,
            `  负责人：${task.owner_session}${lease}`,
          ].join('\n');
    },

    async mesh_task_heartbeat(args, exec) {
      const taskId = requireTaskId(args);
      const actor = sessionIdOf(exec);
      const { task, was_stale: wasStale } = await getBoard().heartbeat(taskId, actor, { leaseMs: args?.leaseMs });
      return [
        `${wasStale ? '已复活' : '已续租'}：${task.task_id}`,
        `  租约至：${fmtTime(task.lease_until)}`,
        wasStale ? '  （之前被标过 stale，现在已恢复；审计里会看到 lease.revived）' : '',
      ]
        .filter((s) => s.length > 0)
        .join('\n');
    },

    async mesh_task_adopt(args, exec) {
      const taskId = requireTaskId(args);
      const actor = sessionIdOf(exec);
      // 与 claim 同一条硬规则：总管只分流不执行，不能通过"收养"把活拿到自己名下
      assertNotDispatcher(actor);
      let res;
      try {
        res = await getBoard().adoptTask(taskId, actor, {
          leaseMs: args?.leaseMs,
          allowUnverifiedAdoption: allowUnverifiedAdoption(),
        });
      } catch (err) {
        // 收养被拒是**可预期的正常结果**（不是工具坏了）：把三类证据原样摊开给调用方。
        // 与 mesh_task_complete 处理门禁拒绝同一套思路：拒绝也要能让人看懂为什么。
        if (err instanceof TeamError && typeof err.code === 'string' && err.code.startsWith('ADOPT_')) {
          const detail = err.detail ?? {};
          const reasons = Array.isArray(detail.reasons)
            ? detail.reasons
            : (Array.isArray(err.detail) ? err.detail : [err.message]);
          return [
            `收养被拒绝（${err.code}）：${taskId}`,
            '  原因：',
            ...reasons.map((r) => `    - ${r}`),
            '',
            '当前证据：',
            ...fmtAdoptionEvidence(detail.evidence),
            '',
            `回退：${adoptionRejectHint(err.code)}`,
          ].join('\n');
        }
        throw err;
      }
      const leaseText = res.task.lease_until === null
        ? ''
        : `\n  租约至：${fmtTime(res.task.lease_until)}（到期前请 mesh_task_heartbeat 续租）`;
      const lines = [
        `${res.unverified ? '已收养（⚠ 未验证）' : '已收养（三证据核验通过）'}：${res.task.task_id}`,
        `  原负责人：${res.from ?? '未知'} → 现在是你（${res.task.owner_session}）`,
        `  状态：${lifecycleLabel(res.task.lifecycle)}${leaseText}`,
        '  三证据：',
        ...fmtAdoptionEvidence(res.evidence),
        '',
        '审计里已记 lease.adopted（三类证据 + 结论 + unverified 标记）。',
      ];
      if (res.unverified === true) {
        lines.push(
          '',
          '⚠ 这是一次**未验证收养**：板服务无法验证原持有者进程是否真的死了（原因见「身份」一行）。',
          '  放行仅因为策略显式允许（allowUnverifiedAdoption / DSH_TEAM_BOARD_ALLOW_UNVERIFIED_ADOPT）。',
          '  它不满足"已验证原持有者已死"——出现纠纷时请把这一点当作事实基线。',
        );
      }
      return lines.join('\n');
    },

    async mesh_task_ack(args, exec) {
      const taskId = requireTaskId(args);
      const actor = sessionIdOf(exec);
      const res = await getBoard().ackTask(taskId, actor);
      if (res.deduped) {
        return `这个任务你已经回执过了（${taskId}），没有重复记录。`;
      }
      return [
        `已回执：${taskId}`,
        `  派发方现在知道这个任务有人接手了（延迟 ${res.latency_ms}ms）`,
        `  下一步：mesh_task_claim 认领后开始干活，并定期 heartbeat。`,
      ].join('\n');
    },

    async mesh_inbox(args, exec) {
      const board = getBoard();
      const who = {
        instanceId: instanceIdOf(getInterconnect(), sessionIdOf(exec)),
        sessionId: sessionIdOf(exec),
        // 显式给了 excludeKinds 就用它（[] = 不过滤）；没给则用默认（排除 peer.event）
        excludeKinds: Array.isArray(args?.excludeKinds) ? args.excludeKinds : undefined,
      };
      if (args?.reset === true) {
        await board.advanceCursor(who.instanceId, who.sessionId, 0);
      }
      const got = await collectInbox(board, who);
      if (got.count === 0) {
        // 注意：这里也要前移游标 —— 纯噪声被"看过"了，否则它们会永久堵住队头
        if (args?.peek !== true && got.nextSeq > got.sinceSeq) {
          await board.advanceCursor(who.instanceId, who.sessionId, got.nextSeq);
        }
        const skippedText = got.skipped > 0 ? `（过滤掉 ${got.skipped} 条噪声）` : '';
        return `没有未读事件${skippedText}（游标 #${got.sinceSeq}${got.nextSeq > got.sinceSeq ? ` → #${got.nextSeq}` : ''}）。`;
      }
      if (args?.peek !== true) {
        await board.advanceCursor(who.instanceId, who.sessionId, got.nextSeq);
      }
      return [
        got.text,
        '',
        `（游标：${got.sinceSeq} → ${args?.peek === true ? `${got.sinceSeq}（peek，未前移）` : got.nextSeq}；共 ${got.count} 条${
          got.skipped > 0 ? `，另过滤 ${got.skipped} 条噪声` : ''
        }）`,
      ].join('\n');
    },

    async mesh_task_report(args, exec) {
      const taskId = requireTaskId(args);
      const actor = sessionIdOf(exec);
      const res = await getBoard().reportEvidence(
        taskId,
        {
          executed: args?.executed,
          outcome: args?.outcome,
          note: args?.note,
          evidenceRef: args?.evidenceRef,
          // v4：结构化复核字段（全部可选，不传即 NULL，老行为不变）
          verifiedBy: args?.verifiedBy,
          verifiedAt: args?.verifiedAt,
          acceptanceRef: args?.acceptanceRef,
          verificationMethod: args?.verificationMethod,
        },
        actor,
      );
      const lines = [
        `已记录证据 #${res.evidence_id}（task ${taskId}）`,
        `  可采信：${res.admissible ? '是' : '否'}`,
      ];
      // v4：复核信息回显 —— 让"谁验的、验的哪条"当场可见，不用去查库
      if (res.verified_by !== null && res.verified_by !== undefined) {
        const same = String(res.verified_by).trim() === String(actor).trim();
        lines.push(
          `  复核人：${res.verified_by}${same ? '（与上报人相同 —— 这是自验自报，独立复核门禁会拒）' : '（与上报人不同，可满足独立复核）'}`,
        );
        if (res.acceptance_ref !== null && res.acceptance_ref !== undefined) {
          lines.push(`  对应验收条目：${res.acceptance_ref}`);
        }
        if (res.verification_method !== null && res.verification_method !== undefined) {
          lines.push(`  复核方式：${res.verification_method}`);
        }
      }
      if (!res.admissible) {
        lines.push('  因为：');
        for (const r of res.reasons) lines.push(`    - ${r}`);
        lines.push('');
        lines.push('这条证据不会推动完成。补一条可采信的证据再试。');
      } else {
        if (res.uploaded !== null && res.uploaded !== undefined) {
          lines.push(
            `  物证已上传到共享板并按内容寻址：${res.uploaded.ref}`,
            `  （sha256 由板服务对字节实算：${res.uploaded.sha256}，${res.uploaded.size} 字节）`,
          );
        } else if (res.ref_sha256 !== null) {
          lines.push(`  物证 sha256（本插件对磁盘实算）：${res.ref_sha256}（${res.ref_size} 字节）`);
        }
        lines.push('', '下一步：mesh_task_complete 请求完成（门禁会再判一次）。');
      }
      return lines.join('\n');
    },

    async mesh_task_complete(args, exec) {
      const taskId = requireTaskId(args);
      const actor = sessionIdOf(exec);
      const board = getBoard();
      try {
        const { task } = await board.completeTask(taskId, actor);
        return [`任务已完成：${task.task_id}`, `  ${task.title}`, `  状态：${lifecycleLabel(task.lifecycle)}`].join('\n');
      } catch (err) {
        if (err instanceof TeamError && err.code === 'GATE_REJECTED') {
          const reasons = Array.isArray(err.detail) ? err.detail : [err.message];
          let evidenceLines = [];
          try {
            evidenceLines = fmtEvidenceLines(await board.listEvidence(taskId));
          } catch {
            /* 拿不到证据清单不能改变"被拒绝"这个结论 */
          }
          return [
            `完成被门禁拒绝（${taskId}）：`,
            ...reasons.map((r) => `  - ${r}`),
            '',
            '拒绝已写入审计事件。请补可采信证据后再试，不要换个说法重试同一次调用。',
            '当前证据：',
            ...evidenceLines,
          ].join('\n');
        }
        throw err;
      }
    },

    async mesh_task_cancel(args, exec) {
      const taskId = requireTaskId(args);
      const actor = sessionIdOf(exec);
      const { task } = await getBoard().cancelTask(taskId, actor, args?.reason ?? '');
      return [`已取消：${task.task_id}`, `  状态：${lifecycleLabel(task.lifecycle)}（终态，不可恢复）`].join('\n');
    },

    async mesh_dispatch(args, exec) {
      const taskId = requireTaskId(args);
      const instanceId = assertNonEmptyString(args?.instanceId, 'instanceId', 256);
      // v3：newSession=true 时不要求 sessionId（那个会话还没被建出来）
      const wantsNewSession = args?.newSession === true;
      const givenSessionId = args?.sessionId === undefined || args?.sessionId === null
        ? undefined
        : args.sessionId;

      if (!wantsNewSession) {
        // 旧路径：sessionId 必填，校验逻辑与 0.3.1 完全一致
        assertNonEmptyString(givenSessionId, 'sessionId', 256);
      } else if (givenSessionId !== undefined) {
        // 给了 sessionId 又要新建：这是自相矛盾的意图，必须说清楚，不能猜。
        throw new TeamError(
          'INVALID_FIELD',
          'newSession=true 时不要给 sessionId：那个会话会被新建出来，不需要你指定。' +
            '如果你只想投给现成会话，去掉 newSession。',
        );
      }

      const board = getBoard();
      const task = await board.getTask(taskId);
      if (task === null) throw new TeamError('TASK_NOT_FOUND', `任务不存在：${taskId}`);
      if (task.lifecycle === 'done' || task.lifecycle === 'canceled') {
        throw new TeamError('TASK_CLOSED', `任务已终结（${task.lifecycle}），不再派发`);
      }

      const interconnect = getInterconnect();
      if (interconnect === null || typeof interconnect !== 'object') {
        throw new TeamError(
          'INTERCONNECT_UNAVAILABLE',
          '本实例没有 interconnect 服务，无法跨实例派活（共享板仍可让对方自己来认领）',
        );
      }

      if (args?.delivery !== undefined && !DELIVERY_MODES.includes(args.delivery)) {
        throw new TeamError('INVALID_FIELD', `delivery 必须是 ${DELIVERY_MODES.join(' / ')} 之一`);
      }

      // ── 0.6：入站唤醒限速（四道闸）──
      // 位置必须在**任何投递/建会话动作之前**：命中就不该建远端会话、不该发任务卡、
      // 不该开 ack 窗口（"拦下"与"送到没人管"是两种完全不同的结论）。
      const wakeHit = evaluateWakeGate({
        task,
        instanceId,
        sessionId: wantsNewSession ? null : givenSessionId,
        newSession: wantsNewSession,
        now: Date.now(),
        config: wakeConfig,
        ledger: wakeLedger,
      });
      if (wakeHit !== null) {
        const payload = {
          // reason 用稳定码（可按码分流），message 给人看
          reason: wakeHit.code,
          code: wakeHit.code,
          message: wakeHit.reason,
          task_id: taskId,
          target_instance: instanceId,
          target_session: wantsNewSession ? null : givenSessionId,
          new_session: wantsNewSession,
          chars: wakeHit.chars,
          min_chars: wakeHit.min_chars ?? null,
          remaining_ms: wakeHit.remaining_ms ?? null,
          wake_count: wakeHit.wake_count ?? null,
          max_wakes: wakeHit.max_wakes ?? null,
        };
        // 尽力落审计（远端板禁止客户端写审计时降级为无事件——但返回文本仍给稳定码）
        await appendAudit(board, DISPATCH_SUPPRESSED_EVENT, taskId, sessionIdOf(exec), payload);
        return [
          `**未派发（入站唤醒限速拦下）**：${instanceId}${wantsNewSession ? ' / <new-session>' : ` / ${givenSessionId ?? '?'}`}`,
          `  原因码：${wakeHit.code}`,
          `  说明：${wakeHit.reason}`,
          `  任务：${task.task_id} ${task.title}`,
          '',
          `处理：${renderSuppressedText(wakeHit)}`,
          '审计事件：dispatch.suppressed（含 reason / task / target）。',
          '**这次没有投递，也没有偷偷改投别的会话。**',
        ].join('\n');
      }

      // 回执窗口：只在 newSession 时套下限；普通派发与 0.3.x 一致（默认 60s）。
      // 建会话等待另算 —— 它仍用 args.ackTimeoutMs 原值（缺省 60s），不跟这个下限走。
      const requestedAckMs = resolveAckWindowMs({ ackTimeoutMs: args?.ackTimeoutMs, newSession: false });
      const ackWindowMs = resolveAckWindowMs({
        ackTimeoutMs: args?.ackTimeoutMs,
        newSession: wantsNewSession,
        floorMs: deps.newSessionAckFloorMs,
      });
      // 只有在"调用方给了更小的值、被下限顶掉"时才是 true；要显式告诉模型它的值没被采纳
      const floorApplied = wantsNewSession && ackWindowMs > requestedAckMs;

      let sessionId = givenSessionId;
      let createdNote = null;

      // ── v3：先在对端建一个全新会话，再往那个新会话投任务卡 ──
      if (wantsNewSession) {
        const created = await requestRemoteSession({
          board,
          instanceId,
          requesterInstance: instanceIdOf(interconnect, sessionIdOf(exec)),
          requesterSession: sessionIdOf(exec),
          cwd: args?.cwd,
          title: args?.title ?? task.title,
          agentPreset: args?.agentPreset,
          // 建会话等待保持旧逻辑（不套回执窗口下限）：60s 等"把会话建出来"本来就够
          ackTimeoutMs: args?.ackTimeoutMs,
        });
        if (created.ok !== true) {
          // 关键：**不降级**。建不出来就如实报，绝不偷偷改投给某个现成会话 ——
          // 那正是这次要消灭的行为。
          return created.text;
        }
        sessionId = created.sessionId;
        createdNote = created.note;
      }

      const text = formatTaskCard(task, {
        fromInstance: instanceIdOf(interconnect, sessionIdOf(exec)),
      });
      const request = { instanceId, sessionId, text };
      if (args?.delivery !== undefined) request.delivery = args.delivery;
      if (args?.resume === true) request.resume = true;

      let result;
      try {
        result = await interconnect.send(request);
      } catch (err) {
        // 抛异常也不吞：记成未投递，并如实返回原因
        result = { delivered: false, instance: instanceId, reason: `exception: ${err?.message ?? String(err)}` };
      }

      // v2：投递成功就开回执窗口，把"送到了没人管"变成可判定的状态
      // v3：新建会话这条事实一并落库，事后能看出"这条派发投的是新建的会话"
      const ackInfo = await board.recordDispatch(taskId, instanceId, sessionId, result, {
        // 实际生效值：newSession 已套过下限（例：给 5000 → 180000）
        ackTimeoutMs: ackWindowMs,
        createdSession: createdNote !== null,
      });
      const view = describeDelivery(result.delivered === true, ackInfo.ack_state, result.reason);

      // 0.5：登记"本实例派出过这条任务"，给 stale 自动重派 / 完成主动通知用。
      // 只在**真的送到**时登记：没送到的派发不存在"派发方在等它做完"这件事。
      // 登记失败只影响这两项新功能，绝不改变本次派发的结论。
      // 0.6：同一次"真的送到"也算一次**入站唤醒**（限速账本只在投递成功后计数）。
      // 只有 wakeGuard 打开时才记账 —— 默认关闭时连一个 Map 条目都不该多出来。
      if (result.delivered === true) {
        if (dispatchRegistry !== null) {
          try {
            dispatchRegistry.record?.(taskId, {
              peerInstance: instanceId,
              peerSession: sessionId,
              dispatcherInstance: instanceIdOf(interconnect, sessionIdOf(exec)),
              dispatcherSession: sessionIdOf(exec),
              dispatchedAt: Date.now(),
            });
          } catch {
            /* ignore */
          }
        }
        if (wakeConfig.wakeGuard === true) wakeLedger.note(instanceId, sessionId, Date.now());
      }

      if (result.delivered === true) {
        return [
          `**${view.label}** → ${instanceId} / ${sessionId}`,
          createdNote === null ? '' : `  ${createdNote}`,
          `  任务：${task.task_id} ${task.title}`,
          result.delivery === undefined ? '' : `  投递方式：${result.delivery}`,
          // 实际生效值必须写出来：调用方给了 5000 却按 180000 走时，不能让它以为只有 5s
          `  回执时限：${fmtTime(ackInfo.ack_deadline_at)}（生效窗口 ${ackWindowMs}ms，约 ${fmtSeconds(ackWindowMs)} 内应有 mesh_task_ack）`,
          floorApplied
            ? `  ⚠ 你给的 ackTimeoutMs=${requestedAckMs}ms 低于 newSession 下限，已按 ${ackWindowMs}ms 生效（只是抬了回执窗口，没抬建会话等待）`
            : '',
          '',
          '对方收到任务卡后应当：先 mesh_task_ack（表示收到了），再 mesh_task_claim 认领。',
          '**投递成功 ≠ 对方知道 ≠ 任务完成。** 到时限仍无回执会被判 ack_timeout（"送到了没人管"）。',
          '完成只看共享板上的门禁结果。',
        ]
          .filter((s) => s.length > 0)
          .join('\n');
      }
      return [
        `**未投递（信没送到）**：${instanceId} / ${sessionId}`,
        createdNote === null ? '' : `  ${createdNote}`,
        `  原因：${result.reason}`,
        '',
        '这不算派成功，也不会进入"等回执"状态（没送到谈不上没人管）。按原因处理',
        '（换活着的会话 / 等链路恢复 / 先配 peers），不要把它当成"对方在做了"。',
      ]
        .filter((s) => s.length > 0)
        .join('\n');
    },

    async mesh_events(args) {
      const taskId = args?.taskId === undefined ? null : requireTaskId(args);
      const rows = await getBoard().recentEvents(args?.limit ?? 20, taskId);
      if (rows.length === 0) return '没有事件。';
      const lines = [`最近 ${rows.length} 条事件（新的在前）：`];
      for (const r of rows) {
        const t = r.task_id === null ? '-' : r.task_id;
        lines.push(`  #${r.seq} ${fmtTime(r.created_at)} ${r.kind} ${t} ${JSON.stringify(r.payload).slice(0, 200)}`);
      }
      return lines.join('\n');
    },
  };
}

/** 由 index.js 组装的真实依赖；测试注入内存板与假 interconnect。 */
export function resolveDeps(ctx, boardPath) {
  return { ctx, boardPath };
}
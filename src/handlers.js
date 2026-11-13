/**
 * handlers.js — 每个工具的执行体。**只做编排**：校验 → 调 domain/store → 把结果写成给人看的文本。
 *
 * 约定：这里不自己判"能不能完成"（那是 domain 的纯函数），也不自己算哈希（那是 store 的事）。
 * 一旦把判定逻辑复制到这里，就出现了第二份会漂移的真相——agent-team 那边已经栽过一次。
 */

import {
  assertNonEmptyString,
  describeDelivery,
  formatTaskCard,
  SESSION_CREATE_REJECT_REASONS,
  TeamError,
  validateCreateInput,
} from './domain.js';
import { collectInbox } from './inbox.js';
import { instanceIdOf, sessionIdOf } from './session.js';

const DELIVERY_MODES = ['followup', 'steer', 'inject'];

/** 建会话请求的轮询间隔：250ms。够密（60s 窗口内能问 240 次），又不至于把板打满。 */
const CREATE_POLL_INTERVAL_MS = 250;

/** 默认等待建会话的时限（ackTimeoutMs 没给时）。与 domain 的默认 TTL 保持一致。 */
const CREATE_TIMEOUT_FALLBACK_MS = 60_000;

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

export function createHandlers(deps) {
  const { getBoard, getInterconnect } = deps;

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

      const lines = [`本实例：${instanceIdOf(interconnect, sessionIdOf(exec))}`, `对端 ${rows.length} 个：`];
      for (const p of rows) {
        lines.push(`  ${p.instanceId}  ${p.link}  ${p.origin}`);
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
        ackTimeoutMs: args?.ackTimeoutMs,
        createdSession: createdNote !== null,
      });
      const view = describeDelivery(result.delivered === true, ackInfo.ack_state, result.reason);

      if (result.delivered === true) {
        return [
          `**${view.label}** → ${instanceId} / ${sessionId}`,
          createdNote === null ? '' : `  ${createdNote}`,
          `  任务：${task.task_id} ${task.title}`,
          result.delivery === undefined ? '' : `  投递方式：${result.delivery}`,
          `  回执时限：${fmtTime(ackInfo.ack_deadline_at)}（${Math.round((ackInfo.ack_deadline_at - Date.now()) / 1000)}s 内应有 mesh_task_ack）`,
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
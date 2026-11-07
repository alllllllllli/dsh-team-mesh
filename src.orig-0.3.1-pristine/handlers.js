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
  TeamError,
  validateCreateInput,
} from './domain.js';
import { collectInbox } from './inbox.js';
import { instanceIdOf, sessionIdOf } from './session.js';

const DELIVERY_MODES = ['followup', 'steer', 'inject'];

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
        },
        actor,
      );
      const lines = [
        `已记录证据 #${res.evidence_id}（task ${taskId}）`,
        `  可采信：${res.admissible ? '是' : '否'}`,
      ];
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
      const sessionId = assertNonEmptyString(args?.sessionId, 'sessionId', 256);
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
      const ackInfo = await board.recordDispatch(taskId, instanceId, sessionId, result, {
        ackTimeoutMs: args?.ackTimeoutMs,
      });
      const view = describeDelivery(result.delivered === true, ackInfo.ack_state, result.reason);

      if (result.delivered === true) {
        return [
          `**${view.label}** → ${instanceId} / ${sessionId}`,
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
        `  原因：${result.reason}`,
        '',
        '这不算派成功，也不会进入"等回执"状态（没送到谈不上没人管）。按原因处理',
        '（换活着的会话 / 等链路恢复 / 先配 peers），不要把它当成"对方在做了"。',
      ].join('\n');
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
/**
 * 冒烟脚本：不启动 DSH、不联网，把"跨实例协作"的整条链路走一遍。
 *
 * 两个 `Board` 指向**同一个库文件**，就等价于同一台机器上的两个 DSH 实例：
 * 一个建任务并派发（用假 interconnect，投递结果可编排），另一个看见任务、认领、干活、
 * 报证据、被门禁拒绝一次、补证据、完成。
 *
 * 用法：node tools/smoke.mjs [板文件路径]
 * 退出码 0 = 全过。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createHandlers } from '../src/handlers.js';
import { Board, defaultBoardPath } from '../src/store.js';

const boardPath = process.argv[2] ?? path.join(os.tmpdir(), `dsh-team-smoke-${Date.now()}.db`);
const dir = path.dirname(boardPath);
fs.mkdirSync(dir, { recursive: true });

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok, detail });
  process.stdout.write(`  ${ok ? '✔' : '✘'} ${label}${detail ? ` — ${detail}` : ''}\n`);
}

// 两个"实例"共用一块板
const boardA = new Board(boardPath);
const boardB = new Board(boardPath);

// 假 interconnect：可编排 delivered / reason，用来验"未投递会如实说"
let nextResult = { delivered: true, instance: 'pc-b', delivery: 'followup' };
const interconnect = {
  peers: () => [
    { instanceId: 'pc-a', origin: 'http://127.0.0.1:13080', link: 'up' },
    { instanceId: 'pc-b', origin: 'http://127.0.0.1:13081', link: 'down' },
  ],
  list: async () => ({ instance: 'pc-a', sessions: [{ sessionId: 'session-x', title: '对方会话', status: 'idle' }] }),
  send: async (req) => ({ ...nextResult, instance: req.instanceId }),
  selfSender: (sessionId) => ({ instanceId: 'pc-a', sessionId }),
};

const handlersA = createHandlers({ getBoard: () => boardA, getInterconnect: () => interconnect });
const handlersB = createHandlers({ getBoard: () => boardB, getInterconnect: () => interconnect });

const execA = { agent: { id: 'session-orch' } };
const execB = { agent: { id: 'session-worker' } };

function headline(t) {
  process.stdout.write(`\n── ${t} ──\n`);
}

headline('1. A 实例看对端与活会话');
const peers = await handlersA.mesh_peers({ includeSessions: true }, execA);
check('列出 2 个 peer，up 的那个带出活会话', peers.includes('pc-a') && peers.includes('session-x'));

headline('2. A 建任务（幂等）');
const created = await handlersA.mesh_task_create(
  { title: '读三份资料写对比报告', brief: '读 source-a/b/c', acceptance: '字段齐全、来源哈希真实', requestId: 'req-1' },
  execA,
);
const taskId = created.match(/task_id: (t-[0-9a-f]{8})/)[1];
check('建出一个任务', /^t-[0-9a-f]{8}$/.test(taskId), taskId);
const again = await handlersA.mesh_task_create({ title: '读三份资料写对比报告', requestId: 'req-1' }, execA);
check('同 requestId 重放不重复建', again.includes('幂等'));

headline('3. A 派给 B 实例（假 interconnect，投递成功）');
const dispatched = await handlersA.mesh_dispatch({ taskId, instanceId: 'pc-b', sessionId: 'session-x' }, execA);
check('投递成功并说明"投递成功≠完成"', dispatched.includes('已投递') && dispatched.includes('≠'));

headline('4. A 派给一个已休眠会话（未投递，必须如实报）');
nextResult = { delivered: false, instance: 'pc-b', reason: 'session-not-live' };
const failed = await handlersA.mesh_dispatch({ taskId, instanceId: 'pc-b', sessionId: 'session-gone' }, execA);
check('未投递时给出原因且明确"这不算派成功"', failed.includes('未投递') && failed.includes('session-not-live'));

headline('5. B 实例在自己的进程里看见同一个任务（跨实例共享）');
const seen = await handlersB.mesh_task_list({}, execB);
check('B 能看到 A 建的任务', seen.includes(taskId));

headline('6. B 认领；A 抢不走');
await handlersB.mesh_task_claim({ taskId }, execB);
let steal = null;
try {
  // 同步抛错的 handler 不能用 .catch()：这里显式 try
  await handlersA.mesh_task_claim({ taskId }, execA);
} catch (err) {
  steal = err;
}
check('别人已认领时拒绝抢占', steal?.code === 'ALREADY_CLAIMED', steal?.code ?? '没拒绝');

headline('7. B 报一条失败证据 → 完成被门禁拒');
await handlersB.mesh_task_report({ taskId, executed: true, outcome: 'fail', note: '第一版不合格' }, execB);
const rejected = await handlersB.mesh_task_complete({ taskId }, execB);
check('门禁按"最后一条可采信证据"拒绝', rejected.includes('LATEST_FAIL'), rejected.split('\n')[1]?.trim());

headline('8. 被拒不写进审计？不行——必须查得到');
const events = await handlersB.mesh_events({ taskId, limit: 20 }, execB);
check('事件流里能看到 task.gate_rejected', events.includes('task.gate_rejected'));

headline('9. B 报可采信 pass（真产物、哈希实算）→ 完成');
const artifact = path.join(dir, 'report.json');
fs.writeFileSync(artifact, JSON.stringify({ sources: [], conclusion: 'ok' }), 'utf8');
const reported = await handlersB.mesh_task_report(
  { taskId, executed: true, outcome: 'pass', evidenceRef: artifact, note: '补齐来源' },
  execB,
);
check('证据可采信且带实算 sha256', reported.includes('可采信：是') && reported.includes('sha256'));
const done = await handlersB.mesh_task_complete({ taskId }, execB);
check('完成后状态是 done', done.includes('任务已完成'));

headline('10. 没给物证的 pass 不算证据');
const created2 = await handlersA.mesh_task_create({ title: '第二个任务', requestId: 'req-2' }, execA);
const task2 = created2.match(/task_id: (t-[0-9a-f]{8})/)[1];
await handlersA.mesh_task_claim({ taskId: task2 }, execA);
const noRef = await handlersA.mesh_task_report({ taskId: task2, executed: true, outcome: 'pass', note: '我保证成了' }, execA);
check('模型自报"成了"但没有物证 → 不可采信', noRef.includes('可采信：否'));
const stillRejected = await handlersA.mesh_task_complete({ taskId: task2 }, execA);
check('因此仍然不能完成', stillRejected.includes('完成被门禁拒绝'));

const failedCount = results.filter((r) => !r.ok).length;
process.stdout.write(`\n════ 检查项 ${results.length}，失败 ${failedCount} ════\n`);
process.stdout.write(`板文件：${boardPath}\n`);
boardA.close();
boardB.close();
if (failedCount === 0) {
  try {
    fs.rmSync(boardPath, { force: true });
    fs.rmSync(`${boardPath}-wal`, { force: true });
    fs.rmSync(`${boardPath}-shm`, { force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
}
process.exitCode = failedCount === 0 ? 0 : 1;

void defaultBoardPath;
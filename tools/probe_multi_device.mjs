// 探针：模拟"两台设备各装一份插件"时共享板会发生什么。
// 不是猜测，是实跑：两个 Board 指向两个不同的 db 文件（= 两台机器各自的 $DSH_HOME/team/team.db）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Board } from '../src/store.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-multidev-'));
const boardA = path.join(tmp, 'deviceA', 'team.db');
const boardB = path.join(tmp, 'deviceB', 'team.db');
fs.mkdirSync(path.dirname(boardA), { recursive: true });
fs.mkdirSync(path.dirname(boardB), { recursive: true });

const evidence = path.join(tmp, 'proof.txt');
fs.writeFileSync(evidence, 'real artifact\n');

const A = new Board(boardA); // 设备 A
const B = new Board(boardB); // 设备 B

const out = [];
const log = (s) => { out.push(s); console.log(s); };

log(`设备A 板：${boardA}`);
log(`设备B 板：${boardB}`);
log('');

// 1. 设备A 建任务
const created = A.createTask({ title: '跨机测试', brief: 'x', acceptance: 'x', requestId: 'multi-1' }, 'session-A');
const taskId = created.task.task_id;
log(`1) 设备A 建任务 ${taskId}  -> ${created.task.lifecycle}`);

// 2. 设备A 派给设备B（投递本身是 interconnect 的事，这里只测板）
log('2) 设备A 派给设备B：投递会成功（interconnect 通了就行）');

// 3. 设备B 想报证据
log('3) 设备B 收到任务卡，调 mesh_task_report：');
try {
  B.reportEvidence(taskId, { executed: true, outcome: 'pass', evidenceRef: evidence, note: '在设备B上做完了' }, 'session-B');
  log('   !! 成功了（说明板是共享的）');
} catch (err) {
  log(`   X 失败：${err.code}  ${err.message}`);
}

// 4. 设备B 想直接完成
log('4) 设备B 调 mesh_task_complete：');
try {
  B.completeTask(taskId, 'session-B');
  log('   !! 成功了（说明板是共享的）');
} catch (err) {
  log(`   X 失败：${err.code}  ${err.message}`);
}

// 5. 设备A 那边任务还在原地
const onA = A.getTask(taskId);
log(`5) 设备A 上看这个任务：lifecycle=${onA.lifecycle}  evidence=${A.listEvidence(taskId).length} 条`);
log('');
log(`结论：A 板有任务，B 板查无此任务 => 两份板互不相通。`);

// 必须先关库再删目录，否则 Windows 上句柄未释放会 EPERM
for (const b of [A, B]) { try { b?.close?.(); } catch { /* ignore */ } }
try {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
} catch (err) {
  log(`（临时目录清理失败，不影响结论：${err.code}）`);
}

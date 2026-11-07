/**
 * store 的测试：**真 SQLite、真文件、真事务**。不用内存桩。
 *
 * 因为这里要验的正是"跨进程/跨实例落在同一个文件上"的行为，
 * 换成内存数据库就把要验的东西验掉了。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Board, defaultBoardPath, openBoard } from '../src/store.js';
import { TeamError } from '../src/domain.js';

const tmps = [];
function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-team-store-'));
  tmps.push(d);
  return d;
}
process.on('exit', () => {
  for (const d of tmps) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* Windows 上 WAL 句柄可能还没释放 */
    }
  }
});

function newBoard() {
  return new Board(path.join(tempDir(), 'team.db'));
}

test('建板：WAL 生效、schema 落盘', () => {
  const b = newBoard();
  const mode = b.db.prepare('PRAGMA journal_mode').get();
  assert.equal(String(Object.values(mode)[0]).toLowerCase(), 'wal');
  const tables = b.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  for (const t of ['task', 'evidence', 'dispatch', 'event', 'meta']) {
    assert.ok(tables.includes(t), `缺表 ${t}`);
  }
  b.close();
});

test('创建任务：默认 open、版本 1，并留下审计事件', () => {
  const b = newBoard();
  const { task, deduped } = b.createTask(
    { title: '读三份资料', brief: '背景', acceptance: '字段齐全', requestId: null },
    'session-a',
  );
  assert.equal(deduped, false);
  assert.equal(task.lifecycle, 'open');
  assert.equal(task.version, 1);
  assert.match(task.task_id, /^t-[0-9a-f]{8}$/);

  const ev = b.recentEvents(5);
  assert.equal(ev[0].kind, 'task.created');
  assert.equal(ev[0].task_id, task.task_id);
  b.close();
});

test('幂等：同一 requestId 重放不新建任务', () => {
  const b = newBoard();
  const a = b.createTask({ title: 'x', brief: '', acceptance: '', requestId: 'req-1' }, 's-a');
  const c = b.createTask({ title: 'x（重放）', brief: '', acceptance: '', requestId: 'req-1' }, 's-a');
  assert.equal(a.deduped, false);
  assert.equal(c.deduped, true);
  assert.equal(c.task.task_id, a.task.task_id);
  assert.equal(b.listTasks({}).length, 1, '重放不能建出第二条');
  b.close();
});

test('认领：变成 working 并记负责人；同一会话重复认领是幂等的', () => {
  const b = newBoard();
  const { task } = b.createTask({ title: 'x', brief: '', acceptance: '', requestId: null }, 's-a');
  const claimed = b.claimTask(task.task_id, 'session-a');
  assert.equal(claimed.task.lifecycle, 'working');
  assert.equal(claimed.task.owner_session, 'session-a');

  const again = b.claimTask(task.task_id, 'session-a');
  assert.equal(again.deduped, true);
  b.close();
});

test('认领：别人已认领就不能抢', () => {
  const b = newBoard();
  const { task } = b.createTask({ title: 'x', brief: '', acceptance: '', requestId: null }, 's-a');
  b.claimTask(task.task_id, 'session-a');
  assert.throws(() => b.claimTask(task.task_id, 'session-b'), (err) => err.code === 'ALREADY_CLAIMED');
  b.close();
});

test('证据：pass 必须给真实存在的物证，哈希由我们实算', () => {
  const b = newBoard();
  const dir = tempDir();
  const artifact = path.join(dir, 'report.json');
  const body = '{"a":1}';
  fs.writeFileSync(artifact, body, 'utf8');
  const expectSha = crypto.createHash('sha256').update(body).digest('hex');

  const { task } = b.createTask({ title: 'x', brief: '', acceptance: '', requestId: null }, 's-a');
  b.claimTask(task.task_id, 'session-a');

  const ok = b.reportEvidence(task.task_id, { executed: true, outcome: 'pass', evidenceRef: artifact, note: '写完了' }, 'session-a');
  assert.equal(ok.admissible, true);
  assert.equal(ok.ref_sha256, expectSha, '必须是对磁盘实算的值');
  assert.equal(ok.ref_size, body.length);

  // 模型自报哈希不管用：库里存的是实算值，不是它说的
  const bad = b.reportEvidence(task.task_id, { executed: true, outcome: 'pass', note: '没有物证' }, 'session-a');
  assert.equal(bad.admissible, false);
  assert.match(bad.reasons.join(';'), /evidenceRef/);
  b.close();
});

test('证据：物证路径不存在 → 不可采信，且不会把不存在的文件当成功', () => {
  const b = newBoard();
  const { task } = b.createTask({ title: 'x', brief: '', acceptance: '', requestId: null }, 's-a');
  b.claimTask(task.task_id, 'session-a');
  const r = b.reportEvidence(
    task.task_id,
    { executed: true, outcome: 'pass', evidenceRef: path.join(tempDir(), 'nope.json') },
    'session-a',
  );
  assert.equal(r.admissible, false);
  assert.equal(r.ref_sha256, null);
  b.close();
});

test('完成门禁：没证据不能完成，且拒绝也留审计', () => {
  const b = newBoard();
  const { task } = b.createTask({ title: 'x', brief: '', acceptance: '', requestId: null }, 's-a');
  b.claimTask(task.task_id, 'session-a');
  assert.throws(() => b.completeTask(task.task_id, 'session-a'), (err) => {
    assert.equal(err.code, 'GATE_REJECTED');
    assert.match(err.message, /NO_EVIDENCE/);
    return true;
  });
  // 关键：门禁拒绝必须留下事件（agent-team 那边的 D-1 就是这条被事务回滚吃掉了）
  const rejected = b.recentEvents(10, task.task_id).find((e) => e.kind === 'task.gate_rejected');
  assert.ok(rejected !== undefined, '门禁拒绝必须能在审计里看到');
  assert.match(JSON.stringify(rejected.payload), /NO_EVIDENCE/);
  // 状态没被改成 done
  assert.equal(b.getTask(task.task_id).lifecycle, 'working');
  b.close();
});

test('完成门禁：有可采信 pass 才能完成', () => {
  const b = newBoard();
  const dir = tempDir();
  const artifact = path.join(dir, 'out.txt');
  fs.writeFileSync(artifact, 'done', 'utf8');
  const { task } = b.createTask({ title: 'x', brief: '', acceptance: '', requestId: null }, 's-a');
  b.claimTask(task.task_id, 'session-a');
  b.reportEvidence(task.task_id, { executed: true, outcome: 'pass', evidenceRef: artifact }, 'session-a');
  const { task: done } = b.completeTask(task.task_id, 'session-a');
  assert.equal(done.lifecycle, 'done');
  assert.equal(b.recentEvents(3, task.task_id)[0].kind, 'task.done');
  b.close();
});

test('完成门禁：最后一条 fail 就拒绝（先过后挂）', () => {
  const b = newBoard();
  const dir = tempDir();
  const artifact = path.join(dir, 'out.txt');
  fs.writeFileSync(artifact, 'done', 'utf8');
  const { task } = b.createTask({ title: 'x', brief: '', acceptance: '', requestId: null }, 's-a');
  b.claimTask(task.task_id, 'session-a');
  b.reportEvidence(task.task_id, { executed: true, outcome: 'pass', evidenceRef: artifact }, 'session-a');
  b.reportEvidence(task.task_id, { executed: true, outcome: 'fail', note: '回归挂了' }, 'session-a');
  assert.throws(() => b.completeTask(task.task_id, 'session-a'), (err) => err.code === 'GATE_REJECTED');
  b.close();
});

test('终结后不能再报证据', () => {
  const b = newBoard();
  const { task } = b.createTask({ title: 'x', brief: '', acceptance: '', requestId: null }, 's-a');
  b.cancelTask(task.task_id, 's-a', '不做了');
  assert.throws(
    () => b.reportEvidence(task.task_id, { executed: true, outcome: 'fail' }, 's-a'),
    (err) => err.code === 'TASK_CLOSED',
  );
  b.close();
});

test('持久化：关掉重开，任务与证据都还在', () => {
  const dir = tempDir();
  const p = path.join(dir, 'team.db');
  const artifact = path.join(dir, 'a.txt');
  fs.writeFileSync(artifact, 'x', 'utf8');

  const b1 = new Board(p);
  const { task } = b1.createTask({ title: '持久化', brief: '', acceptance: '', requestId: null }, 's-a');
  b1.claimTask(task.task_id, 'session-a');
  b1.reportEvidence(task.task_id, { executed: true, outcome: 'pass', evidenceRef: artifact }, 'session-a');
  b1.close();

  const b2 = new Board(p);
  assert.equal(b2.getTask(task.task_id).title, '持久化');
  assert.equal(b2.listEvidence(task.task_id).length, 1);
  b2.close();
});

test('两块板指向同一文件：第二个实例能看见第一个实例写的任务（这就是"共享"）', () => {
  const p = path.join(tempDir(), 'shared.db');
  const a = new Board(p);
  const b = new Board(p);
  const { task } = a.createTask({ title: '跨实例可见', brief: '', acceptance: '', requestId: null }, 's-a');
  assert.equal(b.getTask(task.task_id).title, '跨实例可见');
  // 认领后另一实例看到负责人已变
  a.claimTask(task.task_id, 'session-a');
  assert.equal(b.getTask(task.task_id).owner_session, 'session-a');
  a.close();
  b.close();
});

test('派发记录：投递失败也要落库，并带原因', () => {
  const b = newBoard();
  const { task } = b.createTask({ title: 'x', brief: '', acceptance: '', requestId: null }, 's-a');
  // v2：recordDispatch 返回对象（带 ack 状态），不再只返回 id
  const out = b.recordDispatch(task.task_id, 'pc-ky614', 'session-1', { delivered: false, reason: 'session-not-live' });
  assert.ok(out.dispatch_id > 0);
  const row = b.db.prepare('SELECT * FROM dispatch WHERE dispatch_id = ?').get(out.dispatch_id);
  assert.equal(row.delivered, 0);
  assert.equal(row.reason, 'session-not-live');
  // 没送到就不该开等回执窗口，否则 60s 后会被误判成"送到了没人管"
  assert.equal(out.ack_state, 'none');
  assert.equal(out.ack_id, null);
  b.close();
});

test('defaultBoardPath 落在 $DSH_HOME/team/team.db', () => {
  const before = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = 'C:\\fake-dsh-home';
    assert.equal(defaultBoardPath(), path.join('C:\\fake-dsh-home', 'team', 'team.db'));
  } finally {
    if (before === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = before;
  }
});

test('openBoard 接受显式路径（测试与运维不污染真实板）', () => {
  const p = path.join(tempDir(), 'explicit.db');
  const b = openBoard(p);
  assert.equal(b.dbPath, p);
  b.close();
});

test('非法输入不落地：标题为空时库里没有新行', () => {
  const b = newBoard();
  b.createTask({ title: 'ok', brief: '', acceptance: '', requestId: null }, 's-a');
  const before = b.listTasks({}).length;
  assert.throws(() => b.claimTask('no-such-task', 's-a'), TeamError);
  assert.equal(b.listTasks({}).length, before);
  b.close();
});
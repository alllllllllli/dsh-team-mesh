/**
 * v5_task_graph.test.mjs — 0.7 任务依赖 / 写域 / 乐观并发 / v5 迁移的验收。
 *
 * 这些能力对齐官方 Agent Teams 的语义（官方源码 `task-view.ts` / `task-graph.ts`）：
 *   - blockedBy：只有全部 completed（本插件 = done）才 ready；未 ready 不能 claim；
 *   - writeScopes：与进行中任务重叠**只警告不阻止**（advisory，不是锁）；
 *   - expectedRevision：CAS 冲突返回可重试的 REVISION_CONFLICT，绝不静默覆盖；
 *   - schema v4 → v5：补两列，老数据不丢、迁移幂等。
 *
 * 同时把"错误码分类表"钉住：哪些可重试、哪些是终局。模型/脚本按码分流，
 * 这张表一旦漂移，调用方就会盲试或误放弃。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Board } from '../src/store.js';
import {
  assertTaskGraph,
  describeErrorCode,
  ERROR_CATALOG,
  isRetryableError,
  normalizeWriteScope,
  projectTaskView,
  taskReady,
  validateDependencies,
} from '../src/domain.js';

const tmps = [];
function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-v5-'));
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
function artifact(name = 'out.txt', body = 'done') {
  const p = path.join(tempDir(), name);
  fs.writeFileSync(p, body, 'utf8');
  return p;
}

// ───────────────────────── 依赖 blockedBy ─────────────────────────

test('依赖：未完成的 blocker 让任务不 ready，claim 被 BLOCKED_BY_DEPS 拒绝', () => {
  const b = newBoard();
  const a = b.createTask({ title: '前置任务', brief: '', acceptance: '', requestId: null }, 's-a').task;
  const dep = b.createTask({ title: '依赖任务', requestId: null, blockedBy: [a.task_id] }, 's-a').task;

  assert.deepEqual(dep.blockedBy, [a.task_id]);
  assert.equal(dep.ready, false, '依赖未完成时 ready 必须是 false');
  assert.throws(
    () => b.claimTask(dep.task_id, 's-worker'),
    (err) => {
      assert.equal(err.code, 'BLOCKED_BY_DEPS');
      assert.deepEqual(err.detail.blockedBy, [a.task_id]);
      assert.equal(err.detail.blockers.length, 1);
      return true;
    },
  );
  // 拒绝后状态没变（仍是 open、没人认领）
  const still = b.getTaskView(dep.task_id);
  assert.equal(still.lifecycle, 'open');
  assert.equal(still.owner_session, null);
  b.close();
});

test('依赖：blocker 变 done 之后 ready=true 且能认领（revision 随写操作递增）', () => {
  const b = newBoard();
  const a = b.createTask({ title: '前置', requestId: null }, 's-a').task;
  const dep = b.createTask({ title: '依赖', requestId: null, blockedBy: [a.task_id] }, 's-a').task;

  b.claimTask(a.task_id, 's-a');
  b.reportEvidence(a.task_id, { executed: true, outcome: 'pass', evidenceRef: artifact() }, 's-a');
  const doneA = b.completeTask(a.task_id, 's-a').task;
  assert.equal(doneA.lifecycle, 'done');
  assert.equal(doneA.revision, 3, 'claim(+1) + complete(+1) 后 revision 应为 3');

  const view = b.getTaskView(dep.task_id);
  assert.equal(view.ready, true, '依赖全部 done 后应 ready');
  const claimed = b.claimTask(dep.task_id, 's-worker');
  assert.equal(claimed.task.lifecycle, 'working');
  assert.equal(claimed.task.revision, 2, '创建 rev1，claim 后 rev2');
  b.close();
});

test('依赖：blockedBy 校验（不存在 / 重复 / 引用已取消任务）都不落库', () => {
  const b = newBoard();
  const a = b.createTask({ title: 'A', requestId: null }, 's-a').task;
  const before = b.listTasks({}).length;

  assert.throws(
    () => b.createTask({ title: 'X', requestId: null, blockedBy: ['t-does-not-exist'] }, 's-a'),
    (err) => err.code === 'TASK_NOT_FOUND',
  );
  assert.throws(
    () => b.createTask({ title: 'Y', requestId: null, blockedBy: [a.task_id, a.task_id] }, 's-a'),
    (err) => err.code === 'INVALID_FIELD',
  );
  const canceled = b.createTask({ title: '被取消的前置', requestId: null }, 's-a').task;
  b.cancelTask(canceled.task_id, 's-a', '不做了');
  assert.throws(
    () => b.createTask({ title: 'Z', requestId: null, blockedBy: [canceled.task_id] }, 's-a'),
    (err) => {
      assert.equal(err.code, 'TASK_NOT_FOUND');
      assert.match(err.message, /取消/);
      return true;
    },
  );
  assert.equal(b.listTasks({}).length, before + 1, '只有那个被取消的任务落库，其余拒绝都不落库');
  b.close();
});

test('取消 blocker 之后：依赖方继续阻塞（只认 done），但新任务照常能建（历史欠账不锁板）', () => {
  const b = newBoard();
  const a = b.createTask({ title: '前置会被取消', requestId: null }, 's-a').task;
  const dep = b.createTask({ title: '依赖它', requestId: null, blockedBy: [a.task_id] }, 's-a').task;
  b.cancelTask(a.task_id, 's-a', 'dropped: 不做了');

  // 依赖方：永远等不到 completed → 保持不 ready、不能 claim（与官方"只认 completed"一致）
  const view = b.getTaskView(dep.task_id);
  assert.equal(view.ready, false);
  assert.deepEqual(view.blockedBy, [a.task_id]);
  assert.throws(() => b.claimTask(dep.task_id, 's-worker'), (err) => err.code === 'BLOCKED_BY_DEPS');
  // 关键回归：这条历史欠账不能让**之后每次 create 都失败**（全图校验只报真问题）
  assert.doesNotThrow(() => b.createTask({ title: '之后的新任务', requestId: null }, 's-a'));
  assert.equal(b.listTasks({}).length, 3);
  b.close();
});

test('依赖图纯函数：抓自依赖与成环（合法图放行）', () => {
  const make = (id, blockedBy) => ({ task_id: id, blockedBy, writeScopes: [], lifecycle: 'open' });

  // 合法：B 依赖 A
  assert.doesNotThrow(() => assertTaskGraph([make('A', [])], make('B', ['A'])));
  // 自依赖
  assert.throws(() => assertTaskGraph([], make('A', ['A'])), (err) => err.code === 'TASK_DEPENDENCY_CYCLE');
  // 成环：A→B 且 B→A（用全量图判，防御未来的 set_dependencies 路径）
  const tasks = [make('A', ['B']), make('B', ['A'])];
  assert.throws(
    () => assertTaskGraph(tasks, make('C', ['A'])),
    (err) => err.code === 'TASK_DEPENDENCY_CYCLE',
  );
  // 缺失依赖
  assert.throws(() => assertTaskGraph([], make('D', ['nope'])), (err) => err.code === 'TASK_NOT_FOUND');
});

test('就绪判定照官方：只认 done；canceled 不算满足，缺失的 blocker 视为未满足', () => {
  const done = { task_id: 't-1', lifecycle: 'done' };
  const canceled = { task_id: 't-2', lifecycle: 'canceled' };
  const tasks = [done, canceled, { task_id: 't-3', lifecycle: 'working' }];
  assert.equal(taskReady(tasks, { blockedBy: [] }), true, '无依赖 = ready');
  assert.equal(taskReady(tasks, { blockedBy: ['t-1'] }), true);
  assert.equal(taskReady(tasks, { blockedBy: ['t-2'] }), false, 'canceled 不算完成（官方只认 completed）');
  assert.equal(taskReady(tasks, { blockedBy: ['t-3'] }), false);
  assert.equal(taskReady(tasks, { blockedBy: ['t-missing'] }), false, '缺失 blocker 按未满足处理');
});

// ───────────────────────── 写域 writeScopes ─────────────────────────

test('写域：归一化去重（反斜杠 / ./ / 尾斜杠）', () => {
  assert.equal(normalizeWriteScope('src\\parser\\'), 'src/parser');
  assert.equal(normalizeWriteScope('./docs'), 'docs');
  assert.equal(normalizeWriteScope('a/b/'), 'a/b');
  for (const bad of ['', '/abs/path', 'C:/x', 'C:\\x', '../up', 'a//b', 'a/./b', 'a/../b']) {
    assert.throws(() => normalizeWriteScope(bad), (err) => err.code === 'INVALID_WRITE_SCOPE', `应拒绝 ${JSON.stringify(bad)}`);
  }
});

test('写域：与进行中任务重叠 → writeScopeWarnings（哪个任务重叠），但**不阻止**认领', () => {
  const b = newBoard();
  const t1 = b.createTask({ title: 'T1', requestId: null, writeScopes: ['src/parser'] }, 's-a').task;
  const t2 = b.createTask({ title: 'T2', requestId: null, writeScopes: ['src/parser/lexer'] }, 's-a').task;
  const t3 = b.createTask({ title: 'T3', requestId: null, writeScopes: ['docs'] }, 's-a').task;

  b.claimTask(t1.task_id, 's-1');
  // T2 与进行中的 T1 写域重叠 —— claim 必须成功（advisory 不是锁）
  const claimed2 = b.claimTask(t2.task_id, 's-2');
  assert.equal(claimed2.task.lifecycle, 'working');
  const warnings = claimed2.task.writeScopeWarnings;
  assert.deepEqual(warnings, [`write scopes overlap with ${t1.task_id}`]);

  // 两边互相看得见
  const view1 = b.getTaskView(t1.task_id);
  assert.deepEqual(view1.writeScopeWarnings, [`write scopes overlap with ${t2.task_id}`]);
  // 不重叠的 T3 没有警告
  assert.deepEqual(b.getTaskView(t3.task_id).writeScopeWarnings, []);
  b.close();
});

test('写域：claim 之前（open 状态）不产生警告 —— 只在"进行中任务之间"提示（官方口径）', () => {
  const b = newBoard();
  const t1 = b.createTask({ title: 'T1', requestId: null, writeScopes: ['src/a'] }, 's-a').task;
  b.createTask({ title: 'T2', requestId: null, writeScopes: ['src/a/b'] }, 's-a');
  assert.deepEqual(b.getTaskView(t1.task_id).writeScopeWarnings, [], 'open 任务不参与重叠警告');
  const tasks = [t1];
  const view = projectTaskView(tasks, { ...t1, lifecycle: 'open' });
  assert.deepEqual(view.writeScopeWarnings, []);
  b.close();
});

// ───────────────────────── 乐观并发 expectedRevision ─────────────────────────

test('CAS：expectedRevision 不一致 → REVISION_CONFLICT（可重试），任务不被改动', () => {
  const b = newBoard();
  const t = b.createTask({ title: 'CAS', requestId: null }, 's-a').task;
  assert.equal(t.revision, 1);

  assert.throws(
    () => b.claimTask(t.task_id, 's-a', { expectedRevision: 99 }),
    (err) => {
      assert.equal(err.code, 'REVISION_CONFLICT');
      assert.equal(err.detail.retryable, true);
      assert.equal(err.detail.expected_revision, 99);
      assert.equal(err.detail.current_revision, 1);
      return true;
    },
  );
  assert.equal(b.getTask(t.task_id).lifecycle, 'open', '冲突不能产生任何写入');

  const ok = b.claimTask(t.task_id, 's-a', { expectedRevision: 1 });
  assert.equal(ok.task.revision, 2);

  // 用旧 revision 完成 → 冲突；用当前 revision → 成功
  b.reportEvidence(t.task_id, { executed: true, outcome: 'pass', evidenceRef: artifact() }, 's-a');
  assert.throws(
    () => b.completeTask(t.task_id, 's-a', { expectedRevision: 1 }),
    (err) => err.code === 'REVISION_CONFLICT',
  );
  const done = b.completeTask(t.task_id, 's-a', { expectedRevision: 2 });
  assert.equal(done.task.lifecycle, 'done');
  b.close();
});

test('CAS：cancel / report 也接受 expectedRevision；不给时行为与 0.6.1 完全一致', () => {
  const b = newBoard();
  const t = b.createTask({ title: 'CAS-2', requestId: null }, 's-a').task;
  // 不给 expectedRevision：老路径，照常成功
  b.reportEvidence(t.task_id, { executed: true, outcome: 'fail', note: '第一版不合格' }, 's-a');
  b.claimTask(t.task_id, 's-a');
  // 旧 revision 取消 → 冲突（claim 已把 revision 推到 2）
  assert.throws(
    () => b.cancelTask(t.task_id, 's-a', 'x', { expectedRevision: 1 }),
    (err) => err.code === 'REVISION_CONFLICT',
  );
  assert.throws(
    () => b.reportEvidence(t.task_id, { executed: true, outcome: 'pass' }, 's-a', { expectedRevision: 1 }),
    (err) => err.code === 'REVISION_CONFLICT',
  );
  const canceled = b.cancelTask(t.task_id, 's-a', 'dropped: 无需动作', { expectedRevision: 2 });
  assert.equal(canceled.task.lifecycle, 'canceled');
  b.close();
});

// ───────────────────────── 错误码分类表 ─────────────────────────

test('TASK_NOT_READY：状态不可认领时给稳定码（直接改库模拟脏状态）', () => {
  const b = newBoard();
  const t = b.createTask({ title: '脏状态', requestId: null }, 's-a').task;
  // 正常工具流程造不出"blocked 但无 owner"的状态；这里直接改库模拟历史/异常数据
  b.db.prepare("UPDATE task SET lifecycle = 'blocked', owner_session = NULL WHERE task_id = ?").run(t.task_id);
  assert.throws(
    () => b.claimTask(t.task_id, 's-new'),
    (err) => {
      assert.equal(err.code, 'TASK_NOT_READY');
      assert.equal(err.detail.lifecycle, 'blocked');
      assert.equal(isRetryableError('TASK_NOT_READY'), false);
      return true;
    },
  );
  b.close();
});

test('错误码分类：终局 vs 可重试（README 口径的机器可读版本）', () => {
  // 终局
  for (const code of ['TASK_NOT_FOUND', 'TASK_CLOSED', 'TASK_DEPENDENCY_CYCLE', 'INVALID_WRITE_SCOPE', 'GATE_REJECTED']) {
    assert.equal(isRetryableError(code), false, `${code} 必须是终局`);
  }
  // 可重试
  for (const code of ['REVISION_CONFLICT', 'CONFLICT', 'ALREADY_CLAIMED', 'LEASE_HELD', 'RATE_LIMITED', 'TIMEOUT']) {
    assert.equal(isRetryableError(code), true, `${code} 必须可重试`);
  }
  // blockedBy 依赖：依赖变化前重试无意义，按终局
  assert.equal(isRetryableError('BLOCKED_BY_DEPS'), false);
  // 官方语义别名（命名可与官方不同，但要对得上号）
  assert.equal(describeErrorCode('TASK_CLOSED').alias, 'TASK_TERMINAL');
  assert.equal(describeErrorCode('ALREADY_CLAIMED').alias, 'LEASE_HELD');
  assert.equal(describeErrorCode('REVISION_CONFLICT').alias, 'TEAM_TASK_STALE_REVISION');
  assert.equal(describeErrorCode('TASK_DEPENDENCY_CYCLE').alias, 'TEAM_TASK_DEPENDENCY_CYCLE');
  // 每个码都必须有 hint（模型看不懂分类时能读到一句话）
  for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
    assert.equal(typeof entry.retryable, 'boolean', `${code} 缺 retryable`);
    assert.ok(String(entry.hint ?? '').length > 0, `${code} 缺 hint`);
  }
  // 未分类码：保守按终局，且如实说未分类
  assert.equal(isRetryableError('SOMETHING_NEW'), false);
  assert.match(describeErrorCode('SOMETHING_NEW').hint, /未分类/);
});

// ───────────────────────── v5 迁移 ─────────────────────────

const V4_TASK_DDL = `
CREATE TABLE task (
  task_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  brief TEXT NOT NULL DEFAULT '',
  acceptance TEXT NOT NULL DEFAULT '',
  lifecycle TEXT NOT NULL,
  owner_session TEXT,
  created_by TEXT NOT NULL,
  request_id TEXT UNIQUE,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  lease_pid INTEGER, lease_start_sec INTEGER, lease_host TEXT,
  require_independent_review INTEGER NOT NULL DEFAULT 0,
  ack_state TEXT NOT NULL DEFAULT 'none',
  ack_deadline_at INTEGER, ack_at INTEGER,
  lease_owner TEXT, lease_until INTEGER,
  stale INTEGER NOT NULL DEFAULT 0, stale_at INTEGER
)`;

test('v5 迁移：手工 v4 库补两列，任务/事件/证据数据一字不丢，且迁移幂等', () => {
  const file = path.join(tempDir(), 'v4-copy.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.exec(V4_TASK_DDL);
  db.exec("CREATE TABLE event (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, task_id TEXT, actor TEXT, payload TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL)");
  db.exec(`CREATE TABLE evidence (
    evidence_id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, actor TEXT NOT NULL,
    executed INTEGER NOT NULL, outcome TEXT NOT NULL, admissible INTEGER NOT NULL,
    reasons TEXT NOT NULL DEFAULT '[]', note TEXT NOT NULL DEFAULT '',
    evidence_ref TEXT, ref_sha256 TEXT, ref_size INTEGER, created_at INTEGER NOT NULL,
    verified_by TEXT, verified_at INTEGER, acceptance_ref TEXT, verification_method TEXT)`);
  db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', '4')").run();
  db.prepare(`INSERT INTO task(task_id,title,lifecycle,created_by,version,created_at,updated_at,owner_session)
              VALUES ('t-old0001','老任务一','working','s-a',7,1000,2000,'s-owner')`).run();
  db.prepare(`INSERT INTO task(task_id,title,lifecycle,created_by,version,created_at,updated_at)
              VALUES ('t-old0002','老任务二','open','s-a',1,1001,2001)`).run();
  db.prepare("INSERT INTO event(kind, task_id, actor, payload, created_at) VALUES ('task.created','t-old0001','s-a','{\"title\":\"老任务一\"}',1000)").run();
  db.prepare("INSERT INTO event(kind, task_id, actor, payload, created_at) VALUES ('task.claimed','t-old0001','s-a','{}',1100)").run();
  db.prepare("INSERT INTO event(kind, task_id, actor, payload, created_at) VALUES ('lease.renewed','t-old0001','s-a','{}',1200)").run();
  db.prepare(`INSERT INTO evidence(task_id,actor,executed,outcome,admissible,reasons,note,created_at)
              VALUES ('t-old0001','s-a',1,'pass',1,'[]','旧证据',1300)`).run();
  db.close();

  const b = new Board(file);
  // 1) schema 版本升级 + v5 两列存在
  assert.equal(b.schemaVersion().version, 5);
  const cols = b.db.prepare('PRAGMA table_info(task)').all().map((c) => String(c.name));
  assert.ok(cols.includes('blocked_by'));
  assert.ok(cols.includes('write_scopes'));
  // 2) 老数据一行不丢、值不变
  const t1 = b.getTask('t-old0001');
  assert.equal(t1.title, '老任务一');
  assert.equal(t1.version, 7);
  assert.equal(t1.owner_session, 's-owner');
  assert.equal(t1.lifecycle, 'working');
  assert.deepEqual(t1.blockedBy, [], '老行依赖读成空数组');
  assert.deepEqual(t1.writeScopes, [], '老行写域读成空数组');
  assert.equal(t1.revision, 7, 'revision 别名应等于 version');
  assert.equal(b.listTasks({}).length, 2);
  assert.equal(b.recentEvents(10).length, 3);
  assert.equal(b.listEvidence('t-old0001').length, 1);
  // 3) 迁移后照常工作（老任务可被新逻辑读写）
  assert.equal(b.getTaskView('t-old0002').ready, true);
  b.claimTask('t-old0002', 's-new');
  assert.equal(b.getTask('t-old0002').lifecycle, 'working');
  b.close();

  // 4) 迁移幂等：再开一次，列数不变、数据不变
  const again = new Board(file);
  const cols2 = again.db.prepare('PRAGMA table_info(task)').all().map((c) => String(c.name));
  assert.deepEqual(cols2, cols, '重复打开不许再改列结构');
  assert.equal(again.schemaVersion().version, 5);
  assert.equal(again.getTask('t-old0001').title, '老任务一');
  assert.equal(again.listTasks({}).length, 2);
  // 迁移后照常工作：老任务被新逻辑认领会多一条 task.claimed，所以是 4 条（不是坏的 3 条丢失）
  assert.equal(again.recentEvents(10).length, 4);
  again.close();
});

test('validateDependencies：非法输入 JSON（非数组）与空 id 都被拒', () => {
  assert.throws(() => validateDependencies('not-array', [], null), (err) => err.code === 'INVALID_INPUT');
  assert.throws(() => validateDependencies([''], [], null), (err) => err.code === 'INVALID_FIELD');
});

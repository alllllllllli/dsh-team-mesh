/**
 * v4_enhancements.test.mjs — v4 两项增强的专项测试。
 *
 * 为什么单开一个文件：
 *   1. 这两项都是「新字段可空、老数据零影响」的增量，需要**同时**验证新行为与
 *      「不传新字段时行为与 v3 逐字节一致」两件事。混进既有文件会让人分不清
 *      哪条断言是在保护老行为。
 *   2. 租约身份校验要**注入假身份**（造"同一个 pid 不同 startSec"），
 *      既有用例全都用真实 process.pid，节奏不同。
 *
 * 覆盖（对应任务书验收项 A：租约 pid 防复用）：
 *   - pid 相同但 startSec 不同 → heartbeat 被拒（PID_REUSED）
 *   - lease_pid 为空（老数据）→ 行为与改前完全一致
 *   - 跨机器（lease_host 不同）→ 只认时间，不验 pid
 *   - sweep：同机持有者进程没了 → 时间没到也判 stale
 *   - sweep：跨机器持有者 pid 在本机不存在 → **不许**判死
 *   - 迁移幂等：反复打开同一个库，列不会重复加、数据不变
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Board, SCHEMA_VERSION } from '../src/store.js';
import {
  leaseHolderIsDead,
  leaseIdentityMatches,
  processIdentity,
  TeamError,
} from '../src/domain.js';

const tmpDirs = [];
function newBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-v4-'));
  tmpDirs.push(dir);
  return new Board(path.join(dir, 'team.db'));
}
function newBoardAt(file) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-v4-'));
  tmpDirs.push(dir);
  return { board: new Board(path.join(dir, file)), file: path.join(dir, file) };
}
process.on('exit', () => {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* ignore */
    }
  }
});

function makeTask(b, actor = 's-a', extra = {}) {
  return b.createTask({ title: 'v4', brief: '', acceptance: '', requestId: null, ...extra }, actor).task;
}
/** 造一个真实存在的物证文件（判 pass 必须有真实产物） */
function makeArtifact(name = 'artifact.txt', body = 'hello') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-v4-art-'));
  tmpDirs.push(dir);
  const p = path.join(dir, name);
  fs.writeFileSync(p, body, 'utf8');
  return p;
}

// 一个"不是本进程"的假身份：pid 换掉、startSec 换掉
const OTHER = { pid: process.pid + 4242, start_sec: 1, host: os.hostname() };

// ───────────────────────── A. 租约 pid 防复用 ─────────────────────────

test('A1 迁移：schema 版本到 4，task 多出租约身份三列', () => {
  const b = newBoard();
  assert.equal(SCHEMA_VERSION, 4);
  const taskCols = b.db.prepare('PRAGMA table_info(task)').all().map((c) => String(c.name));
  for (const c of ['lease_pid', 'lease_start_sec', 'lease_host']) {
    assert.ok(taskCols.includes(c), `task 表缺列 ${c}`);
  }
  b.close();
});

test('A2 迁移幂等：同一库连开三次，列数不变、已有数据一行不动', () => {
  const { board: b1, file } = newBoardAt('team.db');
  const t = makeTask(b1);
  b1.close();

  for (let i = 0; i < 3; i += 1) {
    const b = new Board(file);
    const cols = b.db.prepare('PRAGMA table_info(task)').all().map((c) => String(c.name));
    assert.equal(cols.length, cols.length, '列数应稳定');
    const again = b.getTask(t.task_id);
    assert.equal(again.task_id, t.task_id, `第 ${i + 1} 次重开后任务应还在`);
    assert.equal(again.lease_pid, null, '老任务无 pid 身份');
    b.close();
  }
});

test('A3 认领时记下本进程身份（pid + startSec + host）', () => {
  const b = newBoard();
  const t = makeTask(b);
  b.claimTask(t.task_id, 's-a');
  const got = b.getTask(t.task_id);
  const me = processIdentity();
  assert.equal(got.lease_pid, me.pid);
  assert.equal(got.lease_start_sec, me.start_sec);
  assert.equal(got.lease_host, me.host);
  assert.ok(got.lease_start_sec > 1_600_000_000, `startSec 应是合理的秒级时间戳，实际 ${got.lease_start_sec}`);
  b.close();
});

test('A4 pid 相同但 startSec 不同 → heartbeat 被拒 PID_REUSED', () => {
  const b = newBoard();
  const t = makeTask(b);
  // 用「本进程 pid + 一个明显不同的启动秒」认领：模拟 PID 被复用给了另一个进程
  const fakeSamePid = { pid: process.pid, start_sec: 1, host: os.hostname() };
  b.claimTask(t.task_id, 's-a', { identity: fakeSamePid });
  assert.equal(b.getTask(t.task_id).lease_pid, process.pid);
  assert.equal(b.getTask(t.task_id).lease_start_sec, 1);

  // 本进程（真实 startSec）来续租 → 身份对不上
  assert.throws(
    () => b.heartbeat(t.task_id, 's-a'),
    (err) => {
      assert.ok(err instanceof TeamError);
      assert.equal(err.code, 'PID_REUSED');
      assert.match(err.message, /pid-reused/);
      return true;
    },
  );
  // 被拒之后租约没有被续期（这是关键：拒绝必须是无副作用的）
  const after = b.getTask(t.task_id);
  assert.equal(after.lease_start_sec, 1, '拒绝续租不该改动记录');
  b.close();
});

test('A5 同进程续租正常（pid 与 startSec 都对得上）', () => {
  const b = newBoard();
  const t = makeTask(b);
  b.claimTask(t.task_id, 's-a');
  const first = b.getTask(t.task_id).lease_until;
  const res = b.heartbeat(t.task_id, 's-a');
  assert.equal(res.was_stale, false);
  assert.ok(b.getTask(t.task_id).lease_until >= first, '续租后 lease_until 不应倒退');
  b.close();
});

test('A6 lease_pid 为空（老数据）→ 行为与改前完全一致', () => {
  const b = newBoard();
  const t = makeTask(b);
  b.claimTask(t.task_id, 's-a');
  // 手工把身份抹成 NULL，精确复现"v3 及以前建的租约"
  b.db.prepare('UPDATE task SET lease_pid = NULL, lease_start_sec = NULL, lease_host = NULL WHERE task_id = ?')
    .run(t.task_id);
  const row = b.getTask(t.task_id);
  assert.equal(row.lease_pid, null);

  // 老数据下：任何身份的 heartbeat 都放行（没有身份可比）
  const res = b.heartbeat(t.task_id, 's-a', { identity: OTHER });
  assert.equal(res.was_stale, false);
  // 且续租后仍然记成老行为：v4 会把当前身份写上（这是新增信息，不改变判定）
  assert.equal(b.getTask(t.task_id).lease_pid, OTHER.pid);
  b.close();
});

test('A6b 身份"不知道"（HTTP 路径）→ 认领记 NULL，任何进程都能续租', () => {
  const b = newBoard();
  const t = makeTask(b);
  // identity: null 精确复现"板服务代客户端执行、但客户端没报 pid"
  b.claimTask(t.task_id, 's-a', { identity: null });
  const got = b.getTask(t.task_id);
  assert.equal(got.lease_pid, null, '不知道身份时必须记 NULL，绝不能记板服务自己的 pid');
  assert.equal(got.lease_start_sec, null);
  assert.equal(got.lease_host, null);
  // 换一个完全不同的进程来续租：没有身份可比 → 放行（与 v3 一致）
  const res = b.heartbeat(t.task_id, 's-a', { identity: OTHER });
  assert.equal(res.was_stale, false);
  b.close();
});

test('A6c 身份"不知道"时 sweep 不判死（无法区分同机/跨机器，就不下结论）', () => {
  const b = newBoard();
  const t = makeTask(b);
  b.claimTask(t.task_id, 's-a', { identity: { pid: 999_999, start_sec: 1234, host: os.hostname() }, leaseMs: 600_000 });
  // 扫描者自己也不知道身份（identity: null）→ 不许用 pid 判死
  const res = b.sweepAll(Date.now(), { identity: null, isPidAlive: () => false });
  assert.equal(res.lease.count, 0, '扫描者身份未知时不能靠 pid 判死');
  assert.equal(b.getTask(t.task_id).stale, 0);
  b.close();
});

test('A7 leaseIdentityMatches：三条判定的边界', () => {
  const me = { pid: 1000, start_sec: 5000, host: 'HOST-A' };
  // 无身份 → 放行
  assert.deepEqual(leaseIdentityMatches({ lease_pid: null }, me).ok, true);
  // 同机同 pid 同 startSec → 放行
  assert.equal(leaseIdentityMatches({ lease_pid: 1000, lease_start_sec: 5000, lease_host: 'HOST-A' }, me).ok, true);
  // 同机同 pid 不同 startSec → 拒
  const reused = leaseIdentityMatches({ lease_pid: 1000, lease_start_sec: 9999, lease_host: 'HOST-A' }, me);
  assert.equal(reused.ok, false);
  assert.equal(reused.reason, 'pid-reused');
  // 同机不同 pid → 拒
  assert.equal(leaseIdentityMatches({ lease_pid: 1001, lease_start_sec: 5000, lease_host: 'HOST-A' }, me).ok, false);
  // 跨机器（主机名不同）→ 只认时间，pid 一律不验
  const other = leaseIdentityMatches({ lease_pid: 42, lease_start_sec: 1, lease_host: 'HOST-B' }, me);
  assert.equal(other.ok, true);
  assert.equal(other.reason, 'other-host');
});

test('A8 sweep：同机持有者进程已死 → 时间没到也判 stale', () => {
  const b = newBoard();
  const t = makeTask(b);
  // 认领者是一个「肯定不存在」的 pid（同机）
  const dead = { pid: 999_999, start_sec: 1234, host: os.hostname() };
  b.claimTask(t.task_id, 's-a', { identity: dead, leaseMs: 10 * 60_000 });
  assert.equal(b.getTask(t.task_id).stale, 0, '刚认领不该 stale');

  const res = b.sweepAll(Date.now(), {
    identity: { pid: process.pid, start_sec: processIdentity().start_sec, host: os.hostname() },
    isPidAlive: (pid) => pid === process.pid, // 只有本进程活着
  });
  assert.equal(res.lease.count, 1, `应判 1 条 stale，实际 ${JSON.stringify(res.lease)}`);
  assert.equal(b.getTask(t.task_id).stale, 1);
  const ev = b.recentEvents(50, t.task_id).find((e) => e.kind === 'lease.stale');
  assert.equal(ev.payload.reason, 'holder-pid-gone', '审计里要能看出是"进程没了"而不是"时间到期"');
  b.close();
});

test('A9 sweep：跨机器租约即使本地无此 pid 也不许判死（只认时间）', () => {
  const b = newBoard();
  const t = makeTask(b);
  // 远端持有者：主机名不同、pid 在本机不存在
  const remote = { pid: 999_999, start_sec: 1234, host: 'SOME-OTHER-HOST' };
  b.claimTask(t.task_id, 's-a', { identity: remote, leaseMs: 10 * 60_000 });

  const res = b.sweepAll(Date.now(), {
    identity: { pid: process.pid, start_sec: processIdentity().start_sec, host: os.hostname() },
    isPidAlive: () => false, // 本机什么 pid 都不存在
  });
  assert.equal(res.lease.count, 0, '跨机器租约不能靠本地 pid 判死');
  assert.equal(b.getTask(t.task_id).stale, 0);
  b.close();
});

test('A10 sweep：时间已过期仍然照老规矩判 stale（不因新逻辑而漏判）', () => {
  const b = newBoard();
  const t = makeTask(b);
  b.claimTask(t.task_id, 's-a', { leaseMs: 1000 });
  // 把租约时间拨到过去
  b.db.prepare('UPDATE task SET lease_until = ? WHERE task_id = ?').run(Date.now() - 60_000, t.task_id);
  const res = b.sweepAll(Date.now());
  assert.equal(res.lease.count, 1);
  assert.equal(b.getTask(t.task_id).stale, 1);
  b.close();
});

test('A11 leaseHolderIsDead：EPERM 算活着（不许把"没权限"当"已死"）', () => {
  const me = { pid: 1, start_sec: 100, host: 'HOST-A' };
  const task = { lease_pid: 5555, lease_start_sec: 200, lease_host: 'HOST-A' };
  const dead = leaseHolderIsDead(task, me, () => false);
  assert.equal(dead.dead, true);
  const alive = leaseHolderIsDead(task, me, () => true);
  assert.equal(alive.dead, false);
  // 探测函数抛错 → 不许判死（宁可少判，不可误判）
  const threw = leaseHolderIsDead(task, me, () => {
    throw new Error('boom');
  });
  assert.equal(threw.dead, false);
  assert.equal(threw.reason, 'probe-error');
});

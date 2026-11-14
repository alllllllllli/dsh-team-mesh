/**
 * adoption.test.mjs — 0.4「三证据收养」的验收（`mesh_task_adopt` / `POST /task/adopt`）。
 *
 * 为什么单开一个文件、且必须"真跑"：
 *   收养要回答的是"原持有者是不是真的死了"，这个问题**只能靠真实 pid 与真实事件流**判定。
 *   用 mock 替掉 pid 探测或事件表，就等于把要验证的东西替掉了。所以本文件分三层：
 *
 *     1. 纯函数层（`evaluateAdoption`）：三证据的每个分支都注入 now / identity / isPidAlive，
 *        把"时间没到 / 持有者还活着 / 事件流矛盾 / 跨机无法验证"逐条钉死。
 *     2. 本地板层（`Board.adoptTask`）：**真起子进程再杀掉**，走真实的 `process.kill(pid,0)`
 *        验证"同机 pid 真的没了"；另一条用例让子进程继续活着，验证 `ADOPT_HOLDER_ALIVE`。
 *     3. HTTP 层（真起板服务、随机端口、临时库）：走真 socket。子进程通过裸 HTTP 认领，
 *        它退出后由**板服务**去验 pid —— 这正是"板服务只能验自己所在主机的 pid"的落点。
 *
 * 三条最容易写错的边界，也是本文件的主要断言：
 *   - 跨机租约**必须**标 unverified，默认拒绝，且放行时 payload 里 unverified=true
 *     （绝不把未验证写成已验证）；
 *   - 判定"过期"用的是**把判定时刻推后**，不是把 lease_until 拨到过去 ——
 *     后者会让 claim 事件落在 lease_until 之后，反而制造 E3 的"数据自相矛盾"；
 *   - claim 的旧行为一个字都不能变（stale 后照样能抢），adopt 是更严的**可选**路径。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import {
  ADOPT_CODES,
  evaluateAdoption,
  LEASE_ACTIVITY_EVENT_KINDS,
  processIdentity,
  TeamError,
} from '../src/domain.js';
import { createHandlers } from '../src/handlers.js';
import { RemoteBoard } from '../src/remote.js';
import { startBoardService } from '../src/server.js';
import { adoptSpec, TOOL_NAMES } from '../src/spec.js';
import { Board, SCHEMA_VERSION } from '../src/store.js';

const TOKEN = `w-${crypto.randomUUID()}`;
const READ_TOKEN = `r-${crypto.randomUUID()}`;
const HOST = os.hostname();

const tmpDirs = [];
const boards = [];
const services = [];
const children = [];

function mkTmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function newBoard() {
  const b = new Board(path.join(mkTmp('mesh-adopt-'), 'team.db'));
  boards.push(b);
  return b;
}

function makeTask(b, actor = 's-owner', title = 'adopt') {
  return b.createTask({ title, brief: '', acceptance: '', requestId: null }, actor).task;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const IDENTITY = processIdentity();

/** 一个"同机但肯定不存在的 pid"的持有者身份：用来走 verified-dead 分支。 */
function deadIdentity(pid = 999_999) {
  return { pid, start_sec: 1_234_567, host: HOST };
}

/**
 * 起一个真的、活着的子进程（等它就绪再返回）。
 * 用途：证明"pid 真的存在时收养会被拒"。
 */
function spawnSleeper() {
  const script = "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);";
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let out = '';
    const errChunks = [];
    const timer = setTimeout(() => reject(new Error(`子进程 10s 内没就绪：${errChunks.join('')}`)), 10000);
    child.stdout.on('data', (c) => {
      out += c.toString('utf8');
      if (out.includes('ready')) {
        clearTimeout(timer);
        resolve({ child, pid: child.pid });
      }
    });
    child.stderr.on('data', (c) => errChunks.push(c.toString('utf8')));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** 杀掉子进程并等到它真的退出（Windows 下 close 事件 = 进程回收完毕）。 */
function killAndWait(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('close', resolve);
    try {
      child.kill('SIGTERM');
    } catch {
      resolve();
    }
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
      resolve();
    }, 4000).unref?.();
  });
}

/** 轮询等待某个 pid 在系统里消失（给 OS 回收留时间）。 */
async function waitPidGone(pid) {
  for (let i = 0; i < 100; i += 1) {
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (!alive) return true;
    await sleep(20);
  }
  return false;
}

// ─────────────────────── 纯函数层：三证据逐分支 ───────────────────────

const LEASE_UNTIL = 1_000_000;
const NOW_AFTER = LEASE_UNTIL + 1000;

/** 造一条"看起来正常"的任务行（形状与 Board.rowToTask 一致的关键字段）。 */
function fakeTask(over = {}) {
  return {
    task_id: 't-00000001',
    title: 'x',
    lifecycle: 'working',
    owner_session: 's-old',
    lease_until: LEASE_UNTIL,
    stale: 0,
    stale_at: null,
    lease_pid: 4242,
    lease_start_sec: 999,
    lease_host: 'HOST-A',
    ...over,
  };
}

function claimEvent(at = LEASE_UNTIL - 100_000, seq = 1) {
  return { kind: 'task.claimed', created_at: at, seq };
}

function pureVerdict(over = {}) {
  return evaluateAdoption({
    task: fakeTask(),
    events: [claimEvent()],
    identity: { pid: 100, start_sec: 5000, host: 'HOST-A' },
    isPidAlive: () => false,
    now: NOW_AFTER,
    ...over,
  });
}

test('P1 任务不存在 / 已终结 / 无负责人 / 状态非法 → 各自的稳定码', () => {
  assert.equal(evaluateAdoption({ task: null }).code, 'TASK_NOT_FOUND');
  assert.equal(evaluateAdoption({ task: fakeTask({ lifecycle: 'done' }) }).code, 'TASK_CLOSED');
  assert.equal(evaluateAdoption({ task: fakeTask({ lifecycle: 'canceled' }) }).code, 'TASK_CLOSED');
  assert.equal(
    evaluateAdoption({ task: fakeTask({ owner_session: null, lifecycle: 'open' }) }).code,
    ADOPT_CODES.NOT_CLAIMED,
  );
  assert.equal(
    evaluateAdoption({ task: fakeTask({ lifecycle: 'open' }) }).code,
    ADOPT_CODES.STATE_INVALID,
  );
});

test('P2 E1：租约还在有效期且未 stale → ADOPT_NOT_STALE，overrun_ms 为负数（不抹成 0）', () => {
  const v = pureVerdict({ now: LEASE_UNTIL - 5_000 });
  assert.equal(v.allowed, false);
  assert.equal(v.code, ADOPT_CODES.NOT_STALE);
  assert.match(v.message, /ADOPT_NOT_STALE/);
  assert.equal(v.evidence.time.expired, false);
  assert.equal(v.evidence.time.overrun_ms, -5_000, '时间上还没到期，必须如实记负数');
});

test('P3 E1：stale=1 放行时间证据（即使 lease_until 还没到）', () => {
  const v = pureVerdict({
    task: fakeTask({ stale: 1, stale_at: LEASE_UNTIL - 60_000 }),
    // 判定时刻比 lease_until 早：只能靠 stale 标记
    now: LEASE_UNTIL - 1_000,
  });
  assert.equal(v.allowed, true, `应允许，实际 ${JSON.stringify(v)}`);
  assert.equal(v.evidence.time.stale, true);
  assert.equal(v.evidence.time.expired, false);
  assert.equal(v.evidence.time.overrun_ms, -1_000);
});

test('P4 E2：同机 pid 已不存在 → verified-dead，允许收养', () => {
  const v = pureVerdict({ isPidAlive: () => false });
  assert.equal(v.allowed, true);
  assert.equal(v.unverified, false);
  assert.equal(v.verdict, 'adopted-verified');
  assert.equal(v.evidence.identity.verdict, 'verified-dead');
  assert.equal(v.evidence.identity.checked_pid, true);
  assert.equal(v.evidence.identity.reason, 'holder-pid-gone');
});

test('P5 E2：同机 pid 还活着 → ADOPT_HOLDER_ALIVE（不许抢活着的人的活）', () => {
  const v = pureVerdict({ isPidAlive: () => true });
  assert.equal(v.allowed, false);
  assert.equal(v.code, ADOPT_CODES.HOLDER_ALIVE);
  assert.equal(v.evidence.identity.verdict, 'alive');
  assert.match(v.message, /heartbeat/);
});

test('P6 E2：探测函数抛错 ≠ 死了 → unverified，默认拒绝', () => {
  const v = pureVerdict({
    isPidAlive: () => {
      throw new Error('boom');
    },
  });
  assert.equal(v.allowed, false);
  assert.equal(v.code, ADOPT_CODES.EVIDENCE_UNVERIFIABLE);
  assert.equal(v.evidence.identity.reason, 'probe-error');
});

test('P7 E2：跨机 → 必须 unverified（checked_pid=false），默认拒绝且理由说明是能力边界', () => {
  const v = pureVerdict({ task: fakeTask({ lease_host: 'HOST-B' }) });
  assert.equal(v.allowed, false);
  assert.equal(v.code, ADOPT_CODES.EVIDENCE_UNVERIFIABLE);
  assert.equal(v.evidence.identity.verdict, 'unverified');
  assert.equal(v.evidence.identity.reason, 'unverified-cross-host');
  assert.equal(v.evidence.identity.checked_pid, false, '跨机绝不允许标"已验证"');
  assert.match(v.message, /不能代替远端机器验 pid/);
});

test('P8 E2：记录里没有身份（pid/host NULL，v3 老数据）→ unverified', () => {
  const v = pureVerdict({
    task: fakeTask({ lease_pid: null, lease_start_sec: null, lease_host: null }),
  });
  assert.equal(v.allowed, false);
  assert.equal(v.code, ADOPT_CODES.EVIDENCE_UNVERIFIABLE);
  assert.equal(v.evidence.identity.reason, 'unverified-no-identity');
});

test('P9 E2：判定者自己不知道主机名 → 不许验 pid，只能 unverified', () => {
  const v = pureVerdict({ identity: { pid: 100, start_sec: 5000, host: null } });
  assert.equal(v.allowed, false);
  assert.equal(v.code, ADOPT_CODES.EVIDENCE_UNVERIFIABLE);
  assert.equal(v.evidence.identity.reason, 'no-judge-host');
});

test('P10 E3：没有租约类事件 → ADOPT_EVIDENCE_INSUFFICIENT（来历不明）', () => {
  const v = pureVerdict({ events: [{ kind: 'task.created', created_at: 1, seq: 1 }] });
  assert.equal(v.allowed, false);
  assert.equal(v.code, ADOPT_CODES.EVIDENCE_INSUFFICIENT);
  assert.match(v.message, /找不到任何租约类事件/);
});

test('P11 E3：最后一条租约活动晚于 lease_until（过期后仍有续租痕迹）→ 拒绝', () => {
  const v = pureVerdict({
    events: [
      { kind: 'lease.renewed', created_at: LEASE_UNTIL + 500, seq: 7 },
      claimEvent(),
    ],
  });
  assert.equal(v.allowed, false);
  assert.equal(v.code, ADOPT_CODES.EVIDENCE_INSUFFICIENT);
  assert.equal(v.evidence.event.last_before_lease_until, false);
  assert.match(v.message, /互相矛盾/);
});

test('P12 E3：事件扫描被截断且没有租约事件 → 不许把"没看到"当"没有"', () => {
  const v = pureVerdict({
    events: [{ kind: 'evidence.recorded', created_at: LEASE_UNTIL - 1, seq: 9 }],
    eventScanTruncated: true,
  });
  assert.equal(v.allowed, false);
  assert.equal(v.code, ADOPT_CODES.EVIDENCE_INSUFFICIENT);
  assert.equal(v.evidence.event.truncated, true);
  assert.match(v.message, /截断/);
});

test('P13 allowUnverifiedAdoption=true 只放宽"身份未验证"，不妨宽时间/事件证据', () => {
  // 跨机 + 允许未验证 → 放行，但 unverified 必须为 true
  const crossHost = pureVerdict({
    task: fakeTask({ lease_host: 'HOST-B' }),
    allowUnverifiedAdoption: true,
  });
  assert.equal(crossHost.allowed, true);
  assert.equal(crossHost.unverified, true);
  assert.equal(crossHost.verdict, 'adopted-unverified');
  assert.equal(crossHost.policy.allow_unverified_adoption, true);

  // 允许未验证也不能绕过 E3
  const insufficient = pureVerdict({ events: [], allowUnverifiedAdoption: true });
  assert.equal(insufficient.allowed, false);
  assert.equal(insufficient.code, ADOPT_CODES.EVIDENCE_INSUFFICIENT);

  // 也不能绕过"持有者还活着"
  const alive = pureVerdict({ isPidAlive: () => true, allowUnverifiedAdoption: true });
  assert.equal(alive.allowed, false);
  assert.equal(alive.code, ADOPT_CODES.HOLDER_ALIVE);

  // 也不能绕过 E1
  const fresh = pureVerdict({ now: LEASE_UNTIL - 1, allowUnverifiedAdoption: true });
  assert.equal(fresh.allowed, false);
  assert.equal(fresh.code, ADOPT_CODES.NOT_STALE);
});

test('P14 判定顺序：持有者活着时优先报 HOLDER_ALIVE（而不是被 E3/策略盖掉）', () => {
  const v = pureVerdict({ events: [], isPidAlive: () => true });
  assert.equal(v.code, ADOPT_CODES.HOLDER_ALIVE);
});

test('P15 LEASE_ACTIVITY_EVENT_KINDS：lease.stale 不算持有者活动（否则证据会自我污染）', () => {
  assert.ok(LEASE_ACTIVITY_EVENT_KINDS.includes('task.claimed'));
  assert.ok(LEASE_ACTIVITY_EVENT_KINDS.includes('lease.renewed'));
  assert.ok(LEASE_ACTIVITY_EVENT_KINDS.includes('lease.revived'));
  assert.ok(!LEASE_ACTIVITY_EVENT_KINDS.includes('lease.stale'), '扫描者的事件不是持有者活动');
  assert.ok(!LEASE_ACTIVITY_EVENT_KINDS.includes('evidence.recorded'));
});

// ─────────────────────── 本地板层：真实 pid ───────────────────────

test('B0 claim 旧行为不变：stale 后照样能抢（不需要三证据）', () => {
  const b = newBoard();
  const t = makeTask(b);
  b.claimTask(t.task_id, 's-old', { identity: deadIdentity(), leaseMs: 600_000 });
  // 让扫描把"同机持有者已死"标成 stale
  b.sweepAll(Date.now(), { identity: IDENTITY, isPidAlive: () => false });
  assert.equal(b.getTask(t.task_id).stale, 1);

  // 老路径：另一个会话直接 claim 就能接管，与改造前完全一致
  const res = b.claimTask(t.task_id, 's-new');
  assert.equal(res.deduped, false);
  assert.equal(b.getTask(t.task_id).owner_session, 's-new');
  const kinds = b.recentEvents(50, t.task_id).map((e) => e.kind);
  assert.ok(kinds.includes('lease.taken_over'), '旧路径仍留 lease.taken_over');
  assert.ok(!kinds.includes('lease.adopted'), 'claim 不该产生收养事件');
});

test('B1 本地收养成功：三证据落库 + 新负责人拿到有效租约，事件 payload 完整', () => {
  const b = newBoard();
  const t = makeTask(b);
  b.claimTask(t.task_id, 's-old', { identity: deadIdentity(), leaseMs: 600_000 });
  const claimed = b.getTask(t.task_id);

  const res = b.adoptTask(t.task_id, 's-new', {
    isPidAlive: () => false,
    now: claimed.lease_until + 1000,
  });

  assert.equal(res.adopted, true);
  assert.equal(res.unverified, false);
  assert.equal(res.from, 's-old');
  const after = b.getTask(t.task_id);
  assert.equal(after.owner_session, 's-new');
  assert.equal(after.lifecycle, 'working');
  assert.equal(after.stale, 0);
  assert.equal(after.stale_at, null);
  assert.equal(after.lease_owner, 's-new');
  // 收养方没有显式上报身份 → 走本进程身份（与 claim 的默认语义一致）
  assert.equal(after.lease_pid, process.pid);
  assert.equal(after.lease_host, HOST);
  assert.ok(after.lease_until > claimed.lease_until, '新租约应晚于旧租约');

  const ev = b.recentEvents(50, t.task_id).find((e) => e.kind === 'lease.adopted');
  assert.ok(ev !== undefined, '必须落 lease.adopted 事件');
  assert.equal(ev.actor, 's-new');
  assert.equal(ev.payload.from, 's-old');
  assert.equal(ev.payload.verdict, 'adopted-verified');
  assert.equal(ev.payload.unverified, false);
  assert.equal(ev.payload.policy.allow_unverified_adoption, false);
  assert.equal(ev.payload.prev_lease_pid, claimed.lease_pid);
  // 三类证据必须都在 payload 里，而不是只写一句"已收养"
  assert.equal(ev.payload.evidence.time.expired, true);
  assert.equal(ev.payload.evidence.identity.verdict, 'verified-dead');
  assert.equal(ev.payload.evidence.event.last_kind, 'task.claimed');
  assert.equal(ev.payload.evidence.event.renewals_after_lease_until, 0);

  // 新负责人能正常心跳续租
  const hb = b.heartbeat(t.task_id, 's-new');
  assert.equal(hb.was_stale, false);
});

test('B2 真起子进程再杀掉：默认探测（process.kill(pid,0)）确认 pid 已消失 → verified', async () => {
  const b = newBoard();
  const t = makeTask(b);
  const sleeper = await spawnSleeper();
  b.claimTask(t.task_id, 's-old', {
    identity: { pid: sleeper.pid, start_sec: 1_111, host: HOST },
    leaseMs: 600_000,
  });
  const claimed = b.getTask(t.task_id);
  assert.equal(claimed.lease_pid, sleeper.pid);

  await killAndWait(sleeper.child);
  assert.equal(await waitPidGone(sleeper.pid), true, '子进程退出后 pid 应真的不存在');

  // **不注入** isPidAlive：走真实的 process.kill(pid, 0)
  const res = b.adoptTask(t.task_id, 's-new', { now: claimed.lease_until + 1000 });
  assert.equal(res.adopted, true, `真实 pid 已消失应允许收养，实际 ${JSON.stringify(res.evidence)}`);
  assert.equal(res.unverified, false);
  assert.equal(res.evidence.identity.verdict, 'verified-dead');
  assert.equal(res.evidence.identity.reason, 'holder-pid-gone');
});

test('B3 真子进程还活着：默认探测确认存活 → ADOPT_HOLDER_ALIVE', async () => {
  const b = newBoard();
  const t = makeTask(b);
  const sleeper = await spawnSleeper();
  b.claimTask(t.task_id, 's-old', {
    identity: { pid: sleeper.pid, start_sec: 2_222, host: HOST },
    leaseMs: 600_000,
  });
  const claimed = b.getTask(t.task_id);
  try {
    assert.throws(
      () => b.adoptTask(t.task_id, 's-new', { now: claimed.lease_until + 1000 }),
      (err) => {
        assert.ok(err instanceof TeamError);
        assert.equal(err.code, ADOPT_CODES.HOLDER_ALIVE);
        assert.equal(err.detail?.evidence?.identity?.verdict, 'alive');
        return true;
      },
    );
    // 被拒不改动任何东西
    assert.equal(b.getTask(t.task_id).owner_session, 's-old');
    assert.equal(b.getTask(t.task_id).lease_pid, sleeper.pid);
  } finally {
    await killAndWait(sleeper.child);
  }
});

test('B4 跨机持有者：默认拒绝（ADOPT_EVIDENCE_UNVERIFIABLE），允许后放行且 unverified=true', () => {
  const b = newBoard();
  const t = makeTask(b);
  b.claimTask(t.task_id, 's-old', {
    identity: { pid: 999_999, start_sec: 1, host: 'SOME-OTHER-HOST' },
    leaseMs: 600_000,
  });
  const claimed = b.getTask(t.task_id);
  const now = claimed.lease_until + 1000;

  assert.throws(
    () => b.adoptTask(t.task_id, 's-new', { now }),
    (err) => {
      assert.equal(err.code, ADOPT_CODES.EVIDENCE_UNVERIFIABLE);
      assert.equal(err.detail.evidence.identity.reason, 'unverified-cross-host');
      assert.equal(err.detail.evidence.identity.checked_pid, false);
      return true;
    },
  );

  const res = b.adoptTask(t.task_id, 's-new', { now, allowUnverifiedAdoption: true });
  assert.equal(res.adopted, true);
  assert.equal(res.unverified, true);
  assert.equal(res.verdict, 'adopted-unverified');
  const ev = b.recentEvents(50, t.task_id).find((e) => e.kind === 'lease.adopted');
  assert.equal(ev.payload.unverified, true, '放行未验证收养时 payload 必须如实标 true');
  assert.equal(ev.payload.evidence.identity.reason, 'unverified-cross-host');
});

test('B5 时间证据不成立 → ADOPT_NOT_STALE（还没到期、也没 stale）', () => {
  const b = newBoard();
  const t = makeTask(b);
  b.claimTask(t.task_id, 's-old', { identity: deadIdentity(), leaseMs: 600_000 });
  assert.throws(
    () => b.adoptTask(t.task_id, 's-new', { isPidAlive: () => false }),
    (err) => {
      assert.equal(err.code, ADOPT_CODES.NOT_STALE);
      return true;
    },
  );
});

test('B6 事件证据不成立：删掉认领事件（来历不明）→ ADOPT_EVIDENCE_INSUFFICIENT', () => {
  const b = newBoard();
  const t = makeTask(b);
  b.claimTask(t.task_id, 's-old', { identity: deadIdentity(), leaseMs: 600_000 });
  const claimed = b.getTask(t.task_id);
  b.db.prepare("DELETE FROM event WHERE task_id = ? AND kind = 'task.claimed'").run(t.task_id);
  assert.throws(
    () => b.adoptTask(t.task_id, 's-new', { isPidAlive: () => false, now: claimed.lease_until + 1000 }),
    (err) => {
      assert.equal(err.code, ADOPT_CODES.EVIDENCE_INSUFFICIENT);
      assert.match(err.message, /找不到任何租约类事件/);
      return true;
    },
  );
});

test('B7 v3 老数据（没有租约身份）：只能 unverified，默认拒绝', () => {
  const b = newBoard();
  const t = makeTask(b);
  b.claimTask(t.task_id, 's-old', { identity: null, leaseMs: 600_000 });
  const claimed = b.getTask(t.task_id);
  assert.equal(claimed.lease_pid, null);
  assert.throws(
    () => b.adoptTask(t.task_id, 's-new', { now: claimed.lease_until + 1000 }),
    (err) => {
      assert.equal(err.code, ADOPT_CODES.EVIDENCE_UNVERIFIABLE);
      assert.equal(err.detail.evidence.identity.reason, 'unverified-no-identity');
      return true;
    },
  );
});

test('B8 stale 由扫描标记（持有者已死）→ 不需要把时钟推后也能收养', () => {
  const b = newBoard();
  const t = makeTask(b);
  b.claimTask(t.task_id, 's-old', { identity: deadIdentity(888_888), leaseMs: 600_000 });
  b.sweepAll(Date.now(), { identity: IDENTITY, isPidAlive: () => false });
  assert.equal(b.getTask(t.task_id).stale, 1);

  // 判定时刻就是现在：E1 靠 stale 标记，E2 靠真实探测（888888 不存在）
  const res = b.adoptTask(t.task_id, 's-new', {});
  assert.equal(res.adopted, true);
  assert.equal(res.unverified, false);
  assert.equal(res.evidence.time.stale, true);
  assert.equal(res.evidence.time.expired, false);
});

test('B9 同一个进程自己持有租约时不许"收养"自己的任务 → ADOPT_HOLDER_ALIVE(self)', () => {
  const b = newBoard();
  const t = makeTask(b);
  b.claimTask(t.task_id, 's-old', { leaseMs: 600_000 }); // identity 默认 = 本进程
  const claimed = b.getTask(t.task_id);
  assert.equal(claimed.lease_pid, process.pid);
  assert.throws(
    () => b.adoptTask(t.task_id, 's-new', { now: claimed.lease_until + 1000 }),
    (err) => {
      assert.equal(err.code, ADOPT_CODES.HOLDER_ALIVE);
      assert.equal(err.detail.evidence.identity.reason, 'self');
      return true;
    },
  );
});

test('B10 收养不破坏 schema：仍是 v4，没有新增租约列', () => {
  const b = newBoard();
  assert.equal(SCHEMA_VERSION, 4);
  assert.equal(b.schemaVersion().version, 4);
  const cols = b.db.prepare('PRAGMA table_info(task)').all().map((c) => String(c.name));
  const leaseCols = cols.filter((c) => c.startsWith('lease_')).sort();
  assert.deepEqual(leaseCols, ['lease_host', 'lease_owner', 'lease_pid', 'lease_start_sec', 'lease_until']);
  assert.equal(cols.includes('adopted_by'), false, '收养只复用已有列，不许加列');
});

// ─────────────────────── HTTP 层：真板服务 + 真 socket ───────────────────────

async function startService(overrides = {}) {
  const dir = overrides.dir ?? mkTmp('mesh-adopt-http-');
  const svc = await startBoardService({
    boardPath: path.join(dir, 'board.db'),
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    readToken: READ_TOKEN,
    sweep: false,
    logger: { warn: () => {}, info: () => {} },
    ...overrides,
  });
  services.push(svc);
  return { svc, dir, endpoint: `http://127.0.0.1:${svc.port}` };
}

async function rawRequest(endpoint, pathname, { method = 'GET', body = undefined, token = TOKEN } = {}) {
  const headers = {};
  if (token !== null) headers['x-team-token'] = token;
  let payload;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(endpoint + pathname, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, body: json };
}

function newTaskRemote(client, actor, title) {
  return client.createTask({ title, brief: '', acceptance: '', requestId: null }, actor);
}

/**
 * 一个**独立进程**通过裸 HTTP 认领任务，认领完保持存活等待父进程杀掉。
 * 返回 claim 的 pid / 身份 / 认领后的任务行 —— 之后由板服务去判这个 pid 死没死。
 */
function claimFromLiveChild(endpoint, taskId, actor, leaseMs) {
  const script = `
const os = require('node:os');
const { EP, TOKEN, TASK, ACTOR, LEASE_MS } = process.env;
const identity = {
  pid: process.pid,
  start_sec: Math.floor((Date.now() - process.uptime() * 1000) / 1000),
  host: os.hostname(),
};
(async () => {
  const res = await fetch(EP + '/task/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-team-token': TOKEN },
    body: JSON.stringify({ taskId: TASK, actor: ACTOR, leaseMs: Number(LEASE_MS), leaseIdentity: identity }),
  });
  const body = await res.json();
  process.stdout.write(JSON.stringify({ ok: body.ok === true, status: res.status, pid: process.pid, identity, task: body.task }) + '\\n');
  setInterval(() => {}, 1000);
})().catch((err) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(err) }) + '\\n');
  process.exit(1);
});
`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], {
      env: {
        ...process.env,
        EP: endpoint,
        TOKEN,
        TASK: taskId,
        ACTOR: actor,
        LEASE_MS: String(leaseMs),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let buf = '';
    let errBuf = '';
    const timer = setTimeout(() => reject(new Error(`认领子进程 15s 无输出：${errBuf.slice(0, 500)}`)), 15000);
    child.stdout.on('data', (c) => {
      buf += c.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer);
      try {
        const info = JSON.parse(buf.slice(0, nl));
        resolve({ child, ...info });
      } catch (err) {
        reject(new Error(`认领子进程输出非 JSON：${buf.slice(0, 300)}（${err?.message}）`));
      }
    });
    child.stderr.on('data', (c) => {
      errBuf += c.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** 等到任务的 lease_until 之后（走真时钟，HTTP 路径无法注入 now）。 */
async function waitLeaseExpired(client, taskId, marginMs = 60) {
  const task = await client.getTask(taskId);
  assert.ok(typeof task.lease_until === 'number');
  const wait = task.lease_until - Date.now() + marginMs;
  if (wait > 0) await sleep(wait);
  return task;
}

before(async () => {
  // 本文件断言"默认策略"，宿主机上的环境变量不许把它改掉
  delete process.env.DSH_TEAM_BOARD_ALLOW_UNVERIFIED_ADOPT;
  assert.notEqual(HOST, '', '测试需要真实主机名');
});

after(async () => {
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* 已退出 */
    }
  }
  for (const svc of services) {
    try {
      await svc.close();
    } catch {
      /* ignore */
    }
  }
  for (const b of boards) {
    try {
      b.close();
    } catch {
      /* ignore */
    }
  }
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* Windows 上 WAL 句柄偶尔还没放干净 */
    }
  }
});

test('H1 POST /task/adopt 是写类路由：无密钥 401、只读密钥 401、写密钥可过鉴权', async () => {
  const { endpoint } = await startService();
  const none = await rawRequest(endpoint, '/task/adopt', { method: 'POST', body: {}, token: null });
  assert.equal(none.status, 401);
  assert.equal(none.body.error.code, 'UNAUTHORIZED');

  const read = await rawRequest(endpoint, '/task/adopt', { method: 'POST', body: {}, token: READ_TOKEN });
  assert.equal(read.status, 401, '只读密钥不能收养：写分级不许放松');
  assert.equal(read.body.error.code, 'UNAUTHORIZED');

  const write = await rawRequest(endpoint, '/task/adopt', {
    method: 'POST',
    body: { taskId: 't-nope', actor: 's-x' },
  });
  assert.equal(write.status, 404, '写密钥应过鉴权（然后才因任务不存在 404）');
  assert.equal(write.body.error.code, 'TASK_NOT_FOUND');
});

test('H2 真 HTTP 收养：子进程认领后被杀死，板服务用真实 pid 探测判定已死 → verified', async () => {
  const { endpoint } = await startService();
  const client = new RemoteBoard({ endpoint, token: TOKEN });
  const { task } = await newTaskRemote(client, 's-owner', 'HTTP 收养闭环');

  const claimant = await claimFromLiveChild(endpoint, task.task_id, 's-old', 400);
  assert.equal(claimant.ok, true, `子进程认领应成功，实际 ${JSON.stringify(claimant)}`);
  assert.notEqual(claimant.pid, process.pid, '子进程 pid 必须与测试进程不同');

  await killAndWait(claimant.child);
  assert.equal(await waitPidGone(claimant.pid), true);
  const expired = await waitLeaseExpired(client, task.task_id);
  assert.equal(expired.owner_session, 's-old');
  assert.equal(expired.lease_pid, claimant.pid, '板服务记的必须是那个**子进程**的 pid');

  const res = await client.adoptTask(task.task_id, 's-adopter');
  assert.equal(res.adopted, true, `应收养成功，实际 ${JSON.stringify(res)}`);
  assert.equal(res.unverified, false);
  assert.equal(res.from, 's-old');
  assert.equal(res.task.owner_session, 's-adopter');
  assert.equal(res.task.lifecycle, 'working');
  assert.equal(res.task.lease_pid, process.pid, '新租约持有者是收养方（本进程）');
  assert.equal(res.task.lease_host, HOST);
  assert.equal(res.evidence.identity.verdict, 'verified-dead');
  assert.equal(res.evidence.time.expired, true);

  // 事件落库（HTTP 读回来，证明不是只在内存里）
  const events = await client.recentEvents(50, task.task_id);
  const adopted = events.find((e) => e.kind === 'lease.adopted');
  assert.ok(adopted !== undefined, '必须落 lease.adopted 事件');
  assert.equal(adopted.payload.unverified, false);
  assert.equal(adopted.payload.prev_lease_pid, claimant.pid);
  assert.equal(adopted.payload.evidence.identity.verdict, 'verified-dead');
  assert.equal(adopted.payload.evidence.event.renewals_after_lease_until, 0);
  assert.equal(adopted.payload.policy.allow_unverified_adoption, false);
});

test('H3 真 HTTP 拒绝：持有者进程还活着 → 409 + ADOPT_HOLDER_ALIVE，且状态未被改动', async () => {
  const { endpoint } = await startService();
  const client = new RemoteBoard({ endpoint, token: TOKEN });
  const { task } = await newTaskRemote(client, 's-owner', 'HTTP 拒绝路径');
  await client.claimTask(task.task_id, 's-old', { leaseMs: 400 });
  const claimed = await client.getTask(task.task_id);
  await waitLeaseExpired(client, task.task_id);

  const adopter = new RemoteBoard({ endpoint, token: TOKEN });
  await assert.rejects(
    () => adopter.adoptTask(task.task_id, 's-new'),
    (err) => {
      assert.ok(err instanceof TeamError);
      assert.equal(err.code, ADOPT_CODES.HOLDER_ALIVE);
      assert.equal(err.detail?.evidence?.identity?.verdict, 'alive');
      return true;
    },
  );
  const after = await client.getTask(task.task_id);
  assert.equal(after.owner_session, 's-old', '拒绝不许改负责人');
  assert.equal(after.lease_until, claimed.lease_until, '拒绝不许改租约');
  const events = await client.recentEvents(50, task.task_id);
  assert.equal(events.some((e) => e.kind === 'lease.adopted'), false, '拒绝不许落收养事件');
});

test('H4 真 HTTP 跨机租约：默认 409 ADOPT_EVIDENCE_UNVERIFIABLE；板服务允许后放行且 unverified=true', async () => {
  const strict = await startService();
  const strictClient = new RemoteBoard({ endpoint: strict.endpoint, token: TOKEN });
  const { task } = await newTaskRemote(strictClient, 's-owner', '跨机严格');
  // 裸 HTTP 认领：伪造"我在另一台机器上"（真实 deploy 里就是另一台设备连这块板）
  const forged = { pid: 424242, start_sec: 99, host: 'REMOTE-HOST-X' };
  const claimedRes = await rawRequest(strict.endpoint, '/task/claim', {
    method: 'POST',
    body: { taskId: task.task_id, actor: 's-remote', leaseMs: 400, leaseIdentity: forged },
  });
  assert.equal(claimedRes.status, 200, `伪造跨机认领应成功（板不校验来源主机）：${JSON.stringify(claimedRes.body)}`);
  await waitLeaseExpired(strictClient, task.task_id);

  await assert.rejects(
    () => strictClient.adoptTask(task.task_id, 's-new'),
    (err) => {
      assert.equal(err.code, ADOPT_CODES.EVIDENCE_UNVERIFIABLE);
      assert.equal(err.detail?.evidence?.identity?.reason, 'unverified-cross-host');
      assert.equal(err.detail?.evidence?.identity?.checked_pid, false);
      return true;
    },
  );

  // 健康检查如实报默认严格
  const strictHealth = await strictClient.health();
  assert.equal(strictHealth.adoption.allow_unverified, false);

  // ── 允许未验证收养的板：同一场景放行，但 unverified=true 必须落地 ──
  const loose = await startService({ allowUnverifiedAdoption: true });
  const looseClient = new RemoteBoard({ endpoint: loose.endpoint, token: TOKEN });
  const { task: task2 } = await newTaskRemote(looseClient, 's-owner', '跨机放行');
  await rawRequest(loose.endpoint, '/task/claim', {
    method: 'POST',
    body: { taskId: task2.task_id, actor: 's-remote', leaseMs: 400, leaseIdentity: forged },
  });
  await waitLeaseExpired(looseClient, task2.task_id);

  const res = await looseClient.adoptTask(task2.task_id, 's-new');
  assert.equal(res.adopted, true);
  assert.equal(res.unverified, true);
  assert.equal(res.verdict, 'adopted-unverified');
  assert.equal(res.evidence.identity.reason, 'unverified-cross-host');
  assert.equal((await looseClient.health()).adoption.allow_unverified, true);

  const adopted = (await looseClient.recentEvents(50, task2.task_id)).find((e) => e.kind === 'lease.adopted');
  assert.ok(adopted !== undefined);
  assert.equal(adopted.payload.unverified, true, '未验证收养必须如实进审计，不许写成已验证');
});

test('H5 handlers 渲染：拒绝给稳定码 + 三类证据 + 回退建议（不抛裸异常）', async () => {
  const b = newBoard();
  const h = createHandlers({ getBoard: () => b, getInterconnect: () => null });
  const execOut = { agent: { id: 's-other' } };
  const t = makeTask(b);
  b.claimTask(t.task_id, 's-old', { leaseMs: 600_000 });

  const text = await h.mesh_task_adopt({ taskId: t.task_id }, execOut);
  assert.match(text, /收养被拒绝（ADOPT_NOT_STALE）/);
  assert.match(text, /时间：/);
  assert.match(text, /回退：租约还在有效期内/);
});

test('H6 handlers 渲染：成功走三证据摘要；未验证收养有醒目警告', async () => {
  const b = newBoard();

  // 经过允许的未验证收养：跨机 + allowUnverifiedAdoption=true
  const hLoose = createHandlers({ getBoard: () => b, getInterconnect: () => null, allowUnverifiedAdoption: true });
  const t = makeTask(b);
  b.claimTask(t.task_id, 's-old', {
    identity: { pid: 999_999, start_sec: 1, host: 'SOME-OTHER-HOST' },
    leaseMs: 600_000,
  });
  const claimed = b.getTask(t.task_id);
  // 环境里没有 now 注入的入口，这里把 stale 标上让 E1 成立（扫描者=本进程，同机判断）
  b.db.prepare('UPDATE task SET stale = 1, stale_at = ? WHERE task_id = ?').run(Date.now(), t.task_id);
  assert.ok(claimed.lease_until > Date.now());

  const text = await hLoose.mesh_task_adopt({ taskId: t.task_id }, { agent: { id: 's-new' } });
  assert.match(text, /已收养（⚠ 未验证）/);
  assert.match(text, /三证据：/);
  assert.match(text, /未验证/);
  assert.match(text, /lease\.adopted/);

  // 默认严格策略下同一块板（新 handler）应当拒绝
  const hStrict = createHandlers({ getBoard: () => b, getInterconnect: () => null });
  const t2 = makeTask(b);
  b.claimTask(t2.task_id, 's-old', {
    identity: { pid: 999_999, start_sec: 1, host: 'SOME-OTHER-HOST' },
    leaseMs: 600_000,
  });
  b.db.prepare('UPDATE task SET stale = 1, stale_at = ? WHERE task_id = ?').run(Date.now(), t2.task_id);
  const refused = await hStrict.mesh_task_adopt({ taskId: t2.task_id }, { agent: { id: 's-new' } });
  assert.match(refused, /ADOPT_EVIDENCE_UNVERIFIABLE/);
});

test('H7 总管不许收养（与 claim 同一条硬规则）', async () => {
  const b = newBoard();
  const h = createHandlers({
    getBoard: () => b,
    getInterconnect: () => null,
    getDispatcherSessions: () => ['session-dispatcher'],
  });
  const t = makeTask(b);
  await assert.rejects(
    () => h.mesh_task_adopt({ taskId: t.task_id }, { agent: { id: 'session-dispatcher' } }),
    (err) => {
      assert.equal(err.code, 'DISPATCHER_NOT_EXECUTOR');
      return true;
    },
  );
});

// ─────────────────────── 契约 / spec ───────────────────────

test('S1 spec：工具名、必填参数、以及"未验证是能力边界"的说明都在', () => {
  assert.equal(TOOL_NAMES.adopt, 'mesh_task_adopt');
  const spec = adoptSpec();
  assert.equal(spec.name, TOOL_NAMES.adopt);
  assert.equal(spec.parameters.taskId.required, true);
  assert.ok(Object.hasOwn(spec.parameters, 'leaseMs'));
  assert.match(spec.description, /ADOPT_NOT_STALE/);
  assert.match(spec.description, /ADOPT_EVIDENCE_UNVERIFIABLE/);
  assert.match(spec.description, /unverified/);
  assert.match(spec.description, /allowUnverifiedAdoption/);
  assert.match(spec.description, /跨机验 pid 是伪命题/);
  assert.match(spec.description, /claim 的现有行为\*\*没有改动\*\*/);
});

test('S2 handlers 与 spec 名字对齐：createHandlers 里存在 mesh_task_adopt', () => {
  const b = newBoard();
  const h = createHandlers({ getBoard: () => b, getInterconnect: () => null });
  assert.equal(typeof h[TOOL_NAMES.adopt], 'function');
});

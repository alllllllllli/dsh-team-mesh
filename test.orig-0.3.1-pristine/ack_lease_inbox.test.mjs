/**
 * ack_lease_inbox.test.mjs — v2 三项功能的专项测试。
 *
 * 为什么单开一个文件而不塞进 store.test.mjs：
 * 这三项各自对应一个**真实发生过的失败**（发起方不知情、负责人挂了没人知道、
 * 重复刷屏），它们的用例需要"操纵时间"（把 deadline 往前拨），
 * 跟原有 39 条纯逻辑用例的节奏不一样，混在一起会互相干扰。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Board } from '../src/store.js';
import {
  DEFAULT_ACK_TIMEOUT_MS,
  DEFAULT_LEASE_MS,
  canReclaim,
  describeDelivery,
  leaseIsLive,
} from '../src/domain.js';
import { collectInbox, deliverInbox } from '../src/inbox.js';

const tmpDirs = [];
function newBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-v2-'));
  tmpDirs.push(dir);
  return new Board(path.join(dir, 'team.db'));
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

function makeTask(b, actor = 's-a') {
  return b.createTask({ title: 'v2', brief: '', acceptance: '', requestId: null }, actor).task;
}

// ─────────────────────────── ack ───────────────────────────

test('默认时长：ack 60s、租约 10 分钟', () => {
  assert.equal(DEFAULT_ACK_TIMEOUT_MS, 60_000);
  assert.equal(DEFAULT_LEASE_MS, 10 * 60_000);
});

test('投递成功 → 开回执窗口，ack_state=pending，deadline≈60s 后', () => {
  const b = newBoard();
  const t = makeTask(b);
  const out = b.recordDispatch(t.task_id, 'peer', 'sess', { delivered: true });
  assert.equal(out.ack_state, 'pending');
  assert.ok(out.ack_id > 0);
  const delta = out.ack_deadline_at - Date.now();
  assert.ok(delta > 55_000 && delta <= 60_500, `deadline 应≈60s 后，实际 ${delta}ms`);
  b.close();
});

test('回执到达 → ack_state=acked，并记 task.acked 事件', () => {
  const b = newBoard();
  const t = makeTask(b);
  b.recordDispatch(t.task_id, 'peer', 'sess', { delivered: true });
  const res = b.ackTask(t.task_id, 'sess');
  assert.equal(res.acked, true);
  assert.equal(b.getTask(t.task_id).ack_state, 'acked');
  const ev = b.recentEvents(20, t.task_id).find((e) => e.kind === 'task.acked');
  assert.ok(ev !== undefined, '应留下 task.acked 事件');
  b.close();
});

test('回执幂等：重复 ack 不报错，只第一次生效', () => {
  const b = newBoard();
  const t = makeTask(b);
  b.recordDispatch(t.task_id, 'peer', 'sess', { delivered: true });
  const first = b.ackTask(t.task_id, 'sess');
  const second = b.ackTask(t.task_id, 'sess');
  assert.equal(first.acked, true);
  assert.equal(second.acked, false);
  assert.equal(second.deduped, true);
  // 事件只应有一条
  const count = b.recentEvents(50, t.task_id).filter((e) => e.kind === 'task.acked').length;
  assert.equal(count, 1);
  b.close();
});

test('超时未回执 → 扫出 ack_timeout，任务 ack_state=timeout，事件说清是"送到了没人管"', () => {
  const b = newBoard();
  const t = makeTask(b);
  b.recordDispatch(t.task_id, 'peer', 'sess', { delivered: true }, { ackTimeoutMs: 1000 });
  // 把 deadline 往前拨，模拟 60s 已过
  b.db.prepare('UPDATE ack SET deadline_at = ? WHERE task_id = ?').run(Date.now() - 1, t.task_id);
  const swept = b.sweepAckTimeouts();
  assert.deepEqual(swept.timed_out, [t.task_id]);
  assert.equal(b.getTask(t.task_id).ack_state, 'timeout');
  const ev = b.recentEvents(20, t.task_id).find((e) => e.kind === 'task.ack_timeout');
  assert.ok(ev !== undefined, '必须留 ack_timeout 事件');
  assert.equal(ev.payload.verdict, 'delivered-unacked');
  b.close();
});

test('已回执的不会被超时扫描翻掉（acked 优先）', () => {
  const b = newBoard();
  const t = makeTask(b);
  b.recordDispatch(t.task_id, 'peer', 'sess', { delivered: true }, { ackTimeoutMs: 1000 });
  b.ackTask(t.task_id, 'sess');
  b.db.prepare('UPDATE ack SET deadline_at = ? WHERE task_id = ?').run(Date.now() - 1, t.task_id);
  const swept = b.sweepAckTimeouts();
  assert.equal(swept.count, 0, '已 ack 的不该被判超时');
  assert.equal(b.getTask(t.task_id).ack_state, 'acked');
  b.close();
});

test('投递失败 → 不进等待回执（不是"没人管"，是"没送到"）', () => {
  const b = newBoard();
  const t = makeTask(b);
  const out = b.recordDispatch(t.task_id, 'peer', 'sess', { delivered: false, reason: 'unreachable' });
  assert.equal(out.ack_state, 'none');
  assert.equal(out.ack_id, null);
  const swept = b.sweepAckTimeouts();
  assert.equal(swept.count, 0, '没送到不该被判成"送到了没人管"');
  b.close();
});

test('describeDelivery 把三种真相分开（不许都显示成正常）', () => {
  assert.equal(describeDelivery(false, 'none', 'unreachable').verdict, 'not-delivered');
  assert.equal(describeDelivery(true, 'timeout', null).verdict, 'delivered-unacked');
  assert.equal(describeDelivery(true, 'acked', null).verdict, 'acked');
  assert.equal(describeDelivery(true, 'pending', null).verdict, 'delivered-unacked');
  // 中文标签必须能区分
  assert.notEqual(describeDelivery(false, 'none', 'x').label, describeDelivery(true, 'timeout', null).label);
});

// ─────────────────────────── 租约 ───────────────────────────

test('认领即拿租约：lease_until ≈ 10 分钟后', () => {
  const b = newBoard();
  const t = makeTask(b);
  const { task } = b.claimTask(t.task_id, 's1');
  assert.equal(task.lease_owner, 's1');
  const delta = task.lease_until - Date.now();
  assert.ok(delta > DEFAULT_LEASE_MS - 5000 && delta <= DEFAULT_LEASE_MS + 500, `实际 ${delta}ms`);
  b.close();
});

test('租约内别人抢不走（ALREADY_CLAIMED）', () => {
  const b = newBoard();
  const t = makeTask(b);
  b.claimTask(t.task_id, 's1');
  assert.throws(() => b.claimTask(t.task_id, 's2'), /租约仍然有效|ALREADY_CLAIMED/);
  b.close();
});

test('心跳续租：lease_until 前移，并记 lease.renewed', () => {
  const b = newBoard();
  const t = makeTask(b);
  const first = b.claimTask(t.task_id, 's1', { leaseMs: 1000 }).task;
  const before = first.lease_until;
  const renewed = b.heartbeat(t.task_id, 's1', { leaseMs: 60_000 });
  assert.ok(renewed.task.lease_until > before, '续租后 lease_until 必须前移');
  const ev = b.recentEvents(20, t.task_id).find((e) => e.kind === 'lease.renewed');
  assert.ok(ev !== undefined);
  b.close();
});

test('非负责人不能续租（NOT_LEASE_OWNER）', () => {
  const b = newBoard();
  const t = makeTask(b);
  b.claimTask(t.task_id, 's1');
  assert.throws(() => b.heartbeat(t.task_id, 's2'), /NOT_LEASE_OWNER|不是这个任务的负责人/);
  b.close();
});

test('租约过期无心跳 → 扫成 stale，事件留痕，且允许被重新认领', () => {
  const b = newBoard();
  const t = makeTask(b);
  b.claimTask(t.task_id, 's1', { leaseMs: 1000 });
  // 模拟过期
  b.db.prepare('UPDATE task SET lease_until = ? WHERE task_id = ?').run(Date.now() - 1, t.task_id);

  const swept = b.sweepStaleLeases();
  assert.deepEqual(swept.marked, [t.task_id]);
  const after = b.getTask(t.task_id);
  assert.equal(after.stale, 1);
  assert.ok(after.stale_at > 0);
  const ev = b.recentEvents(20, t.task_id).find((e) => e.kind === 'lease.stale');
  assert.ok(ev !== undefined, '必须留 lease.stale 事件');

  // 关键：允许被重新认领
  const taken = b.claimTask(t.task_id, 's2');
  assert.equal(taken.task.owner_session, 's2');
  assert.equal(taken.task.stale, 0, '接管后 stale 应清掉');
  const takeover = b.recentEvents(20, t.task_id).find((e) => e.kind === 'lease.taken_over');
  assert.ok(takeover !== undefined, '接管要留痕');
  b.close();
});

test('stale 之后原负责人心跳可复活（lease.revived）', () => {
  const b = newBoard();
  const t = makeTask(b);
  b.claimTask(t.task_id, 's1', { leaseMs: 1000 });
  b.db.prepare('UPDATE task SET lease_until = ? WHERE task_id = ?').run(Date.now() - 1, t.task_id);
  b.sweepStaleLeases();
  assert.equal(b.getTask(t.task_id).stale, 1);
  const revived = b.heartbeat(t.task_id, 's1');
  assert.equal(revived.was_stale, true);
  assert.equal(b.getTask(t.task_id).stale, 0);
  assert.ok(b.recentEvents(20, t.task_id).some((e) => e.kind === 'lease.revived'));
  b.close();
});

test('已完成的任务不会被标 stale', () => {
  const b = newBoard();
  const t = makeTask(b);
  b.claimTask(t.task_id, 's1', { leaseMs: 1000 });
  const f = path.join(path.dirname(b.dbPath), 'p.txt');
  fs.writeFileSync(f, 'ok');
  b.reportEvidence(t.task_id, { executed: true, outcome: 'pass', evidenceRef: f }, 's1');
  b.completeTask(t.task_id, 's1');
  b.db.prepare('UPDATE task SET lease_until = ? WHERE task_id = ?').run(Date.now() - 1, t.task_id);
  const swept = b.sweepStaleLeases();
  assert.equal(swept.count, 0, 'done 的任务不该被标 stale');
  assert.equal(b.getTask(t.task_id).lifecycle, 'done');
  b.close();
});

test('canReclaim / leaseIsLive 的边界', () => {
  const now = 1_000_000;
  assert.equal(leaseIsLive({ lease_until: now + 1 }, now), true);
  assert.equal(leaseIsLive({ lease_until: now - 1 }, now), false);
  assert.equal(leaseIsLive({ lease_until: null }, now), false);
  assert.equal(canReclaim({ lifecycle: 'open', owner_session: null }, now).ok, true);
  assert.equal(canReclaim({ lifecycle: 'working', owner_session: 'x', stale: 1 }, now).ok, true);
  assert.equal(
    canReclaim({ lifecycle: 'working', owner_session: 'x', stale: 0, lease_until: now + 1000 }, now).ok,
    false,
  );
  assert.equal(canReclaim({ lifecycle: 'done', owner_session: 'x' }, now).ok, false);
});

// ─────────────────────────── 收件箱 ───────────────────────────

test('收件箱：首次读到全部未读，游标前移到实际读到的 seq', async () => {
  const b = newBoard();
  const t = makeTask(b);
  b.claimTask(t.task_id, 's1');
  const got = await collectInbox(b, { instanceId: 'inst', sessionId: 'sess' });
  assert.ok(got.count > 0);
  const maxSeq = b.backend.maxEventSeq();
  assert.equal(got.nextSeq, maxSeq, '一次读全时 nextSeq 应等于板上的最大 seq');
  b.close();
});

test('收件箱：第二轮只注入新增（不重复刷屏）', async () => {
  const b = newBoard();
  const who = { instanceId: 'inst', sessionId: 'sess' };
  const t = makeTask(b);

  // 第一轮
  const r1 = await deliverInbox(b, who, () => {});
  assert.equal(r1.injected, true);
  assert.ok(r1.count > 0);

  // 第二轮：没有新事件 → 不该注入
  const r2 = await deliverInbox(b, who, () => {});
  assert.equal(r2.injected, false);
  assert.equal(r2.count, 0);

  // 产生新事件后再来
  b.claimTask(t.task_id, 's1');
  const r3 = await deliverInbox(b, who, () => {});
  assert.equal(r3.injected, true);
  assert.ok(r3.count > 0);
  assert.ok(r3.sinceSeq >= r1.nextSeq, '第三轮应从第一轮结束处继续');
  b.close();
});

test('收件箱：limit 截断时只前移到已读的那条（不跳过中间事件）', async () => {
  const b = newBoard();
  const who = { instanceId: 'inst', sessionId: 'sess', limit: 2 };
  // 造 5 条事件
  for (let i = 0; i < 5; i += 1) makeTask(b, `s-${i}`);
  const total = b.backend.maxEventSeq();
  assert.ok(total >= 5);

  const r1 = await deliverInbox(b, who, () => {});
  assert.equal(r1.count, 2, '应只取 limit 条');
  assert.ok(r1.nextSeq < total, '不该一口气前移到全表最大 seq');

  const r2 = await deliverInbox(b, who, () => {});
  assert.ok(r2.sinceSeq === r1.nextSeq, '第二轮必须接着第一轮的游标');
  assert.equal(r2.count, 2);
  b.close();
});

test('收件箱：注入抛错则游标不动（下一轮能补上）', async () => {
  const b = newBoard();
  const who = { instanceId: 'inst', sessionId: 'sess' };
  makeTask(b);
  const before = b.getCursor(who.instanceId, who.sessionId);
  await assert.rejects(
    deliverInbox(b, who, () => {
      throw new Error('注入失败');
    }),
    /注入失败/,
  );
  const after = b.getCursor(who.instanceId, who.sessionId);
  assert.equal(after, before, '注入失败时游标必须不前移');
  // 再试一次能成功
  const retry = await deliverInbox(b, who, () => {});
  assert.equal(retry.injected, true);
  b.close();
});

test('收件箱：游标按 (instance, session) 隔离，互不串台', async () => {
  const b = newBoard();
  makeTask(b);
  const a = { instanceId: 'inst', sessionId: 'A' };
  const c = { instanceId: 'inst', sessionId: 'B' };
  await deliverInbox(b, a, () => {});
  const cursorA = b.getCursor('inst', 'A');
  const cursorB = b.getCursor('inst', 'B');
  assert.ok(cursorA > 0);
  assert.equal(cursorB, 0, 'B 没读过，游标应为 0');
  b.close();
});

test('收件箱摘要含任务当前状态（不只是"有个事件"）', async () => {
  const b = newBoard();
  const who = { instanceId: 'inst', sessionId: 'sess' };
  const t = makeTask(b);
  b.claimTask(t.task_id, 's1');
  const got = await collectInbox(b, who);
  assert.ok(got.text.includes(t.task_id), '摘要里应出现任务 id');
  assert.ok(got.text.includes('working') || got.text.includes('进行中'), '应带当前状态');
  b.close();
});

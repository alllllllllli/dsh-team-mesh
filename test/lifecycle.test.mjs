/**
 * lifecycle.test.mjs — 0.5 两项新功能的专项测试：stale 自动重派（P1）+ 完成主动通知（P2）。
 *
 * 两条硬约束决定这些用例必须**真板 + 假 interconnect**：
 *   - 重派次数、通知去重都读板上事件，用真 Board 才能证明"事件真的写进去了"；
 *   - send 的 delivered/reason 必须如实传递，所以假 interconnect 要能返回失败。
 *
 * 每个用例都同时断言"该发生的发生了"和"不该发生的没发生"（不改坏也被抓得到）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createHandlers } from '../src/handlers.js';
import {
  buildNotifyText,
  createDispatchRegistry,
  DEFAULT_MAX_REDISPATCH,
  DEFAULT_REDISPATCH_POLL_MS,
  LIFECYCLE_EVENT_KINDS,
  NOTIFY_TEXT_LIMIT,
  serviceLifecycle,
  startLifecycle,
} from '../src/lifecycle.js';
import { Board } from '../src/store.js';

const tmpDirs = [];
function newBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-lifecycle-'));
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

function makeTask(b, title = 'v0.5 生命周期') {
  return b.createTask({ title, brief: '', acceptance: '', requestId: null }, 'session-orch').task;
}

/** 假 interconnect：记录每次 send；结果可配成成功 / 失败 / 抛异常。 */
function fakeInterconnect(outcome = { delivered: true }) {
  const calls = [];
  return {
    calls,
    selfSender: (sessionId) => ({ instanceId: 'pc-self', sessionId }),
    async send(request) {
      calls.push(request);
      if (typeof outcome === 'function') return outcome(request);
      return outcome;
    },
  };
}

/** 登记"本实例派过这条任务"（模拟 mesh_dispatch 成功后的登记）。 */
function registerDispatch(registry, taskId, opts = {}) {
  registry.record(taskId, {
    peerInstance: opts.peerInstance ?? 'peer-b',
    peerSession: opts.peerSession ?? 'sess-b',
    dispatcherInstance: opts.dispatcherInstance ?? 'pc-self',
    dispatcherSession: opts.dispatcherSession ?? 'dispatcher-1',
  });
}

/** 让任务真的进入 stale（走真租约路径：claim → 租约过期 → sweep）。 */
function makeStale(b, taskId, actor = 'sess-b') {
  b.claimTask(taskId, actor, { leaseMs: 1_000 });
  b.db.prepare('UPDATE task SET lease_until = ? WHERE task_id = ?').run(Date.now() - 5_000, taskId);
  const swept = b.sweepStaleLeases();
  assert.ok(swept.marked.includes(taskId), '前置条件：sweep 必须真的把这条租约标成 stale');
  const task = b.getTask(taskId);
  assert.equal(task.stale, 1, '前置条件：任务必须真的 stale');
  return task;
}

/** 把任务推到 done（真证据 + 真门禁）。 */
function completeTask(b, taskId, actor = 'sess-b') {
  b.claimTask(taskId, actor);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-artifact-'));
  tmpDirs.push(dir);
  const artifact = path.join(dir, 'artifact.txt');
  fs.writeFileSync(artifact, 'done', 'utf8');
  b.reportEvidence(taskId, { executed: true, outcome: 'pass', note: '做完了', evidenceRef: artifact }, actor);
  b.completeTask(taskId, actor);
}

function eventsOf(b, taskId, kind) {
  return b.recentEvents(100, taskId).filter((e) => e.kind === kind);
}

/** 跑一轮（不启动定时器）。 */
async function scanOnce(board, registry, config = {}, extra = {}) {
  return serviceLifecycle({
    board,
    registry,
    getInterconnect: extra.getInterconnect ?? (() => fakeInterconnect()),
    config: { autoRedispatch: false, notifyOnComplete: false, ...config },
    instanceId: 'pc-self',
    ...extra.deps,
  });
}

// ─────────────────────────── P1：stale 自动重派 ───────────────────────────

test('默认配置（autoRedispatch 未开）：stale 任务不重派，连一条重派事件都不写', async () => {
  const b = newBoard();
  const t = makeTask(b);
  b.recordDispatch(t.task_id, 'peer-b', 'sess-b', { delivered: true });
  const registry = createDispatchRegistry();
  registerDispatch(registry, t.task_id);
  makeStale(b, t.task_id);

  const interconnect = fakeInterconnect();
  const out = await serviceLifecycle({
    board: b,
    registry,
    getInterconnect: () => interconnect,
    config: { notifyOnComplete: false },
    instanceId: 'pc-self',
  });

  assert.equal(out.scanned, 1);
  assert.equal(interconnect.calls.length, 0, '默认关闭时一条消息都不该发');
  assert.equal(eventsOf(b, t.task_id, LIFECYCLE_EVENT_KINDS.redispatched).length, 0);
  assert.equal(eventsOf(b, t.task_id, LIFECYCLE_EVENT_KINDS.redispatchFailed).length, 0);
  b.close();
});

test('满足条件：stale + 未终结 + 本实例派发记录 → 重派一次（投回原 target，开新 ack 窗口）', async () => {
  const b = newBoard();
  const t = makeTask(b, '长任务卡');
  b.recordDispatch(t.task_id, 'peer-b', 'sess-b', { delivered: true });
  const registry = createDispatchRegistry();
  registerDispatch(registry, t.task_id);
  makeStale(b, t.task_id);

  const interconnect = fakeInterconnect();
  const out = await scanOnce(b, registry, { autoRedispatch: true, maxRedispatch: 1 }, {
    getInterconnect: () => interconnect,
  });

  assert.equal(out.redispatched.length, 1, `应重派 1 次，实际 ${JSON.stringify(out)}`);
  assert.equal(interconnect.calls.length, 1);
  assert.equal(interconnect.calls[0].instanceId, 'peer-b', '必须投回原 instance');
  assert.equal(interconnect.calls[0].sessionId, 'sess-b', '必须投回原 session');
  assert.match(interconnect.calls[0].text, new RegExp(t.task_id), '任务卡里必须有任务号');
  assert.match(interconnect.calls[0].text, /长任务卡/, '任务卡必须带标题，不能是空壳');

  const ev = eventsOf(b, t.task_id, LIFECYCLE_EVENT_KINDS.redispatched);
  assert.equal(ev.length, 1, '必须落 task.redispatched 审计事件');
  const payload = ev[0].payload;
  assert.equal(payload.reason, 'lease-stale');
  assert.equal(payload.attempt, 1);
  assert.equal(payload.original_instance, 'peer-b');
  assert.equal(payload.original_session, 'sess-b');
  assert.equal(payload.delivered, true);
  assert.equal(payload.ack_state, 'pending', '重派等于一次真实派发，必须重新等回执');
  assert.equal(b.getTask(t.task_id).ack_state, 'pending');
  b.close();
});

test('超过 maxRedispatch 就不再重派：第二轮只剩一条 task.redispatched', async () => {
  const b = newBoard();
  const t = makeTask(b);
  b.recordDispatch(t.task_id, 'peer-b', 'sess-b', { delivered: true });
  const registry = createDispatchRegistry();
  registerDispatch(registry, t.task_id);
  makeStale(b, t.task_id);

  const interconnect = fakeInterconnect();
  const config = { autoRedispatch: true, maxRedispatch: 1 };
  await scanOnce(b, registry, config, { getInterconnect: () => interconnect });
  await scanOnce(b, registry, config, { getInterconnect: () => interconnect });

  assert.equal(interconnect.calls.length, 1, 'maxRedispatch=1 → 最多投一次');
  assert.equal(eventsOf(b, t.task_id, LIFECYCLE_EVENT_KINDS.redispatched).length, 1);
  b.close();
});

test('不满足条件就不重派：未 stale / 已终结 / 没有本实例派发记录', async () => {
  const b = newBoard();
  const fresh = makeTask(b);
  const staleTask = makeTask(b);
  const closed = makeTask(b);
  completeTask(b, closed.task_id);

  const registry = createDispatchRegistry();
  registerDispatch(registry, fresh.task_id);
  registerDispatch(registry, staleTask.task_id);
  makeStale(b, staleTask.task_id);
  registerDispatch(registry, closed.task_id);

  const interconnect = fakeInterconnect();
  const out = await scanOnce(b, registry, { autoRedispatch: true, maxRedispatch: 1 }, {
    getInterconnect: () => interconnect,
  });

  assert.equal(out.redispatched.length, 1, '只有 staleTask 该被重派');
  assert.equal(interconnect.calls.length, 1);
  assert.match(interconnect.calls[0].text, new RegExp(staleTask.task_id));
  assert.equal(eventsOf(b, fresh.task_id, LIFECYCLE_EVENT_KINDS.redispatched).length, 0);
  assert.equal(eventsOf(b, closed.task_id, LIFECYCLE_EVENT_KINDS.redispatched).length, 0);

  // 没登记过的 stale 任务（别的实例派出去的）也不归我重派
  const others = makeTask(b);
  makeStale(b, others.task_id);
  const out2 = await scanOnce(b, registry, { autoRedispatch: true, maxRedispatch: 1 }, {
    getInterconnect: () => interconnect,
  });
  assert.equal(out2.redispatched.length, 0);
  assert.equal(interconnect.calls.length, 1);
  b.close();
});

test('重派失败如实落 task.redispatch_failed（含 reason），绝不写成成功事件', async () => {
  const b = newBoard();
  const t = makeTask(b);
  b.recordDispatch(t.task_id, 'peer-b', 'sess-b', { delivered: true });
  const registry = createDispatchRegistry();
  registerDispatch(registry, t.task_id);
  makeStale(b, t.task_id);

  const interconnect = fakeInterconnect({ delivered: false, reason: 'session-not-live' });
  const out = await scanOnce(b, registry, { autoRedispatch: true, maxRedispatch: 1 }, {
    getInterconnect: () => interconnect,
  });

  assert.equal(out.redispatched.length, 0);
  assert.equal(out.redispatchFailed.length, 1);
  const failed = eventsOf(b, t.task_id, LIFECYCLE_EVENT_KINDS.redispatchFailed);
  assert.equal(failed.length, 1, '必须落 task.redispatch_failed');
  assert.equal(failed[0].payload.reason, 'session-not-live');
  assert.equal(failed[0].payload.delivered, false);
  assert.equal(failed[0].payload.attempt, 1);
  assert.equal(eventsOf(b, t.task_id, LIFECYCLE_EVENT_KINDS.redispatched).length, 0,
    '失败不许写成功事件');
  b.close();
});

test('mesh_dispatch 成功后才登记（未送到不登记）—— 这是"本实例派发"的判据来源', async () => {
  const b = newBoard();
  const t = makeTask(b);
  const registry = createDispatchRegistry();

  const ok = fakeInterconnect();
  const handlers = createHandlers({ getBoard: () => b, getInterconnect: () => ok, dispatchRegistry: registry });
  const text = await handlers.mesh_dispatch(
    { taskId: t.task_id, instanceId: 'peer-b', sessionId: 'sess-b' },
    { agent: { id: 'session-orch' } },
  );
  assert.match(text, /等待回执|投递/, '投递成功的返回文本应表明已进入等回执状态');
  const entry = registry.get(t.task_id);
  assert.ok(entry !== null, '投递成功后必须登记');
  assert.equal(entry.peerInstance, 'peer-b');
  assert.equal(entry.peerSession, 'sess-b');
  assert.equal(entry.dispatcherInstance, 'pc-self');
  assert.equal(entry.dispatcherSession, 'session-orch');

  const t2 = makeTask(b);
  const bad = fakeInterconnect({ delivered: false, reason: 'unreachable' });
  const handlers2 = createHandlers({ getBoard: () => b, getInterconnect: () => bad, dispatchRegistry: registry });
  await handlers2.mesh_dispatch(
    { taskId: t2.task_id, instanceId: 'peer-b', sessionId: 'sess-b' },
    { agent: { id: 'session-orch' } },
  );
  assert.equal(registry.get(t2.task_id), null, '没送到就不存在"派发方在等它做完"，不该登记');
  b.close();
});

// ─────────────────────────── P2：完成主动通知 ───────────────────────────

test('done：给原派发方会话发一条 ≤200 字短消息，只发一次', async () => {
  const b = newBoard();
  const t = makeTask(b, '写报告');
  b.recordDispatch(t.task_id, 'peer-b', 'sess-b', { delivered: true });
  const registry = createDispatchRegistry();
  registerDispatch(registry, t.task_id);
  completeTask(b, t.task_id);

  const interconnect = fakeInterconnect();
  const out = await scanOnce(b, registry, { notifyOnComplete: true }, { getInterconnect: () => interconnect });

  assert.equal(out.notified.length, 1, `应通知 1 次，实际 ${JSON.stringify(out)}`);
  assert.equal(interconnect.calls.length, 1);
  const req = interconnect.calls[0];
  assert.equal(req.instanceId, 'pc-self', '通知目标 = 原派发方所在实例（本实例）');
  assert.equal(req.sessionId, 'dispatcher-1', '通知目标 = 原派发方会话');
  assert.ok(req.text.length <= NOTIFY_TEXT_LIMIT, `正文必须 ≤${NOTIFY_TEXT_LIMIT} 字，实际 ${req.text.length}`);
  assert.match(req.text, new RegExp(t.task_id));
  assert.match(req.text, /写报告/);
  assert.match(req.text, /已完成/);
  assert.match(req.text, /证据 1 条/);

  const sent = eventsOf(b, t.task_id, LIFECYCLE_EVENT_KINDS.notifySent);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.delivered, true);
  assert.equal(sent[0].payload.lifecycle, 'done');

  // 第二轮：板上已有 notify_sent → 不得再发（登记项也会被移出）
  await scanOnce(b, registry, { notifyOnComplete: true }, { getInterconnect: () => interconnect });
  assert.equal(interconnect.calls.length, 1, '同一任务只通知一次');
  assert.equal(eventsOf(b, t.task_id, LIFECYCLE_EVENT_KINDS.notifySent).length, 1);
  assert.equal(registry.get(t.task_id), null, '终态任务应从登记表移出，不再轮询');
  b.close();
});

test('canceled 也通知（状态如实写"已取消"，不冒充完成）', async () => {
  const b = newBoard();
  const t = makeTask(b, '被砍掉的任务');
  b.recordDispatch(t.task_id, 'peer-b', 'sess-b', { delivered: true });
  b.cancelTask(t.task_id, 'session-orch', '不做了');
  const registry = createDispatchRegistry();
  registerDispatch(registry, t.task_id);

  const interconnect = fakeInterconnect();
  await scanOnce(b, registry, { notifyOnComplete: true }, { getInterconnect: () => interconnect });

  assert.equal(interconnect.calls.length, 1);
  assert.match(interconnect.calls[0].text, /已取消/);
  assert.doesNotMatch(interconnect.calls[0].text, /已完成/);
  const sent = eventsOf(b, t.task_id, LIFECYCLE_EVENT_KINDS.notifySent);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.lifecycle, 'canceled');
  b.close();
});

test('没有 interconnect：不报错、降级落 task.notify_skipped（reason=no-interconnect）', async () => {
  const b = newBoard();
  const t = makeTask(b);
  b.recordDispatch(t.task_id, 'peer-b', 'sess-b', { delivered: true });
  b.cancelTask(t.task_id, 'session-orch', '');
  const registry = createDispatchRegistry();
  registerDispatch(registry, t.task_id);

  const out = await scanOnce(b, registry, { notifyOnComplete: true }, { getInterconnect: () => null });

  assert.equal(out.notifySkipped.length, 1);
  assert.equal(out.notifySkipped[0].reason, 'no-interconnect');
  const skipped = eventsOf(b, t.task_id, LIFECYCLE_EVENT_KINDS.notifySkipped);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].payload.reason, 'no-interconnect');
  assert.equal(eventsOf(b, t.task_id, LIFECYCLE_EVENT_KINDS.notifySent).length, 0);
  b.close();
});

test('通知没送到：如实落 task.notify_failed（含 reason），不写成 sent', async () => {
  const b = newBoard();
  const t = makeTask(b);
  b.recordDispatch(t.task_id, 'peer-b', 'sess-b', { delivered: true });
  b.cancelTask(t.task_id, 'session-orch', '');
  const registry = createDispatchRegistry();
  registerDispatch(registry, t.task_id);

  const interconnect = fakeInterconnect({ delivered: false, reason: 'peer-not-configured' });
  const out = await scanOnce(b, registry, { notifyOnComplete: true }, { getInterconnect: () => interconnect });

  assert.equal(out.notifyFailed.length, 1);
  const failed = eventsOf(b, t.task_id, LIFECYCLE_EVENT_KINDS.notifyFailed);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].payload.reason, 'peer-not-configured');
  assert.equal(failed[0].payload.delivered, false);
  assert.equal(eventsOf(b, t.task_id, LIFECYCLE_EVENT_KINDS.notifySent).length, 0);
  b.close();
});

test('notifyOnComplete=false：任务完结也不发消息（配置真的能关）', async () => {
  const b = newBoard();
  const t = makeTask(b);
  b.recordDispatch(t.task_id, 'peer-b', 'sess-b', { delivered: true });
  b.cancelTask(t.task_id, 'session-orch', '');
  const registry = createDispatchRegistry();
  registerDispatch(registry, t.task_id);

  const interconnect = fakeInterconnect();
  const out = await scanOnce(b, registry, { notifyOnComplete: false }, { getInterconnect: () => interconnect });

  assert.equal(interconnect.calls.length, 0);
  assert.equal(eventsOf(b, t.task_id, LIFECYCLE_EVENT_KINDS.notifySent).length, 0);
  assert.equal(eventsOf(b, t.task_id, LIFECYCLE_EVENT_KINDS.notifySkipped).length, 0);
  assert.equal(out.notified.length, 0);
  b.close();
});

// ─────────────────────────── 纯函数 / 定时器 ───────────────────────────

test('buildNotifyText：超长标题也压到 ≤200 字，且不发整段 payload', () => {
  const task = { task_id: 't-12345678', title: '很长的标题'.repeat(50) };
  const text = buildNotifyText({
    task,
    lifecycle: 'done',
    durationMs: 125_000,
    evidenceCount: 3,
    peerInstance: 'peer-b',
  });
  assert.ok(text.length <= NOTIFY_TEXT_LIMIT, `实际 ${text.length} 字`);
  assert.ok(!text.includes('brief'), '不能把 payload 整段塞进去');
  assert.match(text, /耗时 2m5s/);
  assert.match(text, /证据 3 条/);
});

test('默认值：重派默认关、默认最多 1 次、轮询 15s（与 0.4 行为一致的前提）', () => {
  assert.equal(DEFAULT_MAX_REDISPATCH, 1);
  assert.equal(DEFAULT_REDISPATCH_POLL_MS, 15_000);
});

test('startLifecycle：定时器可跑一轮并能在 dispose 后停住', async () => {
  const b = newBoard();
  const t = makeTask(b);
  b.recordDispatch(t.task_id, 'peer-b', 'sess-b', { delivered: true });
  b.cancelTask(t.task_id, 'session-orch', '');
  const registry = createDispatchRegistry();
  registerDispatch(registry, t.task_id);

  const interconnect = fakeInterconnect();
  const svc = startLifecycle({
    board: b,
    registry,
    getInterconnect: () => interconnect,
    config: { autoRedispatch: false, notifyOnComplete: true },
    pollMs: 250_000, // 用例里手动调 serviceOnce，不让定时器自己跳
    instanceId: 'pc-self',
  });
  assert.equal(svc.pollMs, 250_000);
  const got = await svc.serviceOnce();
  assert.equal(got.notified.length, 1);
  svc.dispose();
  assert.equal(await svc.serviceOnce(), null, 'dispose 之后不再扫描');
  b.close();
});

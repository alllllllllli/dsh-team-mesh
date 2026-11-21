/**
 * notify_local.test.mjs — 0.6 P0-1：完成通知改走「本机会话直投」。
 *
 * 0.5 的通知只有一条路：`ctx.interconnect.send` 发给原派发方会话。派发方通常就在本实例，
 * 而本实例要寻址自己的会话需要 interconnect 的 `self` 路由（本机 profile 没配），
 * 真实环境预期落 `notify_failed`。0.6 先走宿主 `sessionController.prompt` 直投，失败再降级。
 *
 * 三条用例对应需求的三种结局：直投成功 / 直投不活跃降级 interconnect / 两者皆失败落 skipped。
 * 全部用**真 Board + 假 sessionController + 假 interconnect**：
 *   - 真 Board 才能证明 `task.notify_*` 审计事件真的写进去了；
 *   - 假 sc 才能让"会话不活跃"稳定复现（真宿主里没法保证那个会话此刻一定不活跃）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createDispatchRegistry, LIFECYCLE_EVENT_KINDS, NOTIFY_TEXT_LIMIT, serviceLifecycle } from '../src/lifecycle.js';
import { Board } from '../src/store.js';

const tmpDirs = [];
function newBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-notify-local-'));
  tmpDirs.push(dir);
  return new Board(path.join(dir, 'team.db'));
}
test.after(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* ignore */
    }
  }
});

function makeTask(b, title = '改走本机会话直投') {
  return b.createTask({ title, brief: '', acceptance: '', requestId: null }, 'session-orch').task;
}

/** 假 interconnect：记录 send；结果可配成功/失败。 */
function fakeInterconnect(outcome = { delivered: true }) {
  const calls = [];
  return {
    calls,
    async send(request) {
      calls.push(request);
      if (typeof outcome === 'function') return outcome(request);
      return outcome;
    },
  };
}

/**
 * 假 sessionController：`outcome='ok'` 表示会话活着（prompt 接受）；
 * `'throw'` 表示会话不活跃/已销毁（宿主会抛稳定错误）。
 */
function fakeSessionController(outcome = 'ok') {
  const calls = [];
  return {
    calls,
    async prompt(request, signal) {
      calls.push({ request, signal });
      if (outcome === 'throw') {
        throw Object.assign(new Error('session/not-found: session "session-orch" was disposed'), {
          code: 'session/not-found',
        });
      }
      return { accepted: true };
    },
  };
}

/** 登记"本实例派过这条任务"（dispatcherInstance 默认本实例 = 走直投候选路径）。 */
function registerDispatch(registry, taskId, opts = {}) {
  registry.record(taskId, {
    peerInstance: opts.peerInstance ?? 'peer-b',
    peerSession: opts.peerSession ?? 'sess-b',
    dispatcherInstance: opts.dispatcherInstance ?? 'pc-self',
    dispatcherSession: opts.dispatcherSession ?? 'session-orch',
  });
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

function scanOnce(board, registry, extra = {}) {
  return serviceLifecycle({
    board,
    registry,
    getInterconnect: extra.getInterconnect ?? (() => fakeInterconnect()),
    getSessionController: extra.getSessionController ?? (() => null),
    config: { autoRedispatch: false, notifyOnComplete: true, ...extra.config },
    instanceId: 'pc-self',
    ...extra.deps,
  });
}

// ─────────────────────────── ① 本实例直投成功 ───────────────────────────

test('done 且落点在本实例：直接 prompt 原派发方会话，不发 interconnect，落 notify_sent(channel=local-session)', async () => {
  const b = newBoard();
  const t = makeTask(b);
  b.recordDispatch(t.task_id, 'peer-b', 'sess-b', { delivered: true });
  const registry = createDispatchRegistry();
  registerDispatch(registry, t.task_id);
  completeTask(b, t.task_id);

  const sc = fakeSessionController('ok');
  const interconnect = fakeInterconnect();
  const out = await scanOnce(b, registry, {
    getSessionController: () => sc,
    getInterconnect: () => interconnect,
  });

  assert.equal(out.notified.length, 1, `应通知 1 次，实际 ${JSON.stringify(out)}`);
  assert.equal(out.notified[0].channel, 'local-session');
  assert.equal(sc.calls.length, 1, '本实例落点必须走直投，且只投一次');
  assert.equal(interconnect.calls.length, 0, '直投成功就不该再走 interconnect');

  const { request, signal } = sc.calls[0];
  assert.equal(request.sessionId, 'session-orch', '目标必须是原派发方会话');
  assert.equal(request.mode, 'queue');
  assert.ok(signal instanceof AbortSignal, 'prompt 第二个参数必须是真 AbortSignal');
  assert.ok(request.requestId.length > 0, '必须给 requestId（宿主用它去重）');
  const text = request.content[0].text;
  assert.ok(text.length <= NOTIFY_TEXT_LIMIT, `通知正文必须 ≤${NOTIFY_TEXT_LIMIT} 字`);
  assert.match(text, new RegExp(t.task_id));
  assert.match(text, /已完成/);

  const sent = eventsOf(b, t.task_id, LIFECYCLE_EVENT_KINDS.notifySent);
  assert.equal(sent.length, 1, '必须落 task.notify_sent');
  assert.equal(sent[0].payload.channel, 'local-session');
  assert.equal(sent[0].payload.delivered, true);
  assert.equal(eventsOf(b, t.task_id, LIFECYCLE_EVENT_KINDS.notifyFailed).length, 0);

  // 第二轮：只通知一次（登记项已被移出 + 板上 notify_sent 去重）
  await scanOnce(b, registry, { getSessionController: () => sc, getInterconnect: () => interconnect });
  assert.equal(sc.calls.length, 1, '同一任务只通知一次');
  b.close();
});

// ─────────────────────────── ② 本实例不活跃 → 降级 interconnect ───────────────────────────

test('本实例会话不活跃：直投失败后降级 interconnect，落 notify_sent(channel=interconnect)', async () => {
  const b = newBoard();
  const t = makeTask(b);
  b.recordDispatch(t.task_id, 'peer-b', 'sess-b', { delivered: true });
  const registry = createDispatchRegistry();
  registerDispatch(registry, t.task_id);
  completeTask(b, t.task_id);

  const sc = fakeSessionController('throw');
  const interconnect = fakeInterconnect({ delivered: true });
  const out = await scanOnce(b, registry, {
    getSessionController: () => sc,
    getInterconnect: () => interconnect,
  });

  assert.equal(out.notified.length, 1, `应通知 1 次，实际 ${JSON.stringify(out)}`);
  assert.equal(out.notified[0].channel, 'interconnect');
  assert.equal(sc.calls.length, 1, '必须先试过直投');
  assert.equal(interconnect.calls.length, 1, '直投失败后必须降级到 interconnect');
  assert.equal(interconnect.calls[0].sessionId, 'session-orch');

  const sent = eventsOf(b, t.task_id, LIFECYCLE_EVENT_KINDS.notifySent);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.channel, 'interconnect');
  assert.equal(sent[0].payload.delivered, true);
  b.close();
});

// ─────────────────────────── ③ 两者皆失败 → skipped ───────────────────────────

test('直投失败且 interconnect 也没送到：落 notify_skipped(channel=none)，reason 写清两边', async () => {
  const b = newBoard();
  const t = makeTask(b);
  b.recordDispatch(t.task_id, 'peer-b', 'sess-b', { delivered: true });
  const registry = createDispatchRegistry();
  registerDispatch(registry, t.task_id);
  completeTask(b, t.task_id);

  const sc = fakeSessionController('throw');
  const interconnect = fakeInterconnect({ delivered: false, reason: 'unreachable' });
  const out = await scanOnce(b, registry, {
    getSessionController: () => sc,
    getInterconnect: () => interconnect,
  });

  assert.equal(out.notifySkipped.length, 1, `应落 skipped，实际 ${JSON.stringify(out)}`);
  assert.match(out.notifySkipped[0].reason, /^all-channels-failed/);
  assert.equal(out.notifyFailed.length, 0, '两条路都试过时该落 skipped，不是 failed');
  assert.equal(out.notified.length, 0);

  const skipped = eventsOf(b, t.task_id, LIFECYCLE_EVENT_KINDS.notifySkipped);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].payload.channel, 'none');
  assert.match(skipped[0].payload.local_reason, /session\/not-found/);
  assert.equal(skipped[0].payload.interconnect_reason, 'unreachable');
  assert.match(skipped[0].payload.reason, /all-channels-failed/);
  assert.equal(eventsOf(b, t.task_id, LIFECYCLE_EVENT_KINDS.notifySent).length, 0);
  assert.equal(eventsOf(b, t.task_id, LIFECYCLE_EVENT_KINDS.notifyFailed).length, 0);
  b.close();
});

// ─────────────────────────── 兼容：远端落点 / 无直投能力 ───────────────────────────

test('落点不是本实例（远端派发方）：不走直投，仍走 interconnect（失败落 notify_failed, channel=interconnect）', async () => {
  const b = newBoard();
  const t = makeTask(b);
  b.recordDispatch(t.task_id, 'peer-b', 'sess-b', { delivered: true });
  const registry = createDispatchRegistry();
  registerDispatch(registry, t.task_id, { dispatcherInstance: 'peer-remote', dispatcherSession: 'sess-remote' });
  completeTask(b, t.task_id);

  const sc = fakeSessionController('ok');
  const interconnect = fakeInterconnect({ delivered: false, reason: 'peer-not-configured' });
  const out = await scanOnce(b, registry, {
    getSessionController: () => sc,
    getInterconnect: () => interconnect,
  });

  assert.equal(sc.calls.length, 0, '远处落点不该在本机找会话');
  const failed = eventsOf(b, t.task_id, LIFECYCLE_EVENT_KINDS.notifyFailed);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].payload.channel, 'interconnect');
  assert.equal(failed[0].payload.reason, 'peer-not-configured');
  assert.equal(out.notifyFailed.length, 1);
  b.close();
});

test('没有 sessionController 且没有 interconnect：仍按 0.5 语义落 skipped(reason=no-interconnect, channel=none)', async () => {
  const b = newBoard();
  const t = makeTask(b);
  b.recordDispatch(t.task_id, 'peer-b', 'sess-b', { delivered: true });
  const registry = createDispatchRegistry();
  registerDispatch(registry, t.task_id);
  completeTask(b, t.task_id);

  const out = await scanOnce(b, registry, { getInterconnect: () => null });
  assert.equal(out.notifySkipped.length, 1);
  assert.equal(out.notifySkipped[0].reason, 'no-interconnect');
  const skipped = eventsOf(b, t.task_id, LIFECYCLE_EVENT_KINDS.notifySkipped);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].payload.channel, 'none');
  b.close();
});

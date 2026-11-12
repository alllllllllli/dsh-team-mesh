/**
 * new_session.test.mjs — v3「派发侧支持新建会话」的三条硬要求。
 *
 * 这个文件存在的理由：`newSession` 这条链路**最危险的失败模式不是报错，而是降级** ——
 * 建不出来就偷偷投给某个现成会话，于是派发方以为"成功派给新会话"，
 * 实际上活又堵回那一个会话里（这正是 2026-11-08 凌晨 4 次 ACK_TIMEOUT 的病根）。
 *
 * 所以三条用例分别钉死：
 *   ① newSession:true 时**先建会话、再投那个新会话**（不是投给任何现成会话）
 *   ② 对端拒绝时**如实报错且不降级**（interconnect.send 一次都不能被调用）
 *   ③ newSession 缺省时行为与 0.3.1 完全一致（包括 sessionId 必填、不产生建会话请求）
 *
 * 还有一条独立的：接收端确实调了宿主 create()，且默认开关是关的。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canCreateSession, createSessionViaHost, serviceSessionRequests } from '../src/createSession.js';
import { DEFAULT_SESSION_REQUEST_TTL_MS } from '../src/domain.js';
import { createHandlers } from '../src/handlers.js';
import { Board } from '../src/store.js';

const tmpDirs = [];
function newBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-new-session-'));
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

/** 假 interconnect：记录每次 send 的入参，投递结果可编排。 */
function fakeInterconnect(overrides = {}) {
  const calls = [];
  const svc = {
    calls,
    peers: () => [{ instanceId: 'peer-b', origin: 'http://127.0.0.1:13085', link: 'up' }],
    list: async () => ({ instance: 'peer-b', sessions: [{ sessionId: 'session-old', status: 'idle' }] }),
    selfSender: (sessionId) => ({ instanceId: 'peer-a', sessionId }),
    send: async (req) => {
      calls.push(req);
      return { delivered: true, instance: req.instanceId, delivery: 'followup' };
    },
    ...overrides,
  };
  return svc;
}

function makeTask(board, actor = 'session-orch') {
  return board.createTask(
    { title: '新建会话派活', brief: '', acceptance: '', requestId: null },
    actor,
  ).task;
}

const exec = { agent: { id: 'session-orch' } };

// ───────────── ① newSession:true → 先建会话，再投那个新会话 ─────────────

test('① newSession:true：先在对端建会话，任务卡投给**新建**的 sessionId', async () => {
  const board = newBoard();
  const task = makeTask(board);
  const ic = fakeInterconnect();

  // 另一侧的 team-mesh（模拟接收端）：从板上领请求，建出一个会话，写回结果
  const responder = (async () => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const pending = board.pendingSessionRequests('peer-b', 5);
      if (pending.length > 0) {
        board.claimSessionRequest(pending[0].request_id, {
          claimedBy: 'session-receiver',
          sessionId: 'session-brand-new',
        });
        return;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('等不到建会话请求');
  })();

  const h = createHandlers({ getBoard: () => board, getInterconnect: () => ic });
  const out = await h.mesh_dispatch(
    { taskId: task.task_id, instanceId: 'peer-b', newSession: true, title: '专用会话' },
    exec,
  );
  await responder;

  // 投给的是新会话，不是任何现成会话
  assert.equal(ic.calls.length, 1, '应当只投递一次');
  assert.equal(ic.calls[0].sessionId, 'session-brand-new', '必须投给新建出来的会话');
  assert.notEqual(ic.calls[0].sessionId, 'session-old', '绝不能降级投给现成会话');
  assert.match(out, /等待回执/, '应报告投递成功（已投递、正在等回执）');
  assert.match(out, /session-brand-new/, '回复里应出现新会话 id');
  assert.match(out, /新建会话/, '回复里应能看出这是新建的会话');

  // 落库也要能看出"这是新建的会话"
  const row = board.db.prepare('SELECT * FROM dispatch WHERE task_id = ?').get(task.task_id);
  assert.equal(Number(row.created_session), 1, 'dispatch 记录应标记 created_session=1');
  assert.equal(row.peer_session, 'session-brand-new');

  const ev = board.recentEvents(50, task.task_id).find((e) => e.kind === 'task.dispatched');
  assert.equal(ev.payload.created_session, true, '审计事件也应标出这是新建会话');

  board.close();
});

// ───────────── ② 对端拒绝 → 如实报错，不降级 ─────────────

test('② 对端拒绝（create-refused）：如实报错，绝不降级投给现成会话', async () => {
  const board = newBoard();
  const task = makeTask(board);
  const ic = fakeInterconnect();

  const responder = (async () => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const pending = board.pendingSessionRequests('peer-b', 5);
      if (pending.length > 0) {
        board.claimSessionRequest(pending[0].request_id, {
          claimedBy: 'session-receiver',
          rejectReason: 'create-refused',
          rejectMessage: '对端 allowCreate=false',
        });
        return;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('等不到建会话请求');
  })();

  const h = createHandlers({ getBoard: () => board, getInterconnect: () => ic });
  const out = await h.mesh_dispatch(
    { taskId: task.task_id, instanceId: 'peer-b', newSession: true },
    exec,
  );
  await responder;

  // 核心断言：一次 send 都没发出去
  assert.equal(ic.calls.length, 0, '建会话被拒时绝不能投递任务卡（不许降级）');

  assert.match(out, /未派发/, '必须明确说没派出去');
  assert.match(out, /create-refused/, '必须给出稳定的原因码');
  assert.match(out, /allowCreate/, '要告诉人这是开关问题');
  assert.match(out, /includeSessions/, '要给出"用现成会话"的替代路径');
  assert.match(out, /没有偷偷改投/, '要明确说明没有降级');

  board.close();
});

test('② 补充：请求超时（没人处理）也要如实报 create-timeout，且不降级', async () => {
  const board = newBoard();
  const task = makeTask(board);
  const ic = fakeInterconnect();

  const h = createHandlers({ getBoard: () => board, getInterconnect: () => ic });
  // 给一个极短的时限，且没人去处理
  const out = await h.mesh_dispatch(
    { taskId: task.task_id, instanceId: 'peer-b', newSession: true, ackTimeoutMs: 300 },
    exec,
  );

  assert.equal(ic.calls.length, 0, '超时也绝不能降级投递');
  assert.match(out, /未派发/);
  assert.match(out, /create-timeout/, '超时要给稳定的原因码，不能含糊其辞');

  board.close();
});

// ───────────── ③ newSession 缺省 → 与 0.3.1 完全一致 ─────────────

test('③ newSession 缺省：行为与旧版一致（投给给定会话、不产生任何建会话请求）', async () => {
  const board = newBoard();
  const task = makeTask(board);
  const ic = fakeInterconnect();

  const h = createHandlers({ getBoard: () => board, getInterconnect: () => ic });
  const out = await h.mesh_dispatch(
    { taskId: task.task_id, instanceId: 'peer-b', sessionId: 'session-old' },
    exec,
  );

  assert.equal(ic.calls.length, 1);
  assert.equal(ic.calls[0].sessionId, 'session-old', '缺省时应原样投给给定会话');
  assert.match(out, /等待回执/, '缺省时应和旧版一样报告"已投递、等回执"');

  // 一条建会话请求都不该产生
  const reqCount = board.db.prepare('SELECT COUNT(*) AS n FROM session_request').get();
  assert.equal(Number(reqCount.n), 0, '缺省时不该产生任何建会话请求');

  // dispatch 记录也不该标成新建
  const row = board.db.prepare('SELECT * FROM dispatch WHERE task_id = ?').get(task.task_id);
  assert.equal(Number(row.created_session), 0, '缺省时 created_session 应为 0');

  board.close();
});

test('③ 补充：newSession 缺省且不给 sessionId → 仍然报"sessionId 必填"（旧校验不变）', async () => {
  const board = newBoard();
  const task = makeTask(board);
  const h = createHandlers({ getBoard: () => board, getInterconnect: () => fakeInterconnect() });

  await assert.rejects(
    () => h.mesh_dispatch({ taskId: task.task_id, instanceId: 'peer-b' }, exec),
    (err) => err.code === 'INVALID_FIELD' && /sessionId/.test(err.message),
    '缺省 newSession 时必须还要求 sessionId',
  );

  board.close();
});

test('③ 补充：newSession=true 同时给 sessionId → 报意图矛盾，不猜', async () => {
  const board = newBoard();
  const task = makeTask(board);
  const ic = fakeInterconnect();
  const h = createHandlers({ getBoard: () => board, getInterconnect: () => ic });

  await assert.rejects(
    () => h.mesh_dispatch({ taskId: task.task_id, instanceId: 'peer-b', newSession: true, sessionId: 'session-old' }, exec),
    (err) => err.code === 'INVALID_FIELD' && /newSession=true/.test(err.message),
  );
  assert.equal(ic.calls.length, 0, '矛盾参数下不该有任何投递');

  board.close();
});

// ───────────── 接收端：真的调宿主 create()，且默认关闭 ─────────────

test('接收端：确实调用宿主 sessionController.create() 新建会话（不是 resume）', async () => {
  const calls = [];
  // 这个假宿主只提供 create()，**没有** resume —— 如果实现偷偷走 resume，这里就会失败
  const ctx = {
    get: (name) => (name === 'sessionController' ? { create: async (req) => {
      calls.push(req);
      return { sessionId: 'session-from-host', agentPreset: req.agentPreset };
    } } : undefined),
  };

  const out = await createSessionViaHost(ctx, { cwd: 'C:/work', agentPreset: 'dev' });
  assert.equal(out.ok, true);
  assert.equal(out.sessionId, 'session-from-host');
  assert.deepEqual(calls[0], { cwd: 'C:/work', agentPreset: 'dev' }, '应把 cwd/preset 透传给宿主');
  assert.equal(calls.length, 1);
});

test('接收端：宿主没有 sessionController → create-unsupported（不是抛异常）', async () => {
  const out = await createSessionViaHost({ get: () => undefined }, {});
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'create-unsupported');
  assert.equal(canCreateSession({ get: () => undefined }), false);
});

test('接收端：宿主 create() 抛错 → create-failed，且带上宿主的 code', async () => {
  const ctx = {
    get: () => ({
      create: async () => {
        const err = new Error('cwd 不可写');
        err.code = 'gateway/bad-request';
        throw err;
      },
    }),
  };
  const out = await createSessionViaHost(ctx, {});
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'create-failed');
  assert.match(out.message, /gateway\/bad-request/);
});

test('接收端：allowCreate=false（默认）时**照样读、并回写 create-refused**，但绝不建会话', async () => {
  const board = newBoard();
  const { request_id } = board.createSessionRequest({
    targetInstance: 'peer-b',
    requesterInstance: 'peer-a',
    ttlMs: 60_000,
  });
  let called = 0;
  const ctx = { get: () => ({ create: async () => { called += 1; return { sessionId: 'x' }; } }) };

  const done = await serviceSessionRequests({
    board,
    ctx,
    instanceId: 'peer-b',
    allowCreate: false, // 默认值
  });
  assert.equal(called, 0, '关着时绝不能调宿主 create()');
  assert.deepEqual(done, [{ request_id, rejected: 'create-refused' }], '关着时要如实回写 create-refused');

  // 请求被认领并写了拒绝原因 —— 不是留在板上等 TTL
  const row = board.getSessionRequest(request_id);
  assert.equal(row.state, 'claimed', '关着时也要认领（否则派发方只能等到超时）');
  assert.equal(row.reject_reason, 'create-refused');
  assert.equal(row.session_id, null, '拒绝时不该有 session_id');
  assert.equal(board.pendingSessionRequests('peer-b', 5).length, 0, '不该再留在 pending');

  board.close();
});

test('接收端：allowCreate=false 时派发方**快速**拿到 create-refused，而不是等 TTL 超时', async () => {
  const board = newBoard();
  const task = makeTask(board);
  const ic = fakeInterconnect();

  // 接收端只跑一次 serviceSessionRequests（模拟它开了轮询），开关是关的
  const receiver = (async () => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const done = await serviceSessionRequests({ board, ctx: {}, instanceId: 'peer-b', allowCreate: false });
      if (done.length > 0) return done;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('接收端一直没处理请求');
  })();

  const h = createHandlers({ getBoard: () => board, getInterconnect: () => ic });
  // 回执窗口给足 60s：如果实现还在"关着就静默"，这里必然等到 TTL 才返回
  const t0 = Date.now();
  const out = await h.mesh_dispatch(
    { taskId: task.task_id, instanceId: 'peer-b', newSession: true, ackTimeoutMs: 60_000 },
    exec,
  );
  const elapsed = Date.now() - t0;
  await receiver;

  assert.match(out, /create-refused/, '必须给出 create-refused 这个稳定短码');
  assert.doesNotMatch(out, /create-timeout/, '不能被混成"没人处理"');
  assert.ok(elapsed < 5000, `必须快速返回（实测 ${elapsed}ms），不能等满 60s 的 TTL`);
  assert.equal(ic.calls.length, 0, '被拒时仍然一次投递都不许发（不许降级）');

  board.close();
});

test('反向对照：对端不在线（没人读板）仍是 create-timeout，不会变成 create-refused', async () => {
  const board = newBoard();
  const task = makeTask(board);
  const ic = fakeInterconnect();

  const h = createHandlers({ getBoard: () => board, getInterconnect: () => ic });
  const out = await h.mesh_dispatch(
    { taskId: task.task_id, instanceId: 'peer-b', newSession: true, ackTimeoutMs: 300 },
    exec,
  );

  assert.match(out, /create-timeout/, '没人处理就是超时');
  assert.doesNotMatch(out, /create-refused/, '不能把"不在线"说成"关了开关"');
  assert.equal(ic.calls.length, 0);

  board.close();
});

test('接收端：allowCreate=true 时建会话并写回 sessionId', async () => {
  const board = newBoard();
  const { request_id } = board.createSessionRequest({
    targetInstance: 'peer-b',
    requesterInstance: 'peer-a',
    ttlMs: 60_000,
  });
  const ctx = { get: () => ({ create: async () => ({ sessionId: 'session-made-here' }) }) };

  const done = await serviceSessionRequests({ board, ctx, instanceId: 'peer-b', allowCreate: true });
  assert.equal(done.length, 1);
  assert.equal(done[0].sessionId, 'session-made-here');

  const row = board.getSessionRequest(request_id);
  assert.equal(row.state, 'claimed');
  assert.equal(row.session_id, 'session-made-here');

  board.close();
});

test('接收端：只处理发给本机的请求（target_instance 不符就不碰）', async () => {
  const board = newBoard();
  board.createSessionRequest({
    targetInstance: 'someone-else',
    requesterInstance: 'peer-a',
    ttlMs: 60_000,
  });
  let called = 0;
  const ctx = { get: () => ({ create: async () => { called += 1; return { sessionId: 'x' }; } }) };

  const done = await serviceSessionRequests({ board, ctx, instanceId: 'peer-b', allowCreate: true });
  assert.deepEqual(done, []);
  assert.equal(called, 0, '不该替别的实例建会话');

  board.close();
});

test('默认 TTL 是 60s，且超时请求会被扫成 expired', () => {
  assert.equal(DEFAULT_SESSION_REQUEST_TTL_MS, 60_000);

  const board = newBoard();
  board.createSessionRequest({
    targetInstance: 'peer-b',
    requesterInstance: 'peer-a',
    ttlMs: 1000,
  });
  // 把时钟拨到未来
  const swept = board.sweepAll(Date.now() + 5000);
  assert.equal(swept.session_request, 1, '应扫出 1 条超时请求');
  assert.equal(board.pendingSessionRequests('peer-b', 5).length, 0);

  board.close();
});

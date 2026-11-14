/**
 * ack_window.test.mjs — newSession 的「回执窗口下限 180s」（方案 B：只抬回执窗口）。
 *
 * 背景：实测"对端建会话 + 模型起跑"要 99s 才 ack，60s 窗口必然误判成 ack_timeout。
 * 但这里有两个**必须分开**的等待：
 *   ① 建会话等待：等对端把会话建出来（轮询 3s、旧默认 60s 够）→ **不受下限影响**
 *   ② 回执窗口：等对面新会话起跑并 ack（99s）→ **newSession 时强制 ≥180s**
 * 把它们混成一件（连建会话等待也拉到 180s）会让旧用例真的空等 360s —— 本轮明确否掉。
 *
 * 所以这个文件钉死三件事：
 *   A. 纯函数 resolveAckWindowMs 的取值表（含配置项 newSessionAckFloorMs）
 *   B. 真派发落板的 ack 窗口（5000→180000 / 300000→300000 / 普通 300→300 不受影响）
 *   C. **回归锁**：newSession+ackTimeoutMs=300 时建会话等待仍是 300ms 级，快速返回 create-timeout
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DEFAULT_ACK_TIMEOUT_MS } from '../src/domain.js';
import { createHandlers, resolveAckWindowMs } from '../src/handlers.js';
import { NEW_SESSION_ACK_FLOOR_MS } from '../src/spec.js';
import { Board } from '../src/store.js';

const tmpDirs = [];
function newBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-ack-window-'));
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

function fakeInterconnect() {
  const calls = [];
  return {
    calls,
    peers: () => [],
    selfSender: (sessionId) => ({ instanceId: 'peer-a', sessionId }),
    send: async (req) => {
      calls.push(req);
      return { delivered: true, instance: req.instanceId, delivery: 'followup' };
    },
  };
}

function makeTask(board) {
  return board.createTask({ title: '回执窗口用例', brief: '', acceptance: '', requestId: null }, 'session-orch').task;
}

const exec = { agent: { id: 'session-orch' } };

/** 最后一行 ack 的窗口（毫秒）；没有则 null。 */
function lastAckWindow(board, taskId) {
  const row = board.db
    .prepare('SELECT dispatched_at, deadline_at FROM ack WHERE task_id = ? ORDER BY ack_id DESC LIMIT 1')
    .get(taskId);
  if (row === undefined) return null;
  return Number(row.deadline_at) - Number(row.dispatched_at);
}

/** 最后一条建会话请求的存活时限；没有则 null。 */
function lastSessionRequestTtl(board) {
  const row = board.db
    .prepare('SELECT created_at, deadline_at FROM session_request ORDER BY rowid DESC LIMIT 1')
    .get();
  if (row === undefined) return null;
  return Number(row.deadline_at) - Number(row.created_at);
}

/** 一个"对端接收端"：看到板上出现建会话请求就认领并写回新 sessionId（模拟对端建好了）。 */
function respondCreate(board, sessionId, deadlineMs = 5000) {
  return (async () => {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      const pending = board.pendingSessionRequests('peer-b', 5);
      if (pending.length > 0) {
        board.claimSessionRequest(pending[0].request_id, {
          claimedBy: 'session-receiver',
          sessionId,
        });
        return;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('等不到建会话请求');
  })();
}

// ───────────── A. 纯函数取值表 ─────────────

test('A1 常量：newSession 回执窗口下限是 180000ms', () => {
  assert.equal(NEW_SESSION_ACK_FLOOR_MS, 180_000);
  assert.equal(DEFAULT_ACK_TIMEOUT_MS, 60_000);
});

test('A2 newSession + ackTimeoutMs=5000 → 抬到 180000（下限生效）', () => {
  assert.equal(resolveAckWindowMs({ ackTimeoutMs: 5000, newSession: true }), 180_000);
});

test('A3 newSession + ackTimeoutMs=300000 → 尊重显式更大值（不下压）', () => {
  assert.equal(resolveAckWindowMs({ ackTimeoutMs: 300_000, newSession: true }), 300_000);
});

test('A4 非 newSession + ackTimeoutMs=300 → 300，完全不受下限影响', () => {
  assert.equal(resolveAckWindowMs({ ackTimeoutMs: 300, newSession: false }), 300);
  // 与旧行为一致：不给值就是默认 60s
  assert.equal(resolveAckWindowMs({ newSession: false }), 60_000);
  assert.equal(resolveAckWindowMs({}), 60_000);
});

test('A5 newSession 不给 ackTimeoutMs → 默认窗口直接被下限顶到 180000', () => {
  assert.equal(resolveAckWindowMs({ newSession: true }), 180_000);
});

test('A6 配置项 newSessionAckFloorMs 可覆盖默认下限，但只在 newSession 时参与', () => {
  assert.equal(resolveAckWindowMs({ ackTimeoutMs: 5000, newSession: true, floorMs: 120_000 }), 120_000);
  assert.equal(resolveAckWindowMs({ ackTimeoutMs: 400_000, newSession: true, floorMs: 120_000 }), 400_000);
  assert.equal(resolveAckWindowMs({ ackTimeoutMs: 5000, newSession: false, floorMs: 120_000 }), 5000);
});

test('A7 非法 ackTimeoutMs（NaN/负数/0/字符串）按"没给"处理，绝不算出 NaN 截止时间', () => {
  for (const bad of [Number.NaN, -1, 0, 'abc', null, undefined]) {
    assert.equal(resolveAckWindowMs({ ackTimeoutMs: bad, newSession: false }), 60_000);
    assert.equal(resolveAckWindowMs({ ackTimeoutMs: bad, newSession: true }), 180_000);
  }
  // 数字字符串是合法输入（配置/模型有时会给字符串）
  assert.equal(resolveAckWindowMs({ ackTimeoutMs: '300000', newSession: true }), 300_000);
});

// ───────────── B. 真派发落板的 ack 窗口 ─────────────

test('B1 newSession + ackTimeoutMs=5000：板上 ack 窗口是 180000，返回文本写明生效值与"已抬升"', async () => {
  const board = newBoard();
  const task = makeTask(board);
  const ic = fakeInterconnect();
  const responder = respondCreate(board, 'session-brand-new');

  const h = createHandlers({ getBoard: () => board, getInterconnect: () => ic });
  const out = await h.mesh_dispatch(
    { taskId: task.task_id, instanceId: 'peer-b', newSession: true, ackTimeoutMs: 5000 },
    exec,
  );
  await responder;

  assert.equal(lastAckWindow(board, task.task_id), 180_000, 'newSession 的 ack 窗口必须被抬到 180000');
  assert.match(out, /生效窗口 180000ms/, '返回里必须写出实际生效值');
  assert.match(out, /已按 180000ms 生效/, '被下限顶掉时必须明确告诉模型：你给的值没被采纳');
  // ---- 同一时刻，建会话等待仍然是调用方给的 5000（没被下限污染）----
  assert.equal(lastSessionRequestTtl(board), 5000, '建会话等待不许跟回执窗口下限走');

  board.close();
});

test('B2 newSession + ackTimeoutMs=300000：板上窗口是 300000（显式更大值优先）', async () => {
  const board = newBoard();
  const task = makeTask(board);
  const ic = fakeInterconnect();
  const responder = respondCreate(board, 'session-brand-new');

  const h = createHandlers({ getBoard: () => board, getInterconnect: () => ic });
  const out = await h.mesh_dispatch(
    { taskId: task.task_id, instanceId: 'peer-b', newSession: true, ackTimeoutMs: 300_000 },
    exec,
  );
  await responder;

  assert.equal(lastAckWindow(board, task.task_id), 300_000);
  assert.match(out, /生效窗口 300000ms/);
  assert.doesNotMatch(out, /已按 180000ms 生效/, '显式值已经满足下限，不该出现"被抬升"提示');

  board.close();
});

test('B3 普通派发 + ackTimeoutMs=300：窗口就是 300，不受 180s 下限影响', async () => {
  const board = newBoard();
  const task = makeTask(board);
  const ic = fakeInterconnect();

  const h = createHandlers({ getBoard: () => board, getInterconnect: () => ic });
  const out = await h.mesh_dispatch(
    { taskId: task.task_id, instanceId: 'peer-b', sessionId: 'session-old', ackTimeoutMs: 300 },
    exec,
  );

  assert.equal(lastAckWindow(board, task.task_id), 300);
  assert.match(out, /生效窗口 300ms/);
  assert.doesNotMatch(out, /newSession 下限/, '普通派发不该出现 newSession 下限提示');

  board.close();
});

test('B4 普通派发不给 ackTimeoutMs：窗口仍是默认 60000（旧行为不变）', async () => {
  const board = newBoard();
  const task = makeTask(board);
  const ic = fakeInterconnect();

  const h = createHandlers({ getBoard: () => board, getInterconnect: () => ic });
  await h.mesh_dispatch({ taskId: task.task_id, instanceId: 'peer-b', sessionId: 'session-old' }, exec);

  assert.equal(lastAckWindow(board, task.task_id), 60_000);
  board.close();
});

test('B5 通过 createHandlers 依赖透传 newSessionAckFloorMs 配置（120s 覆盖默认）', async () => {
  const board = newBoard();
  const task = makeTask(board);
  const ic = fakeInterconnect();
  const responder = respondCreate(board, 'session-brand-new');

  const h = createHandlers({ getBoard: () => board, getInterconnect: () => ic, newSessionAckFloorMs: 120_000 });
  const out = await h.mesh_dispatch(
    { taskId: task.task_id, instanceId: 'peer-b', newSession: true, ackTimeoutMs: 5000 },
    exec,
  );
  await responder;

  assert.equal(lastAckWindow(board, task.task_id), 120_000, '配置项应覆盖默认 180s 下限');
  assert.match(out, /生效窗口 120000ms/);

  board.close();
});

// ───────────── C. 回归锁：建会话等待不许被下限拖慢（方案 B 的核心）─────────────

test('C1 newSession + ackTimeoutMs=300 且没人处理：仍 300ms 级返回 create-timeout，不空等 180s', async () => {
  const board = newBoard();
  const task = makeTask(board);
  const ic = fakeInterconnect();

  const h = createHandlers({ getBoard: () => board, getInterconnect: () => ic });
  const t0 = Date.now();
  const out = await h.mesh_dispatch(
    { taskId: task.task_id, instanceId: 'peer-b', newSession: true, ackTimeoutMs: 300 },
    exec,
  );
  const elapsed = Date.now() - t0;

  assert.match(out, /create-timeout/, '没人处理就是 create-timeout');
  assert.ok(elapsed < 5000, `建会话等待必须保持 300ms 级（实测 ${elapsed}ms）；被下限拖到 180s 就是做错了`);
  assert.equal(lastSessionRequestTtl(board), 300, '建会话请求的 TTL 仍是调用方给的值');
  assert.equal(lastAckWindow(board, task.task_id), null, '建会话失败不该产生 ack 窗口');

  board.close();
});

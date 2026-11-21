/**
 * wake_guard.test.mjs — 0.6 P0-2：入站唤醒限速四道闸。
 *
 * 每条闸门都同时断言三件事：
 *   ① 不投递（假 interconnect 的 send 一次都没被调用、ack 窗口没开）；
 *   ② 返回文本带稳定码（按码分流，不靠猜）；
 *   ③ 审计里真的落了 `dispatch.suppressed`（含 reason / task / target）。
 * 另外单独锁"默认全关 = 与 0.5 完全一致"：不配 wakeGuard 时连一条事件都不该多出来。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createHandlers } from '../src/handlers.js';
import { Board } from '../src/store.js';
import {
  createWakeLedger,
  DISPATCH_SUPPRESSED_EVENT,
  evaluateWakeGate,
  normalizeWakeConfig,
  taskTextChars,
  WAKE_GUARD_CODES,
  WAKE_GUARD_DEFAULTS,
} from '../src/wakeGuard.js';

const tmpDirs = [];
function newBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-wake-'));
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

function makeTask(b, title = '整理三份材料并写报告', brief = '把三份材料的事实核对后写成报告', acceptance = '字段齐全') {
  return b.createTask({ title, brief, acceptance, requestId: null }, 'session-orch').task;
}

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

function handlersWith(b, interconnect, wakeConfig) {
  const ledger = createWakeLedger();
  return {
    ledger,
    handlers: createHandlers({
      getBoard: () => b,
      getInterconnect: () => interconnect,
      wakeConfig,
      wakeLedger: ledger,
    }),
  };
}

function suppressedEvents(b, taskId) {
  return b.recentEvents(100, taskId).filter((e) => e.kind === DISPATCH_SUPPRESSED_EVENT);
}

const exec = { agent: { id: 'session-orch' } };
const baseArgs = (taskId) => ({ taskId, instanceId: 'peer-b', sessionId: 'sess-b' });

// ─────────────────────────── 默认关闭：与 0.5 完全一致 ───────────────────────────

test('默认（不配 wakeGuard）：四道闸都不生效，派发照旧、没有 dispatch.suppressed', async () => {
  const b = newBoard();
  const t = makeTask(b, 'x', '', ''); // 短到任何 minTaskChars 都会拦
  const interconnect = fakeInterconnect();
  const { handlers } = handlersWith(b, interconnect, undefined);

  const text1 = await handlers.mesh_dispatch(baseArgs(t.task_id), exec);
  const text2 = await handlers.mesh_dispatch(baseArgs(t.task_id), exec);

  assert.match(text1, /投递|回执/, '默认应正常投递');
  assert.match(text2, /投递|回执/);
  assert.equal(interconnect.calls.length, 2, '默认关闭时每次都真的发');
  assert.equal(suppressedEvents(b, t.task_id).length, 0, '默认关闭不该多出一条审计事件');
  assert.equal(b.getTask(t.task_id).ack_state, 'pending', '默认行为应进入等回执');
  b.close();
});

test('配置对象只认显式 true：wakeGuard:"true" 字符串不算开（保持默认行为）', async () => {
  const b = newBoard();
  const t = makeTask(b, 'x', '', '');
  const interconnect = fakeInterconnect();
  const { handlers } = handlersWith(b, interconnect, { wakeGuard: 'true', wakeMinTaskChars: 100 });
  await handlers.mesh_dispatch(baseArgs(t.task_id), exec);
  assert.equal(interconnect.calls.length, 1, '非布尔 true 不得开闸');
  b.close();
});

// ─────────────────────────── 四道闸各一条 ───────────────────────────

test('WAKE_SILENT：wakeNoWake=true 时完全不唤醒，只落板', async () => {
  const b = newBoard();
  const t = makeTask(b);
  const interconnect = fakeInterconnect();
  const { handlers } = handlersWith(b, interconnect, { wakeGuard: true, wakeNoWake: true });

  const text = await handlers.mesh_dispatch(baseArgs(t.task_id), exec);

  assert.match(text, /未派发（入站唤醒限速拦下）/);
  assert.match(text, /WAKE_SILENT/);
  assert.equal(interconnect.calls.length, 0, '静默闸命中时一次都不能发');
  assert.equal(b.getTask(t.task_id).ack_state, 'none', '没投递就不该开回执窗口');
  const ev = suppressedEvents(b, t.task_id);
  assert.equal(ev.length, 1, '必须落 dispatch.suppressed');
  assert.equal(ev[0].payload.reason, WAKE_GUARD_CODES.silent);
  assert.equal(ev[0].payload.task_id, t.task_id);
  assert.equal(ev[0].payload.target_instance, 'peer-b');
  assert.equal(ev[0].payload.target_session, 'sess-b');
  b.close();
});

test('WAKE_TOO_SHORT：任务正文短于 wakeMinTaskChars 时不唤醒', async () => {
  const b = newBoard();
  const t = makeTask(b, '在吗', '', '');
  const interconnect = fakeInterconnect();
  const { handlers } = handlersWith(b, interconnect, { wakeGuard: true, wakeMinTaskChars: 40 });

  const text = await handlers.mesh_dispatch(baseArgs(t.task_id), exec);

  assert.match(text, /WAKE_TOO_SHORT/);
  assert.match(text, /wakeMinTaskChars=40/);
  assert.equal(interconnect.calls.length, 0);
  const ev = suppressedEvents(b, t.task_id);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].payload.reason, WAKE_GUARD_CODES.tooShort);
  assert.equal(ev[0].payload.min_chars, 40);
  assert.ok(ev[0].payload.chars < 40);
  b.close();
});

test('WAKE_COOLDOWN：同一目标冷却期内第二次派发不唤醒', async () => {
  const b = newBoard();
  const t = makeTask(b);
  const interconnect = fakeInterconnect();
  const { handlers } = handlersWith(b, interconnect, {
    wakeGuard: true,
    wakeThreadCooldownMs: 60_000,
  });

  await handlers.mesh_dispatch(baseArgs(t.task_id), exec);
  const text = await handlers.mesh_dispatch(baseArgs(t.task_id), exec);

  assert.match(text, /WAKE_COOLDOWN/);
  assert.equal(interconnect.calls.length, 1, '第二次必须被冷却闸拦下');
  const ev = suppressedEvents(b, t.task_id);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].payload.reason, WAKE_GUARD_CODES.cooldown);
  assert.ok(ev[0].payload.remaining_ms > 0 && ev[0].payload.remaining_ms <= 60_000);
  b.close();
});

test('WAKE_LIMIT：同一目标累计唤醒到 wakeMaxPerThread 后不再唤醒', async () => {
  const b = newBoard();
  const t = makeTask(b);
  const interconnect = fakeInterconnect();
  const { handlers } = handlersWith(b, interconnect, {
    wakeGuard: true,
    wakeMaxPerThread: 1,
  });

  await handlers.mesh_dispatch(baseArgs(t.task_id), exec); // 第 1 次唤醒
  const text = await handlers.mesh_dispatch(baseArgs(t.task_id), exec); // 第 2 次应被上限拦

  assert.match(text, /WAKE_LIMIT/);
  assert.equal(interconnect.calls.length, 1, '第二次必须被上限闸拦下');
  const ev = suppressedEvents(b, t.task_id);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].payload.reason, WAKE_GUARD_CODES.limit);
  assert.equal(ev[0].payload.max_wakes, 1);
  assert.equal(ev[0].payload.wake_count, 1);
  b.close();
});

// ─────────────────────────── 计数口径 ───────────────────────────

test('计数只在"真的送到"时发生：上次投递失败不算一次唤醒', async () => {
  const b = newBoard();
  const t = makeTask(b);
  const interconnect = fakeInterconnect({ delivered: false, reason: 'unreachable' });
  const { handlers, ledger } = handlersWith(b, interconnect, {
    wakeGuard: true,
    wakeMaxPerThread: 1,
  });

  const failed = await handlers.mesh_dispatch(baseArgs(t.task_id), exec);
  assert.match(failed, /未投递/);
  assert.equal(ledger.get('peer-b', 'sess-b'), null, '没送到不该记唤醒');

  // 换一个会成功的投递：上限 1 仍应放行（因为上一条没算数）
  const okInterconnect = fakeInterconnect({ delivered: true });
  const { handlers: handlers2 } = handlersWith(b, okInterconnect, {
    wakeGuard: true,
    wakeMaxPerThread: 1,
  });
  const ok = await handlers2.mesh_dispatch(baseArgs(t.task_id), exec);
  assert.match(ok, /投递|回执/);
  assert.equal(okInterconnect.calls.length, 1);
  b.close();
});

test('闸门顺序：wakeNoWake 优先于 wakeMinTaskChars（稳定码不被别的闸盖住）', async () => {
  const b = newBoard();
  const t = makeTask(b, '在吗', '', '');
  const interconnect = fakeInterconnect();
  const { handlers } = handlersWith(b, interconnect, {
    wakeGuard: true,
    wakeNoWake: true,
    wakeMinTaskChars: 10_000,
  });
  const text = await handlers.mesh_dispatch(baseArgs(t.task_id), exec);
  assert.match(text, /WAKE_SILENT/);
  assert.doesNotMatch(text, /WAKE_TOO_SHORT/);
  b.close();
});

// ─────────────────────────── 纯函数 / 默认值 ───────────────────────────

test('normalizeWakeConfig：默认值全部"不改变现有行为"，非法值夹回默认', () => {
  assert.deepEqual(normalizeWakeConfig(undefined), { ...WAKE_GUARD_DEFAULTS });
  assert.deepEqual(normalizeWakeConfig({}), { ...WAKE_GUARD_DEFAULTS });
  assert.equal(WAKE_GUARD_DEFAULTS.wakeGuard, false);
  assert.equal(WAKE_GUARD_DEFAULTS.wakeNoWake, false);
  assert.equal(WAKE_GUARD_DEFAULTS.wakeMinTaskChars, 0);
  assert.equal(WAKE_GUARD_DEFAULTS.wakeThreadCooldownMs, 0);
  assert.equal(WAKE_GUARD_DEFAULTS.wakeMaxPerThread, 0);
  const cfg = normalizeWakeConfig({
    wakeGuard: true,
    wakeMinTaskChars: -5,
    wakeThreadCooldownMs: 'abc',
    wakeMaxPerThread: 3.9,
  });
  assert.equal(cfg.wakeGuard, true);
  assert.equal(cfg.wakeMinTaskChars, 0, '负数夹到 0');
  assert.equal(cfg.wakeThreadCooldownMs, 0, 'NaN 退回 0');
  assert.equal(cfg.wakeMaxPerThread, 3, '小数取整');
});

test('taskTextChars：只数任务正文，不数任务卡模板（否则空壳任务永远过闸）', () => {
  assert.equal(taskTextChars({ title: '在吗' }), 2);
  assert.equal(taskTextChars({ title: 'ab', brief: ' cde ', acceptance: 'f' }), 6);
  assert.equal(taskTextChars({}), 0);
  assert.equal(taskTextChars(null), 0);
});

test('evaluateWakeGate：默认配置直接放行，且不产生任何副作用', () => {
  const ledger = createWakeLedger();
  const hit = evaluateWakeGate({
    task: { title: 'x' },
    instanceId: 'peer-b',
    sessionId: 'sess-b',
    config: normalizeWakeConfig({}),
    ledger,
  });
  assert.equal(hit, null);
  assert.equal(ledger.size, 0);
});

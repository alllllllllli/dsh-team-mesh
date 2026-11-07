import assert from 'node:assert/strict';
import test from 'node:test';

import { createPeerEventRecorder } from '../src/index.js';

const notification = { kind: 'task.done', taskId: 't-1' };

function fakeCtx() {
  const warnings = [];
  return { warnings, ctx: { logger: { warn: (m) => warnings.push(m) } } };
}

test('远端板：直接跳过，不写审计事件', async () => {
  const { ctx, warnings } = fakeCtx();
  let called = 0;
  const board = {
    isRemote: true,
    appendEvent: async () => { called += 1; throw new Error('REMOTE_AUDIT_READONLY'); },
  };
  const record = createPeerEventRecorder({ ctx, board });
  assert.equal(record(notification, 'peer-a'), undefined);
  await new Promise((r) => setImmediate(r));
  assert.equal(called, 0, 'remote board must not be written to');
  assert.deepEqual(warnings, []);
});

test('本地板：写入成功时按约定参数记录', async () => {
  const { ctx, warnings } = fakeCtx();
  const calls = [];
  const board = { appendEvent: async (...args) => { calls.push(args); } };
  createPeerEventRecorder({ ctx, board })(notification, 'peer-b');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, [['peer.event', null, 'peer-b', notification]]);
  assert.deepEqual(warnings, []);
});

test('本地板：async 拒绝被接住，不会变成未处理拒绝', async () => {
  const { ctx, warnings } = fakeCtx();
  const board = { appendEvent: async () => { throw new Error('board down'); } };
  createPeerEventRecorder({ ctx, board })(notification, 'peer-c');
  await new Promise((r) => setImmediate(r));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /board down/);
});

test('本地板：同步抛出也被接住', async () => {
  const { ctx, warnings } = fakeCtx();
  const board = { appendEvent: () => { throw new Error('sync boom'); } };
  createPeerEventRecorder({ ctx, board })(notification, 'peer-d');
  await new Promise((r) => setImmediate(r));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /sync boom/);
});

test('日志器本身抛错也不会外泄', async () => {
  const ctx = { logger: { warn: () => { throw new Error('logger broken'); } } };
  const board = { appendEvent: async () => { throw new Error('board down'); } };
  assert.doesNotThrow(() => createPeerEventRecorder({ ctx, board })(notification, 'peer-e'));
  await new Promise((r) => setImmediate(r));
});

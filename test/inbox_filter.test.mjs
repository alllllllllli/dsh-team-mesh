/**
 * inbox_filter.test.mjs — peer.event 噪声过滤（v3）的专项测试。
 *
 * 为什么单开一个文件：这个改动的**风险点非常具体**——过滤本身容易写对，
 * 但"被过滤的事件会不会堵住游标"极易写错，而写错后的症状是**静默饿死**：
 * 后面的 task 事件永远浮不上来，而且测试不专门构造这种场景就发现不了。
 *
 * 所以三个用例直接对应派活单里的 a/b/c：
 *   a) 全是 peer.event 的两轮 → 不注入内容，但游标前进
 *   b) peer.event 夹在中间 → 后面的 task 事件下一轮就能浮出，不被饿死
 *   c) 关闭过滤（excludeKinds: []）→ 行为与改动前一致
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Board } from '../src/store.js';
import { DEFAULT_INBOX_EXCLUDE_KINDS, collectInbox, deliverInbox } from '../src/inbox.js';
import { installInboxHook } from '../src/inboxHook.js';

const tmpDirs = [];
function newBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-filter-'));
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

/** 直接往板上灌 peer.event 噪声（模拟别处会话的 created/disposed/running）。 */
function noise(b, n, label = 'x') {
  for (let i = 0; i < n; i += 1) {
    b.appendEvent('peer.event', null, 'pc-other', { kind: 'agent/status', sessionId: `session-${label}-${i}`, status: 'running' });
  }
}

const WHO = { instanceId: 'server', sessionId: 'session-1', limit: 5 };

test('默认排除 peer.event（配置项默认值正确）', () => {
  assert.deepEqual(DEFAULT_INBOX_EXCLUDE_KINDS, ['peer.event']);
});

// ─────────────────────── a) 全是噪声：不注入但游标前进 ───────────────────────

test('a1. 全是 peer.event：不注入内容，但游标前进（不堵队头）', async () => {
  const b = newBoard();
  noise(b, 20);
  const before = await b.getCursor(WHO.instanceId, WHO.sessionId);
  const got = await collectInbox(b, WHO);

  assert.equal(got.count, 0, '全是噪声时不该有可显示内容');
  assert.equal(got.text, '', '不该生成摘要');
  assert.ok(got.skipped > 0, '应报告过滤了多少条');
  assert.ok(got.nextSeq > before, `游标必须前进，否则永久堵死（before=${before} next=${got.nextSeq}）`);
});

test('a2. deliverInbox 在纯噪声时：injected=false 但游标确实动了', async () => {
  const b = newBoard();
  noise(b, 10);
  const before = await b.getCursor(WHO.instanceId, WHO.sessionId);
  let emitted = false;
  const r = await deliverInbox(b, WHO, () => {
    emitted = true;
  });

  assert.equal(emitted, false, '纯噪声不该注入任何文本');
  assert.equal(r.injected, false);
  assert.ok(r.nextSeq > before, '游标应前进');
  const after = await b.getCursor(WHO.instanceId, WHO.sessionId);
  assert.equal(after, r.nextSeq, '游标应已落库');
});

test('a3. 两轮纯噪声：第二轮不再重复处理同一批（游标已越过）', async () => {
  const b = newBoard();
  noise(b, 10);
  const r1 = await deliverInbox(b, WHO, () => {});
  const r2 = await deliverInbox(b, WHO, () => {});
  assert.equal(r1.injected, false);
  assert.equal(r2.injected, false);
  assert.equal(r2.sinceSeq, r1.nextSeq, '第二轮应从第一轮结束处继续');
  assert.equal(r2.skipped, 0, '第二轮没有新噪声可跳过');
});

test('a4. 纯噪声之后新来一条真实事件：下一轮就能看到，不被饿死', async () => {
  const b = newBoard();
  noise(b, 50); // 远超 limit=5
  await deliverInbox(b, WHO, () => {}); // 第一轮：全是噪声，游标越过

  // 来一条真实任务事件
  const t = b.createTask({ title: '真事件', brief: '', acceptance: '', requestId: null }, 's-a').task;

  const r2 = await deliverInbox(b, WHO, () => {});
  assert.equal(r2.injected, true, '真实事件必须能浮出来');
  assert.ok(r2.count >= 1);
});

// ─────────────────────── b) 噪声夹在中间：后面的事件不被饿死 ───────────────────────

test('b1. peer.event 夹在中间：task 事件仍被显示（靠多取 + 翻页）', async () => {
  const b = newBoard();
  noise(b, 30);
  const t = b.createTask({ title: '夹在中间的真事件', brief: '', acceptance: '', requestId: null }, 's-a').task;
  noise(b, 30);

  const got = await collectInbox(b, WHO);
  assert.ok(got.count >= 1, '夹在噪声中间的真实事件必须被取到');
  assert.ok(got.text.includes(t.task_id), `摘要应点名任务 ${t.task_id}：\n${got.text}`);
  assert.ok(!got.text.includes('peer.event'), `摘要不该出现被排除的 kind：\n${got.text}`);
});

test('b2. 关键：真实事件排在 limit 之外时，游标不能越过它（否则饿死）', async () => {
  const b = newBoard();
  // 造 10 条真实事件，每条后面夹 3 条噪声，总 40 条
  const ids = [];
  for (let i = 0; i < 10; i += 1) {
    ids.push(b.createTask({ title: `真-${i}`, brief: '', acceptance: '', requestId: null }, 's-a').task.task_id);
    noise(b, 3);
  }

  const first = await collectInbox(b, WHO);
  assert.equal(first.count, 5, `limit=5 应只显示 5 条，实际 ${first.count}`);

  // 核心断言：逐轮推进游标，**必须把所有 10 条真实事件都读到**。
  // 如果游标跳到全表最大 seq，第二轮就什么都读不到了，下面的集合会缺条目。
  const collected = new Set();
  for (const id of ids) if (first.text.includes(id)) collected.add(id);

  // 先把第一轮的结果真正落进游标，之后每轮的 sinceSeq 才会往前走
  await b.advanceCursor(WHO.instanceId, WHO.sessionId, first.nextSeq);
  let cursor = first.nextSeq;

  for (let round = 0; round < 10 && collected.size < ids.length; round += 1) {
    const got = await collectInbox(b, WHO);
    if (got.count === 0) break;
    for (const id of ids) if (got.text.includes(id)) collected.add(id);
    if (got.nextSeq <= cursor) break; // 游标没动，防死循环
    cursor = got.nextSeq;
    await b.advanceCursor(WHO.instanceId, WHO.sessionId, cursor);
  }
  assert.equal(
    collected.size,
    ids.length,
    `必须能读到全部 ${ids.length} 条真实事件（不饿死），实际 ${collected.size} 条；` +
      `缺：${ids.filter((x) => !collected.has(x)).join(',')}`,
  );
});

test('b3. 真实事件数量恰在 limit 边界：能一次读完且游标越过全部噪声', async () => {
  const b = newBoard();
  noise(b, 20);
  const t = b.createTask({ title: '唯一真事件', brief: '', acceptance: '', requestId: null }, 's-a').task;
  noise(b, 20);

  const got = await collectInbox(b, WHO);
  assert.equal(got.count, 1, '只有一条真实事件');
  // 只有 1 条真实事件（< limit），所以后面所有噪声都可以被越过
  assert.ok(got.nextSeq > 40, `游标应越过全部噪声与真事件，实际 ${got.nextSeq}`);
  assert.ok(got.text.includes(t.task_id));
});

// ─────────────────────── c) 关闭过滤：行为与改动前一致 ───────────────────────

test('c1. excludeKinds: [] → 不过滤，peer.event 正常显示', async () => {
  const b = newBoard();
  noise(b, 10);
  const got = await collectInbox(b, { ...WHO, excludeKinds: [] });
  assert.ok(got.count > 0, '关闭过滤后应能看到 peer.event');
  assert.ok(got.text.includes('peer.event'), `应出现 peer.event：\n${got.text}`);
  assert.equal(got.skipped, 0, '不过滤时 skipped 应为 0');
});

test('c2. 不传 excludeKinds → 用默认值（排除 peer.event）', async () => {
  const b = newBoard();
  noise(b, 10);
  const got = await collectInbox(b, { instanceId: 'server', sessionId: 'session-1', limit: 5 });
  assert.equal(got.count, 0, '默认应排除 peer.event');
  assert.ok(got.skipped > 0);
});

test('c3. excludeKinds 传自定义种类：只排它，peer.event 照显', async () => {
  const b = newBoard();
  b.appendEvent('peer.event', null, 'a', {});
  b.appendEvent('task.created', 't-abc', 's', { title: 'x' });
  const got = await collectInbox(b, { ...WHO, excludeKinds: ['task.created'] });
  assert.ok(got.count >= 1);
  assert.ok(got.text.includes('peer.event'), '自定义排除后 peer.event 应出现');
  assert.ok(!got.text.includes('task.created'), 'task.created 应被排除');
});

test('c4. 排除全部种类 → 纯噪声等价行为（不注入但游标前进）', async () => {
  const b = newBoard();
  b.appendEvent('peer.event', null, 'a', {});
  b.appendEvent('task.created', 't-abc', 's', {});
  const before = await b.getCursor(WHO.instanceId, WHO.sessionId);
  const got = await collectInbox(b, { ...WHO, excludeKinds: ['peer.event', 'task.created'] });
  assert.equal(got.count, 0);
  assert.ok(got.nextSeq > before, '全被排除时游标仍应前进');
});

// ─────────────────────── 走真实钩子：噪声不产生注入消息 ───────────────────────

test('d1. 钩子路径：纯噪声不注入任何消息（不刷屏）', async () => {
  const b = newBoard();
  noise(b, 30);
  let listener = null;
  installInboxHook({
    ctx: {
      on: (_e, fn) => {
        listener = fn;
        return () => {};
      },
      logger: { warn: () => {} },
    },
    board: b,
    limit: 5,
    resolveInstance: async () => 'server',
  });
  const out = await listener(
    { agent: { id: 'session-1' }, signal: { aborted: false }, step: 1, messages: [] },
    async () => ({ messages: [] }),
  );
  assert.equal(out.messages.length, 0, '纯噪声不该产生注入消息');
  const cursor = await b.getCursor('server', 'session-1');
  assert.ok(cursor > 0, '游标应已越过噪声');
});

test('d2. 钩子路径：噪声 + 真事件 → 只注入真事件', async () => {
  const b = newBoard();
  noise(b, 30);
  const t = b.createTask({ title: '钩子真事件', brief: '', acceptance: '', requestId: null }, 's-a').task;
  noise(b, 30);

  let listener = null;
  installInboxHook({
    ctx: {
      on: (_e, fn) => {
        listener = fn;
        return () => {};
      },
      logger: { warn: () => {} },
    },
    board: b,
    limit: 5,
    resolveInstance: async () => 'server',
  });
  const out = await listener(
    { agent: { id: 'session-1' }, signal: { aborted: false }, step: 1, messages: [] },
    async () => ({ messages: [] }),
  );
  assert.equal(out.messages.length, 1, '应注入一条摘要');
  const text = JSON.stringify(out.messages[0]);
  assert.ok(text.includes(t.task_id), '应含真实任务');
  assert.ok(!text.includes('peer.event'), '不该含噪声');
});

test('d3. 钩子路径：excludeKinds 配置为 [] 时噪声照显（可回退）', async () => {
  const b = newBoard();
  noise(b, 5);
  let listener = null;
  installInboxHook({
    ctx: {
      on: (_e, fn) => {
        listener = fn;
        return () => {};
      },
      logger: { warn: () => {} },
    },
    board: b,
    limit: 5,
    excludeKinds: [],
    resolveInstance: async () => 'server',
  });
  const out = await listener(
    { agent: { id: 'session-1' }, signal: { aborted: false }, step: 1, messages: [] },
    async () => ({ messages: [] }),
  );
  assert.equal(out.messages.length, 1, '关闭过滤后应注入');
  assert.ok(JSON.stringify(out.messages[0]).includes('peer.event'));
});

// ─────────────────────── 摘要要如实说明"过滤掉了多少" ───────────────────────

test('e1. 摘要里写明跳过了多少噪声（否则用户以为没动静）', async () => {
  const b = newBoard();
  noise(b, 10);
  b.createTask({ title: '真', brief: '', acceptance: '', requestId: null }, 's-a');
  const got = await collectInbox(b, WHO);
  assert.ok(got.count >= 1);
  assert.ok(got.skipped > 0, '应有跳过计数');
  assert.ok(/过滤/.test(got.text), `摘要应说明过滤：\n${got.text}`);
});

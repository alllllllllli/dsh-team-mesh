/**
 * v5_remote_compat.test.mjs — 0.7 客户端对 **0.6.1 旧板服务**的兼容（硬要求）。
 *
 * 背景：生产上的共享板在 mcloud，本次**不升级板服务**。新客户端若把
 * `blockedBy / writeScopes / expectedRevision` 直接塞给旧服务端，轻则被忽略（静默失真），
 * 重则报错把跨机派活全打挂（0.6.0 踩过"整插件加载失败"的坑）。
 *
 * 所以规则是：`/health` 能力探测 → 探测不到就不发新字段 → 本地按"空依赖 / 空写域 /
 * 不做 CAS"降级，且**绝不能因此让插件加载失败**。本文件用真 HTTP 假板服务把两条路径
 * （legacy / 新版）都验一遍，并核对请求体里到底发了什么。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { parseCapabilities, RemoteBoard } from '../src/remote.js';

/** 启动一个记录请求体的假板服务。health 用调用方给的响应。 */
async function fakeBoard(healthBody) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try {
        body = raw.length > 0 ? JSON.parse(raw) : null;
      } catch {
        body = { _raw: raw };
      }
      seen.push({ method: req.method, url: req.url, body });
      const send = (obj) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const pathname = new URL(req.url, 'http://x').pathname;
      if (pathname === '/health') return send(healthBody);
      if (pathname === '/task/create') {
        return send({
          ok: true,
          task: {
            task_id: 't-fake0001',
            title: body.title,
            lifecycle: 'open',
            version: 1,
            blockedBy: body.blockedBy,
            writeScopes: body.writeScopes,
            ready: true,
            writeScopeWarnings: [],
          },
          deduped: false,
        });
      }
      if (pathname === '/task/get') {
        return send({ ok: true, task: { task_id: 't-fake0001', title: 'x', lifecycle: 'open', version: 1 } });
      }
      if (pathname === '/task/list') {
        return send({ ok: true, tasks: [{ task_id: 't-fake0001', title: 'x', lifecycle: 'open', version: 1 }] });
      }
      if (pathname === '/task/claim') {
        return send({ ok: true, task: { task_id: 't-fake0001', lifecycle: 'working', version: 2 }, deduped: false });
      }
      if (pathname === '/task/complete') return send({ ok: true, task: { task_id: 't-fake0001', lifecycle: 'done', version: 3 } });
      if (pathname === '/task/cancel') return send({ ok: true, task: { task_id: 't-fake0001', lifecycle: 'canceled', version: 3 } });
      return send({ ok: false, error: { code: 'NO_ROUTE', message: `no route ${pathname}` } });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// ───────────────────────── 能力探测本身 ─────────────────────────

test('parseCapabilities：capabilities 数组优先；否则按 schema_version>=5；都没有=legacy', () => {
  assert.equal(parseCapabilities({ schema_version: 4 }).legacy, true);
  assert.equal(parseCapabilities({ schema_version: 4 }).features.size, 0);
  assert.equal(parseCapabilities({}).legacy, true, '探测不到一律按 legacy（保守）');
  assert.equal(parseCapabilities(null).legacy, true);

  const bySchema = parseCapabilities({ schema_version: 5 });
  assert.equal(bySchema.legacy, false);
  assert.equal(bySchema.source, 'schema_version');
  assert.ok(bySchema.features.has('task-deps'));

  const explicit = parseCapabilities({ schema_version: 4, capabilities: ['task-deps'] });
  assert.equal(explicit.legacy, false);
  assert.equal(explicit.source, 'capabilities');
  assert.equal(explicit.features.has('task-deps'), true);
  assert.equal(explicit.features.has('write-scopes'), false, '显式能力清单以服务端为准，不补全');
});

// ───────────────────────── legacy（0.6.1）服务端 ─────────────────────────

test('0.6.1 legacy 服务端：不发送 blockedBy/writeScopes/expectedRevision，返回按空依赖降级', async () => {
  const fake = await fakeBoard({ ok: true, service: 'fake', version: '1.0.0', schema_version: 4 });
  try {
    const board = new RemoteBoard({ endpoint: fake.endpoint, token: 't' });
    const health = await board.health();
    assert.equal(health.schema_version, 4);
    assert.equal(board.capabilities().legacy, true);
    assert.deepEqual(board.capabilities().features, []);
    assert.equal(board.supports('task-deps'), false);

    const created = await board.createTask(
      { title: '旧板任务', brief: '', acceptance: '', requestId: null, blockedBy: ['t-x'], writeScopes: ['src/a'] },
      's-a',
    );
    // 请求体里**绝不能**出现新字段
    const createReq = fake.seen.find((r) => r.url === '/task/create');
    assert.equal(Object.hasOwn(createReq.body, 'blockedBy'), false, 'legacy 服务端不许收到 blockedBy');
    assert.equal(Object.hasOwn(createReq.body, 'writeScopes'), false, 'legacy 服务端不许收到 writeScopes');
    // 返回按空依赖/空写域降级，ready 由 open 推导（不编造服务端没给的结论）
    assert.deepEqual(created.task.blockedBy, []);
    assert.deepEqual(created.task.writeScopes, []);
    assert.equal(created.task.ready, true);
    assert.deepEqual(created.task.writeScopeWarnings, []);
    assert.equal(created.task.revision, 1);

    const claimed = await board.claimTask('t-fake0001', 's-a', { expectedRevision: 99 });
    const claimReq = fake.seen.find((r) => r.url === '/task/claim');
    assert.equal(Object.hasOwn(claimReq.body, 'expectedRevision'), false, 'legacy 服务端不许收到 expectedRevision');
    assert.equal(claimed.task.lifecycle, 'working');

    const got = await board.getTask('t-fake0001');
    assert.equal(got.blockedBy.length, 0);
    assert.equal(got.writeScopes.length, 0);
    assert.equal(got.ready, true, 'legacy 视图：open 且无依赖 = ready');

    const listed = await board.listTasks({});
    assert.equal(listed.length, 1);
    assert.equal(listed[0].ready, true);

    // 写操作也不带新字段
    await board.completeTask('t-fake0001', 's-a', { expectedRevision: 1 });
    await board.cancelTask('t-fake0001', 's-a', 'x', { expectedRevision: 1 });
    for (const url of ['/task/complete', '/task/cancel']) {
      const req = fake.seen.find((r) => r.url === url);
      assert.equal(Object.hasOwn(req.body, 'expectedRevision'), false, `${url} 不许带新字段`);
    }
    board.close();
  } finally {
    await fake.close();
  }
});

test('legacy 探测失败不影响"能连上"：health 返回非 JSON 结构时 capabilities 退化为 legacy', async () => {
  const fake = await fakeBoard({ ok: true, version: 'weird' }); // 没有 schema_version / capabilities
  try {
    const board = new RemoteBoard({ endpoint: fake.endpoint });
    await board.health();
    assert.equal(board.capabilities().legacy, true);
    assert.equal(board.capabilities().schema_version, null);
    board.close();
  } finally {
    await fake.close();
  }
});

// ───────────────────────── 新版（0.7+）服务端 ─────────────────────────

test('0.7 服务端（capabilities/schema 5）：发送并使用新字段与派生视图', async () => {
  const fake = await fakeBoard({
    ok: true,
    service: 'fake',
    version: '1.0.0',
    schema_version: 5,
    capabilities: ['task-deps', 'write-scopes', 'expected-revision'],
  });
  try {
    const board = new RemoteBoard({ endpoint: fake.endpoint, token: 't' });
    await board.health();
    assert.equal(board.capabilities().legacy, false);
    assert.equal(board.supports('expected-revision'), true);

    const created = await board.createTask(
      { title: '新板任务', brief: '', acceptance: '', requestId: null, blockedBy: ['t-a'], writeScopes: ['src\\a'] },
      's-a',
    );
    const createReq = fake.seen.find((r) => r.url === '/task/create');
    assert.deepEqual(createReq.body.blockedBy, ['t-a']);
    assert.deepEqual(createReq.body.writeScopes, ['src\\a']);
    // 服务端返回的派生字段原样保留（不覆盖、不重算）
    assert.deepEqual(created.task.blockedBy, ['t-a']);
    assert.equal(created.task.ready, true, '服务端说 ready 就信服务端（派生逻辑在板侧）');

    await board.claimTask('t-fake0001', 's-a', { expectedRevision: 7 });
    const claimReq = fake.seen.find((r) => r.url === '/task/claim');
    assert.equal(claimReq.body.expectedRevision, 7);
    board.close();
  } finally {
    await fake.close();
  }
});

test('新版服务端按 schema_version>=5 推断能力（没显式 capabilities 也能用新字段）', async () => {
  const fake = await fakeBoard({ ok: true, version: '1.0.0', schema_version: 5 });
  try {
    const board = new RemoteBoard({ endpoint: fake.endpoint });
    await board.health();
    assert.equal(board.capabilities().legacy, false);
    assert.equal(board.capabilities().source, 'schema_version');
    await board.createTask({ title: 'x', brief: '', acceptance: '', requestId: null, blockedBy: ['t-b'] }, 's');
    const req = fake.seen.find((r) => r.url === '/task/create');
    assert.deepEqual(req.body.blockedBy, ['t-b']);
    board.close();
  } finally {
    await fake.close();
  }
});

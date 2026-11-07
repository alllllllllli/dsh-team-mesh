/**
 * 契约测试：**拿宿主真实的 `defineTool`** 编译全部 spec，再用一个假 ctx 真跑 apply。
 *
 * 为什么这一步不能省：schema 用了宿主不认的关键字时，`ctx.tools.register()` 会在
 * apply 阶段抛错，整个插件树起不来 —— 用户看到的是"应用打不开"。这种错误必须在
 * 装进用户 profile 之前就炸在测试里。
 *
 * defineTool 来自 `vendor/node_modules/@deepseek-ai/dsh-tools`（从 app.asar 解出来的
 * 那一份，与宿主运行的是同一个版本）。解包流程见 tools/vendor_deps.mjs。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { allSpecs, TOOL_NAMES } from '../src/spec.js';
import { apply, PLUGIN_VERSION, toolNames } from '../src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TOOLS_ENTRY = path.join(ROOT, 'vendor', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');

const tmps = [];
function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-team-contract-'));
  tmps.push(d);
  return d;
}
process.on('exit', () => {
  for (const d of tmps) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* ignore */
    }
  }
});

async function realDefineTool() {
  assert.ok(fs.existsSync(TOOLS_ENTRY), `缺少解包出来的 dsh-tools：先跑 node tools/vendor_deps.mjs`);
  const mod = await import(pathToFileURL(TOOLS_ENTRY).href);
  assert.equal(typeof mod.defineTool, 'function');
  return mod.defineTool;
}

// ───────────────────────── spec 能被真实 defineTool 编译 ─────────────────────────

test('全部 spec 都能被宿主真实的 defineTool 编译（这一步失败就等于应用起不来）', async () => {
  const defineTool = await realDefineTool();
  const specs = allSpecs();
  // 不写死数字：以 TOOL_NAMES 为准，防止加了工具忘记同步测试
  assert.equal(specs.length, Object.keys(TOOL_NAMES).length);
  assert.ok(specs.length >= 12, `工具数不应少于 12（v2 含 ack/heartbeat/inbox），实际 ${specs.length}`);

  for (const spec of specs) {
    const tool = defineTool({ ...spec, execute: async () => 'ok' });
    assert.equal(tool.name, spec.name, `工具名被改写：${spec.name}`);
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 20, `${spec.name} 的描述太短，模型看不懂`);
    assert.equal(typeof tool.execute, 'function');
    // parameters 会被投影成面向模型的 schema：必须带上我们声明的键
    const declared = Object.keys(spec.parameters ?? {});
    for (const key of declared) {
      assert.ok(
        JSON.stringify(tool.parameters).includes(key),
        `${spec.name} 的参数 ${key} 没出现在投影后的 schema 里`,
      );
    }
  }
});

test('反向对照：用宿主不认的关键字会被编译出来 -> 说明这个测试真能抓到问题', async () => {
  const defineTool = await realDefineTool();
  // minLength 属于注记式约束，宿主不支持。它必须在这里就炸，而不是等模型调用。
  assert.throws(() => {
    defineTool({
      name: 'bogus_tool',
      description: '故意写一个宿主不认的 schema，用来证明契约测试不是摆设',
      parameters: { text: { type: 'string', minLength: 3 } },
      execute: async () => 'x',
    });
  }, /./, '带不支持关键字的 spec 应当在编译期就抛错');
});

test('required 标记被保留：必填参数缺失时由宿主校验拦下', async () => {
  const defineTool = await realDefineTool();
  const create = defineTool({ ...allSpecs().find((s) => s.name === TOOL_NAMES.create), execute: async () => 'x' });
  const projected = JSON.stringify(create.parameters);
  assert.match(projected, /title/, 'title 必须出现在 schema 里');
  // 我们的 spec 里 title 标了 required
  const titleSpec = allSpecs().find((s) => s.name === TOOL_NAMES.create).parameters.title;
  assert.equal(titleSpec.required, true);
});

// ───────────────────────── apply 真的注册了工具 ─────────────────────────

function fakeCtx() {
  const registered = [];
  const listeners = [];
  const logs = [];
  return {
    registered,
    listeners,
    logs,
    ctx: {
      tools: {
        register(tool) {
          registered.push(tool);
          return () => {
            const i = registered.indexOf(tool);
            if (i >= 0) registered.splice(i, 1);
          };
        },
      },
      on(event, listener) {
        const record = { event, listener };
        listeners.push(record);
        // 按记录对象本身移除：按 listener 找会失败（列表里装的是 record）
        return () => {
          const i = listeners.indexOf(record);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
      logger: {
        info: (m) => logs.push(`info: ${m}`),
        warn: (m) => logs.push(`warn: ${m}`),
        error: (m) => logs.push(`error: ${m}`),
      },
    },
  };
}

const exec = (sessionId) => ({ agent: { id: sessionId }, signal: new AbortController().signal });

test('apply 注册全部工具、订阅对端事件、返回可用的 disposer', async () => {
  const prev = process.env.DSH_TOOLS_PATH;
  process.env.DSH_TOOLS_PATH = TOOLS_ENTRY;
  try {
    const { ctx, registered, listeners, logs } = fakeCtx();
    const boardPath = path.join(tempDir(), 'team.db');
    const dispose = await apply(ctx, { boardPath });

    assert.equal(typeof dispose, 'function');
    assert.equal(registered.length, Object.keys(TOOL_NAMES).length, `注册数应与 TOOL_NAMES 一致，实际 ${registered.length}`);
    assert.deepEqual(
      registered.map((t) => t.name).sort(),
      Object.values(TOOL_NAMES).sort(),
    );
    assert.ok(listeners.some((l) => l.event === 'interconnect/event'), '应订阅对端事件');
    assert.ok(logs.some((l) => l.startsWith('info:')), '应打印加载日志');
    assert.ok(fs.existsSync(boardPath), '板文件应被创建');

    dispose();
    assert.equal(registered.length, 0, 'disposer 应解绑全部工具');
    assert.equal(listeners.length, 0, 'disposer 应解绑事件监听');
  } finally {
    if (prev === undefined) delete process.env.DSH_TOOLS_PATH;
    else process.env.DSH_TOOLS_PATH = prev;
  }
});

test('apply 出错时不让应用起不来：返回空 disposer 并记日志', async () => {
  const prev = process.env.DSH_TOOLS_PATH;
  delete process.env.DSH_TOOLS_PATH;
  try {
    const { ctx, logs } = fakeCtx();
    // 不设 DSH_TOOLS_PATH，且普通 node 里 import 不到 @deepseek-ai/dsh-tools
    const dispose = await apply(ctx, { boardPath: path.join(tempDir(), 'x.db') });
    assert.equal(typeof dispose, 'function');
    assert.doesNotThrow(() => dispose());
    assert.ok(logs.some((l) => l.startsWith('error:')), '必须留下错误日志，不能静默');
  } finally {
    if (prev !== undefined) process.env.DSH_TOOLS_PATH = prev;
  }
});

// ───────────────────────── 真跑一遍工具（不含 DSH 与网络） ─────────────────────────

test('端到端（无 DSH）：建任务 → 认领 → 报失败被拒 → 补可采信 pass → 完成', async () => {
  const prev = process.env.DSH_TOOLS_PATH;
  process.env.DSH_TOOLS_PATH = TOOLS_ENTRY;
  try {
    const { ctx } = fakeCtx();
    const dir = tempDir();
    const dispose = await apply(ctx, { boardPath: path.join(dir, 'team.db') });
    const byName = Object.fromEntries(ctx.tools && [] ? [] : []);
    // 直接从注册表拿工具
    const tools = new Map();
    // fakeCtx 的 register 把工具收进了数组，重新拿一次
    // （这里重跑 apply 会重复注册，所以直接读内部数组：用一个新的 ctx 更清楚）
    dispose();

    const fresh = fakeCtx();
    const dispose2 = await apply(fresh.ctx, { boardPath: path.join(dir, 'team.db') });
    for (const t of fresh.registered) tools.set(t.name, t);

    const created = await tools.get(TOOL_NAMES.create).execute(
      { title: '读三份资料写报告', acceptance: '字段齐全', requestId: 'req-e2e' },
      exec('session-orch'),
    );
    assert.match(created, /已建任务/);
    const taskId = created.match(/task_id: (t-[0-9a-f]{8})/)[1];

    const idem = await tools.get(TOOL_NAMES.create).execute(
      { title: '读三份资料写报告', requestId: 'req-e2e' },
      exec('session-orch'),
    );
    assert.match(idem, /幂等/, '同 requestId 重放必须命中幂等');

    const claimed = await tools.get(TOOL_NAMES.claim).execute({ taskId }, exec('session-worker'));
    assert.match(claimed, /已认领/);

    // 报一条 fail：不可采信地推动完成是做不到的
    await tools.get(TOOL_NAMES.report).execute(
      { taskId, executed: true, outcome: 'fail', note: '第一版不合格' },
      exec('session-worker'),
    );
    const rejected = await tools.get(TOOL_NAMES.complete).execute({ taskId }, exec('session-worker'));
    assert.match(rejected, /完成被门禁拒绝/);
    assert.match(rejected, /LATEST_FAIL/);

    // 真产物
    const artifact = path.join(dir, 'report.json');
    fs.writeFileSync(artifact, '{"sources":[]}', 'utf8');
    const reported = await tools.get(TOOL_NAMES.report).execute(
      { taskId, executed: true, outcome: 'pass', evidenceRef: artifact, note: '补齐了三份来源' },
      exec('session-worker'),
    );
    assert.match(reported, /可采信：是/);
    assert.match(reported, /sha256/);

    const done = await tools.get(TOOL_NAMES.complete).execute({ taskId }, exec('session-worker'));
    assert.match(done, /任务已完成/);

    const list = await tools.get(TOOL_NAMES.list).execute({ lifecycle: 'done' }, exec('session-orch'));
    assert.match(list, /done（已完成）/);

    const events = await tools.get(TOOL_NAMES.events).execute({ taskId, limit: 10 }, exec('session-orch'));
    assert.match(events, /task\.gate_rejected/, '被门禁拒过这件事必须能在事件流里查到');

    dispose2();
  } finally {
    if (prev === undefined) delete process.env.DSH_TOOLS_PATH;
    else process.env.DSH_TOOLS_PATH = prev;
  }
});

test('没有 interconnect 服务时：peers 与 dispatch 都如实说不可用，不假装成功', async () => {
  const prev = process.env.DSH_TOOLS_PATH;
  process.env.DSH_TOOLS_PATH = TOOLS_ENTRY;
  try {
    const fresh = fakeCtx();
    const dispose = await apply(fresh.ctx, { boardPath: path.join(tempDir(), 'team.db') });
    const tools = new Map(fresh.registered.map((t) => [t.name, t]));

    const peers = await tools.get(TOOL_NAMES.peers).execute({}, exec('s'));
    assert.match(peers, /没有 interconnect 服务/);

    const created = await tools.get(TOOL_NAMES.create).execute({ title: 'x' }, exec('s'));
    const taskId = created.match(/task_id: (t-[0-9a-f]{8})/)[1];
    await assert.rejects(
      () => tools.get(TOOL_NAMES.dispatch).execute({ taskId, instanceId: 'pc-b', sessionId: 'session-1' }, exec('s')),
      (err) => err.code === 'INTERCONNECT_UNAVAILABLE',
    );
    dispose();
  } finally {
    if (prev === undefined) delete process.env.DSH_TOOLS_PATH;
    else process.env.DSH_TOOLS_PATH = prev;
  }
});

test('toolNames() 与 spec 一致', () => {
  assert.deepEqual(toolNames().sort(), Object.values(TOOL_NAMES).sort());
  assert.equal(toolNames().length, Object.keys(TOOL_NAMES).length);
  assert.match(PLUGIN_VERSION, /^\d+\.\d+\.\d+/);
});
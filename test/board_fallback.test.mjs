/**
 * board_fallback.test.mjs — 0.6.1：远端板不可达时**默认降级到单机板**，而不是整插件加载失败。
 *
 * 事故（2026-11-21）：重启后 `boardEndpoint: http://172.24.112.14:13090` 恰好网络断，
 * `registerAll` 的健康检查抛错 → `apply()` 吞掉并返回空 no-op → 团队任务工具全部消失。
 * 0.6.1 起默认 `boardFallback: 'local'`：远端连不上就打 WARN、写 `mesh-degraded.json`、
 * 改用本地板、**全部工具照常注册**；`boardFallback: 'fail'` 才维持旧行为。
 *
 * 这一组用例全部把 `DSH_HOME` 指到临时目录、`boardPath` 走临时库，**不碰真实
 * `~/.dsh/team/team.db`**；远端用真 HTTP server（健康成功）与刚关闭的端口（不可达）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createHandlers } from '../src/handlers.js';
import {
  apply,
  DEGRADED_FILENAME,
  LOAD_ERROR_FILENAME,
  normalizeBoardFallback,
  PLUGIN_VERSION,
  resolveDegradedPath,
  resolveLoadErrorPath,
} from '../src/index.js';
import { allSpecs, TOOL_NAMES } from '../src/spec.js';
import { openBoard } from '../src/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TOOLS_ENTRY = path.join(ROOT, 'vendor', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');
/** 假的远端密钥：任何输出/日志/诊断文件里都不许出现它。 */
const FAKE_TOKEN = 'board-token-must-not-leak-0123456789';

const tmps = [];
const openServers = [];

function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-fallback-'));
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

test.after(async () => {
  for (const server of openServers.splice(0)) {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
});

/** 临时 HOME + 解包出来的 dsh-tools；测完原样恢复（不改真实环境）。 */
async function withEnv(home, fn) {
  const prevTools = process.env.DSH_TOOLS_PATH;
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_TOOLS_PATH = TOOLS_ENTRY;
  process.env.DSH_HOME = home;
  try {
    return await fn();
  } finally {
    if (prevTools === undefined) delete process.env.DSH_TOOLS_PATH;
    else process.env.DSH_TOOLS_PATH = prevTools;
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  }
}

/** 假 ctx：记日志、把注册的工具收进 Map（用来调 execute，验证真能干活）。 */
function fakeCtx() {
  const logs = [];
  const tools = new Map();
  const ctx = {
    tools: {
      register(tool) {
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
    },
    on: () => () => {},
    logger: {
      info: (m) => logs.push(`info: ${m}`),
      warn: (m) => logs.push(`warn: ${m}`),
      error: (m) => logs.push(`error: ${m}`),
    },
  };
  return { ctx, logs, tools };
}

const exec = (sessionId) => ({ agent: { id: sessionId }, signal: new AbortController().signal });

/** 起一个真的 TCP server 再立刻关掉，拿一个"此刻没人监听"的端口。 */
async function closedPort() {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** 起一个只回 /health 的假板服务（远端"恢复可用"用）。计一次请求数，用来验证探活停表。 */
async function startHealthServer(port) {
  const state = { requests: 0 };
  const server = http.createServer((_req, res) => {
    state.requests += 1;
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, version: 'fake-board', schema_version: 4 }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  openServers.push(server);
  return {
    server,
    requests: () => state.requests,
    close: async () => {
      const i = openServers.indexOf(server);
      if (i >= 0) openServers.splice(i, 1);
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function waitFor(fn, { timeoutMs = 3000, stepMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fn()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

// ───────────── ① 默认：降级到本地板，插件照常加载 ─────────────

test('默认（未设 boardFallback）：远端不可达 → 降级本地、工具全注册、写降级诊断并清掉 load-error', async () => {
  const dir = tempDir();
  await withEnv(dir, async () => {
    const port = await closedPort();
    const endpoint = `http://127.0.0.1:${port}`;
    const { ctx, logs, tools } = fakeCtx();

    // 上次失败的残留证据：降级成功（= 装载成功）必须清掉它
    const loadError = resolveLoadErrorPath({ boardEndpoint: endpoint });
    fs.mkdirSync(path.dirname(loadError), { recursive: true });
    fs.writeFileSync(loadError, JSON.stringify({ time: 'old', error: { message: 'old' } }), 'utf8');

    const dispose = await apply(ctx, {
      boardEndpoint: endpoint,
      boardToken: FAKE_TOKEN,
      boardTimeoutMs: 300,
      boardRetryMs: 60_000, // 本用例不测恢复，别让后台探活干扰
    });
    assert.equal(typeof dispose, 'function', '远端不可达也必须返回可调用的 disposer');

    // 工具全注册（这是事故里消失的东西）
    const specs = allSpecs();
    assert.equal(tools.size, specs.length, `工具应全部注册，实际 ${tools.size}/${specs.length}`);
    assert.deepEqual([...tools.keys()].sort(), Object.values(TOOL_NAMES).sort());

    // 降级诊断文件：字段齐全、不含 token
    const degradedFile = resolveDegradedPath({ boardEndpoint: endpoint });
    assert.equal(degradedFile, path.join(dir, 'team', DEGRADED_FILENAME), '降级诊断应与 load-error 同目录');
    assert.ok(fs.existsSync(degradedFile), '降级时必须写 mesh-degraded.json');
    const body = JSON.parse(fs.readFileSync(degradedFile, 'utf8'));
    assert.equal(body.mode, 'local-degraded');
    assert.equal(body.version, PLUGIN_VERSION);
    assert.equal(body.endpoint, endpoint);
    assert.ok(typeof body.error.message === 'string' && body.error.message.length > 0, 'error.message 要能说明原因');
    assert.match(String(body.hint), /重启/, 'hint 要写明恢复需重启');
    assert.ok(!JSON.stringify(body).includes(FAKE_TOKEN), '降级诊断不得包含 boardToken');

    // 残留 load-error 被清掉（这次是"装载成功"）
    assert.equal(fs.existsSync(loadError), false, '降级成功必须删掉残留的 mesh-load-error.json');

    // WARN 日志：endpoint + 原因，不含 token
    const warn = logs.find((l) => l.startsWith('warn:') && l.includes(endpoint));
    assert.ok(warn, '降级必须留一条带 endpoint 的 WARN 日志');
    assert.ok(!logs.join('\n').includes(FAKE_TOKEN), '日志不得包含 boardToken');

    // 本地板真的建出来了
    assert.ok(fs.existsSync(path.join(dir, 'team', 'team.db')), '降级应落到单机默认库路径');

    // 降级后基本业务在本地板上可用：建任务 / 列任务
    const created = await tools.get(TOOL_NAMES.create).execute({ title: '降级后的任务' }, exec('sess-orch'));
    assert.match(created, /已建任务/);
    const listed = await tools.get(TOOL_NAMES.list).execute({}, exec('sess-orch'));
    assert.match(listed, /降级后的任务/);

    dispose();
  });
});

// ───────────── ② fail：维持 0.6.0 旧行为 ─────────────

test("boardFallback:'fail'：远端不可达 → 按旧行为加载失败（写 load-error，不写降级诊断）", async () => {
  const dir = tempDir();
  await withEnv(dir, async () => {
    const port = await closedPort();
    const endpoint = `http://127.0.0.1:${port}`;
    const { ctx, logs } = fakeCtx();

    const dispose = await apply(ctx, {
      boardEndpoint: endpoint,
      boardToken: FAKE_TOKEN,
      boardFallback: 'fail',
      boardTimeoutMs: 300,
    });
    // 默认（不 strict）仍吞异常返回空 disposer —— fail 模式 = 0.6.0 的行为
    assert.equal(typeof dispose, 'function');
    assert.doesNotThrow(() => dispose());

    const loadError = resolveLoadErrorPath({ boardEndpoint: endpoint });
    assert.ok(fs.existsSync(loadError), 'fail 模式必须写 mesh-load-error.json');
    const body = JSON.parse(fs.readFileSync(loadError, 'utf8'));
    assert.equal(body.boardEndpoint, endpoint);
    assert.equal(fs.existsSync(resolveDegradedPath({ boardEndpoint: endpoint })), false, 'fail 模式不该写降级诊断');
    assert.ok(logs.some((l) => l.startsWith('error:')), '失败必须留 error 日志（不能静默）');
    assert.ok(!logs.join('\n').includes(FAKE_TOKEN), '日志不得包含 boardToken');
  });
});

test("boardFallback:'fail' + DSH_TEAM_STRICT=1：把异常抛给宿主（失败可见）", async () => {
  const dir = tempDir();
  const prevStrict = process.env.DSH_TEAM_STRICT;
  process.env.DSH_TEAM_STRICT = '1';
  try {
    await withEnv(dir, async () => {
      const port = await closedPort();
      const endpoint = `http://127.0.0.1:${port}`;
      const { ctx } = fakeCtx();
      await assert.rejects(
        () => apply(ctx, { boardEndpoint: endpoint, boardFallback: 'fail', boardTimeoutMs: 300 }),
        /连不上远端板/,
        'strict + fail 必须抛出加载错误，而不是返回空壳',
      );
      assert.ok(fs.existsSync(resolveLoadErrorPath({ boardEndpoint: endpoint })), '抛错前也要写诊断文件');
    });
  } finally {
    if (prevStrict === undefined) delete process.env.DSH_TEAM_STRICT;
    else process.env.DSH_TEAM_STRICT = prevStrict;
  }
});

// ───────────── ③ 配置校验：拼错按 local，但要提示 ─────────────

test('normalizeBoardFallback：只认 local / fail；未设默认 local；其他值按 local 并留 WARN', () => {
  const logs = [];
  const ctx = { logger: { warn: (m) => logs.push(String(m)) } };
  assert.equal(normalizeBoardFallback(undefined, ctx), 'local');
  assert.equal(normalizeBoardFallback('', ctx), 'local');
  assert.equal(normalizeBoardFallback('fail', ctx), 'fail');
  assert.equal(normalizeBoardFallback(' LOCAL ', ctx), 'local');
  assert.equal(logs.length, 0, '合法值不该打 WARN');
  assert.equal(normalizeBoardFallback('locall', ctx), 'local', '拼错按 local 处理（不能把插件打挂）');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /boardFallback/);
  assert.match(logs[0], /locall/);
});

test('boardFallback 拼错：仍降级成功，日志里提示取值不合法', async () => {
  const dir = tempDir();
  await withEnv(dir, async () => {
    const port = await closedPort();
    const endpoint = `http://127.0.0.1:${port}`;
    const { ctx, logs, tools } = fakeCtx();
    const dispose = await apply(ctx, {
      boardEndpoint: endpoint,
      boardFallback: 'locall',
      boardTimeoutMs: 300,
      boardRetryMs: 60_000,
    });
    assert.equal(tools.size, allSpecs().length, '拼错也不能少注册工具');
    assert.ok(fs.existsSync(resolveDegradedPath({ boardEndpoint: endpoint })), '拼错应按 local 降级');
    assert.ok(
      logs.some((l) => l.startsWith('warn:') && l.includes('boardFallback') && l.includes('locall')),
      '要提示拼写错误',
    );
    dispose();
  });
});

// ───────────── ④ 可诊断性：mesh_peers 首行给板模式与原因 ─────────────

test('降级下 mesh_peers 首行显示「板模式：本地降级（原因…）」并提示跨机不同步', async () => {
  const dir = tempDir();
  await withEnv(dir, async () => {
    const port = await closedPort();
    const endpoint = `http://127.0.0.1:${port}`;
    const { ctx, tools } = fakeCtx();
    const dispose = await apply(ctx, {
      boardEndpoint: endpoint,
      boardToken: FAKE_TOKEN,
      boardTimeoutMs: 300,
      boardRetryMs: 60_000,
    });
    // fakeCtx 没有 interconnect → mesh_peers 走"没有 interconnect"分支，但板模式行必须在最前面
    const out = await tools.get(TOOL_NAMES.peers).execute({}, exec('sess-orch'));
    const firstLine = out.split('\n')[0];
    assert.match(firstLine, /^板模式：本地降级（原因：/);
    assert.match(firstLine, /ECONNREFUSED|BOARD_UNREACHABLE|连不上/);
    assert.match(out, /跨机任务不会同步/);
    assert.match(out, /网络恢复后重启 DSH/);
    assert.ok(!out.includes(FAKE_TOKEN), '诊断输出不得包含 boardToken');
    dispose();
  });
});

test('降级下 mesh_dispatch 明确提示：本地板 / 跨机任务不会同步 / 重启才切回', async () => {
  const dir = tempDir();
  const board = openBoard(path.join(dir, 'team.db'));
  try {
    const task = board.createTask({ title: '跨机任务', brief: '', acceptance: '', requestId: null }, 'sess-orch').task;
    const calls = [];
    const interconnect = {
      peers: () => [{ instanceId: 'peer-b', origin: 'http://127.0.0.1:13085', link: 'up' }],
      selfSender: (sessionId) => ({ instanceId: 'self-a', sessionId }),
      list: async () => ({ sessions: [] }),
      send: async (req) => {
        calls.push(req);
        return { delivered: true, instance: req.instanceId, delivery: 'followup' };
      },
    };
    const h = createHandlers({
      getBoard: () => board,
      getInterconnect: () => interconnect,
      getBoardMode: () => ({ mode: 'local-degraded', endpoint: 'http://127.0.0.1:1', reason: 'BOARD_UNREACHABLE: 连不上板服务' }),
    });
    const out = await h.mesh_dispatch(
      { taskId: task.task_id, instanceId: 'peer-b', sessionId: 'session-1' },
      exec('sess-orch'),
    );
    // 仍然照常投递（不阻断），但必须让人知道板不对
    assert.equal(calls.length, 1, '降级不改变派发行为，只是如实告警');
    assert.match(out, /板模式：本地降级/);
    assert.match(out, /当前本地板，跨机任务不会同步/);
    assert.match(out, /网络恢复后重启 DSH 切回远端/);
  } finally {
    board.close();
  }
});

// ───────────── ⑤ 远端可用时不降级（反证：降级不是无条件发生） ─────────────

test('远端可用时不降级：板模式=远端，且清掉上次遗留的降级诊断', async () => {
  const dir = tempDir();
  const port = await closedPort();
  const health = await startHealthServer(port);
  try {
    await withEnv(dir, async () => {
      const endpoint = `http://127.0.0.1:${port}`;
      const { ctx, logs, tools } = fakeCtx();
      // 上次降级留下的旧证据：这次远端连上了，必须删掉
      const staleDegraded = path.join(dir, 'team', DEGRADED_FILENAME);
      fs.mkdirSync(path.dirname(staleDegraded), { recursive: true });
      fs.writeFileSync(staleDegraded, JSON.stringify({ mode: 'local-degraded' }), 'utf8');

      const dispose = await apply(ctx, { boardEndpoint: endpoint, boardToken: FAKE_TOKEN, boardTimeoutMs: 1000 });
      assert.ok(
        logs.some((l) => l.startsWith('info:') && l.includes('远端板已连上')),
        '远端可用时应走原来的成功路径',
      );
      assert.equal(fs.existsSync(staleDegraded), false, '远端连上时必须删掉旧的降级诊断');
      assert.equal(fs.existsSync(path.join(dir, 'team', LOAD_ERROR_FILENAME)), false);

      const out = await tools.get(TOOL_NAMES.peers).execute({}, exec('sess-orch'));
      assert.match(out.split('\n')[0], /^板模式：远端（http:\/\/127\.0\.0\.1:/);
      dispose();
    });
  } finally {
    await health.close();
  }
});

// ───────────── ⑥ 后台重试：只记一次恢复、恢复后停表 ─────────────

test('后台重试：先失败后成功只记一条 remote_available_again，并在诊断文件里补证据', async () => {
  const dir = tempDir();
  const port = await closedPort();
  let health = null;
  try {
    await withEnv(dir, async () => {
      const endpoint = `http://127.0.0.1:${port}`;
      const { ctx, logs } = fakeCtx();
      const dispose = await apply(ctx, {
        boardEndpoint: endpoint,
        boardToken: FAKE_TOKEN,
        boardTimeoutMs: 300,
        boardRetryMs: 40, // 测试注入短间隔
      });
      assert.ok(fs.existsSync(path.join(dir, 'team', DEGRADED_FILENAME)), '起始应是降级状态');

      // 先失败、后成功：把"远端"起起来，等后台探活发现
      health = await startHealthServer(port);
      const recovered = await waitFor(() => logs.some((l) => l.includes('remote_available_again: true')));
      assert.ok(recovered, '远端恢复后日志里应出现一条 remote_available_again: true');

      const body = JSON.parse(fs.readFileSync(path.join(dir, 'team', DEGRADED_FILENAME), 'utf8'));
      assert.equal(body.remote_available_again, true, '诊断文件要补上恢复证据');
      assert.equal(body.mode, 'local-degraded', '恢复不改变板模式（不热切换）');
      assert.ok(!JSON.stringify(body).includes(FAKE_TOKEN), '诊断文件不得包含 boardToken');

      // 恢复后停表：再等几个周期，恢复记录仍只有一条、探活请求不再增加
      const probeCount = health.requests();
      await new Promise((resolve) => setTimeout(resolve, 250));
      const recoverLines = logs.filter((l) => l.includes('remote_available_again: true'));
      assert.equal(recoverLines.length, 1, `恢复只许记一次，实际 ${recoverLines.length} 次`);
      assert.equal(health.requests(), probeCount, '恢复后应停止后台探活');
      dispose();
    });
  } finally {
    if (health !== null) await health.close();
  }
});

test('dispose 后后台探活定时器不再跑（不拖住进程、也不偷偷探活）', async () => {
  const dir = tempDir();
  const port = await closedPort();
  let health = null;
  try {
    await withEnv(dir, async () => {
      const { ctx, logs } = fakeCtx();
      const dispose = await apply(ctx, {
        boardEndpoint: `http://127.0.0.1:${port}`,
        boardTimeoutMs: 300,
        boardRetryMs: 30,
      });
      dispose(); // 立刻卸载

      // 卸载之后远端才"恢复"：定时器若没清掉，就会打过来并记恢复日志
      health = await startHealthServer(port);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(health.requests(), 0, 'dispose 后不该再有探活请求');
      assert.equal(logs.filter((l) => l.includes('remote_available_again')).length, 0);
    });
  } finally {
    if (health !== null) await health.close();
  }
});

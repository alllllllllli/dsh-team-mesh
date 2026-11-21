/**
 * peer_probe.test.mjs — 0.6 P0-3：`mesh_peers` 可诊断 + 新工具 `mesh_peer_probe`。
 *
 * 这一组用例**不用假 TCP**：真起一个 `node:net` server 当"通"的对端，
 * 再用一个刚关闭的端口当"不通"的对端 —— 否则探测逻辑写错了也测不出来。
 *
 * interconnect 用假对象：我们只读它的公开面 `peers()` / `selfSender()` / `list()`，
 * 不碰它的源码与配置（这是本项的红线）。
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';

import { createHandlers } from '../src/handlers.js';
import { PEER_PROBE_TIMEOUT_MS } from '../src/diagnose.js';
import { TOOL_NAMES, allSpecs } from '../src/spec.js';

const OPEN_SERVERS = [];

/** 起一个真的在监听的 TCP server，返回 origin 与端口。 */
async function startTcpPeer() {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  OPEN_SERVERS.push(server);
  const port = server.address().port;
  return { origin: `http://127.0.0.1:${port}`, port, server };
}

/** 拿一个"此刻没人监听"的端口：开一个再立刻关掉。 */
async function closedPort() {
  const { server, port } = await startTcpPeer();
  await new Promise((resolve) => server.close(resolve));
  const i = OPEN_SERVERS.indexOf(server);
  if (i >= 0) OPEN_SERVERS.splice(i, 1);
  return port;
}

// 用 node:test 的 after 钩子关掉所有监听 socket：否则每个用例起的 server 会吊住
// 子进程的事件循环，`node --test` 永远等不到退出（真的踩过，不是理论问题）。
test.after(async () => {
  for (const server of OPEN_SERVERS.splice(0)) {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
});

/** 假 interconnect：只实现本项用到的公开方法。 */
function fakeInterconnect(rows, opts = {}) {
  const listCalls = [];
  return {
    listCalls,
    selfSender: (sessionId) => ({ instanceId: 'pc-self', sessionId }),
    peers: () => rows,
    async list(instanceId) {
      listCalls.push(instanceId);
      if (opts.list === undefined) return { sessions: [] };
      if (typeof opts.list === 'function') return opts.list(instanceId);
      return opts.list;
    },
  };
}

function handlersWith(interconnect) {
  return createHandlers({
    getBoard: () => ({}),
    getInterconnect: () => interconnect,
  });
}

const noExec = { agent: { id: 'session-orch' } };

// ─────────────────────────── mesh_peers：补三种诊断字段 ───────────────────────────

test('mesh_peers：TCP 通的对端，输出带 TCP 耗时与链路状态', async () => {
  const { origin } = await startTcpPeer();
  const handlers = handlersWith(
    fakeInterconnect([{ instanceId: 'peer-live', origin, link: 'up' }]),
  );

  const text = await handlers.mesh_peers({}, noExec);

  assert.match(text, /本实例：pc-self/);
  assert.match(text, /peer-live\s+up/);
  assert.ok(text.includes(origin), '必须回显配置 origin');
  assert.match(text, /TCP：通（\d+ms）/);
  assert.match(text, /链路：up/);
  // 通的链路不该满屏候选原因
  assert.doesNotMatch(text, /可能原因/);
});

test('mesh_peers：TCP 不通的对端，输出非空错误 + 四种候选原因并列', async () => {
  const port = await closedPort();
  const origin = `http://127.0.0.1:${port}`;
  const handlers = handlersWith(
    fakeInterconnect([{ instanceId: 'peer-dead', origin, link: 'down' }]),
  );

  const text = await handlers.mesh_peers({}, noExec);

  assert.match(text, /peer-dead\s+down/);
  assert.match(text, /TCP：不通（.+，耗时 \d+ms）/);
  assert.match(text, /链路：down/);
  assert.match(text, /可能原因（无法区分，以下并列）/);
  // 四种候选必须都出现，不能只挑一个当结论
  assert.match(text, /端口不通/);
  assert.match(text, /隧道断了/);
  assert.match(text, /token 不一致/);
  assert.match(text, /instanceId 不匹配/);
  assert.match(text, /mesh_peer_probe/);
});

test('mesh_peers：includeSessions 行为不变（up 时列会话，down 时明确说列不出）', async () => {
  const { origin } = await startTcpPeer();
  const interconnect = fakeInterconnect(
    [
      { instanceId: 'peer-live', origin, link: 'up' },
      { instanceId: 'peer-dead', origin: 'http://127.0.0.1:9', link: 'down' },
    ],
    { list: () => ({ sessions: [{ sessionId: 's-1', status: 'idle', title: '活会话' }] }) },
  );
  const handlers = handlersWith(interconnect);

  const text = await handlers.mesh_peers({ includeSessions: true }, noExec);

  assert.match(text, /活会话 1 个/);
  assert.match(text, /s-1\s+\[idle\]\s+活会话/);
  assert.equal(interconnect.listCalls.length, 1, 'down 的对端不该去 list');
  assert.match(text, /链路未通，列不出会话/);
});

test('mesh_peers：origin 是 self 解析函数时不崩、如实说无法探测', async () => {
  const handlers = handlersWith(
    fakeInterconnect([{ instanceId: 'self-route', origin: () => 'http://127.0.0.1:1', link: 'down' }]),
  );
  const text = await handlers.mesh_peers({}, noExec);
  assert.match(text, /self 解析函数/);
  assert.match(text, /TCP：跳过/);
});

// ─────────────────────────── mesh_peer_probe：新工具 ───────────────────────────

test('mesh_peer_probe：未配置的 instanceId 报稳定码 peer-not-configured', async () => {
  const handlers = handlersWith(fakeInterconnect([{ instanceId: 'peer-a', origin: 'http://127.0.0.1:9', link: 'down' }]));
  await assert.rejects(
    () => handlers.mesh_peer_probe({ instanceId: 'nope' }, noExec),
    (err) => {
      assert.equal(err.code, 'PEER_NOT_CONFIGURED');
      assert.match(err.message, /peer-not-configured/);
      assert.match(err.message, /peer-a/, '应列出已配置的对端，方便发现拼写错误');
      return true;
    },
  );
});

test('mesh_peer_probe：通的对端返回 origin / host:port / TCP 耗时 / 链路 / 最后错误 / 建议', async () => {
  const { origin, port } = await startTcpPeer();
  const handlers = handlersWith(fakeInterconnect([{ instanceId: 'peer-live', origin, link: 'up' }]));

  const text = await handlers.mesh_peer_probe({ instanceId: 'peer-live' }, noExec);

  assert.match(text, /对端探测：peer-live/);
  assert.match(text, /配置 origin：http:\/\/127\.0\.0\.1:\d+/);
  assert.match(text, new RegExp(`解析 host/port：127\\.0\\.0\\.1:${port}`));
  assert.match(text, /TCP 可达性：通（\d+ms）/);
  assert.match(text, /链路状态：up/);
  assert.match(text, /最后错误：无/);
  assert.match(text, /诊断建议：/);
  const suggestions = text.split('诊断建议：')[1].trim().split('\n').filter((l) => /^\s+\d+\./.test(l));
  assert.ok(suggestions.length >= 1 && suggestions.length <= 3, `建议必须 1–3 条，实际 ${suggestions.length}`);
});

test('mesh_peer_probe：不通的对端给出具体 TCP 错误 + 并列原因 + 可执行建议（≤3）', async () => {
  const port = await closedPort();
  const handlers = handlersWith(
    fakeInterconnect([{ instanceId: 'peer-dead', origin: `http://127.0.0.1:${port}`, link: 'down' }]),
  );

  const text = await handlers.mesh_peer_probe({ instanceId: 'peer-dead' }, noExec);

  assert.match(text, /TCP 可达性：不通（/);
  assert.match(text, /最后错误：(ECONNREFUSED|timeout)/);
  assert.match(text, /链路状态：down/);
  assert.match(text, /可能原因（无法区分，以下并列）/);
  assert.match(text, /Test-NetConnection/, '建议必须可执行');
  const suggestions = text.split('诊断建议：')[1].trim().split('\n').filter((l) => /^\s+\d+\./.test(l));
  assert.ok(suggestions.length <= 3, `建议最多 3 条，实际 ${suggestions.length}`);
});

test('mesh_peer_probe：非法 origin 如实说解析不了，不编 host/port', async () => {
  const handlers = handlersWith(
    fakeInterconnect([{ instanceId: 'peer-bad', origin: 'not a url', link: 'down' }]),
  );
  const text = await handlers.mesh_peer_probe({ instanceId: 'peer-bad' }, noExec);
  assert.match(text, /无法解析/);
  assert.match(text, /TCP 可达性：跳过/);
});

test('mesh_peer_probe：没有 interconnect 服务时如实说不可用，不假装探测成功', async () => {
  const handlers = createHandlers({ getBoard: () => ({}), getInterconnect: () => null });
  const text = await handlers.mesh_peer_probe({ instanceId: 'peer-a' }, noExec);
  assert.match(text, /没有 interconnect 服务/);
});

// ─────────────────────────── 契约：新工具进 TOOL_NAMES / allSpecs ───────────────────────────

test('契约：mesh_peer_probe 已进 TOOL_NAMES 与 allSpecs（13 → 14），探测超时 1s', () => {
  assert.equal(TOOL_NAMES.probe, 'mesh_peer_probe');
  const specs = allSpecs();
  assert.equal(specs.length, 14, `工具总数应为 14，实际 ${specs.length}`);
  assert.ok(specs.some((s) => s.name === 'mesh_peer_probe'));
  const probe = specs.find((s) => s.name === 'mesh_peer_probe');
  assert.equal(probe.parameters.instanceId.required, true);
  assert.equal(PEER_PROBE_TIMEOUT_MS, 1_000);
});

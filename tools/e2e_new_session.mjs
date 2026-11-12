/**
 * e2e_new_session.mjs — 端到端：**跨进程**走一遍 newSession 全链路。
 *
 * 前面的单测都在同一个进程里（假 interconnect + 直接调 board）。
 * 这个脚本换成真实形态：
 *   - 起一个真的板 HTTP 服务（就是 server.js，PC/server 线上跑的就是它）
 *   - 两个独立的 node 子进程冒充派发方 / 接收方
 *   - 接收方是真的调"宿主 create()"（用一个只实现 create 的假宿主，
 *     这样不需要 DSH 也能证明"走的是 create 不是 resume"）
 *
 * 为什么值得写：单测里 board 是本地 SQLite，跨进程会暴露 WAL、
 * HTTP 鉴权、JSON 编解码这些只在真实部署里出现的问题。
 *
 * 用法：node tools/e2e_new_session.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startBoardService } from '../src/server.js';
import { Board } from '../src/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TOKEN = 'e2e-token-not-a-real-secret';

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok });
  process.stdout.write(`  ${ok ? '✔' : '✘'} ${label}${detail ? ` — ${detail}` : ''}\n`);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-e2e-new-'));
const dbPath = path.join(dir, 'team.db');
const board = new Board(dbPath);

// 真的起一个板服务（和线上同一个 server.js）
const service = await startBoardService({
  board,
  host: '127.0.0.1',
  port: 0,
  token: TOKEN,
  logger: { info() {}, warn() {}, error() {} },
});
const port = service.server.address().port;
const endpoint = `http://127.0.0.1:${port}`;

const task = board.createTask({ title: 'e2e 新建会话', brief: '', acceptance: '', requestId: null }, 'session-orch').task;

process.stdout.write(`\n板服务：${endpoint}（真 HTTP，带 token 鉴权）\n任务：${task.task_id}\n\n`);

/** 起一个子进程跑给定模块，等它自己结束。 */
function runChild(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out }));
  });
}

const CHILD_SOURCE = {
  /** 接收方：轮询板上属于本机的请求，调"宿主 create()"，写回结果。 */
  receiver: `
import { serviceSessionRequests } from './src/createSession.js';
import { RemoteBoard } from './src/remote.js';
const board = new RemoteBoard({ endpoint: process.env.E2E_ENDPOINT, token: process.env.E2E_TOKEN });
const host = { get: (n) => n === 'sessionController' ? { create: async () => ({ sessionId: 'session-from-receiver' }) } : undefined };
const deadline = Date.now() + 20000;
while (Date.now() < deadline) {
  const done = await serviceSessionRequests({ board, ctx: host, instanceId: 'peer-b', allowCreate: true });
  if (done.length > 0) { process.stdout.write('RECEIVER_OK ' + JSON.stringify(done)); process.exit(0); }
  await new Promise(r => setTimeout(r, 100));
}
process.stdout.write('RECEIVER_TIMEOUT'); process.exit(1);
`,
  /** 派发方：调 mesh_dispatch({ newSession: true })，把结果打出来。 */
  dispatcher: `
import { createHandlers } from './src/handlers.js';
import { RemoteBoard } from './src/remote.js';
const board = new RemoteBoard({ endpoint: process.env.E2E_ENDPOINT, token: process.env.E2E_TOKEN });
const sent = [];
const ic = {
  peers: () => [{ instanceId: 'peer-b', origin: 'http://127.0.0.1:1', link: 'up' }],
  list: async () => ({ instance: 'peer-b', sessions: [{ sessionId: 'session-old' }] }),
  selfSender: (s) => ({ instanceId: 'peer-a', sessionId: s }),
  send: async (req) => { sent.push(req); return { delivered: true, instance: req.instanceId, delivery: 'followup' }; },
};
const h = createHandlers({ getBoard: () => board, getInterconnect: () => ic });
const out = await h.mesh_dispatch(
  { taskId: process.env.E2E_TASK, instanceId: 'peer-b', newSession: true },
  { agent: { id: 'session-orch' } },
);
process.stdout.write(JSON.stringify({ out, sent }));
`,
};

function writeChild(name) {
  const p = path.join(ROOT, `.e2e-child-${name}.mjs`);
  fs.writeFileSync(p, CHILD_SOURCE[name], 'utf8');
  return p;
}

const receiverPath = writeChild('receiver');
const dispatcherPath = writeChild('dispatcher');

try {
  process.stdout.write('── 场景 1：派发方要新会话，接收方建出来并写回 ──\n');
  // 先起接收方（它一直轮询），再起派发方
  const receiverPromise = runChild(receiverPath, { E2E_ENDPOINT: endpoint, E2E_TOKEN: TOKEN });
  await new Promise((r) => setTimeout(r, 300));
  const dispRes = await runChild(dispatcherPath, {
    E2E_ENDPOINT: endpoint,
    E2E_TOKEN: TOKEN,
    E2E_TASK: task.task_id,
  });
  const receiverRes = await receiverPromise;

  check('接收方确实处理了请求', receiverRes.out.includes('RECEIVER_OK'), receiverRes.out.trim().slice(0, 80));

  let parsed = null;
  try {
    parsed = JSON.parse(dispRes.out.trim().split('\n').pop());
  } catch {
    /* 下面会判 */
  }
  check('派发方拿到结果', parsed !== null, dispRes.out.slice(0, 200));
  if (parsed !== null) {
    check('投给了**新建**的会话，不是现成会话',
      parsed.sent.length === 1 && parsed.sent[0].sessionId === 'session-from-receiver',
      `实际 ${parsed.sent.map((s) => s.sessionId).join(',') || '(无)'}`);
    check('回复里说明了这是新建的会话', /新建会话/.test(parsed.out));
    check('没有降级投给 session-old', !parsed.sent.some((s) => s.sessionId === 'session-old'));
    // 跨进程也要能把 ack 窗口说清楚（远端板少回一个字段就会变成 undefined/NaN）
    check('回执时限是真实时间，不是 undefined/NaN',
      !/undefined|NaN/.test(parsed.out), (parsed.out.match(/回执时限：([^\n]*)/) ?? [])[1] ?? '');
  }

  // 跨进程也要能看出 created_session 落了库
  const row = board.db.prepare('SELECT * FROM dispatch WHERE task_id = ?').get(task.task_id);
  check('板上 dispatch 记录标了 created_session=1', row !== undefined && Number(row.created_session) === 1);
  check('板上 dispatch 记录指向新会话', row !== undefined && row.peer_session === 'session-from-receiver');

  process.stdout.write('\n── 场景 2：接收方不开开关 → 派发方如实报 create-timeout，不降级 ──\n');
  const task2 = board.createTask({ title: 'e2e 无人处理', brief: '', acceptance: '', requestId: null }, 'session-orch').task;
  const dispRes2 = await runChild(dispatcherPath, {
    E2E_ENDPOINT: endpoint,
    E2E_TOKEN: TOKEN,
    E2E_TASK: task2.task_id,
  });
  let parsed2 = null;
  try {
    parsed2 = JSON.parse(dispRes2.out.trim().split('\n').pop());
  } catch {
    /* 判下面 */
  }
  check('派发方拿到结果（场景2）', parsed2 !== null, dispRes2.out.slice(0, 200));
  if (parsed2 !== null) {
    check('明确报 create-timeout', /create-timeout/.test(parsed2.out));
    check('**一次 send 都没发**（没有降级）', parsed2.sent.length === 0, `实际 ${parsed2.sent.length} 次`);
  }
} finally {
  // 板服务自己持有 http server；close() 不等回调（等的话会挂住不退出）。
  // 这里显式关掉监听，再关板，然后让进程正常结束。
  try {
    await new Promise((resolve) => service.server.close(resolve));
  } catch {
    /* 已经关了 */
  }
  try {
    service.board?.close?.();
  } catch {
    /* ignore */
  }
  try {
    board.close();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(receiverPath, { force: true });
    fs.rmSync(dispatcherPath, { force: true });
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* ignore */
  }
}

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n════ 检查项 ${results.length}，失败 ${failed.length} ════\n`);
process.exitCode = failed.length === 0 ? 0 : 1;

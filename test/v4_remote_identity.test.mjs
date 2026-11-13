/**
 * v4_remote_identity.test.mjs — `remote.js` 是否真的把**调用方身份**通过 HTTP 报给板服务。
 *
 * 为什么单开一个文件、且必须真起进程：
 *   改动前的缺口是「板服务侧读 body.leaseIdentity 的代码已就绪，但客户端不发」。
 *   要证明这个缺口被补上，只能看**一条真实 HTTP 请求**里到底有没有这个字段、
 *   板服务落库时记的 pid 到底是谁的。用 mock 替换 HTTP 层等于把要验证的东西替掉。
 *
 * 本文件的三层真实：
 *   1. 板服务跑在**独立子进程**（test/helpers/board_child.mjs）—— 它的 pid 与客户端
 *      天然不同。否则「记的是调用方 pid」与「记的是板服务 pid」两种实现断言结果一样，
 *      测试就失去了区分能力。
 *   2. 客户端 A/B/C 各跑在**独立子进程**（test/helpers/lease_client_child.mjs）——
 *      pid 是真的不同，不是伪造 process.pid。
 *   3. 全部走真 socket、真 JSON、真鉴权。
 *
 * 覆盖（对应任务书验收 1/2/4）：
 *   - 客户端确实上报 pid / start_sec / host，且值与调用方进程一致
 *   - 板服务落库的 lease_pid 是**调用方** pid（≠ 板服务 pid）—— 方向正确性
 *   - 同进程续租成功；换进程续租被拒 PID_REUSED（两种：pid 不同 / pid 相同但 startSec 不同）
 *   - 老客户端（body 不带 leaseIdentity）→ 记 NULL，行为与 v3 完全一致
 *   - 原始 HTTP 层看到的状态码与 error.code（不经任何客户端封装）
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

import { processIdentity } from '../src/domain.js';
import { RemoteBoard } from '../src/remote.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOARD_CHILD = path.join(HERE, 'helpers', 'board_child.mjs');
const CLIENT_CHILD = path.join(HERE, 'helpers', 'lease_client_child.mjs');

// 测试自带随机密钥：绝不复用现网那两把，也不会出现在任何输出里
const TOKEN = `t-${crypto.randomUUID()}`;
const READ_TOKEN = `r-${crypto.randomUUID()}`;

const tmpDirs = [];
const live = { child: null, endpoint: '', pid: -1, dbPath: '' };

function mkTmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

/** 起一个**独立进程**的板服务，等它把真实端口打回来。 */
function startBoardChild() {
  const dbPath = path.join(mkTmp('mesh-v4http-'), 'team.db');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BOARD_CHILD], {
      env: {
        ...process.env,
        DSH_TEAM_BOARD_DB: dbPath,
        DSH_TEAM_BOARD_TOKEN: TOKEN,
        DSH_TEAM_BOARD_READ_TOKEN: READ_TOKEN,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    let stderr = '';
    const timer = setTimeout(() => {
      reject(new Error(`板服务子进程 10s 内没就绪。stderr=${stderr.slice(0, 800)}`));
    }, 10000);
    child.stdout.on('data', (c) => {
      buf += c.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      try {
        const info = JSON.parse(buf.slice(0, nl));
        clearTimeout(timer);
        resolve({ child, dbPath, pid: Number(info.pid), port: Number(info.port), endpoint: `http://127.0.0.1:${info.port}` });
      } catch (err) {
        clearTimeout(timer);
        reject(new Error(`板服务子进程就绪行不是 JSON：${buf.slice(0, 200)}（${err?.message}）`));
      }
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** 跑一个一次性的客户端子进程，取它最后一行 JSON。 */
function runClient(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLIENT_CHILD, JSON.stringify(args)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => {
      out += c.toString('utf8');
    });
    child.stderr.on('data', (c) => {
      err += c.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', () => {
      const line = out.trim().split(/\r?\n/).filter((l) => l.trim().length > 0).pop() ?? '';
      try {
        resolve(JSON.parse(line));
      } catch (e) {
        reject(new Error(`客户端子进程没打出 JSON。stdout=${out.slice(0, 500)} stderr=${err.slice(0, 800)}（${e?.message}）`));
      }
    });
  });
}

/** 建一张新卡（每张卡一个独立用例，互不干扰）。 */
async function newTask(client, actor, title) {
  const r = await client.createTask({ title, brief: '', acceptance: '', requestId: null }, actor);
  return r.task.task_id;
}

before(async () => {
  const started = await startBoardChild();
  live.child = started.child;
  live.endpoint = started.endpoint;
  live.pid = started.pid;
  live.dbPath = started.dbPath;
  assert.ok(live.pid > 0, '板服务子进程应有真实 pid');
  assert.notEqual(live.pid, process.pid, '板服务必须与测试进程不同 pid，否则本文件的方向断言无效');
});

after(async () => {
  if (live.child !== null) {
    await new Promise((resolve) => {
      live.child.once('close', resolve);
      live.child.kill('SIGTERM');
      setTimeout(() => {
        try {
          live.child.kill('SIGKILL');
        } catch {
          /* 已退出 */
        }
        resolve();
      }, 4000).unref?.();
    });
  }
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* ignore */
    }
  }
});

// ───────────────────────── R. HTTP 路径的租约身份 ─────────────────────────

test('R1 leaseIdentity() 的字段名与 domain.processIdentity 一致（pid / start_sec / host）', () => {
  const rb = new RemoteBoard({ endpoint: 'http://127.0.0.1:1', token: TOKEN });
  const id = rb.leaseIdentity();
  assert.deepEqual(Object.keys(id).sort(), ['host', 'pid', 'start_sec'], '字段名必须与 server.js readIdentity 严格对齐');

  const me = processIdentity();
  assert.equal(id.pid, process.pid, 'pid 必须是本进程');
  assert.equal(id.host, me.host, 'host 必须与本机一致');
  assert.ok(Number.isInteger(id.start_sec), 'start_sec 必须是整数（server 端 Number.isInteger 校验）');
  assert.ok(id.start_sec > 1_600_000_000, `start_sec 应是合理的秒级时间戳，实际 ${id.start_sec}`);
  // 反推值与即时计算值允许差 1 秒（跨整秒边界），但不许是 0 或明显无关的数
  assert.ok(Math.abs(id.start_sec - me.start_sec) <= 1, `start_sec 应与即时反推值一致，差 ${id.start_sec - me.start_sec}s`);
});

test('R1b 同一进程反复取身份完全一致（start_sec 不因跨秒而漂移）', () => {
  const rb = new RemoteBoard({ endpoint: 'http://127.0.0.1:1', token: TOKEN });
  const first = rb.leaseIdentity();
  const second = rb.leaseIdentity();
  assert.deepEqual(first, second, '同一进程的身份必须稳定，否则 claim 与 heartbeat 会自相矛盾');
  // 返回副本：外部改动不能污染本进程身份
  first.pid = -1;
  assert.equal(rb.leaseIdentity().pid, process.pid, 'leaseIdentity() 必须返回副本');
});

test('R2 真 HTTP claim：板服务记下的 lease_pid 是**调用方** pid，不是板服务自己的', async () => {
  const client = new RemoteBoard({ endpoint: live.endpoint, token: TOKEN });
  const actor = 'session-http-a';
  const taskId = await newTask(client, actor, 'R2 方向正确性');

  await client.claimTask(taskId, actor);
  const got = await client.getTask(taskId);

  assert.equal(got.lease_pid, process.pid, 'lease_pid 必须是调用方进程的 pid');
  assert.notEqual(got.lease_pid, live.pid, '绝不能是板服务进程的 pid（方向写反就落在这里）');
  assert.equal(got.lease_host, os.hostname(), 'lease_host 必须是调用方主机名');
  assert.equal(got.lease_start_sec, client.leaseIdentity().start_sec, 'start_sec 必须原样过线');
});

test('R3 同一客户端进程 heartbeat 续租成功（身份对得上）', async () => {
  const client = new RemoteBoard({ endpoint: live.endpoint, token: TOKEN });
  const actor = 'session-http-b';
  const taskId = await newTask(client, actor, 'R3 同进程续租');

  await client.claimTask(taskId, actor);
  const before = await client.getTask(taskId);
  const r = await client.heartbeat(taskId, actor);
  const afterTask = await client.getTask(taskId);

  assert.equal(r.was_stale, false);
  assert.equal(afterTask.lease_pid, process.pid);
  assert.ok(afterTask.lease_until >= before.lease_until, '续租后到期时间不应倒退');
});

test('R4 子进程 claim：落库 pid 是那个子进程的（证明身份真的从调用方过线）', async () => {
  const admin = new RemoteBoard({ endpoint: live.endpoint, token: TOKEN });
  const actor = 'session-http-c';
  const taskId = await newTask(admin, actor, 'R4 子进程 claim');

  const res = await runClient({ endpoint: live.endpoint, token: TOKEN, taskId, actor, mode: 'claim' });
  assert.equal(res.ok, true, `子进程 claim 应成功，实际 ${JSON.stringify(res)}`);
  assert.equal(res.reported_identity.pid, res.child_pid, '子进程报的 pid 必须是它自己');
  assert.notEqual(res.child_pid, process.pid, '子进程 pid 必须与测试进程不同（否则本用例无意义）');

  const got = await admin.getTask(taskId);
  assert.equal(got.lease_pid, res.child_pid, '板服务必须记下**调用方子进程**的 pid');
  assert.notEqual(got.lease_pid, live.pid, '不能是板服务 pid');
  assert.notEqual(got.lease_pid, process.pid, '也不能是测试进程 pid');
  assert.equal(got.lease_host, res.child_host);
});

test('R5 换进程续租（pid 不同，同名 owner）→ 被拒 PID_REUSED', async () => {
  const admin = new RemoteBoard({ endpoint: live.endpoint, token: TOKEN });
  const actor = 'session-http-d';
  const taskId = await newTask(admin, actor, 'R5 换进程续租');

  const claimant = await runClient({ endpoint: live.endpoint, token: TOKEN, taskId, actor, mode: 'claim' });
  assert.equal(claimant.ok, true);
  const claimed = await admin.getTask(taskId);
  assert.equal(claimed.lease_pid, claimant.child_pid);

  // 另一个进程，用同一个 owner 名字来续租 —— 名字对得上，进程对不上
  const thief = await runClient({ endpoint: live.endpoint, token: TOKEN, taskId, actor, mode: 'heartbeat' });
  assert.equal(thief.ok, false, `应被拒，实际 ${JSON.stringify(thief)}`);
  assert.equal(thief.code, 'PID_REUSED');
  assert.match(thief.message, /pid-reused/);

  // 被拒不该改动记录
  const after = await admin.getTask(taskId);
  assert.equal(after.lease_pid, claimant.child_pid, '拒绝续租不许改持有者');
  assert.equal(after.lease_until, claimed.lease_until, '拒绝续租不许延长租约');
});

test('R6 pid 相同但 startSec 不同（PID 被系统复用）→ 被拒 PID_REUSED', async () => {
  const admin = new RemoteBoard({ endpoint: live.endpoint, token: TOKEN });
  const actor = 'session-http-e';
  const taskId = await newTask(admin, actor, 'R6 pid 复用');

  const claimant = await runClient({ endpoint: live.endpoint, token: TOKEN, taskId, actor, mode: 'claim' });
  assert.equal(claimant.ok, true);
  const realPid = claimant.child_pid;
  const realStart = claimant.reported_identity.start_sec;

  // 关键场景：pid 号相同（就是原持有者那个号），但进程启动时刻不同 ——
  // 这正是「原进程崩了、系统把同一个 pid 分给了别人」的样子。
  const forged = { pid: realPid, start_sec: realStart + 777, host: claimant.child_host };
  const reused = await runClient({ endpoint: live.endpoint, token: TOKEN, taskId, actor, mode: 'heartbeat', identity: forged });
  assert.equal(reused.ok, false, `应被拒，实际 ${JSON.stringify(reused)}`);
  assert.equal(reused.code, 'PID_REUSED');
  assert.match(reused.message, /pid-reused/);
  // detail 要能看出是哪一项对不上（server.js 把 ident.detail 原样回传）
  assert.equal(reused.detail?.lease_start_sec, realStart);
  assert.equal(reused.detail?.my_start_sec, realStart + 777);
});

test('R7 老客户端（body 不带 leaseIdentity）→ 记 NULL，任何进程都能续租（v3 行为不变）', async () => {
  const admin = new RemoteBoard({ endpoint: live.endpoint, token: TOKEN });
  const actor = 'session-http-f';
  const taskId = await newTask(admin, actor, 'R7 老客户端兼容');

  const legacyClaim = await runClient({ endpoint: live.endpoint, token: TOKEN, taskId, actor, mode: 'claim', legacy: true });
  assert.equal(legacyClaim.ok, true, `老客户端 claim 必须照常成功，实际 ${JSON.stringify(legacyClaim)}`);

  const got = await admin.getTask(taskId);
  assert.equal(got.lease_pid, null, '没报身份就必须记 NULL，绝不能顶替成板服务自己的 pid');
  assert.equal(got.lease_start_sec, null);
  assert.equal(got.lease_host, null);

  // 身份未知时不校验 pid：另一个进程用同名 owner 续租应当成功
  const other = await runClient({ endpoint: live.endpoint, token: TOKEN, taskId, actor, mode: 'heartbeat' });
  assert.equal(other.ok, true, `老数据续租必须照旧放行，实际 ${JSON.stringify(other)}`);
  const after = await admin.getTask(taskId);
  assert.equal(after.lease_pid, other.child_pid, '续租成功后按新客户端身份记录');
});

test('R8 原始 HTTP：绕过所有客户端封装，直接看到 400 + PID_REUSED', async () => {
  const client = new RemoteBoard({ endpoint: live.endpoint, token: TOKEN });
  const actor = 'session-http-g';
  const taskId = await newTask(client, actor, 'R8 裸 HTTP');

  const claimant = await runClient({ endpoint: live.endpoint, token: TOKEN, taskId, actor, mode: 'claim' });
  assert.equal(claimant.ok, true);

  const forged = { pid: claimant.child_pid, start_sec: claimant.reported_identity.start_sec + 1, host: claimant.child_host };
  const res = await fetch(`${live.endpoint}/task/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-team-token': TOKEN },
    body: JSON.stringify({ taskId, actor, leaseMs: 600000, leaseIdentity: forged }),
  });
  const body = await res.json();
  assert.equal(res.status, 400, `PID_REUSED 的 HTTP 状态应为 400，实际 ${res.status}`);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'PID_REUSED');
  assert.equal(body.error.detail?.my_start_sec, forged.start_sec);

  // 同一请求但身份正确 → 200，说明失败原因确实是身份而非别的
  const okRes = await fetch(`${live.endpoint}/task/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-team-token': TOKEN },
    body: JSON.stringify({ taskId, actor, leaseMs: 600000, leaseIdentity: claimant.reported_identity }),
  });
  const okBody = await okRes.json();
  assert.equal(okRes.status, 200, `身份正确时应 200，实际 ${okRes.status} ${JSON.stringify(okBody)}`);
  assert.equal(okBody.ok, true);
});

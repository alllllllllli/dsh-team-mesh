/**
 * board_hardening.test.mjs — 板服务四项硬化的验收（0.4）。
 *
 *   1. blob GC：只删「无 evidence 引用 + 已过保留期」的对象；有引用一个不删；幂等。
 *   2. 落盘审计：状态变更请求追加 JSONL，按天滚动；写失败只 warn，不影响请求。
 *   3. 限流：按调用方固定窗口，超限 429 + 稳定错误码；默认阈值不打回正常轮询；可关。
 *   4. 监听地址：host 可配，**默认行为不变**（127.0.0.1），/health 报真值与安全提示。
 *
 * 为什么这些用例值得单独写一文件（而不是塞进现有文件）：
 *   这四项都是"加保护"而不是"加功能" —— 出错的形态是**保护本身把正常业务搞坏**
 *   （GC 误删仍被引用的物证、审计写失败把请求打 500、限流把正常轮询打成 429）。
 *   所以断言的重点不是"功能存在"，而是"边界行为"：被引用不删、未到期不删、
 *   写失败不炸、默认阈值下 60 次轮询全过、429 不落审计。
 *
 * 测试方式：
 *   - GC / 审计 / 限流 / host 全部起**真板服务**、走真 socket（端口 0 让系统挑）。
 *   - 板库是临时目录里的真 SQLite；没有任何用例碰 13090 生产端口。
 *   - 定时 sweep 一律关掉，避免和断言互相抢时序；要 sweep 就显式 POST /sweep。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_BLOB_RETENTION_MS } from '../src/backend.js';
import { Board } from '../src/store.js';
import { startBoardService } from '../src/server.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, '..');
const TOKEN = `w-${crypto.randomUUID()}`;
const READ_TOKEN = `r-${crypto.randomUUID()}`;
const DAY = 24 * 60 * 60 * 1000;

// ───────────────────── 环境隔离：这些用例要断言"默认值" ─────────────────────
// node --test 每个文件一个子进程，所以在这里删掉环境变量不会影响别的测试文件；
// 不删的话，宿主机上任何一次手工配置（比如上一轮排障留下的 DSH_TEAM_BOARD_HOST）
// 都会让"默认行为"的断言变成假通过/假失败。
const ENV_KEYS = [
  'DSH_TEAM_BOARD_HOST',
  'DSH_TEAM_BOARD_PORT',
  'DSH_TEAM_BOARD_DB',
  'DSH_TEAM_BOARD_TOKEN',
  'DSH_TEAM_BOARD_READ_TOKEN',
  'DSH_TEAM_BOARD_SWEEP_MS',
  'DSH_TEAM_BOARD_BLOB_GC',
  'DSH_TEAM_BOARD_BLOB_RETENTION_MS',
  'DSH_TEAM_BOARD_AUDIT',
  'DSH_TEAM_BOARD_AUDIT_DIR',
  'DSH_TEAM_BOARD_RATE_LIMIT',
  'DSH_TEAM_BOARD_RATE_WINDOW_MS',
];
const savedEnv = new Map();
for (const k of ENV_KEYS) {
  savedEnv.set(k, process.env[k]);
  delete process.env[k];
}

const tmpDirs = [];
const services = [];
const boards = [];

function mkTmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

/** 直接开一块本地板（GC 的纯后端用例不需要 HTTP）。 */
function openBoard() {
  const dir = mkTmp('mesh-gc-');
  const b = new Board(path.join(dir, 'team.db'));
  boards.push(b);
  return b;
}

/**
 * 起一块真板 + 真 HTTP 服务。默认关掉定时 sweep（断言要可控），
 * 默认用随机密钥（绝不复用现网那两把）。
 */
async function startService(overrides = {}) {
  const dir = overrides.dir ?? mkTmp('mesh-harden-');
  const dbPath = overrides.dbPath ?? path.join(dir, 'team.db');
  const warns = [];
  const logger = overrides.logger ?? { warn: (m) => warns.push(String(m)), info: () => {} };
  const svc = await startBoardService({
    boardPath: dbPath,
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    readToken: READ_TOKEN,
    sweep: false,
    ...overrides,
    logger,
  });
  services.push(svc);
  return {
    svc,
    dir,
    dbPath,
    warns,
    endpoint: `http://127.0.0.1:${svc.port}`,
    auditDir: overrides.auditDir ?? path.join(dir, 'audit'),
  };
}

/** 走真 HTTP 发 JSON 请求。token=null 表示不带密钥。 */
async function request(endpoint, pathname, { method = 'GET', body = undefined, token = TOKEN } = {}) {
  const headers = {};
  if (token !== null) headers['x-team-token'] = token;
  let payload;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(endpoint + pathname, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try {
    json = text === '' ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, body: json, text, headers: res.headers };
}

async function putBlob(endpoint, bytes, token = TOKEN) {
  const res = await fetch(`${endpoint}/blob/put`, { method: 'POST', headers: { 'x-team-token': token }, body: bytes });
  return { status: res.status, body: await res.json() };
}

/**
 * 跑一个子进程并收集输出。
 *
 * 为什么必须异步 spawn、不能用 spawnSync：被测的板服务就起在**本测试进程**里，
 * spawnSync 会把事件循环整个卡住 —— 子进程的 HTTP 请求永远得不到响应，
 * 测试会以"请求超时"失败，看起来像工具坏了，实际是测试写法把服务饿死了。
 */
function runNode(args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: REPO_ROOT });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ status: null, stdout, stderr: `${stderr}\n[测试超时 ${timeoutMs}ms]` });
    }, timeoutMs);
    child.stdout.on('data', (c) => {
      stdout += String(c);
    });
    child.stderr.on('data', (c) => {
      stderr += String(c);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr: `${stderr}\n${String(err)}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
  });
}

/** 审计目录里的文件（只有按天滚动的 JSONL 才算，宿主机上的别的东西不进来）。 */
function readAuditFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^board-audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort();
}

function readAuditEntries(dir) {
  const out = [];
  for (const f of readAuditFiles(dir)) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      out.push(JSON.parse(line));
    }
  }
  return out;
}

after(async () => {
  for (const svc of services) {
    try {
      await svc.close();
    } catch {
      /* ignore */
    }
  }
  for (const b of boards) {
    try {
      b.close();
    } catch {
      /* ignore */
    }
  }
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* Windows 上 WAL 句柄偶尔还没放干净，残留临时目录不影响断言 */
    }
  }
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ═══════════════════════════ 1. blob GC ═══════════════════════════

test('G1 GC：被 evidence 引用的 blob，无论多老都不删', () => {
  const b = openBoard();
  const { task } = b.createTask({ title: 'gc-ref', brief: '', acceptance: '', requestId: null }, 'tester');
  const bytes = Buffer.from(`g1-proof-${crypto.randomUUID()}`);
  const { sha256 } = b.backend.putBlob(bytes);
  const ev = b.reportEvidence(
    task.task_id,
    { executed: true, outcome: 'pass', note: 'G1 物证', evidenceRef: `blob://sha256:${sha256}` },
    'tester',
  );
  // 前提断言：这条证据真的可采信，说明 blob 确实被 evidence 引用（不是"看起来引用"）。
  assert.equal(ev.admissible, true);

  // 把时间推到 30 天后：任何保留期都过了，唯一能保它的理由是"仍被引用"。
  const gc = b.backend.gcBlobs({ now: Date.now() + 30 * DAY });
  assert.equal(gc.deleted, 0, '被引用的 blob 一个都不许删');
  assert.equal(gc.kept_referenced, 1);
  assert.notEqual(b.backend.getBlob(sha256), null, '引用仍在，对象必须还在');
});

test('G2 GC：无引用且已过期的 blob 被删除，并报出释放字节数', () => {
  const b = openBoard();
  const bytes = Buffer.from(`g2-orphan-${crypto.randomUUID()}`);
  const { sha256 } = b.backend.putBlob(bytes);
  b.db.prepare('UPDATE blob SET created_at = ? WHERE sha256 = ?').run(Date.now() - 8 * DAY, sha256);

  const gc = b.backend.gcBlobs({ now: Date.now() });
  assert.equal(gc.deleted, 1);
  assert.equal(gc.freed_bytes, bytes.length);
  assert.equal(gc.remaining, 0);
  assert.equal(gc.kept_fresh, 0);
  assert.equal(b.backend.getBlob(sha256), null, '过期孤儿必须真的从表里消失');
});

test('G3 GC：保留期内（默认 7 天）绝不删，过了保留期才删', () => {
  assert.equal(DEFAULT_BLOB_RETENTION_MS, 7 * DAY, '默认保留期就是 7 天');

  const b = openBoard();
  const { sha256 } = b.backend.putBlob(Buffer.from(`g3-${crypto.randomUUID()}`));

  const before = b.backend.gcBlobs({ now: Date.now() });
  assert.equal(before.deleted, 0);
  assert.equal(before.kept_fresh, 1);
  assert.equal(before.retention_ms, 7 * DAY);
  assert.notEqual(b.backend.getBlob(sha256), null);

  const later = b.backend.gcBlobs({ now: Date.now() + 8 * DAY });
  assert.equal(later.deleted, 1, '过了 7 天就该回收');
  assert.equal(b.backend.getBlob(sha256), null);
});

test('G4 GC 幂等：连跑三次不重复计数，被引用对象始终还在', () => {
  const b = openBoard();
  const { task } = b.createTask({ title: 'gc-idem', brief: '', acceptance: '', requestId: null }, 'tester');
  const orphanA = b.backend.putBlob(Buffer.from(`g4-a-${crypto.randomUUID()}`));
  const orphanB = b.backend.putBlob(Buffer.from(`g4-b-${crypto.randomUUID()}`));
  const keep = b.backend.putBlob(Buffer.from(`g4-keep-${crypto.randomUUID()}`));
  b.reportEvidence(
    task.task_id,
    { executed: true, outcome: 'pass', note: 'G4 物证', evidenceRef: `blob://sha256:${keep.sha256}` },
    'tester',
  );
  // 全表都当作 30 天前创建：到期条件一次性满足，才能看清"第二次跑是不是空操作"。
  b.db.prepare('UPDATE blob SET created_at = ?').run(Date.now() - 30 * DAY);

  const first = b.backend.gcBlobs({ now: Date.now() });
  assert.equal(first.deleted, 2);
  assert.equal(first.remaining, 1);
  assert.equal(first.kept_referenced, 1);

  const second = b.backend.gcBlobs({ now: Date.now() });
  assert.equal(second.deleted, 0, '第二次跑必须什么都没删（幂等）');
  assert.equal(second.remaining, 1);

  const third = b.backend.gcBlobs({ now: Date.now() + 365 * DAY });
  assert.equal(third.deleted, 0, '再老一年也不动被引用的对象');
  assert.notEqual(b.backend.getBlob(keep.sha256), null);
  assert.equal(b.backend.getBlob(orphanA.sha256), null);
  assert.equal(b.backend.getBlob(orphanB.sha256), null);
});

test('G5 GC：保留期可配（0 = 立即回收，调大则保留），负数不许变成"删光"', () => {
  const b = openBoard();

  const fresh = b.backend.putBlob(Buffer.from(`g5-fresh-${crypto.randomUUID()}`));
  const zero = b.backend.gcBlobs({ now: Date.now() + 50, retentionMs: 0 });
  assert.equal(zero.retention_ms, 0);
  assert.equal(zero.deleted, 1, '保留期 0 表示"不用等，立刻可回收"');
  assert.equal(b.backend.getBlob(fresh.sha256), null);

  const tenDays = b.backend.putBlob(Buffer.from(`g5-old-${crypto.randomUUID()}`));
  b.db.prepare('UPDATE blob SET created_at = ? WHERE sha256 = ?').run(Date.now() - 10 * DAY, tenDays.sha256);
  const wide = b.backend.gcBlobs({ now: Date.now(), retentionMs: 30 * DAY });
  assert.equal(wide.deleted, 0, '保留期 30 天时，10 天前的对象还在保留期内');
  const narrow = b.backend.gcBlobs({ now: Date.now(), retentionMs: 7 * DAY });
  assert.equal(narrow.deleted, 1);

  const invalid = b.backend.gcBlobs({ now: Date.now(), retentionMs: -1 });
  assert.equal(invalid.retention_ms, DEFAULT_BLOB_RETENTION_MS, '负保留期按默认值处理，不能退化成"删光"');
});

test('G6 HTTP：POST /sweep 回收孤儿 blob，/health 报 gc 计数，第二次 sweep 幂等', async () => {
  const { endpoint, svc } = await startService();
  const bytes = Buffer.from(`g6-http-${crypto.randomUUID()}`);
  const put = await putBlob(endpoint, bytes);
  assert.equal(put.status, 200);
  svc.board.db.prepare('UPDATE blob SET created_at = ? WHERE sha256 = ?').run(Date.now() - 8 * DAY, put.body.sha256);

  const swept = await request(endpoint, '/sweep', { method: 'POST', body: {} });
  assert.equal(swept.status, 200);
  // 新段：gc 计数（数字必须是真的删了 1 个、释放了对应字节）
  assert.equal(swept.body.gc.deleted, 1);
  assert.equal(swept.body.gc.freed_bytes, bytes.length);
  assert.equal(swept.body.gc.retention_ms, DEFAULT_BLOB_RETENTION_MS);
  // 老段原样保留：老客户端的解析不会被这次升级打断
  assert.ok(swept.body.ack !== undefined && swept.body.lease !== undefined);
  assert.equal(typeof swept.body.session_request, 'number');

  const again = await request(endpoint, '/sweep', { method: 'POST', body: {} });
  assert.equal(again.body.gc.deleted, 0, '第二次 sweep 必须幂等');

  const health = await request(endpoint, '/health');
  assert.equal(health.body.gc.enabled, true);
  assert.equal(health.body.gc.deleted_total, 1, '累计删除数跨轮保留');
  assert.equal(health.body.gc.last_result.deleted, 0, 'last_result 记的是**最近一轮**（第二轮删了 0 个）');
  assert.equal(health.body.blobs, 0);
});

test('G7 HTTP：被证据引用的 blob 在 sweep 后仍在（跨接口真值）', async () => {
  const { endpoint, svc } = await startService();
  const bytes = Buffer.from(`g7-http-${crypto.randomUUID()}`);
  const put = await putBlob(endpoint, bytes);
  const created = await request(endpoint, '/task/create', { method: 'POST', body: { title: 'G7', actor: 'alice' } });
  assert.equal(created.status, 200);
  const taskId = created.body.task.task_id;
  const reported = await request(endpoint, '/task/report', {
    method: 'POST',
    body: {
      taskId,
      executed: true,
      outcome: 'pass',
      note: 'G7 物证',
      evidenceRef: `blob://sha256:${put.body.sha256}`,
      actor: 'alice',
    },
  });
  assert.equal(reported.status, 200);
  assert.equal(reported.body.admissible, true, '前提：证据必须真的可采信');

  svc.board.db.prepare('UPDATE blob SET created_at = ? WHERE sha256 = ?').run(Date.now() - 30 * DAY, put.body.sha256);
  const swept = await request(endpoint, '/sweep', { method: 'POST', body: {} });
  assert.equal(swept.body.gc.deleted, 0);
  assert.equal(swept.body.gc.kept_referenced, 1);

  const stat = await request(endpoint, `/blob/stat?sha256=${put.body.sha256}`);
  assert.equal(stat.status, 200, '被引用的物证必须还能按 key 取到元信息');
});

test('G8 GC 可整体关闭：opts.blobGc=false 时 sweep 只清租约不碰 blob', async () => {
  const { endpoint, svc } = await startService({ blobGc: false });
  const put = await putBlob(endpoint, Buffer.from(`g8-${crypto.randomUUID()}`));
  svc.board.db.prepare('UPDATE blob SET created_at = ? WHERE sha256 = ?').run(Date.now() - 8 * DAY, put.body.sha256);

  const swept = await request(endpoint, '/sweep', { method: 'POST', body: {} });
  assert.equal(swept.body.gc.enabled, false);
  assert.equal(swept.body.gc.deleted, 0);

  const health = await request(endpoint, '/health');
  assert.equal(health.body.gc.enabled, false);
  assert.equal(health.body.blobs, 1, 'GC 关掉时孤儿 blob 继续留着（由运维决定）');
});

test('G9 GC / 审计 / 限流都支持环境变量关闭（沿用现有配置读取风格）', async () => {
  process.env.DSH_TEAM_BOARD_BLOB_GC = '0';
  process.env.DSH_TEAM_BOARD_AUDIT = '0';
  process.env.DSH_TEAM_BOARD_RATE_LIMIT = '0';
  try {
    const { endpoint, auditDir } = await startService();
    const health = await request(endpoint, '/health');
    assert.equal(health.body.gc.enabled, false);
    assert.equal(health.body.audit.enabled, false);
    assert.equal(health.body.rate_limit.enabled, false);
    const created = await request(endpoint, '/task/create', { method: 'POST', body: { title: 'G9', actor: 'env' } });
    assert.equal(created.status, 200);
    assert.equal(fs.existsSync(auditDir), false, '审计关掉后连目录都不该建');
  } finally {
    delete process.env.DSH_TEAM_BOARD_BLOB_GC;
    delete process.env.DSH_TEAM_BOARD_AUDIT;
    delete process.env.DSH_TEAM_BOARD_RATE_LIMIT;
  }
});

// ═══════════════════════════ 2. 落盘审计 ═══════════════════════════

test('A1 审计：写请求追加单行 JSONL，字段可追（路由/状态/actor/task_id），且不含密钥', async () => {
  const { endpoint, auditDir } = await startService();
  const created = await request(endpoint, '/task/create', {
    method: 'POST',
    body: { title: 'A1', actor: 'alice', requestId: 'a1-req' },
  });
  assert.equal(created.status, 200);
  const taskId = created.body.task.task_id;

  const files = readAuditFiles(auditDir);
  assert.equal(files.length, 1, `审计目录里应恰好一个按天滚动的 JSONL，实际：${JSON.stringify(fs.existsSync(auditDir) ? fs.readdirSync(auditDir) : [])}`);
  assert.match(files[0], /^board-audit-\d{4}-\d{2}-\d{2}\.jsonl$/);

  const entries = readAuditEntries(auditDir);
  assert.equal(entries.length, 1);
  const e = entries[0];
  assert.equal(e.v, 1);
  assert.equal(e.method, 'POST');
  assert.equal(e.path, '/task/create');
  assert.equal(e.level, 'write');
  assert.equal(e.status, 200);
  assert.equal(e.ok, true);
  assert.equal(e.error_code, null);
  assert.equal(e.actor, 'alice');
  assert.equal(e.task_id, null, '建任务时 body 里没有 taskId，如实记 null');
  assert.equal(e.request_id, 'a1-req', '幂等键要能追');
  assert.ok(Number.isInteger(e.duration_ms) && e.duration_ms >= 0);
  assert.equal(Number.isNaN(Date.parse(e.ts)), false, 'ts 必须可解析');
  assert.equal(e.client_ip, '127.0.0.1');

  const raw = fs.readFileSync(path.join(auditDir, files[0]), 'utf8');
  assert.equal(raw.includes(TOKEN), false, '审计里绝不能出现写密钥');
  assert.equal(raw.includes(READ_TOKEN), false, '审计里也不能出现只读密钥');

  // 第二个写请求是**追加**，不是覆盖
  await request(endpoint, '/task/claim', { method: 'POST', body: { taskId, actor: 'bob' } });
  const entries2 = readAuditEntries(auditDir);
  assert.equal(entries2.length, 2);
  assert.equal(entries2[1].path, '/task/claim');
  assert.equal(entries2[1].task_id, taskId);
  assert.equal(entries2[1].actor, 'bob');
});

test('A2 审计：读路由与探活不落盘；未知名路由也不落盘（避免扫描器刷满磁盘）', async () => {
  const { endpoint, auditDir } = await startService();
  await request(endpoint, '/health');
  await request(endpoint, '/task/list');
  await request(endpoint, '/nope', { method: 'POST', body: {} });
  assert.equal(readAuditEntries(auditDir).length, 0, '读请求 / 404 不该产生审计行');

  await request(endpoint, '/task/create', { method: 'POST', body: { title: 'A2', actor: 'x' } });
  assert.equal(readAuditEntries(auditDir).length, 1);
});

test('A3 审计：被拒绝的写请求也留痕（401 / 404），错误码可追，且不落密钥', async () => {
  const { endpoint, auditDir } = await startService();
  const wrongToken = `wrong-${crypto.randomUUID()}`;

  const notFound = await request(endpoint, '/task/complete', { method: 'POST', body: { taskId: 't-nope', actor: 'eve' } });
  assert.equal(notFound.status, 404);
  const unauthorized = await request(endpoint, '/task/create', { method: 'POST', body: { title: 'x' }, token: wrongToken });
  assert.equal(unauthorized.status, 401);

  const entries = readAuditEntries(auditDir);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].status, 404);
  assert.equal(entries[0].ok, false);
  assert.equal(entries[0].error_code, 'TASK_NOT_FOUND');
  assert.equal(entries[0].task_id, 't-nope');
  assert.equal(entries[1].status, 401);
  assert.equal(entries[1].error_code, 'UNAUTHORIZED');

  const raw = readAuditFiles(auditDir).map((f) => fs.readFileSync(path.join(auditDir, f), 'utf8')).join('');
  assert.equal(raw.includes(wrongToken), false, '被试过的错误密钥同样不许进审计');
});

test('A4 审计：写失败只 warn，不影响请求本身', async () => {
  const badRoot = mkTmp('mesh-audit-bad-');
  const badDir = path.join(badRoot, 'audit-is-a-file');
  fs.writeFileSync(badDir, 'not a directory'); // 让 mkdir/append 必失败

  const { endpoint, warns } = await startService({ auditDir: badDir });
  const created = await request(endpoint, '/task/create', { method: 'POST', body: { title: 'A4', actor: 'alice' } });
  assert.equal(created.status, 200, '审计写失败绝不许把请求打成 500');
  assert.ok(created.body.task.task_id);

  const list = await request(endpoint, '/task/list');
  assert.ok(list.body.tasks.some((t) => t.task_id === created.body.task.task_id), '数据必须照常落库');

  assert.ok(warns.length >= 1, `审计写失败应至少 warn 一次，实际 ${warns.length} 次`);
  assert.ok(warns.some((w) => w.includes('审计日志写入失败')));

  const health = await request(endpoint, '/health');
  assert.equal(health.body.audit.enabled, true);
  assert.ok(health.body.audit.failures >= 1, '/health 要能看出"审计在失败"');
  assert.ok(health.body.audit.last_error);
});

test('A5 审计可关闭：opts.audit=false 时不建目录，/health 如实报 disabled', async () => {
  const { endpoint, dir } = await startService({ audit: false });
  await request(endpoint, '/task/create', { method: 'POST', body: { title: 'A5', actor: 'x' } });
  assert.equal(fs.existsSync(path.join(dir, 'audit')), false);

  const health = await request(endpoint, '/health');
  assert.equal(health.body.audit.enabled, false);
  assert.equal(health.body.audit.entries, 0);
});

test('A6 审计不记请求体内容：session-request 的 prompt 不许落盘', async () => {
  const { endpoint, auditDir } = await startService();
  const prompt = `TOP-SECRET-PROMPT-${crypto.randomUUID()}`;
  const res = await request(endpoint, '/session-request/create', {
    method: 'POST',
    body: { targetInstance: 'inst-a', requesterInstance: 'inst-b', prompt },
  });
  assert.equal(res.status, 200);

  const raw = readAuditFiles(auditDir).map((f) => fs.readFileSync(path.join(auditDir, f), 'utf8')).join('');
  assert.equal(raw.includes(prompt), false, '审计不许记录 prompt 正文（那是用户内容）');
  assert.ok(raw.includes('/session-request/create'), '但路由本身要能追到');
});

// ═══════════════════════════ 3. 按调用方限流 ═══════════════════════════

test('R1 限流：超过阈值 → 429 + 稳定码 RATE_LIMITED + retry-after', async () => {
  const { endpoint } = await startService({ rateLimit: 3 });
  for (let i = 0; i < 3; i += 1) {
    const r = await request(endpoint, '/task/create', { method: 'POST', body: { title: `R1-${i}`, actor: 'rl' } });
    assert.equal(r.status, 200, `第 ${i + 1} 次不该被限流`);
  }
  const fourth = await request(endpoint, '/task/create', { method: 'POST', body: { title: 'R1-4', actor: 'rl' } });
  assert.equal(fourth.status, 429);
  assert.equal(fourth.body.ok, false);
  assert.equal(fourth.body.error.code, 'RATE_LIMITED', '错误码必须是稳定短码，不能被写成一句自由文本');
  assert.equal(fourth.body.error.detail.limit, 3);
  assert.equal(fourth.body.error.detail.window_ms, 60000);
  assert.ok(Number(fourth.body.error.detail.retry_after_ms) > 0);
  const retryAfter = Number(fourth.headers.get('retry-after'));
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1, `retry-after 头必须是正整数秒，实际：${fourth.headers.get('retry-after')}`);
  assert.equal(JSON.stringify(fourth.body).includes(TOKEN), false);

  const health = await request(endpoint, '/health');
  assert.equal(health.body.rate_limit.rejected_total, 1);
});

test('R2 限流可关闭：rateLimit=false 时连续写不会被 429', async () => {
  const { endpoint } = await startService({ rateLimit: false });
  for (let i = 0; i < 10; i += 1) {
    const r = await request(endpoint, '/task/create', { method: 'POST', body: { title: `R2-${i}`, actor: 'x' } });
    assert.equal(r.status, 200, `第 ${i + 1} 次被拒（限流没关掉）`);
  }
  const health = await request(endpoint, '/health');
  assert.equal(health.body.rate_limit.enabled, false);
  assert.equal(health.body.rate_limit.rejected_total, 0);
});

test('R3 限流按调用方隔离：一个 token 打满不波及别的调用方，且读写分级不变', async () => {
  const { endpoint } = await startService({ rateLimit: 2 });
  assert.equal((await request(endpoint, '/task/create', { method: 'POST', body: { title: 'R3-a', actor: 'a' } })).status, 200);
  assert.equal((await request(endpoint, '/task/create', { method: 'POST', body: { title: 'R3-b', actor: 'a' } })).status, 200);
  assert.equal((await request(endpoint, '/task/create', { method: 'POST', body: { title: 'R3-c', actor: 'a' } })).status, 429);

  // 换一个 token：独立的计数桶 → 不会继承上一个调用方的 429，
  // 但它不是合法写密钥，所以应当是 401（**写分级语义没有因为限流被放松**）。
  const other = await request(endpoint, '/task/create', {
    method: 'POST',
    body: { title: 'R3-d', actor: 'b' },
    token: `other-${crypto.randomUUID()}`,
  });
  assert.equal(other.status, 401);
  const readKey = await request(endpoint, '/task/create', {
    method: 'POST',
    body: { title: 'R3-e', actor: 'b' },
    token: READ_TOKEN,
  });
  assert.equal(readKey.status, 401, '只读密钥不能写：分级语义不许放松');

  const health = await request(endpoint, '/health');
  assert.ok(health.body.rate_limit.tracked_callers >= 2, `应至少 2 个调用方桶，实际 ${health.body.rate_limit.tracked_callers}`);
});

test('R4 默认阈值保守：正常轮询 60 次 + 5 次写全部放行', async () => {
  const { endpoint } = await startService();
  for (let i = 0; i < 60; i += 1) {
    const r = await request(endpoint, '/task/list');
    assert.equal(r.status, 200, `第 ${i + 1} 次正常轮询被限流 —— 默认阈值太紧`);
  }
  for (let i = 0; i < 5; i += 1) {
    const r = await request(endpoint, '/task/create', { method: 'POST', body: { title: `R4-${i}`, actor: 'x' } });
    assert.equal(r.status, 200);
  }
  const health = await request(endpoint, '/health');
  assert.equal(health.body.rate_limit.enabled, true);
  assert.equal(health.body.rate_limit.limit, 600);
  assert.equal(health.body.rate_limit.window_ms, 60000);
  assert.equal(health.body.rate_limit.rejected_total, 0);
});

test('R5 GET /health 豁免限流：看门狗不能被自己的探活打死', async () => {
  const { endpoint } = await startService({ rateLimit: 2 });
  // 带 token 请求 /health，强制它和写请求落在同一个调用方桶里 ——
  // 只有这样才能证明"豁免"是真的，而不是因为桶不同碰巧没超。
  for (let i = 0; i < 5; i += 1) {
    const r = await request(endpoint, '/health');
    assert.equal(r.status, 200, `/health 被限流了（第 ${i + 1} 次）`);
  }
  assert.equal((await request(endpoint, '/task/create', { method: 'POST', body: { title: 'R5-a', actor: 'x' } })).status, 200);
  assert.equal((await request(endpoint, '/task/create', { method: 'POST', body: { title: 'R5-b', actor: 'x' } })).status, 200);
  assert.equal((await request(endpoint, '/task/create', { method: 'POST', body: { title: 'R5-c', actor: 'x' } })).status, 429);
});

test('R6 固定窗口：窗口过去后自动恢复', async () => {
  const { endpoint } = await startService({ rateLimit: 1, rateLimitWindowMs: 250 });
  assert.equal((await request(endpoint, '/task/create', { method: 'POST', body: { title: 'R6-a', actor: 'x' } })).status, 200);
  assert.equal((await request(endpoint, '/task/create', { method: 'POST', body: { title: 'R6-b', actor: 'x' } })).status, 429);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal((await request(endpoint, '/task/create', { method: 'POST', body: { title: 'R6-c', actor: 'x' } })).status, 200);
});

test('R7 被限流的请求不落审计（否则限流自己会把磁盘写爆）', async () => {
  const { endpoint, auditDir } = await startService({ rateLimit: 1 });
  assert.equal((await request(endpoint, '/task/create', { method: 'POST', body: { title: 'R7-a', actor: 'x' } })).status, 200);
  assert.equal((await request(endpoint, '/task/create', { method: 'POST', body: { title: 'R7-b', actor: 'x' } })).status, 429);
  const entries = readAuditEntries(auditDir);
  assert.equal(entries.length, 1, `429 不该产生审计行，实际 ${entries.length} 行`);
  assert.equal(entries[0].status, 200);
  const health = await request(endpoint, '/health');
  assert.equal(health.body.rate_limit.rejected_total, 1);
});

// ═══════════════════════════ 4. 监听地址可配 ═══════════════════════════

test('H1 默认监听地址仍是 127.0.0.1（行为不变），/health 报真值与安全提示', async () => {
  delete process.env.DSH_TEAM_BOARD_HOST; // 双保险：模块顶部已删，这里再兜一次
  const dir = mkTmp('mesh-host-default-');
  const svc = await startBoardService({
    boardPath: path.join(dir, 'team.db'),
    port: 0,
    token: TOKEN,
    readToken: READ_TOKEN,
    sweep: false,
    logger: { warn() {}, info() {} },
  });
  services.push(svc);

  const endpoint = `http://127.0.0.1:${svc.port}`;
  const { body } = await request(endpoint, '/health');
  assert.equal(body.listen_host, '127.0.0.1', '默认必须还是回环地址（这次升级不改变现有行为）');
  assert.equal(body.listen_port, svc.port);
  assert.equal(body.listen_host_configured, '127.0.0.1');
  assert.equal(body.listen_exposed, false);
  assert.ok(typeof body.listen_hint === 'string' && body.listen_hint.includes('回环'), `提示应说明是回环：${body.listen_hint}`);
  assert.equal(body.schema_version, 4, 'schema_version 必须仍是 4（本次没有任何 schema 变更）');
  // 新观测段都在且默认启用
  assert.equal(body.gc.enabled, true);
  assert.equal(body.gc.retention_ms, DEFAULT_BLOB_RETENTION_MS);
  assert.equal(body.audit.enabled, true);
  assert.equal(body.rate_limit.enabled, true);
  assert.equal(body.rate_limit.limit, 600);
  assert.equal(body.sweep.enabled, false, '本用例显式关掉了定时 sweep');
  // /health 是公开路由，不许把任何密钥吐出去
  const raw = JSON.stringify(body);
  assert.equal(raw.includes(TOKEN), false);
  assert.equal(raw.includes(READ_TOKEN), false);
});

test('H2 host 可配 0.0.0.0：/health 如实报"暴露"并给出警告提示', async () => {
  const { endpoint, svc } = await startService({ host: '0.0.0.0' });
  const { body } = await request(endpoint, '/health');
  assert.equal(body.listen_host, '0.0.0.0');
  assert.equal(body.listen_port, svc.port);
  assert.equal(body.listen_exposed, true);
  assert.ok(body.listen_hint.includes('所有网卡'), `提示应说明对网络可见：${body.listen_hint}`);
  const list = await request(endpoint, '/task/list');
  assert.equal(list.status, 200, '绑 0.0.0.0 时从本机回环仍然可达');
});

test('H3 host 可由环境变量 DSH_TEAM_BOARD_HOST 配置（沿用现有读取风格）', async () => {
  const dir = mkTmp('mesh-host-env-');
  process.env.DSH_TEAM_BOARD_HOST = '127.0.0.1';
  try {
    const svc = await startBoardService({
      boardPath: path.join(dir, 'team.db'),
      port: 0,
      token: TOKEN,
      sweep: false,
      logger: { warn() {}, info() {} },
    });
    services.push(svc);
    const { body } = await request(`http://127.0.0.1:${svc.port}`, '/health');
    assert.equal(body.listen_host, '127.0.0.1');
    assert.equal(body.listen_host_configured, '127.0.0.1');
  } finally {
    delete process.env.DSH_TEAM_BOARD_HOST;
  }
});

// ═══════════════════════════ 5. 外部 sweep 工具 ═══════════════════════════

test('T1 tools/sweep_once.mjs：真子进程调用 POST /sweep，输出 blob GC 计数且不打印密钥', async () => {
  const { endpoint, svc } = await startService();
  const bytes = Buffer.from(`t1-tool-${crypto.randomUUID()}`);
  const put = await putBlob(endpoint, bytes);
  svc.board.db.prepare('UPDATE blob SET created_at = ? WHERE sha256 = ?').run(Date.now() - 8 * DAY, put.body.sha256);

  const r = await runNode([
    path.join(REPO_ROOT, 'tools', 'sweep_once.mjs'),
    '--once',
    '--endpoint',
    endpoint,
    '--token',
    TOKEN,
  ]);
  assert.equal(r.status, 0, `sweep_once 退出码应为 0，实际 ${r.status}；stderr=${r.stderr}`);
  assert.match(r.stdout, /blob_gc_deleted=1/, `输出里应有 GC 计数：${r.stdout}`);
  assert.match(r.stdout, /kept_referenced=\d+/);
  assert.match(r.stdout, /remaining=\d+/);
  assert.equal(r.stdout.includes(TOKEN), false, '工具绝不许把密钥打到 stdout');
  assert.equal(r.stderr.includes(TOKEN), false);
});

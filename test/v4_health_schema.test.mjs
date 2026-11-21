/**
 * v4_health_schema.test.mjs — `/health` 报的 `schema_version` 是不是**库里的真值**。
 *
 * 为什么单开一个文件：
 *   要验证的缺陷不是"字段缺失"，而是**假判据**：`/health` 里写死 `schema_version: 1`，
 *   跟库里真实的 4 毫无关系。光断言"现在是 4"**不能**证明缺陷被修好 ——
 *   把 `1` 改成 `4` 也能让这条断言通过，但假判据依然在，只是换了个数字。
 *
 *   所以本文件的重点是**反证**：同一块板，把库里的值改成 5 / 7 / 3，
 *   `/health` 必须跟着变。只有"库变 → 接口变"成立，才证明它是读出来的。
 *
 * 三层真实：
 *   1. 真 HTTP：起真板服务、走真 socket、真 JSON 序列化（不 mock 路由）。
 *   2. 真磁盘：库是临时目录里的真 SQLite 文件，改值用**另一条连接**写，
 *      再从接口读 —— 证明读的是磁盘上的库，不是进程内缓存的值。
 *   3. 真读不到：把行删掉 / 写脏值，断言返回 `null` 而不是回退成 1。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { Board, SCHEMA_VERSION } from '../src/store.js';
import { startBoardService, BOARD_SERVICE_VERSION } from '../src/server.js';

const tmpDirs = [];
const services = [];

// 测试自带随机密钥：绝不复用现网那两把
const TOKEN = `t-${crypto.randomUUID()}`;
const READ_TOKEN = `r-${crypto.randomUUID()}`;

function mkTmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

/**
 * 起一块真板 + 真 HTTP 服务（端口 0 让系统挑，避免撞车）。
 * 测试里关掉定时 sweep：它与本文件断言无关，留着只会引入时序噪声。
 */
async function startService() {
  const dir = mkTmp('mesh-health-');
  const dbPath = path.join(dir, 'team.db');
  const board = new Board(dbPath);
  const svc = await startBoardService({
    board,
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    readToken: READ_TOKEN,
    sweep: false,
    logger: { warn: () => {}, info: () => {} },
  });
  services.push(svc);
  return { svc, dbPath, endpoint: `http://127.0.0.1:${svc.port}` };
}

/** 走真 HTTP 拿 /health 的原始 JSON。 */
async function getHealth(endpoint, headers = {}) {
  const res = await fetch(`${endpoint}/health`, { headers });
  const body = await res.json();
  return { status: res.status, body };
}

/**
 * 用**另一条连接**改库里的 schema_version。
 * 另起连接是关键：从板服务自己的句柄改也可以，但那样就分不清
 * 「接口读了库」与「接口读了自己进程的内存」。
 */
function setSchemaVersionOnDisk(dbPath, value) {
  const db = new DatabaseSync(dbPath);
  try {
    if (value === null) {
      db.prepare('DELETE FROM meta WHERE key = ?').run('schema_version');
    } else {
      const exists = db.prepare('SELECT 1 AS ok FROM meta WHERE key = ?').get('schema_version');
      if (exists === undefined) {
        db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('schema_version', String(value));
      } else {
        db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(value), 'schema_version');
      }
    }
  } finally {
    db.close();
  }
}

/** 直接查库，作为断言的真值来源（不经任何被测代码）。 */
function readSchemaVersionOnDisk(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
    return row === undefined ? null : String(row.value);
  } finally {
    db.close();
  }
}

after(async () => {
  for (const svc of services) {
    try {
      await svc.close();
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
});

// ───────────────────────── 基本契约 ─────────────────────────

test('H1 新板：/health 的 schema_version 等于库里真实值（当前为 5）', async () => {
  const { endpoint, dbPath } = await startService();
  const onDisk = readSchemaVersionOnDisk(dbPath);
  assert.equal(onDisk, String(SCHEMA_VERSION), '新库的 meta.schema_version 应等于 SCHEMA_VERSION');

  const { status, body } = await getHealth(endpoint);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.schema_version, Number(onDisk));
  assert.equal(body.schema_version, 5, '0.7 起当前 schema 版本应为 5（新增依赖/写域列）');
  assert.equal(body.schema_version_error, null, '读成功时不该带错误码');
  // 0.7 能力清单也在 /health 里，客户端据此决定发不发新字段
  assert.ok(Array.isArray(body.capabilities), '0.7 起 /health 应带 capabilities 数组');
  for (const cap of ['task-deps', 'write-scopes', 'expected-revision']) {
    assert.ok(body.capabilities.includes(cap), `capabilities 应包含 ${cap}`);
  }
});

test('H2 version 是 HTTP 契约版本，与 schema_version 语义无关，本次不动', async () => {
  const { endpoint } = await startService();
  const { body } = await getHealth(endpoint);
  // 这条断言是**保护性**的：改 schema_version 时不许顺手把服务版本也改了。
  assert.equal(body.version, BOARD_SERVICE_VERSION);
  assert.equal(body.version, '1.0.0');
  // 两个字段各说各的事：一个是契约版本（字符串），一个是库版本（整数）。
  assert.equal(typeof body.version, 'string');
  assert.equal(typeof body.schema_version, 'number');
});

test('H3 /health 仍是公开路由（不带密钥也 200），修复没有把探活搞成要鉴权', async () => {
  const { endpoint } = await startService();
  const { status, body } = await getHealth(endpoint); // 不带 x-team-token
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  // 公开路由里也不能把密钥吐出去
  assert.equal(JSON.stringify(body).includes(TOKEN), false);
  assert.equal(JSON.stringify(body).includes(READ_TOKEN), false);
});

// ───────────────────── 反证：库变 → 接口跟着变 ─────────────────────

test('H4 反证：库里改成 6 → /health 立刻报 6（证明不是写死 5）', async () => {
  const { endpoint, dbPath } = await startService();

  // 先确认基线是 5，避免"本来就等于 6"这种假通过
  assert.equal((await getHealth(endpoint)).body.schema_version, 5);

  setSchemaVersionOnDisk(dbPath, 6);
  assert.equal(readSchemaVersionOnDisk(dbPath), '6', '磁盘上确实已经是 6');

  const { status, body } = await getHealth(endpoint);
  assert.equal(status, 200);
  assert.equal(body.schema_version, 6, '库改成 6 后 /health 必须报 6；报 5 说明还是写死的');
});

test('H5 反证：连改三次（7 → 2 → 9），每次 /health 都跟随', async () => {
  const { endpoint, dbPath } = await startService();
  for (const v of [7, 2, 9]) {
    setSchemaVersionOnDisk(dbPath, v);
    const { body } = await getHealth(endpoint);
    assert.equal(body.schema_version, v, `库为 ${v} 时 /health 应报 ${v}`);
    assert.equal(body.schema_version_error, null);
  }
});

test('H6 反证：库里的值比 SCHEMA_VERSION 小（3）也照实报，不回退成 4', async () => {
  const { endpoint, dbPath } = await startService();
  setSchemaVersionOnDisk(dbPath, 3);
  const { body } = await getHealth(endpoint);
  // 注意：这里是**只读**场景（板已经打开，不会再跑迁移），所以 3 会原样透出。
  // 若实测报 4，说明实现里偷偷用了常量 SCHEMA_VERSION 而不是库里的值。
  assert.equal(body.schema_version, 3);
});

test('H7 反证：库里值改成字符串 "6"（meta.value 是 TEXT）也能正确解析成数字 6', async () => {
  const { endpoint, dbPath } = await startService();
  setSchemaVersionOnDisk(dbPath, '6');
  const { body } = await getHealth(endpoint);
  assert.equal(body.schema_version, 6);
});

// ───────────────────── 读不到时：明确表达，不回退 ─────────────────────

test('H8 行被删掉 → schema_version 为 null（不是 1），并带 MISSING 原因', async () => {
  const { endpoint, dbPath } = await startService();
  setSchemaVersionOnDisk(dbPath, null);
  assert.equal(readSchemaVersionOnDisk(dbPath), null, '磁盘上这行确实没了');

  const { status, body } = await getHealth(endpoint);
  assert.equal(status, 200, '读不到 schema 版本不该让探活失败');
  assert.equal(body.schema_version, null);
  assert.notEqual(body.schema_version, 1, '**绝不许**回退成 1 —— 那是把假判据换个写法保留');
  assert.equal(body.schema_version_error, 'MISSING');
  assert.equal(body.ok, true, '服务本身是活的，只是"不知道 schema 版本"');
});

test('H9 值不是正整数（abc / 0 / -1 / 空串）→ null + NOT_A_POSITIVE_INTEGER，不回退', async () => {
  const { endpoint, dbPath } = await startService();
  for (const bad of ['abc', '0', '-1', '']) {
    setSchemaVersionOnDisk(dbPath, bad);
    const { status, body } = await getHealth(endpoint);
    assert.equal(status, 200);
    assert.equal(body.schema_version, null, `脏值 ${JSON.stringify(bad)} 必须报 null`);
    assert.notEqual(body.schema_version, 1);
    assert.equal(body.schema_version_error, 'NOT_A_POSITIVE_INTEGER', `脏值 ${JSON.stringify(bad)} 的原因码`);
  }
});

test('H10 小数 / 带空格的数值：不猜，报 null（不是 4、也不是 4.5）', async () => {
  const { endpoint, dbPath } = await startService();
  setSchemaVersionOnDisk(dbPath, '4.5');
  const { body } = await getHealth(endpoint);
  assert.equal(body.schema_version, null, '4.5 不是整数版本号，不许四舍五入成 4');
  assert.equal(body.schema_version_error, 'NOT_A_POSITIVE_INTEGER');
});

// ───────────────────── 分层：方法确实在 backend，路由不拼 SQL ─────────────────────

test('H11 分层：Board.schemaVersion() 存在且与库一致（路由不该自己拼 SQL）', async () => {
  const { svc, dbPath } = await startService();
  const res = svc.board.schemaVersion();
  assert.equal(res.version, 5);
  assert.equal(res.present, true);
  assert.equal(res.error, null);
  assert.equal(res.raw, readSchemaVersionOnDisk(dbPath));

  // 后端层直接读也一样（证明只是薄转发，没有第二套逻辑）
  const backendRes = svc.board.backend.readSchemaVersion();
  assert.deepEqual(backendRes, res);
});

test('H12 分层：server.js 里不再出现写死的 schema_version 字面量', async () => {
  // 静态反证：本次缺陷的形态就是"源码里有个字面量"，所以直接查源码。
  // 注释里会引用旧写法（`schema_version: 1`）来说明为什么改，那是文档不是代码，
  // 所以只扫**非注释行**，否则这条断言会因为解释文字而误报。
  // 注意仓库路径含空格，必须用 fileURLToPath 解码，手写 replace 会留下 %20。
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '..', 'src', 'server.js'), 'utf8');
  const codeLines = src
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    });
  const offending = codeLines.filter((line) => /schema_version\s*:\s*\d/.test(line));
  assert.deepEqual(
    offending,
    [],
    `server.js 里不许再出现 \`schema_version: <数字>\` 这种写死写法，命中：${JSON.stringify(offending)}`,
  );
});

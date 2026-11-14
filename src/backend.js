/**
 * backend.js — 板的**后端接口 + 本地 SQLite 实现**。
 *
 * 拆这一层的原因很具体：原型把"板"和"SQLite"写死在一起，于是任务只能活在
 * 本机 `$DSH_HOME/team/team.db` 里 —— 两台设备各有一块互不相通的板，
 * 跨机派的活对方根本查不到（实跑：设备B 报证据得到 TASK_NOT_FOUND）。
 *
 * 现在 Board 只认这个接口的方法名与错误码；具体是本地 SQLite 还是远端 HTTP
 * 由构造时给的 backend 决定。四条不变量与判定逻辑一律留在 Board/domain 里，
 * 后端只负责存和取 —— **门禁不跟着后端走**，否则远端实现一接就可能被放松。
 *
 * 接口（全部同步，因为本地 SQLite 是同步的；远端实现内部用 deasync 之外的
 * 方式不可行，所以远端走异步，由 asym 适配层包装，见 remote.js 的说明）：
 *   createTask / getTask / listTasks / claimTask / reportEvidence / listEvidence
 *   completeTask / cancelTask / recordDispatch / recentEvents / appendEvent / close
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { eventPayload } from './domain.js';

export const SCHEMA_VERSION = 4;

/**
 * blob 默认保留期：7 天。
 *
 * 为什么是 7 天而不是"删完即删"：blob 的典型生命周期是**上传 → 几秒后报证据**，
 * 但这条链路上任何一环都可能断（客户端报证据失败重试、任务被 cancel 后又重开、
 * 人工补证据）。保留 7 天等于给"上传了但还没被引用"一个远大于实际用时的窗口，
 * 同时又不至于让孤儿 blob 永久占空间。保留期可配（见 server.js 的
 * DSH_TEAM_BOARD_BLOB_RETENTION_MS），也可以整体关掉 GC。
 */
export const DEFAULT_BLOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task (
  task_id       TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  brief         TEXT NOT NULL DEFAULT '',
  acceptance    TEXT NOT NULL DEFAULT '',
  lifecycle     TEXT NOT NULL CHECK (lifecycle IN
    ('open','claimed','working','blocked','done','canceled')),
  owner_session TEXT,
  created_by    TEXT NOT NULL,
  request_id    TEXT UNIQUE,
  version       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  -- v4：租约身份（防 PID 复用）。三个都可空 —— 老数据为 NULL 时行为与 v3 完全一致。
  lease_pid               INTEGER,
  lease_start_sec         INTEGER,
  lease_host              TEXT,
  -- v4：可选「独立复核」门禁。默认 0 = 关闭，老任务行为完全不变。
  require_independent_review INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS evidence (
  evidence_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      TEXT NOT NULL REFERENCES task(task_id),
  actor        TEXT NOT NULL,
  executed     INTEGER NOT NULL CHECK (executed IN (0,1)),
  outcome      TEXT NOT NULL CHECK (outcome IN ('pass','fail','unknown')),
  admissible   INTEGER NOT NULL CHECK (admissible IN (0,1)),
  reasons      TEXT NOT NULL DEFAULT '[]',
  note         TEXT NOT NULL DEFAULT '',
  evidence_ref TEXT,
  ref_sha256   TEXT,
  ref_size     INTEGER,
  created_at   INTEGER NOT NULL,
  -- v4：结构化复核信息。四个都可空 —— 老数据为 NULL，老逻辑不读它们。
  verified_by          TEXT,
  verified_at          INTEGER,
  acceptance_ref       TEXT,
  verification_method  TEXT
);

CREATE INDEX IF NOT EXISTS idx_evidence_task ON evidence(task_id, evidence_id);

CREATE TABLE IF NOT EXISTS dispatch (
  dispatch_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       TEXT NOT NULL REFERENCES task(task_id),
  peer_instance TEXT NOT NULL,
  peer_session  TEXT NOT NULL,
  delivered     INTEGER NOT NULL CHECK (delivered IN (0,1)),
  reason        TEXT,
  created_session INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS event (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  task_id    TEXT,
  actor      TEXT,
  payload    TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_event_task ON event(task_id, seq);

-- 跨机证据：内容寻址的对象存储。key 是内容的 sha256，值是字节本身。
-- 只增不改：同一个 key 重复上传是幂等的，且上传方无法决定 key（服务端算）。
CREATE TABLE IF NOT EXISTS blob (
  sha256     TEXT PRIMARY KEY,
  size       INTEGER NOT NULL,
  bytes      BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

-- ── v2：ack / 租约 / 收件箱游标 ──────────────────────────────────────────
-- 投递回执：每次派发一行。acked_at 为 NULL 表示"还没人认领这封信"。
-- 为什么单独一张表而不是只靠 event：需要被"超时扫描"高效查询，
-- 且要能回答"这封信到底送到了没 / 送到了但没人理"两个不同问题。
CREATE TABLE IF NOT EXISTS ack (
  ack_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       TEXT NOT NULL,
  dispatch_id   INTEGER,
  peer_instance TEXT NOT NULL,
  peer_session  TEXT NOT NULL,
  delivered     INTEGER NOT NULL CHECK (delivered IN (0,1)),
  delivery_reason TEXT,
  dispatched_at INTEGER NOT NULL,
  deadline_at   INTEGER NOT NULL,
  acked_at      INTEGER,
  acker         TEXT,
  timed_out     INTEGER NOT NULL DEFAULT 0 CHECK (timed_out IN (0,1)),
  timed_out_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_ack_task ON ack(task_id, ack_id);
CREATE INDEX IF NOT EXISTS idx_ack_pending ON ack(acked_at, timed_out, deadline_at);

-- 收件箱游标：每个客户端（instance+session）一条，记"已读到哪个 seq"。
-- 主键是 (instance_id, session_id)，所以天然按客户端隔离，不会互相串。
CREATE TABLE IF NOT EXISTS cursor (
  instance_id TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  last_seq    INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (instance_id, session_id)
);

-- ── v3：远端建会话请求（newSession） ─────────────────────────────────────
-- 病根：interconnect 只有 list/send，没有 create，于是派发方只能挑现成会话；
-- 对端只有一个活会话时，所有任务全堵进那一个（2026-11-08 凌晨实测 4 次全 ACK_TIMEOUT）。
--
-- 解法不用改 interconnect 协议：借**共享板**当信箱。
--   派发方 createSessionRequest() 写一行 pending → 对端 team-mesh 的收件箱轮询看到
--   → 它在本机调 Host 的 sessionController.create() **真正新建会话**
--   → 再 claimSessionRequest() 把结果写回（sessionId 或拒绝原因）
--   → 派发方 waitSessionRequest() 读到结果，拿新 sessionId 做正常的 interconnect.send。
--
-- 为什么在板上而不是在 interconnect 帧里：板本来就是两端都能读写的共享介质，
-- 而且 boardToken 已经鉴权。改帧要全集群升同一版插件，改板不用。
CREATE TABLE IF NOT EXISTS session_request (
  request_id    TEXT PRIMARY KEY,
  -- 谁请求的：用于对端判断"这条是不是给我的"
  target_instance TEXT NOT NULL,
  requester_instance TEXT NOT NULL,
  requester_session  TEXT,
  -- 想要什么（全部可空，由接收端补默认值）
  cwd           TEXT,
  title         TEXT,
  agent_preset  TEXT,
  prompt        TEXT,
  -- 生命周期：pending → claimed(已建/已拒) ；expired 由清扫写
  state         TEXT NOT NULL DEFAULT 'pending'
                CHECK (state IN ('pending','claimed','expired')),
  -- 结果：成功给 session_id，失败给 reject_reason + reject_message
  session_id    TEXT,
  reject_reason TEXT,
  reject_message TEXT,
  claimed_by    TEXT,
  created_at    INTEGER NOT NULL,
  claimed_at    INTEGER,
  deadline_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_request_target
  ON session_request(target_instance, state, created_at);
`;

/** v2 给 task 表追加的列（SQLite 的 ADD COLUMN 是幂等的按需执行，不能写在 DDL 里重复） */
const TASK_V2_COLUMNS = [
  ['ack_state', "TEXT NOT NULL DEFAULT 'none'"], // none | pending | acked | timeout
  ['ack_deadline_at', 'INTEGER'],
  ['ack_at', 'INTEGER'],
  ['lease_owner', 'TEXT'],
  ['lease_until', 'INTEGER'],
  ['stale', 'INTEGER NOT NULL DEFAULT 0'],
  ['stale_at', 'INTEGER'],
];

/**
 * v4 给 task 表追加的列 —— **租约身份 + 可选独立复核门禁**。
 *
 * 为什么要有 lease_pid / lease_start_sec：v2/v3 的租约只靠 `lease_owner`（一个字符串）
 * 加 `lease_until`（时间戳）。进程崩了、系统把同一个 PID 复用给别的进程后，
 * 光看"负责人名字对不对"无法分辨"还是那个进程"和"PID 被复用给了另一个进程"。
 * 加上 pid + 进程启动时刻（秒），就能在同一台机器上判定"持有者还是不是当初那个进程"。
 *
 * 为什么三个都可空：**老数据零影响**。NULL 表示"这条租约没有身份信息"，
 * 所有校验遇到 NULL 一律跳过，行为与 v3 逐字节一致。
 *
 * lease_host：跨机器时 pid 无意义（不同机器 pid 空间独立，同号纯属巧合），
 * 所以只有 lease_host 与本机相同才验 pid；不同机器只认时间。
 */
const TASK_V4_COLUMNS = [
  ['lease_pid', 'INTEGER'],
  ['lease_start_sec', 'INTEGER'],
  ['lease_host', 'TEXT'],
  ['require_independent_review', 'INTEGER NOT NULL DEFAULT 0'],
];

/**
 * v4 给 evidence 表追加的列 —— **结构化复核信息**。
 *
 * 病根：v3 的 evidence 只有 `actor`（谁报的）+ `evidence_ref`（指向什么）。
 * 缺三样东西，验收时必然扯皮：
 *   谁验的（verified_by，必须允许与 actor 不同）
 *   什么时候验的（verified_at）
 *   验的是哪一条验收标准（acceptance_ref，如 A03）
 *   用什么方法验的（verification_method：disk-hash / manual-review / test-run）
 * 四个都可空：老证据保持 NULL，老逻辑一个字都不读它们。
 */
const EVIDENCE_V4_COLUMNS = [
  ['verified_by', 'TEXT'],
  ['verified_at', 'INTEGER'],
  ['acceptance_ref', 'TEXT'],
  ['verification_method', 'TEXT'],
];


export class LocalSqliteBackend {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.closed = false;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    // WAL：多进程并发读写；busy_timeout：对方持写锁时等而不是立刻 SQLITE_BUSY
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA synchronous = FULL;');
    this.db.exec(DDL);
    // v1 → v2 迁移：给已有 task 表补列。SQLite 没有 ADD COLUMN IF NOT EXISTS，
    // 所以按 PRAGMA table_info 逐个判断，可反复执行（幂等）。
    this.migrateTaskV2();
    this.migrateDispatchV3();
    this.migrateTaskV4();
    this.migrateEvidenceV4();
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
    if (row === undefined) {
      this.db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
    } else if (Number(row.value) < SCHEMA_VERSION) {
      this.db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(SCHEMA_VERSION), 'schema_version');
    }
  }

  migrateTaskV2() {
    const existing = new Set(
      this.db.prepare('PRAGMA table_info(task)').all().map((c) => String(c.name)),
    );
    for (const [name, decl] of TASK_V2_COLUMNS) {
      if (existing.has(name)) continue;
      this.db.exec(`ALTER TABLE task ADD COLUMN ${name} ${decl}`);
    }
  }

  /**
   * v3 迁移：给老的 dispatch 表补 created_session 列。
   * 老库（0.3.1 建的）里这张表没有这列，不补 INSERT 会直接报 no such column。
   * 默认 0 = "现成会话"，正好是老行为的正确表述。
   */
  migrateDispatchV3() {
    const existing = new Set(
      this.db.prepare('PRAGMA table_info(dispatch)').all().map((c) => String(c.name)),
    );
    if (!existing.has('created_session')) {
      this.db.exec('ALTER TABLE dispatch ADD COLUMN created_session INTEGER NOT NULL DEFAULT 0');
    }
  }

  /**
   * 通用补列：按 PRAGMA table_info 判断列是否存在，缺了才 ALTER。
   *
   * **幂等**是硬要求：这个方法在每次打开库时都会跑（板服务每次启动、
   * 每个测试用例建库时都跑），重复执行必须是空操作，不报错、不写数据。
   * @returns {string[]} 本次实际补上的列名（已存在的不算）
   */
  addColumnsIfMissing(table, columns) {
    const existing = new Set(
      this.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => String(c.name)),
    );
    const added = [];
    for (const [name, decl] of columns) {
      if (existing.has(name)) continue;
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
      added.push(name);
    }
    return added;
  }

  /** v4 迁移：task 表补租约身份列 + 独立复核开关。幂等，老行一律 NULL / 0。 */
  migrateTaskV4() {
    return this.addColumnsIfMissing('task', TASK_V4_COLUMNS);
  }

  /** v4 迁移：evidence 表补结构化复核列。幂等，老行一律 NULL。 */
  migrateEvidenceV4() {
    return this.addColumnsIfMissing('evidence', EVIDENCE_V4_COLUMNS);
  }

  /**
   * 读**库里记录的** schema 版本（`meta.schema_version`）。
   *
   * 存在的理由：`/health` 原来把这个字段写死成 `1`，而库里真实值是 4，
   * 于是它成了**假判据** —— 谁想用它确认板服务加载了哪版代码都会被误导。
   * 现在改成从库里读，SQL 只允许出现在这一层（分层：路由只搬结论）。
   *
   * **不吞错、不回退**：读不到就返回 `version: null` 并带上原因，
   * 绝不 fallback 成 1 —— 回退成字面量等于把假判据换个写法保留下来。
   *
   * @returns {{version: number|null, raw: string|null, present: boolean, error: string|null}}
   *   `version` 只在值是可解析的正整数时才给数；`raw` 是无损的原始字符串；
   *   `present` 表示这一行是否存在；`error` 为 null 表示"读到了且合法"。
   */
  readSchemaVersion() {
    try {
      const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
      if (row === undefined) {
        return { version: null, raw: null, present: false, error: 'MISSING' };
      }
      const raw = row.value === null || row.value === undefined ? null : String(row.value);
      if (raw === null) {
        return { version: null, raw: null, present: true, error: 'NULL_VALUE' };
      }
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        return { version: null, raw, present: true, error: 'NOT_A_POSITIVE_INTEGER' };
      }
      return { version: n, raw, present: true, error: null };
    } catch (err) {
      // 库被关了 / 文件损坏 / 不是 SQLite：如实说读不到，让 /health 显示 null。
      return { version: null, raw: null, present: false, error: String(err?.message ?? err) };
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch {
      /* 已关或宿主进程退出中 */
    }
  }

  /** 单一写事务入口：BEGIN IMMEDIATE 拿写锁，失败必回滚。 */
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* 回滚失败也要把原错抛出去 */
      }
      throw err;
    }
  }

  // ───────────────────── 存储原语（Board 不该直接碰 SQL） ─────────────────────

  findTaskByIdempotencyKey(key) {
    return this.db.prepare('SELECT * FROM task WHERE request_id = ?').get(key);
  }

  insertTask(row) {
    this.db
      .prepare(
        `INSERT INTO task(task_id, title, brief, acceptance, lifecycle, created_by, request_id,
           version, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.task_id,
        row.title,
        row.brief,
        row.acceptance,
        row.lifecycle,
        row.created_by,
        row.request_id,
        row.version,
        row.created_at,
        row.updated_at,
      );
  }

  readTaskRow(taskId) {
    return this.db.prepare('SELECT * FROM task WHERE task_id = ?').get(taskId);
  }

  queryTasks(where, args, limit) {
    const sql = `SELECT * FROM task ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY updated_at DESC LIMIT ?`;
    return this.db.prepare(sql).all(...args, limit);
  }

  /** 乐观并发：只有 version 没变才写得进去。返回是否写成功。 */
  updateTaskCas(taskId, expectedVersion, sets) {
    const cols = Object.keys(sets);
    const assignments = cols.map((c) => `${c} = ?`).join(', ');
    const values = cols.map((c) => sets[c]);
    const info = this.db
      .prepare(`UPDATE task SET ${assignments}, version = version + 1, updated_at = ?
                WHERE task_id = ? AND version = ?`)
      .run(...values, Date.now(), taskId, expectedVersion);
    return Number(info.changes) > 0;
  }

  insertEvidence(row) {
    const info = this.db
      .prepare(
        `INSERT INTO evidence(task_id, actor, executed, outcome, admissible, reasons, note,
           evidence_ref, ref_sha256, ref_size, created_at,
           verified_by, verified_at, acceptance_ref, verification_method)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.task_id,
        row.actor,
        row.executed ? 1 : 0,
        row.outcome,
        row.admissible ? 1 : 0,
        JSON.stringify(row.reasons),
        row.note,
        row.evidence_ref,
        row.ref_sha256,
        row.ref_size,
        row.created_at,
        // v4：四个复核字段都可空，缺省写 NULL（老调用方不传，行为与 v3 一致）
        row.verified_by ?? null,
        row.verified_at ?? null,
        row.acceptance_ref ?? null,
        row.verification_method ?? null,
      );
    return Number(info.lastInsertRowid);
  }

  queryEvidence(taskId) {
    return this.db.prepare('SELECT * FROM evidence WHERE task_id = ? ORDER BY evidence_id ASC').all(taskId);
  }

  insertDispatch(row) {
    const info = this.db
      .prepare(
        `INSERT INTO dispatch(task_id, peer_instance, peer_session, delivered, reason, created_session, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        row.task_id,
        row.peer_instance,
        row.peer_session,
        row.delivered ? 1 : 0,
        row.reason,
        row.created_session ?? 0,
        row.created_at,
      );
    return Number(info.lastInsertRowid);
  }

  insertEvent(row) {
    const info = this.db
      .prepare('INSERT INTO event(kind, task_id, actor, payload, created_at) VALUES (?,?,?,?,?)')
      .run(row.kind, row.task_id, row.actor, row.payload ?? '{}', row.created_at);
    return Number(info.lastInsertRowid);
  }

  queryEvents(limit, taskId) {
    const sql = taskId === null
      ? 'SELECT * FROM event ORDER BY seq DESC LIMIT ?'
      : 'SELECT * FROM event WHERE task_id = ? ORDER BY seq DESC LIMIT ?';
    return taskId === null
      ? this.db.prepare(sql).all(limit)
      : this.db.prepare(sql).all(taskId, limit);
  }

  // ─────────────────── v3：远端建会话请求（板当信箱） ───────────────────

  insertSessionRequest(row) {
    this.db
      .prepare(
        `INSERT INTO session_request(request_id, target_instance, requester_instance, requester_session,
           cwd, title, agent_preset, prompt, state, created_at, deadline_at)
         VALUES (?,?,?,?,?,?,?,?,'pending',?,?)`,
      )
      .run(
        row.request_id,
        row.target_instance,
        row.requester_instance,
        row.requester_session ?? null,
        row.cwd ?? null,
        row.title ?? null,
        row.agent_preset ?? null,
        row.prompt ?? null,
        row.created_at,
        row.deadline_at,
      );
    return row.request_id;
  }

  readSessionRequest(requestId) {
    return this.db.prepare('SELECT * FROM session_request WHERE request_id = ?').get(requestId);
  }

  /** 取该实例名下待处理的请求，**最旧优先**（先来先建，避免新请求饿死老的）。 */
  queryPendingSessionRequests(targetInstance, limit) {
    return this.db
      .prepare(
        `SELECT * FROM session_request
          WHERE target_instance = ? AND state = 'pending'
          ORDER BY created_at ASC LIMIT ?`,
      )
      .all(targetInstance, limit);
  }

  /**
   * 抢占一条 pending 请求并写结果（一个事务内完成）。
   * 用 state='pending' 做 CAS：两个进程同时扫到同一条，只有一个能写进去。
   * @returns 是否由本次调用接管（false 表示已被别人处理或已过期）
   */
  claimSessionRequest(requestId, row) {
    const info = this.db
      .prepare(
        `UPDATE session_request
            SET state = 'claimed', claimed_by = ?, claimed_at = ?,
                session_id = ?, reject_reason = ?, reject_message = ?
          WHERE request_id = ? AND state = 'pending'`,
      )
      .run(
        row.claimed_by ?? null,
        row.claimed_at,
        row.session_id ?? null,
        row.reject_reason ?? null,
        row.reject_message ?? null,
        requestId,
      );
    return Number(info.changes) > 0;
  }

  /** 把超过 deadline 还 pending 的请求标成 expired。返回被标了几条。 */
  expireSessionRequests(now) {
    const info = this.db
      .prepare(`UPDATE session_request SET state = 'expired' WHERE state = 'pending' AND deadline_at <= ?`)
      .run(now);
    return Number(info.changes);
  }

  // ───────────────────── 内容寻址对象（跨机证据用） ─────────────────────

  /** key 由服务端算：调用方给字节，不给哈希。 */
  putBlob(bytes) {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    this.db
      .prepare('INSERT OR IGNORE INTO blob(sha256, size, bytes, created_at) VALUES (?,?,?,?)')
      .run(sha, buf.length, buf, Date.now());
    return { sha256: sha, size: buf.length };
  }

  getBlob(sha256) {
    const row = this.db.prepare('SELECT sha256, size, bytes FROM blob WHERE sha256 = ?').get(sha256);
    if (row === undefined) return null;
    return {
      sha256: row.sha256,
      size: Number(row.size),
      bytes: Buffer.isBuffer(row.bytes) ? row.bytes : Buffer.from(row.bytes),
    };
  }

  hasBlob(sha256) {
    return this.db.prepare('SELECT 1 AS ok FROM blob WHERE sha256 = ?').get(sha256) !== undefined;
  }

  countBlobs() {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM blob').get();
    return Number(row.n);
  }

  /** 只读元信息，不拉字节（验收时判断存在性够用）。 */
  statBlob(sha256) {
    const row = this.db.prepare('SELECT sha256, size FROM blob WHERE sha256 = ?').get(sha256);
    return row === undefined ? null : { sha256: row.sha256, size: Number(row.size) };
  }

  /**
   * blob 垃圾回收：删掉「**没有任何 evidence 引用** 且 已过保留期」的 blob。
   *
   * 为什么必须按 evidence 引用判定，而不是"看它有没有出现在事件里"：
   * 事件表是审计流水，会永久保留；用事件当引用源等于永远不回收。
   * `evidence.ref_sha256` 是门禁实算出来的物证哈希（blob 引用在报证据时
   * 由 resolveRef 取字节复算后写入），它是**当前仍被验收依据依赖**的唯一事实来源。
   *
   * 再保守一层：同时认 `evidence_ref = 'blob://sha256:<hex>'` 这种字符串形式。
   * 正常路径两列都会写，但库里被人手工改过 / 老版本数据只有一列时，
   * 单认一列就可能误删一条仍被引用为"待复核物证"的对象 ——
   * 漏删只是占空间，误删不可恢复，所以两边都扫。
   *
   * 幂等：删完再跑一次 deleted 必为 0；被引用的、未到期的永远不删。
   *
   * @param {{now?:number, retentionMs?:number}} [opts]
   * @returns {{enabled:boolean, retention_ms:number, cutoff_at:number, total_before:number,
   *   candidates:number, deleted:number, freed_bytes:number, kept_referenced:number,
   *   kept_fresh:number, remaining:number}}
   */
  gcBlobs(opts = {}) {
    const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
    const retentionMs = Number.isFinite(Number(opts.retentionMs)) && Number(opts.retentionMs) >= 0
      ? Math.floor(Number(opts.retentionMs))
      : DEFAULT_BLOB_RETENTION_MS;
    const cutoff = now - retentionMs;

    // 一个事务、一条 DELETE：候选与删除之间不会有别的写插进来。
    // 即便真的并发插进一条新引用，DELETE 自身的 NOT EXISTS 也会当场保住它。
    return this.tx(() => {
      const totalBefore = this.countBlobs();
      const candidates = this.db
        .prepare(
          `SELECT sha256, size FROM blob b
            WHERE b.created_at <= ?
              AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.ref_sha256 = b.sha256)
              AND NOT EXISTS (
                SELECT 1 FROM evidence e2
                 WHERE e2.evidence_ref = 'blob://sha256:' || b.sha256
              )`,
        )
        .all(cutoff);
      const del = this.db.prepare(
        `DELETE FROM blob
          WHERE sha256 = ?
            AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.ref_sha256 = ?)
            AND NOT EXISTS (
              SELECT 1 FROM evidence e2 WHERE e2.evidence_ref = 'blob://sha256:' || ?
            )`,
      );
      let deleted = 0;
      let freedBytes = 0;
      for (const c of candidates) {
        const info = del.run(c.sha256, c.sha256, c.sha256);
        if (Number(info.changes) > 0) {
          deleted += 1;
          freedBytes += Number(c.size ?? 0);
        }
      }
      const keptReferencedRow = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM blob b
            WHERE b.created_at <= ?
              AND (
                EXISTS (SELECT 1 FROM evidence e WHERE e.ref_sha256 = b.sha256)
                OR EXISTS (
                  SELECT 1 FROM evidence e2 WHERE e2.evidence_ref = 'blob://sha256:' || b.sha256
                )
              )`,
        )
        .get(cutoff);
      const keptFreshRow = this.db
        .prepare('SELECT COUNT(*) AS n FROM blob WHERE created_at > ?')
        .get(cutoff);
      return {
        enabled: true,
        retention_ms: retentionMs,
        cutoff_at: cutoff,
        total_before: totalBefore,
        candidates: candidates.length,
        deleted,
        freed_bytes: freedBytes,
        kept_referenced: Number(keptReferencedRow.n),
        kept_fresh: Number(keptFreshRow.n),
        remaining: totalBefore - deleted,
      };
    });
  }

  // ───────────────────── v2：投递回执（ack） ─────────────────────

  insertAck(row) {
    const info = this.db
      .prepare(
        `INSERT INTO ack(task_id, dispatch_id, peer_instance, peer_session, delivered,
           delivery_reason, dispatched_at, deadline_at, timed_out)
         VALUES (?,?,?,?,?,?,?,?,0)`,
      )
      .run(
        row.task_id,
        row.dispatch_id ?? null,
        row.peer_instance,
        row.peer_session,
        row.delivered ? 1 : 0,
        row.delivery_reason ?? null,
        row.dispatched_at,
        row.deadline_at,
      );
    return Number(info.lastInsertRowid);
  }

  /** 找到这个任务上"仍未 ack 且未判超时"的那一行。 */
  findPendingAck(taskId) {
    return this.db
      .prepare('SELECT * FROM ack WHERE task_id = ? AND acked_at IS NULL AND timed_out = 0 ORDER BY ack_id DESC LIMIT 1')
      .get(taskId);
  }

  findAckById(ackId) {
    return this.db.prepare('SELECT * FROM ack WHERE ack_id = ?').get(ackId);
  }

  listAcks(taskId) {
    return this.db.prepare('SELECT * FROM ack WHERE task_id = ? ORDER BY ack_id ASC').all(taskId);
  }

  markAckAcked(ackId, acker, at) {
    const info = this.db
      .prepare('UPDATE ack SET acked_at = ?, acker = ? WHERE ack_id = ? AND acked_at IS NULL')
      .run(at, acker, ackId);
    return Number(info.changes) > 0;
  }

  markAckTimedOut(ackId, at) {
    const info = this.db
      .prepare('UPDATE ack SET timed_out = 1, timed_out_at = ? WHERE ack_id = ? AND acked_at IS NULL AND timed_out = 0')
      .run(at, ackId);
    return Number(info.changes) > 0;
  }

  /** 所有"已过期但仍未 ack、也未判超时"的行 —— 供扫描判定 ack_timeout。 */
  queryExpiredAcks(now) {
    return this.db
      .prepare('SELECT * FROM ack WHERE acked_at IS NULL AND timed_out = 0 AND deadline_at <= ? ORDER BY ack_id ASC')
      .all(now);
  }

  /** 所有"租约已过期但还没标 stale"的任务 —— 供扫描判定 stale。 */
  queryExpiredLeases(now) {
    return this.db
      .prepare(
        `SELECT * FROM task WHERE lease_until IS NOT NULL AND lease_until <= ?
           AND stale = 0 AND lifecycle NOT IN ('done','canceled')`,
      )
      .all(now);
  }

  /**
   * v4：所有"租约**还没到期**、但有身份信息、且尚未标 stale"的任务。
   *
   * 为什么单独一条查询而不是把所有活跃任务都拉出来：这张表在真机上会一直长，
   * 每秒扫全表只为了看几十个活跃租约不值。`lease_pid IS NOT NULL` 直接把
   * 老数据（v3 及以前、无身份）排除掉 —— 老租约只走时间判定，行为不变。
   */
  queryLiveLeases(now) {
    return this.db
      .prepare(
        `SELECT * FROM task WHERE lease_until IS NOT NULL AND lease_until > ?
           AND lease_pid IS NOT NULL AND stale = 0
           AND lifecycle NOT IN ('done','canceled')`,
      )
      .all(now);
  }

  // ───────────────────── v2：收件箱游标 ─────────────────────

  getCursor(instanceId, sessionId) {
    const row = this.db
      .prepare('SELECT last_seq FROM cursor WHERE instance_id = ? AND session_id = ?')
      .get(instanceId, sessionId);
    return row === undefined ? 0 : Number(row.last_seq);
  }

  setCursor(instanceId, sessionId, lastSeq, at) {
    this.db
      .prepare(
        `INSERT INTO cursor(instance_id, session_id, last_seq, updated_at) VALUES (?,?,?,?)
         ON CONFLICT(instance_id, session_id) DO UPDATE SET last_seq = ?, updated_at = ?`,
      )
      .run(instanceId, sessionId, lastSeq, at, lastSeq, at);
    return lastSeq;
  }

  /** seq 大于游标的事件（升序），用于注入摘要。limit 防一次刷太少条撑爆上下文。 */
  queryEventsAfter(afterSeq, limit) {
    return this.db
      .prepare('SELECT * FROM event WHERE seq > ? ORDER BY seq ASC LIMIT ?')
      .all(afterSeq, limit);
  }

  maxEventSeq() {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM event').get();
    return Number(row.m);
  }

}

/** 默认板路径：`$DSH_HOME/team/team.db`。没有 DSH_HOME 时退回用户目录。 */
export function defaultBoardPath() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0
    ? process.env.DSH_HOME
    : path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh');
  return path.join(home, 'team', 'team.db');
}

export { eventPayload };

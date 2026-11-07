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

export const SCHEMA_VERSION = 2;

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
  updated_at    INTEGER NOT NULL
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
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evidence_task ON evidence(task_id, evidence_id);

CREATE TABLE IF NOT EXISTS dispatch (
  dispatch_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       TEXT NOT NULL REFERENCES task(task_id),
  peer_instance TEXT NOT NULL,
  peer_session  TEXT NOT NULL,
  delivered     INTEGER NOT NULL CHECK (delivered IN (0,1)),
  reason        TEXT,
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
           evidence_ref, ref_sha256, ref_size, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
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
      );
    return Number(info.lastInsertRowid);
  }

  queryEvidence(taskId) {
    return this.db.prepare('SELECT * FROM evidence WHERE task_id = ? ORDER BY evidence_id ASC').all(taskId);
  }

  insertDispatch(row) {
    const info = this.db
      .prepare(
        `INSERT INTO dispatch(task_id, peer_instance, peer_session, delivered, reason, created_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(row.task_id, row.peer_instance, row.peer_session, row.delivered ? 1 : 0, row.reason, row.created_at);
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

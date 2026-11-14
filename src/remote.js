/**
 * remote.js — 远端板客户端。**接口与 Board 同名，但方法是异步的。**
 *
 * 为什么可以既同步又异步：本地 Board 是同步的（node:sqlite），远端必须异步。
 * handlers 里对每个板调用都 `await` —— 而 `await` 对普通值同样成立，
 * 于是同一套 handler 同时伺候两种板，不需要把本地路径改成异步、也不动摇 39 条既有用例。
 *
 * 这里有一条**必须守住的安全线**：
 * 客户端只发"意图"，不发"结论"。所以本类没有 `completeAnyway()`、
 * 也没有任何能传哈希或 admissible 的字段 —— 那些只由服务端算。
 * 客户端能做的最大胆的事就是"我说我 pass"，而服务端会自己去核物证。
 *
 * 证据跨机的关键机制（`uploadLocalFile`）：
 *   模型给一个本机路径 → 客户端读出字节 → POST /blob/put → **服务端算 sha256**
 *   → 拿到 `blob://sha256:<hash>` → 用这个引用去报证据。
 * 于是"验收方自己重算哈希"这件事成立，且模型全程没有机会自报哈希。
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

import { processIdentity, TeamError } from './domain.js';
import { blobRef, isBlobRef, parseRef } from './refs.js';

const DEFAULT_TIMEOUT_MS = 10000;

/**
 * v4：本进程的租约身份 —— **调用方进程**的 pid / 进程启动秒 / 主机名。
 *
 * 方向必须搞清楚：RemoteBoard 跑在**调用方机器**上，所以这里要报的是调用方的身份。
 * 板服务是长驻单例，它看不到调用方的 pid；如果让它拿自己的 pid 顶替，板服务一重启
 * 所有在跑的租约就全被判成 PID 复用（见 src/server.js 的 readIdentity 注释）。
 *
 * 为什么在模块加载时只算一次：`start_sec` 是 `Date.now() - uptime*1000` 反推的，
 * 两次调用之间若恰好跨过整秒边界，`Math.floor` 会差 1 —— claim 与 heartbeat 报出
 * 两个不同的 startSec，就会被板服务误判成 PID_REUSED（假阳性）。身份在一个进程的
 * 生命周期内本来就不变，算一次、到处用，既更准也更省。
 */
const PROCESS_LEASE_IDENTITY = Object.freeze(processIdentity());

class BoardHttpError extends TeamError {}

function request(url, opts = {}) {
  const mod = url.protocol === 'https:' ? https : http;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: opts.method ?? 'GET',
        headers: opts.headers ?? {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    // 超时必须显式处理：SSH 隧道断掉时 TCP 可能既不报错也不返回，没有超时就永远卡住。
    req.setTimeout(timeoutMs, () => {
      req.destroy(new TeamError('TIMEOUT', `连板服务超时（${timeoutMs}ms）：${url.origin}`));
    });
    req.on('error', (err) => {
      if (err instanceof TeamError) return reject(err);
      const code = err?.code ?? 'NETWORK';
      reject(
        new TeamError(
          'BOARD_UNREACHABLE',
          `连不上板服务 ${url.origin}（${code}）：${err?.message ?? err}。` +
            '检查板服务是否在跑、隧道是否断开、endpoint 是否写对。',
        ),
      );
    });
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

export class RemoteBoard {
  /**
   * @param {{endpoint:string, token?:string, timeoutMs?:number, actor?:string}} opts
   */
  constructor(opts = {}) {
    const endpoint = String(opts.endpoint ?? '').trim();
    if (endpoint === '') {
      throw new TeamError('INVALID_ENDPOINT', '远端板需要 endpoint（例如 http://127.0.0.1:13090）');
    }
    let parsed;
    try {
      parsed = new URL(endpoint);
    } catch {
      throw new TeamError('INVALID_ENDPOINT', `endpoint 不是合法 URL：${endpoint}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new TeamError('INVALID_ENDPOINT', `endpoint 只支持 http/https：${endpoint}`);
    }
    this.endpoint = endpoint.replace(/\/+$/, '');
    this.base = parsed;
    this.token = opts.token ?? '';
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.dbPath = null; // 远端没有本地库文件
    this.isRemote = true;
  }

  close() {
    /* 无长连接可关；保留方法是为了与 Board 的接口一致 */
  }

  url(p, query) {
    const u = new URL(this.endpoint + p);
    if (query !== undefined) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
      }
    }
    // endpoint 可能带前缀路径；用 URL 拼接保证不丢
    return u;
  }

  headers(extra = {}) {
    const h = { ...extra };
    if (this.token !== '') h['x-team-token'] = this.token;
    return h;
  }

  /**
   * v4：随 claim / heartbeat 上报的**调用方**租约身份。
   *
   * 与板服务 src/server.js 的 `readIdentity(body)` 一一对应：它读 `body.leaseIdentity`
   * 的 `pid` / `start_sec` / `host` 三项，任何一项缺失或类型不对就整条不采信。
   * 所以这里返回的字段名必须与它严格一致（`start_sec` 下划线，不是 `startSec`）。
   *
   * 返回副本而不是共享对象：调用方若改了返回值，不能污染本进程的身份常量。
   * @returns {{pid:number, start_sec:number, host:string|null}}
   */
  leaseIdentity() {
    return { ...PROCESS_LEASE_IDENTITY };
  }

  async call(method, p, { query, body } = {}) {
    const u = this.url(p, query);
    const opts = { method, headers: this.headers(), timeoutMs: this.timeoutMs };
    if (body !== undefined) {
      opts.body = Buffer.from(JSON.stringify(body), 'utf8');
      opts.headers['content-type'] = 'application/json; charset=utf-8';
    }
    const res = await request(u, opts);
    let parsed = null;
    if (res.body.length > 0) {
      try {
        parsed = JSON.parse(res.body.toString('utf8'));
      } catch {
        throw new TeamError(
          'BAD_RESPONSE',
          `板服务返回了非 JSON（HTTP ${res.status}）：${res.body.toString('utf8').slice(0, 200)}`,
        );
      }
    }
    if (res.status >= 200 && res.status < 300 && parsed?.ok === true) return parsed;
    const err = parsed?.error;
    if (err !== undefined && err !== null) {
      throw new BoardHttpError(err.code ?? 'REMOTE_ERROR', err.message ?? `HTTP ${res.status}`, err.detail ?? undefined);
    }
    throw new TeamError('BAD_RESPONSE', `板服务返回 HTTP ${res.status}，没有结构化错误`);
  }

  // ───────────────────────── 任务 ─────────────────────────

  async createTask(input, actor) {
    const r = await this.call('POST', '/task/create', {
      body: {
        title: input.title,
        brief: input.brief,
        acceptance: input.acceptance,
        requestId: input.requestId,
        actor,
      },
    });
    return { task: r.task, deduped: r.deduped === true };
  }

  async getTask(taskId) {
    try {
      const r = await this.call('GET', '/task/get', { query: { taskId } });
      return r.task;
    } catch (err) {
      if (err instanceof TeamError && err.code === 'TASK_NOT_FOUND') return null;
      throw err;
    }
  }

  async listTasks(opts = {}) {
    const r = await this.call('GET', '/task/list', {
      query: { lifecycle: opts.lifecycle, ownerSession: opts.ownerSession, limit: opts.limit },
    });
    return r.tasks;
  }

  async claimTask(taskId, actor, opts = {}) {
    const r = await this.call('POST', '/task/claim', {
      body: {
        taskId,
        actor,
        leaseMs: opts?.leaseMs,
        // v4：让板服务记下**本进程**（调用方）的身份，而不是它自己的 pid。
        leaseIdentity: this.leaseIdentity(),
      },
    });
    return { task: r.task, deduped: r.deduped === true };
  }

  /**
   * 本机文件 → 板上的内容寻址对象。服务端算哈希，客户端只递字节。
   * @returns {Promise<{ref:string, sha256:string, size:number}>}
   */
  async uploadLocalFile(localPath) {
    const abs = path.resolve(localPath);
    let bytes;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) throw new TeamError('REF_NOT_FILE', `不是普通文件：${abs}`);
      bytes = fs.readFileSync(abs);
    } catch (err) {
      if (err instanceof TeamError) throw err;
      throw new TeamError('REF_NOT_FOUND', `本机文件不存在或不可读：${abs}（${err?.code ?? err}）`);
    }
    const u = this.url('/blob/put');
    const res = await request(u, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/octet-stream' }),
      body: bytes,
      timeoutMs: Math.max(this.timeoutMs, 30000),
    });
    let parsed = null;
    try {
      parsed = JSON.parse(res.body.toString('utf8'));
    } catch {
      throw new TeamError('BAD_RESPONSE', `上传物证返回非 JSON（HTTP ${res.status}）`);
    }
    if (res.status !== 200 || parsed?.ok !== true) {
      const e = parsed?.error;
      throw new BoardHttpError(e?.code ?? 'UPLOAD_FAILED', e?.message ?? `上传物证失败 HTTP ${res.status}`);
    }
    return { ref: blobRef(parsed.sha256), sha256: parsed.sha256, size: Number(parsed.size) };
  }

  /**
   * 报证据。若引用是本机路径，**先上传再改写为 blob 引用** —— 这是跨机闭环的核心。
   * 模型仍然只给一个本机路径，不需要知道 blob 协议存在。
   */
  async reportEvidence(taskId, input, actor) {
    let evidenceRef = input.evidenceRef;
    let upload = null;
    if (typeof evidenceRef === 'string' && evidenceRef.trim().length > 0) {
      const parsed = parseRef(evidenceRef);
      if (parsed.kind === 'file' && fs.existsSync(parsed.localPath)) {
        upload = await this.uploadLocalFile(parsed.localPath);
        evidenceRef = upload.ref;
      }
      // 已存在的本机路径 → 上传；不存在的路径保持原样，让服务端判"不存在"并拒绝。
      // 这一步是刻意的：不能因为"上传失败"就把一条不存在的证据变成合格证据。
    }
    const r = await this.call('POST', '/task/report', {
      body: {
        taskId,
        executed: input.executed,
        outcome: input.outcome,
        note: input.note,
        evidenceRef,
        actor,
      },
    });
    r.uploaded = upload;
    return r;
  }

  async listEvidence(taskId) {
    const r = await this.call('GET', '/task/evidence', { query: { taskId } });
    return r.evidence;
  }

  async completeTask(taskId, actor) {
    const r = await this.call('POST', '/task/complete', { body: { taskId, actor } });
    return { task: r.task, gate: r.gate };
  }

  async cancelTask(taskId, actor, reason) {
    const r = await this.call('POST', '/task/cancel', { body: { taskId, actor, reason } });
    return { task: r.task };
  }

  async recordDispatch(taskId, peerInstance, peerSession, result, opts = {}) {
    const r = await this.call('POST', '/dispatch/record', {
      body: {
        taskId,
        peerInstance,
        peerSession,
        result,
        ackTimeoutMs: opts?.ackTimeoutMs,
        createdSession: opts?.createdSession === true,
      },
    });
    return { dispatch_id: r.dispatch_id, ack_id: r.ack_id, ack_state: r.ack_state, ack_deadline_at: r.ack_deadline_at };
  }

  // ──────────────── v3：远端建会话请求（板当信箱） ────────────────

  async createSessionRequest(input) {
    const r = await this.call('POST', '/session-request/create', { body: { ...input } });
    return { request_id: r.request_id, deadline_at: Number(r.deadline_at) };
  }

  async getSessionRequest(requestId) {
    try {
      const r = await this.call('GET', '/session-request/get', { query: { requestId } });
      return r.request ?? null;
    } catch (err) {
      // 不存在的请求号不是错误，是"还没有" —— 轮询路径靠这个区分
      if (err instanceof TeamError && (err.code === 'TASK_NOT_FOUND' || err.code === 'NOT_FOUND')) return null;
      throw err;
    }
  }

  async pendingSessionRequests(targetInstance, limit = 5) {
    const r = await this.call('GET', '/session-request/pending', { query: { targetInstance, limit } });
    return r.requests ?? [];
  }

  async claimSessionRequest(requestId, result) {
    const r = await this.call('POST', '/session-request/claim', {
      body: {
        requestId,
        claimedBy: result?.claimedBy,
        sessionId: result?.sessionId,
        rejectReason: result?.rejectReason,
        rejectMessage: result?.rejectMessage,
      },
    });
    return { claimed: r.claimed === true, request: r.request ?? null };
  }

  async recentEvents(limit = 20, taskId = null) {
    const r = await this.call('GET', '/events', { query: { limit, taskId } });
    return r.events;
  }

  // ───────────────────────── v2：回执 / 心跳 / 收件箱 ─────────────────────────

  async ackTask(taskId, actor) {
    const r = await this.call('POST', '/task/ack', { body: { taskId, actor } });
    return { acked: r.acked === true, deduped: r.deduped === true, ack_state: r.ack_state, latency_ms: r.latency_ms, task: r.task };
  }

  async heartbeat(taskId, actor, opts = {}) {
    const r = await this.call('POST', '/task/heartbeat', {
      body: {
        taskId,
        actor,
        leaseMs: opts?.leaseMs,
        // v4：续租时板服务拿它跟 claim 时记下的 pid/startSec 比对；
        // 对不上就回 PID_REUSED —— 这正是「PID 被系统复用」在 HTTP 路径上的落点。
        leaseIdentity: this.leaseIdentity(),
      },
    });
    return { task: r.task, was_stale: r.was_stale === true };
  }

  /**
   * 0.4：三证据收养。**判定发生在板服务那一侧**（只有板服务所在的主机才可能验 pid），
   * 所以这里不发送"是否允许未验证"这类策略参数 —— 策略由板服务的配置决定，
   * 客户端无法自我授权（与"客户端只发意图、不发结论"是同一条安全线）。
   *
   * 拒绝时板服务回结构化错误（ADOPT_NOT_STALE / ADOPT_HOLDER_ALIVE / ...），
   * call() 会把它变成带 code 与 detail 的 TeamError，detail 里就是三类证据原文。
   */
  async adoptTask(taskId, actor, opts = {}) {
    const r = await this.call('POST', '/task/adopt', {
      body: {
        taskId,
        actor,
        leaseMs: opts?.leaseMs,
        // 收养后新租约的**持有者**是调用方；身份仍按 v4 的规矩由调用方上报。
        leaseIdentity: this.leaseIdentity(),
      },
    });
    return {
      task: r.task,
      adopted: r.adopted === true,
      from: r.from ?? null,
      unverified: r.unverified === true,
      verdict: r.verdict ?? null,
      evidence: r.evidence ?? null,
      policy: r.policy ?? null,
    };
  }

  async listAcks(taskId) {
    const r = await this.call('GET', '/acks', { query: { taskId } });
    return r.acks;
  }

  /** 让服务端把过期 ack/租约扫一遍。注入前调用。 */
  async sweepAll(now) {
    const r = await this.call('POST', '/sweep', { body: now === undefined ? {} : { now } });
    return { ack: r.ack, lease: r.lease };
  }

  async pendingEvents(instanceId, sessionId, limit = 20, sinceSeq) {
    const r = await this.call('GET', '/inbox/pending', {
      query: { instanceId, sessionId, limit, since: sinceSeq },
    });
    return { since_seq: Number(r.since_seq), events: r.events, max_seq: Number(r.max_seq) };
  }

  async getCursor(instanceId, sessionId) {
    const r = await this.call('GET', '/cursor', { query: { instanceId, sessionId } });
    return Number(r.last_seq);
  }

  async advanceCursor(instanceId, sessionId, lastSeq) {
    const r = await this.call('POST', '/cursor', { body: { instanceId, sessionId, lastSeq } });
    return Number(r.last_seq);
  }

  async appendEvent(kind, taskId, actor, payload) {
    // 审计事件由服务端在各自操作里写；客户端不允许凭空插事件（会被伪造审计）。
    // 这里显式拒绝，而不是静默丢弃 —— 静默丢弃会让人以为记上了。
    throw new TeamError(
      'REMOTE_AUDIT_READONLY',
      '远端模式下不能由客户端写审计事件（审计由板服务在操作内部生成）',
    );
  }

  async ping() {
    return this.call('GET', '/health');
  }

  /** 自检：能不能连上、有没有密钥。启动时调用一次，把问题暴露在这一步。 */
  async health() {
    const u = this.url('/health');
    const res = await request(u, { method: 'GET', headers: this.headers(), timeoutMs: this.timeoutMs });
    if (res.status !== 200) {
      throw new TeamError('BOARD_UNHEALTHY', `板服务 /health 返回 HTTP ${res.status}`);
    }
    return JSON.parse(res.body.toString('utf8'));
  }
}

/** 是否是远端板实例（handler 用它决定要不要做上传动作）。 */
export function isRemoteBoard(board) {
  return board !== null && board !== undefined && board.isRemote === true;
}

export { isBlobRef };

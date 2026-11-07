/**
 * server.js — 板服务（HTTP）。一台主机跑，多台设备连它，于是"一块板"变成真的。
 *
 * 设计取舍，逐条说明为什么不是别的做法：
 *
 * 1. **所有判定在服务端做。** 客户端只能发意图（"我要认领"、"我报这条证据"），
 *    不能发结果（"我完成了"、"这哈希是多少"）。所以 HTTP 接口里没有
 *    `complete = true` 这种字段 —— 只有 `POST /complete`，由服务端在它自己的
 *    写事务里跑门禁。客户端无法绕过，也无法改判定。
 *
 * 2. **零依赖（只用 node:http）。** 这个插件要装进别人的 DSH profile，
 *    多一个运行时依赖就多一次版本冲突的机会。原型阶段不值得。
 *
 * 3. **鉴权走共享密钥 + 常量时间比较。** 隧道已经是加密通道，但同机其他进程
 *    也能连 127.0.0.1，所以还是要有密钥。没配密钥就**拒绝写操作**（fail-closed），
 *    而不是默默放开 —— "默认不安全"是最难发现的那种不安全事故。
 *
 * 4. **错误必须可诊断。** 客户端拿到的是结构化错误 `{code, message}`，
 *    code 直接沿用 TeamError 的码（GATE_REJECTED / TASK_NOT_FOUND / ...），
 *    这样远端失败与本地失败对模型是同一套说法，行为不会因为"跨了网"就变模糊。
 */
import crypto from 'node:crypto';
import http from 'node:http';

import { TeamError } from './domain.js';
import { Board } from './store.js';

export const BOARD_SERVICE_VERSION = '1.0.0';

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB：证据说明 + 元信息够用，blob 走单独的二进制接口
const MAX_BLOB_BYTES = 64 * 1024 * 1024; // 64 MiB：单条证据产物上限，超过让用户压缩或换引用

/** 常量时间比较，避免用 === 比密钥泄漏长度差异时序。 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendErr(res, err) {
  if (err instanceof TeamError) {
    const status = err.code === 'TASK_NOT_FOUND' ? 404
      : err.code === 'GATE_REJECTED' ? 409
      : err.code === 'CONFLICT' ? 409
      : err.code === 'ALREADY_CLAIMED' ? 409
      : err.code === 'TASK_CLOSED' ? 409
      : err.code === 'UNAUTHORIZED' ? 401
      : 400;
    sendJson(res, status, {
      ok: false,
      error: { code: err.code, message: err.message, detail: err.detail ?? null },
    });
    return;
  }
  sendJson(res, 500, {
    ok: false,
    error: { code: 'INTERNAL', message: String(err?.message ?? err) },
  });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > limit) {
        reject(new TeamError('BODY_TOO_LARGE', `请求体超过 ${limit} 字节`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req, MAX_BODY_BYTES);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new TeamError('INVALID_JSON', '请求体不是合法 JSON');
  }
}

/**
 * 路由表。每条都是 `方法 路径 → 处理函数(ctx, params, body)`。
 * 处理函数只做参数搬运，判定一律落在 Board 上（Board 内部再落 domain）。
 */
function makeRoutes(board) {
  return {
    'GET /health': () => ({
      ok: true,
      service: 'dsh-team-mesh board',
      version: BOARD_SERVICE_VERSION,
      schema_version: 1,
      board: board.dbPath ?? null,
      blobs: board.backend.countBlobs ? board.backend.countBlobs() : null,
    }),

    'POST /task/create': (_ctx, _p, body) => {
      const res = board.createTask(
        {
          title: body.title,
          brief: body.brief ?? '',
          acceptance: body.acceptance ?? '',
          requestId: body.requestId ?? null,
        },
        body.actor ?? 'unknown',
      );
      return { ok: true, ...res };
    },

    'GET /task/get': (_ctx, params) => {
      const task = board.getTask(params.taskId);
      if (task === null) throw new TeamError('TASK_NOT_FOUND', `任务不存在：${params.taskId}`);
      return { ok: true, task };
    },

    'GET /task/list': (_ctx, params) => ({
      ok: true,
      tasks: board.listTasks({
        lifecycle: params.lifecycle,
        ownerSession: params.ownerSession,
        limit: params.limit,
      }),
    }),

    'POST /task/claim': (_ctx, _p, body) => {
      const res = board.claimTask(body.taskId, body.actor ?? 'unknown', { leaseMs: body.leaseMs });
      return { ok: true, ...res };
    },

    'POST /task/report': (_ctx, _p, body) => {
      const res = board.reportEvidence(
        body.taskId,
        {
          executed: body.executed,
          outcome: body.outcome,
          note: body.note,
          evidenceRef: body.evidenceRef,
        },
        body.actor ?? 'unknown',
      );
      return { ok: true, ...res };
    },

    'GET /task/evidence': (_ctx, params) => ({
      ok: true,
      evidence: board.listEvidence(params.taskId),
    }),

    'POST /task/complete': (_ctx, _p, body) => {
      const res = board.completeTask(body.taskId, body.actor ?? 'unknown');
      return { ok: true, ...res };
    },

    'POST /task/cancel': (_ctx, _p, body) => {
      const res = board.cancelTask(body.taskId, body.actor ?? 'unknown', body.reason ?? '');
      return { ok: true, ...res };
    },

    // ── v2：回执 / 心跳续租 / 收件箱游标 ──
    'POST /task/ack': (_ctx, _p, body) => {
      const res = board.ackTask(body.taskId, body.actor ?? 'unknown');
      return { ok: true, ...res };
    },

    'POST /task/heartbeat': (_ctx, _p, body) => {
      const res = board.heartbeat(body.taskId, body.actor ?? 'unknown', { leaseMs: body.leaseMs });
      return { ok: true, ...res };
    },

    'GET /acks': (_ctx, params) => ({
      ok: true,
      acks: board.listAcks(params.taskId),
    }),

    /** 扫描过期 ack / 租约。客户端在注入前调一次，保证看到的是最新真相。 */
    'POST /sweep': (_ctx, _p, body) => {
      const res = board.sweepAll(body?.now === undefined ? Date.now() : Number(body.now));
      return { ok: true, ...res };
    },

    'GET /inbox/pending': (_ctx, params) => {
      const res = board.pendingEvents(
        String(params.instanceId ?? 'unknown'),
        String(params.sessionId ?? 'unknown'),
        params.limit === undefined ? 20 : Number(params.limit),
        // 收件箱翻页时用 since 覆盖游标起点；不传则按存储游标
        params.since === undefined || params.since === '' ? undefined : Number(params.since),
      );
      return { ok: true, ...res };
    },

    'GET /cursor': (_ctx, params) => {
      const lastSeq = board.getCursor(String(params.instanceId ?? 'unknown'), String(params.sessionId ?? 'unknown'));
      return { ok: true, last_seq: lastSeq };
    },

    'POST /cursor': (_ctx, _p, body) => {
      const seq = board.advanceCursor(
        String(body.instanceId ?? 'unknown'),
        String(body.sessionId ?? 'unknown'),
        Number(body.lastSeq ?? 0),
      );
      return { ok: true, last_seq: seq };
    },

    'POST /dispatch/record': (_ctx, _p, body) => {
      const res = board.recordDispatch(body.taskId, body.peerInstance, body.peerSession, body.result ?? {}, {
        ackTimeoutMs: body.ackTimeoutMs,
        createdSession: body.createdSession === true,
      });
      // 必须把 ack 字段原样带回来：远端板模式下 handlers 靠 ack_state / ack_deadline_at
      // 决定显示"等待回执 / 送到了没人管"，少带一个就会显示 undefined / NaN。
      return { ok: true, ...res };
    },

    // ── v3：远端建会话请求（板当信箱） ──
    'POST /session-request/create': (_ctx, _p, body) => {
      const res = board.createSessionRequest({
        targetInstance: body.targetInstance,
        requesterInstance: body.requesterInstance,
        requesterSession: body.requesterSession,
        cwd: body.cwd,
        title: body.title,
        agentPreset: body.agentPreset,
        prompt: body.prompt,
        ttlMs: body.ttlMs,
      });
      return { ok: true, ...res };
    },

    'GET /session-request/get': (_ctx, params) => ({
      ok: true,
      request: board.getSessionRequest(String(params.requestId ?? '')),
    }),

    'GET /session-request/pending': (_ctx, params) => ({
      ok: true,
      requests: board.pendingSessionRequests(String(params.targetInstance ?? ''), params.limit === undefined ? 5 : Number(params.limit)),
    }),

    'POST /session-request/claim': (_ctx, _p, body) => {
      const res = board.claimSessionRequest(body.requestId, {
        claimedBy: body.claimedBy,
        sessionId: body.sessionId,
        rejectReason: body.rejectReason,
        rejectMessage: body.rejectMessage,
      });
      return { ok: true, ...res };
    },

    'GET /events': (_ctx, params) => ({
      ok: true,
      events: board.recentEvents(params.limit ?? 20, params.taskId ?? null),
    }),
  };
}

/** 哪些路由需要密钥。/health 是探活，不需要；其余全要。 */
function needsAuth(method, pathname) {
  if (method === 'GET' && pathname === '/health') return false;
  return true;
}

/**
 * 启动板服务。
 * @param {{boardPath?:string, host?:string, port?:number, token?:string, board?:Board, logger?:object}} opts
 */
export async function startBoardService(opts = {}) {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 13090;
  const token = opts.token ?? process.env.DSH_TEAM_BOARD_TOKEN ?? '';
  const board = opts.board ?? new Board(opts.boardPath);
  const routes = makeRoutes(board);
  const log = opts.logger ?? console;

  if (token === '') {
    // fail-closed：没有密钥就只允许本机只读探活，写操作一律 401。
    // 这不是"宽容模式"，是明确留一条可诊断的路径：客户端会收到 UNAUTHORIZED 并知道要配密钥。
    log.warn?.('[board] 未设置 DSH_TEAM_BOARD_TOKEN：所有写操作将被拒绝（fail-closed）');
  }

  const server = http.createServer(async (req, res) => {
    let pathname = '/';
    let params = {};
    try {
      const url = new URL(req.url ?? '/', `http://${host}:${port}`);
      pathname = url.pathname.replace(/\/+$/, '') || '/';
      params = Object.fromEntries(url.searchParams.entries());
      const method = req.method ?? 'GET';

      // ── blob 上传/下载单独处理：走二进制，不走 JSON ──
      if (pathname === '/blob/put' && method === 'POST') {
        if (needsAuth(method, pathname)) requireAuth(req, token);
        const bytes = await readBody(req, MAX_BLOB_BYTES);
        if (bytes.length === 0) throw new TeamError('INVALID_INPUT', 'blob 内容为空');
        // key 由服务端算：客户端只给字节，无法指定哈希
        const out = board.backend.putBlob(bytes);
        return sendJson(res, 200, { ok: true, ...out });
      }
      if (pathname === '/blob/get' && method === 'GET') {
        if (needsAuth(method, pathname)) requireAuth(req, token);
        const sha = String(params.sha256 ?? '');
        const got = board.backend.getBlob(sha);
        if (got === null) throw new TeamError('BLOB_NOT_FOUND', `板上没有这个对象：${sha}`);
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(got.size),
          'x-blob-sha256': got.sha256,
          'cache-control': 'no-store',
        });
        return res.end(got.bytes);
      }
      if (pathname === '/blob/stat' && method === 'GET') {
        if (needsAuth(method, pathname)) requireAuth(req, token);
        const sha = String(params.sha256 ?? '');
        const st = board.backend.statBlob(sha);
        if (st === null) throw new TeamError('BLOB_NOT_FOUND', `板上没有这个对象：${sha}`);
        return sendJson(res, 200, { ok: true, ...st });
      }

      const handler = routes[`${method} ${pathname}`];
      if (handler === undefined) {
        return sendJson(res, 404, {
          ok: false,
          error: { code: 'NO_ROUTE', message: `没有这个接口：${method} ${pathname}` },
        });
      }
      if (needsAuth(method, pathname)) requireAuth(req, token);
      const body = method === 'POST' ? await readJson(req) : {};
      const out = handler({}, params, body);
      return sendJson(res, 200, out);
    } catch (err) {
      return sendErr(res, err);
    }
  });

  function requireAuth(req, expected) {
    if (expected === '') {
      throw new TeamError('UNAUTHORIZED', '板服务端没有配置 DSH_TEAM_BOARD_TOKEN，写操作一律拒绝（fail-closed）');
    }
    const got = req.headers['x-team-token'];
    if (typeof got !== 'string' || !safeEqual(got, expected)) {
      throw new TeamError('UNAUTHORIZED', '共享密钥不匹配（检查客户端的 boardToken）');
    }
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  return {
    server,
    board,
    port: typeof addr === 'object' && addr !== null ? addr.port : port,
    host,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      board.close();
    },
  };
}

// ─────────────────────────── CLI 入口 ───────────────────────────
// 直接 `node src/server.js` 就是起服务（README 里的启动命令）。
const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;

if (isMain) {
  const port = Number(process.env.DSH_TEAM_BOARD_PORT ?? '13090');
  const host = process.env.DSH_TEAM_BOARD_HOST ?? '127.0.0.1';
  startBoardService({ boardPath: process.env.DSH_TEAM_BOARD_DB, host, port })
    .then((svc) => {
      console.log(`[board] listening on http://${svc.host}:${svc.port}`);
      console.log(`[board] db = ${svc.board.dbPath}`);
      console.log(`[board] auth = ${process.env.DSH_TEAM_BOARD_TOKEN ? 'token 已配置' : '未配置（写操作会被拒绝）'}`);
    })
    .catch((err) => {
      console.error(`[board] 启动失败：${err?.message ?? err}`);
      process.exitCode = 1;
    });
}

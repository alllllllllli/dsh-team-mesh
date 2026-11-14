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
  /** 进程内 sweep 的自证状态。挂到 /health 上，让「定时器到底跑没跑」可被外部观测。 */
  const sweepState = {
    enabled: false,
    interval_ms: null,
    runs: 0,
    failures: 0,
    last_run_at: null,
    last_ok_at: null,
    last_error: null,
    last_result: null,
  };

  const routes = {
    'GET /health': () => {
      // `schema_version` 必须是**从库里读出来的真值**，不能是字面量。
      //
      // 修复的缺陷：这里原来写死 `schema_version: 1`，而库里的真实值是 4。
      // 后果不是"少了个字段"，而是**假判据** —— 任何人想用 /health 确认板服务
      // 加载了哪一版代码（含 schema 迁移是否跑过），都会被这个 1 误导。
      //
      // 读不到时返回 `null` + `schema_version_error`，**绝不回退成 1**：
      // fallback 成字面量等于把假判据换个写法保留，仍然会说谎。
      // `null` 让调用方一眼看出"不知道"，这正是我们想要的可诊断性。
      //
      // 注意语义边界：上面那个 `version` 是**板服务的 HTTP 契约版本**
      //（BOARD_SERVICE_VERSION），跟数据库 schema 无关，这次不动它。
      const schema = board.schemaVersion();
      return {
        ok: true,
        service: 'dsh-team-mesh board',
        version: BOARD_SERVICE_VERSION,
        schema_version: schema.version,
        schema_version_error: schema.error,
        board: board.dbPath ?? null,
        blobs: board.backend.countBlobs ? board.backend.countBlobs() : null,
        // P0-1 观测点：不改数据库、不加路由，只把内存里的计数器读出来。
        // 有它就能证明「定时 sweep 真的在跑」，而不是只能相信代码里有个 setInterval。
        sweep: { ...sweepState },
      };
    },

    'POST /task/create': (_ctx, _p, body) => {
      const res = board.createTask(
        {
          title: body.title,
          brief: body.brief ?? '',
          acceptance: body.acceptance ?? '',
          requestId: body.requestId ?? null,
          // v4：可选，缺省 false（老调用方不传 → 行为不变）
          requireIndependentReview: body.requireIndependentReview === true,
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
      const res = board.claimTask(body.taskId, body.actor ?? 'unknown', {
        leaseMs: body.leaseMs,
        // v4：租约身份。**必须由客户端报自己的 pid**，不能用板服务的 pid ——
        // 板服务是长驻单例，它一重启就会把所有在跑的租约误判成 PID 复用。
        // 客户端没报（当前 remote.js 就是这样，本次冻结不动它）→ null = 不知道，
        // 板服务如实记 NULL，所有校验跳过，行为与 v3 完全一致。
        identity: readIdentity(body),
      });
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
          // v4：结构化复核字段（全部可选，不传即 NULL，老行为不变）
          verifiedBy: body.verifiedBy,
          verifiedAt: body.verifiedAt,
          acceptanceRef: body.acceptanceRef,
          verificationMethod: body.verificationMethod,
        },
        body.actor ?? 'unknown',
      );
      return { ok: true, ...res };
    },

    /** v4：开关某任务的「独立复核」门禁。默认关闭，逐任务打开。 */
    'POST /task/review-policy': (_ctx, _p, body) => {
      const res = board.setIndependentReview(
        body.taskId,
        body.requireIndependentReview === true,
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
      const res = board.heartbeat(body.taskId, body.actor ?? 'unknown', {
        leaseMs: body.leaseMs,
        // v4：同上，身份由客户端报；没报就是 null（不知道）→ 不校验
        identity: readIdentity(body),
      });
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

  return { routes, sweepState };
}

/**
 * 只读路由白名单（P0-2）。
 *
 * 只有「读数据、不改任何状态」的 GET 才允许进这张表。判据是**能不能改库**，
 * 不是「像不像查询」：
 * - `GET /health` 探活，天然公开（启动自检靠它，不能要求先有密钥）。
 * - `GET /cursor` 读游标是只读；`POST /cursor` 前移游标是写，所以不在表里。
 * - `GET /inbox/pending` 只读事件、**不前移游标**（前移是单独的 POST），故可入表。
 * - `GET /blob/get` / `GET /blob/stat` 读内容寻址对象，只读。
 *
 * 任何新加的 POST 一律不在表里 —— 漏写只会更严，不会更松。
 */
/**
 * v4：从请求体里读「调用方的租约身份」。
 *
 * 为什么身份必须由**调用方**报，不能由板服务自己填：板服务是长驻单例，
 * claim/heartbeat 是代客户端执行的。如果板服务把自己的 pid 记成持有者，
 * 那么板服务一重启，所有正在跑的租约的 pid 就都对不上了，客户端心跳会被
 * 一律判成 PID_REUSED —— 一个重启就让整个集群的租约全部失效。
 *
 * 返回：
 *   null  —— 客户端没报、或报得不完整。**这是当前 remote.js 的实际情形**
 *            （本次冻结不动它），于是板服务如实记 NULL，所有校验跳过，
 *            行为与 v3 逐字节一致。
 *   对象  —— 客户端报了 pid + start_sec + host 三项，逐项校验后才采信。
 *
 * 校验从严：任何一项缺失或类型不对，整条身份都不采信（退化为 null）。
 * 半个身份比没有身份更危险 —— 拿 pid 却不知道是哪台机器的 pid，会把跨机器租约误判。
 */
function readIdentity(body) {
  const raw = body?.leaseIdentity;
  if (raw === null || raw === undefined || typeof raw !== 'object') return null;
  const pid = Number(raw.pid);
  const startSec = Number(raw.start_sec ?? raw.startSec);
  const host = raw.host === null || raw.host === undefined ? null : String(raw.host);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (!Number.isInteger(startSec) || startSec <= 0) return null;
  if (host === null || host.length === 0) return null;
  return { pid, start_sec: startSec, host };
}

const READ_ONLY_ROUTES = new Set([
  'GET /health',
  'GET /task/list',
  'GET /task/get',
  'GET /task/evidence',
  'GET /acks',
  'GET /events',
  'GET /inbox/pending',
  'GET /cursor',
  'GET /session-request/get',
  'GET /session-request/pending',
  'GET /blob/get',
  'GET /blob/stat',
]);

/**
 * 这条请求需要哪一级密钥。
 *
 * 返回 `'none' | 'read' | 'write'`。调用方据此选择用哪把密钥去比。
 * 分三级而不是布尔，是为了让「写」这个最强权限永远不可能被只读密钥满足 ——
 * 布尔值一旦写成 `if (needAuth && tokenOk)`，只读密钥就能过写路由。
 *
 * @param {string} method HTTP 方法
 * @param {string} pathname 已归一化的路径
 * @returns {'none'|'read'|'write'}
 */
function requiredAuthLevel(method, pathname) {
  const key = `${method} ${pathname}`;
  if (key === 'GET /health') return 'none';
  if (READ_ONLY_ROUTES.has(key)) return 'read';
  return 'write';
}

/** 向后兼容包装：仍返回布尔（是否需要任何密钥）。新代码请用 requiredAuthLevel。 */
function needsAuth(method, pathname) {
  return requiredAuthLevel(method, pathname) !== 'none';
}

/**
 * 启动板服务。
 * @param {{boardPath?:string, host?:string, port?:number, token?:string, board?:Board, logger?:object}} opts
 */
export async function startBoardService(opts = {}) {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 13090;
  // 写密钥：能读能写。沿用旧变量名，旧部署一行不改就能跑。
  const writeToken = opts.token ?? process.env.DSH_TEAM_BOARD_TOKEN ?? '';
  // 只读密钥：只能读。**没配就退化为写密钥** —— 这样默认部署的权限模型与改造前完全等价，
  // 不会因为这次升级就把现网读请求打成 401（向后兼容优先于「默认更严」）。
  const readToken = opts.readToken ?? process.env.DSH_TEAM_BOARD_READ_TOKEN ?? writeToken;
  const token = writeToken; // 兼容旧引用
  const board = opts.board ?? new Board(opts.boardPath);
  const { routes, sweepState } = makeRoutes(board);
  const log = opts.logger ?? console;

  if (writeToken === '') {
    // fail-closed：没有密钥就只允许本机只读探活，写操作一律 401。
    // 这不是"宽容模式"，是明确留一条可诊断的路径：客户端会收到 UNAUTHORIZED 并知道要配密钥。
    log.warn?.('[board] 未设置 DSH_TEAM_BOARD_TOKEN：所有写操作将被拒绝（fail-closed）');
  }
  if (writeToken !== '' && readToken === writeToken) {
    // 明确告知：只读密钥没单独配，此时「分级」是逻辑上存在、实际等价于单密钥。
    log.info?.('[board] 未设置 DSH_TEAM_BOARD_READ_TOKEN：只读密钥退化为写密钥（权限模型与旧版等价）');
  }

  /**
   * 需要时按级别校验。路由不认识时按 `write` 处理 —— 未知路径也不该被白嫖。
   * @param {import('node:http').IncomingMessage} req
   * @param {string} method
   * @param {string} pathname
   */
  function requireAuthIfNeeded(req, method, pathname) {
    const level = requiredAuthLevel(method, pathname);
    if (level === 'none') return;
    requireAuth(req, level);
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
        requireAuthIfNeeded(req, method, pathname);
        const bytes = await readBody(req, MAX_BLOB_BYTES);
        if (bytes.length === 0) throw new TeamError('INVALID_INPUT', 'blob 内容为空');
        // key 由服务端算：客户端只给字节，无法指定哈希
        const out = board.backend.putBlob(bytes);
        return sendJson(res, 200, { ok: true, ...out });
      }
      if (pathname === '/blob/get' && method === 'GET') {
        requireAuthIfNeeded(req, method, pathname);
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
        requireAuthIfNeeded(req, method, pathname);
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
      requireAuthIfNeeded(req, method, pathname);
      const body = method === 'POST' ? await readJson(req) : {};
      const out = handler({}, params, body);
      return sendJson(res, 200, out);
    } catch (err) {
      return sendErr(res, err);
    }
  });

  /**
   * 按权限级别校验密钥。
   *
   * 两把密钥的语义（**向后兼容是硬要求**：现网只配了写密钥，只读密钥默认等于写密钥）：
   * - `writeToken`：能读能写。旧客户端、DSH 插件全用它，行为与改造前完全一致。
   * - `readToken`：只能读。没配 `DSH_TEAM_BOARD_READ_TOKEN` 时**退化为 writeToken**，
   *   于是「未配置只读密钥」这种默认状态下，权限模型与改造前 100% 等价（不收紧也不放松）。
   *
   * fail-closed 保留：写密钥为空时一切写操作仍 401，绝不因为加了分级就放开写。
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {'read'|'write'} level 这条路由要求的最低权限
   */
  function requireAuth(req, level) {
    const got = req.headers['x-team-token'];
    const gotStr = typeof got === 'string' ? got : '';

    if (level === 'read') {
      // 只读：写密钥或只读密钥任一命中即可（写密钥必然能读）。
      const okWrite = writeToken !== '' && safeEqual(gotStr, writeToken);
      const okRead = readToken !== '' && safeEqual(gotStr, readToken);
      if (okWrite || okRead) return;
      if (writeToken === '' && readToken === '') {
        throw new TeamError('UNAUTHORIZED', '板服务端没有配置任何密钥，只读路由也拒绝（fail-closed）');
      }
      throw new TeamError('UNAUTHORIZED', '密钥不匹配或缺少密钥（只读路由需要 read 或 write 密钥）');
    }

    // 写：**只认写密钥**。只读密钥在这里必然失败 —— 这是分级的意义所在。
    if (writeToken === '') {
      throw new TeamError('UNAUTHORIZED', '板服务端没有配置 DSH_TEAM_BOARD_TOKEN，写操作一律拒绝（fail-closed）');
    }
    if (!safeEqual(gotStr, writeToken)) {
      throw new TeamError('UNAUTHORIZED', '写密钥不匹配（检查客户端的 boardToken）');
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

  // ── P0-1 方案 A：进程内定时 sweep ──
  //
  // 修的问题：`board.sweepAll()` 原来只有 `src/inbox.js:62` 一个调用点，
  // 也就是说「有会话活动时顺带扫一次」。板安静（没人开新轮次）时，
  // 过期租约与 ack 超时永远不会被标出来，板状态长期停在旧样子。
  //
  // 为什么放在服务进程里而不是外部脚本：清扫写的是**这个进程自己持有的**那块库，
  // 同进程调用能复用已有的写事务与串行化，不需要跨进程抢 SQLite 写锁，
  // 也不需要把密钥再复制一份到脚本里。
  //
  // 三条防御，缺一条都不该上线：
  // 1. `unref()`：定时器不阻止进程退出。否则 Ctrl-C / 服务重启会被这个 interval 挂住。
  // 2. `try/catch` 包住每一轮：一次清扫抛异常（库锁、磁盘满）不能杀掉整个板服务 ——
  //    板服务是 20 张真卡的唯一入口，为了清扫把服务搞挂是本末倒置。
  // 3. 重入保护：上一轮还没跑完就不开下一轮。清扫是幂等的，但堆叠会浪费写锁。
  const sweepMs = Number(opts.sweepIntervalMs ?? process.env.DSH_TEAM_BOARD_SWEEP_MS ?? 60000);
  const sweepEnabled = Number.isFinite(sweepMs) && sweepMs > 0 && opts.sweep !== false;
  let sweepTimer = null;
  let sweeping = false;
  sweepState.enabled = sweepEnabled;
  sweepState.interval_ms = sweepEnabled ? sweepMs : null;

  function runSweepOnce() {
    if (sweeping) return;
    sweeping = true;
    sweepState.runs += 1;
    sweepState.last_run_at = Date.now();
    try {
      const res = board.sweepAll(sweepState.last_run_at);
      sweepState.last_ok_at = sweepState.last_run_at;
      sweepState.last_result = {
        ack_timeouts: res?.ack?.count ?? 0,
        lease_stale: res?.lease?.count ?? 0,
        session_request_expired: typeof res?.session_request === 'number' ? res.session_request : null,
      };
    } catch (err) {
      // 清扫失败只记账，不抛出：下一次 tick 会重试，服务照常对外。
      sweepState.failures += 1;
      sweepState.last_error = String(err?.message ?? err);
      try {
        log.warn?.(`[board] 定时 sweep 失败（第 ${sweepState.failures} 次）：${sweepState.last_error}`);
      } catch {
        /* 日志本身失败也不能影响服务 */
      }
    } finally {
      sweeping = false;
    }
  }

  if (sweepEnabled) {
    sweepTimer = setInterval(runSweepOnce, sweepMs);
    if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
    log.info?.(`[board] 定时 sweep 已启用：每 ${sweepMs} ms 扫一次过期租约 / ack 超时 / 过期建会话请求`);
  } else {
    log.warn?.('[board] 定时 sweep 已禁用（DSH_TEAM_BOARD_SWEEP_MS<=0 或 sweep:false）——过期租约需外部触发 POST /sweep');
  }

  return {
    server,
    board,
    sweepState,
    /** 手动跑一轮 sweep（测试与外部触发用，和定时器走同一条路径）。 */
    runSweepOnce,
    port: typeof addr === 'object' && addr !== null ? addr.port : port,
    host,
    async close() {
      if (sweepTimer !== null) clearInterval(sweepTimer);
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
      console.log(`[board] auth = ${process.env.DSH_TEAM_BOARD_TOKEN ? '写密钥已配置' : '未配置（写操作会被拒绝）'}`);
      console.log(
        `[board] read-key = ${process.env.DSH_TEAM_BOARD_READ_TOKEN ? '只读密钥已单独配置' : '未单独配置（只读退化为写密钥，与旧版等价）'}`,
      );

    })
    .catch((err) => {
      console.error(`[board] 启动失败：${err?.message ?? err}`);
      process.exitCode = 1;
    });
}

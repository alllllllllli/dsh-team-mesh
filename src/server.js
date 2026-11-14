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
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { DEFAULT_BLOB_RETENTION_MS } from './backend.js';
import { TeamError } from './domain.js';
import { Board } from './store.js';

export const BOARD_SERVICE_VERSION = '1.0.0';

const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB：证据说明 + 元信息够用，blob 走单独的二进制接口
const MAX_BLOB_BYTES = 64 * 1024 * 1024; // 64 MiB：单条证据产物上限，超过让用户压缩或换引用

/**
 * 限流默认阈值：**600 次 / 60 秒 / 每个调用方**（= 10 次/秒）。
 *
 * 为什么定得这么宽：板服务的正常流量是 GET 轮询（收件箱每步一次）、
 * sweep（60 秒一次）和偶尔的工具调用；一次 DSH 会话一轮最多几个请求。
 * 阈值必须高于"一台机器上多个会话共享同一个 token"的峰值，否则正常的
 * sweep / 轮询会被打成 429，把一次配置升级变成一次事故。
 * 600/min 给同机 20 个会话各留 30 次/分钟，仍能挡住明显的失控循环。
 */
const DEFAULT_RATE_LIMIT = 600;
const DEFAULT_RATE_WINDOW_MS = 60 * 1000;
/** 限流表最多记多少个调用方：只防内存被大量伪造 token 撑爆，正常集群远小于此。 */
const MAX_TRACKED_CALLERS = 4096;

/** 常量时间比较，避免用 === 比密钥泄漏长度差异时序。 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function sendJson(res, status, obj, extraHeaders = null) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  };
  if (extraHeaders !== null) Object.assign(headers, extraHeaders);
  res.writeHead(status, headers);
  res.end(body);
  return status;
}

/** 把错误发回去，并**返回真正的 HTTP 状态码**（审计日志要记它）。 */
function sendErr(res, err) {
  if (err instanceof TeamError) {
    const status = err.code === 'TASK_NOT_FOUND' ? 404
      : err.code === 'GATE_REJECTED' ? 409
      : err.code === 'CONFLICT' ? 409
      : err.code === 'ALREADY_CLAIMED' ? 409
      : err.code === 'TASK_CLOSED' ? 409
      // 0.4：收养拒绝都是"当前状态/证据不允许这次接管"，语义上是冲突而不是参数错
      : typeof err.code === 'string' && err.code.startsWith('ADOPT_') ? 409
      : err.code === 'RATE_LIMITED' ? 429
      : err.code === 'UNAUTHORIZED' ? 401
      : 400;
    const extraHeaders = {};
    if (err.code === 'RATE_LIMITED') {
      // 带上 retry-after：客户端（和人）能据此退避，而不是盲目重试继续打。
      const retryMs = Number(err.detail?.retry_after_ms);
      if (Number.isFinite(retryMs)) extraHeaders['retry-after'] = String(Math.max(1, Math.ceil(retryMs / 1000)));
    }
    return sendJson(res, status, {
      ok: false,
      error: { code: err.code, message: err.message, detail: err.detail ?? null },
    }, extraHeaders);
  }
  return sendJson(res, 500, {
    ok: false,
    error: { code: 'INTERNAL', message: String(err?.message ?? err) },
  });
}

/** 请求方 IP。审计与限流都只用它，不落 token。 */
function clientIp(req) {
  const raw = req.socket?.remoteAddress ?? '';
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

/**
 * 限流的调用方 key：客户端 IP + token 指纹。
 *
 * 为什么用指纹而不是 token 本身：同一台机器上不同密钥的调用方要分开计数，
 * 但内存与日志里不该出现明文密钥。指纹只做"同一个密钥归到同一个桶"，
 * 无法反推出密钥。没有密钥的请求归到 anon 桶（按 IP 区分）。
 */
function callerKey(req) {
  const raw = req.headers['x-team-token'];
  const token = typeof raw === 'string' ? raw : '';
  const fp = token === ''
    ? 'anon'
    : crypto.createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 12);
  return `${clientIp(req)}|${fp}`;
}

/** 本地日期 YYYY-MM-DD：审计文件按天滚动时用本地时间，运维对着日历能直接找。 */
function localDateStamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 配置里常见的"关掉"写法（环境变量是字符串，不能只认布尔）。 */
function isOffValue(v) {
  if (v === undefined || v === null) return false;
  const s = String(v).trim().toLowerCase();
  return s === '0' || s === 'false' || s === 'off' || s === 'no';
}

/**
 * 配置里常见的"打开"写法：`1 / true / yes / on`（trim + 小写），其余一律 false。
 *
 * 为什么要认四种而不是只认 'true'：文档与 CHANGELOG 的示例一直写
 * `DSH_TEAM_BOARD_ALLOW_UNVERIFIED_ADOPT=1`，而 shell / 计划任务里 `=1` 是最常见的写法。
 * 只认一种的后果不是"少一个语法糖"，而是**按文档配置却不生效** —— 两机验证时 verifier
 * 实测抓到的就是这个：`=1` 不放行、`=true` 才放行。配置解析必须和文档同一口径。
 *
 * 与 isOffValue 对称：认不出的一律 false（缺省关闭，fail-closed），不做"非空即真"的猜测。
 */
function isOnValue(v) {
  if (v === undefined || v === null) return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/**
 * 监听地址的安全含义。
 *
 * 板服务**没有 TLS**，只靠共享密钥鉴权。绑定到回环地址时，网络上的攻击面是 0，
 * 跨机由 SSH 隧道负责加密；绑定到 0.0.0.0 等于把"明文密钥 + 全部任务数据"
 * 放到网络上，只有确认流量走加密隧道/受信内网时才可接受。
 * /health 与启动日志共用这一句话，避免两处说法不一致。
 */
function listenSecurity(host) {
  const h = String(host ?? '').toLowerCase();
  const loopback = h === 'localhost' || h === '::1' || h === '[::1]' || h === '127.0.0.1' || h.startsWith('127.');
  if (loopback) {
    return {
      exposed: false,
      hint: '仅本机回环可达（推荐）：跨机请用 SSH 隧道/端口转发把板服务端口接到本机回环，不要把明文密钥暴露到网络',
    };
  }
  return {
    exposed: true,
    hint: '对所有网卡可见：板服务没有 TLS、只有共享密钥，务必确认只经加密隧道或受信内网访问；能收窄到 127.0.0.1 就收窄',
  };
}

/** 通用配置读取：参数 > 环境变量 > 默认值（与 server.js 原有配置读取风格一致）。 */
function pickNumber(optsValue, envValue, fallback) {
  const raw = optsValue !== undefined && optsValue !== null && optsValue !== ''
    ? optsValue
    : (envValue !== undefined && envValue !== null && envValue !== '' ? envValue : undefined);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
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
 * 固定窗口限流器（按调用方）。
 *
 * 为什么用固定窗口而不是令牌桶：这里要挡的是"失控的循环 / 误配置把板打满"，
 * 不是要精确整形流量。固定窗口实现 20 行、状态可直接读进 /health，
 * 代价是窗口边界允许短时 2 倍突发 —— 对一个任务板的保护目的完全够用。
 *
 * 关闭方式：enabled=false（DSH_TEAM_BOARD_RATE_LIMIT=0 或 opts.rateLimit=false）。
 */
function createRateLimiter({ enabled, limit, windowMs }) {
  const buckets = new Map(); // callerKey -> {count, start}
  const state = {
    enabled,
    limit: enabled ? limit : null,
    window_ms: windowMs,
    tracked_callers: 0,
    rejected_total: 0,
  };

  function prune(now) {
    if (buckets.size <= 256) return;
    for (const [k, b] of buckets) {
      if (now - b.start >= windowMs) buckets.delete(k);
    }
    // 极端情况（大量伪造密钥轮换）下兜底，防止 Map 无限长。
    while (buckets.size > MAX_TRACKED_CALLERS) {
      const oldest = buckets.keys().next().value;
      if (oldest === undefined) break;
      buckets.delete(oldest);
    }
  }

  return {
    state,
    /**
     * @returns {null | {limit:number, window_ms:number, retry_after_ms:number}}
     *   null 表示放行；对象表示本轮已超限（调用方应回 429）。
     */
    check(key, now = Date.now()) {
      if (!enabled) return null;
      prune(now);
      let b = buckets.get(key);
      if (b === undefined || now - b.start >= windowMs) {
        b = { count: 0, start: now };
        buckets.set(key, b);
      }
      b.count += 1;
      state.tracked_callers = buckets.size;
      if (b.count <= limit) return null;
      state.rejected_total += 1;
      return {
        limit,
        window_ms: windowMs,
        retry_after_ms: Math.max(1, b.start + windowMs - now),
      };
    },
  };
}

/**
 * 落盘审计：把**状态变更类请求**追加成 JSONL，按天滚动。
 *
 * 为什么用同步 append 而不是异步队列：一次请求本来就是毫秒级、单行 < 1KB，
 * 同步写把顺序固定住（审计的价值在于"先后顺序可信"），也不引入"进程退出丢缓冲"的问题。
 * 代价是磁盘慢时会拖慢请求 —— 所以写入失败一律只 warn、绝不影响请求结果；
 * 并且 warn 做了节流（第 1 次 + 每 100 次），避免磁盘满时用日志把请求路径也堵死。
 *
 * 不记录的内容：token、请求体全文（session-request 的 prompt 是用户内容）、
 * blob 字节。只记路由、状态码、耗时、调用方 IP 与少量业务标识。
 */
function createAuditLogger({ dir, logger }) {
  const state = {
    enabled: dir !== null,
    dir: dir ?? null,
    entries: 0,
    failures: 0,
    last_error: null,
    last_write_at: null,
  };
  let dirReady = false;

  function warnFailure(err) {
    state.failures += 1;
    state.last_error = String(err?.message ?? err);
    if (state.failures === 1 || state.failures % 100 === 0) {
      try {
        logger?.warn?.(`[board] 审计日志写入失败（第 ${state.failures} 次，已忽略、不影响请求）：${state.last_error}`);
      } catch {
        /* 日志本身失败也不能影响请求 */
      }
    }
  }

  function append(entry) {
    if (!state.enabled) return;
    const now = Number.isFinite(entry.ts_ms) ? entry.ts_ms : Date.now();
    try {
      if (!dirReady) {
        fs.mkdirSync(dir, { recursive: true });
        dirReady = true;
      }
      const file = path.join(dir, `board-audit-${localDateStamp(now)}.jsonl`);
      fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
      state.entries += 1;
      state.last_write_at = now;
    } catch (err) {
      dirReady = false; // 目录可能刚被修好，下次重试
      warnFailure(err);
    }
  }

  return { state, append };
}

/**
 * 路由表。每条都是 `方法 路径 → 处理函数(ctx, params, body)`。
 * 处理函数只做参数搬运，判定一律落在 Board 上（Board 内部再落 domain）。
 */
function makeRoutes(board, cfg = {}) {
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

  /**
   * blob GC 的观测状态。和 sweepState 分开记：
   * 主清扫（租约/ack）失败与 GC 失败是两种故障，混成一个计数器就查不出是谁坏了。
   */
  const gcState = {
    enabled: cfg.gc?.enabled === true,
    retention_ms: cfg.gc?.enabled === true ? (cfg.gc?.retentionMs ?? DEFAULT_BLOB_RETENTION_MS) : null,
    last_run_at: null,
    last_ok_at: null,
    last_error: null,
    last_result: null,
    deleted_total: 0,
    freed_bytes_total: 0,
    failures: 0,
  };

  /**
   * 跑一轮「主清扫 + blob GC」。
   *
   * POST /sweep 与进程内定时器**必须走同一条路径**：两条路径分叉的后果不是"少删几个 blob"，
   * 而是 /health 的计数器和真实发生的事对不上 —— 观测数据一旦不可信，
   * 后面所有"GC 到底在不在跑"的判断都是假的。所以这里是唯一的 sweep 入口。
   *
   * GC 失败**不把整轮清扫判死**：租约/ack 的清理已经做完了，如实报 gc.error 即可。
   */
  function sweepBoard(now) {
    const main = board.sweepAll(now);
    let gc;
    if (gcState.enabled && typeof board.backend?.gcBlobs === 'function') {
      try {
        gc = board.backend.gcBlobs({ now, retentionMs: gcState.retention_ms });
        gcState.last_run_at = now;
        gcState.last_ok_at = now;
        gcState.last_error = null;
        gcState.last_result = {
          deleted: gc.deleted,
          freed_bytes: gc.freed_bytes,
          kept_referenced: gc.kept_referenced,
          kept_fresh: gc.kept_fresh,
          remaining: gc.remaining,
          retention_ms: gc.retention_ms,
        };
        gcState.deleted_total += Number(gc.deleted ?? 0);
        gcState.freed_bytes_total += Number(gc.freed_bytes ?? 0);
      } catch (err) {
        gcState.failures += 1;
        gcState.last_run_at = now;
        gcState.last_error = String(err?.message ?? err);
        gc = { enabled: true, retention_ms: gcState.retention_ms, deleted: 0, error: gcState.last_error };
        try {
          cfg.logger?.warn?.(`[board] blob GC 失败（不影响本轮其它清扫）：${gcState.last_error}`);
        } catch {
          /* 日志失败不能影响清扫结果 */
        }
      }
    } else {
      gc = {
        enabled: false,
        retention_ms: null,
        deleted: 0,
        kept_referenced: null,
        kept_fresh: null,
        remaining: typeof board.backend?.countBlobs === 'function' ? board.backend.countBlobs() : null,
      };
      gcState.last_run_at = now;
      gcState.last_ok_at = now;
    }
    return { ...main, gc };
  }

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
        // ── 监听地址与安全提示（新增）──
        // 报**实际 bind 出来的地址**（server.address().address），不是配置字符串：
        // 配置 localhost 时实际可能是 127.0.0.1 或 ::1，看真值才知道网络暴露面。
        // hint 与启动日志共用 listenSecurity() 的同一句，避免两处口径不一致。
        listen_host: cfg.listen?.host ?? null,
        listen_port: cfg.listen?.port ?? null,
        listen_host_configured: cfg.listen?.configured_host ?? null,
        listen_exposed: cfg.listen?.exposed ?? null,
        listen_hint: cfg.listen?.hint ?? null,
        // P0-1 观测点：不改数据库、不加路由，只把内存里的计数器读出来。
        // 有它就能证明「定时 sweep 真的在跑」，而不是只能相信代码里有个 setInterval。
        sweep: { ...sweepState },
        gc: { ...gcState },
        audit: { ...(cfg.audit?.state ?? { enabled: false }) },
        rate_limit: { ...(cfg.limiter?.state ?? { enabled: false }) },
        // 0.4：收养策略也做成可观测的 —— "当前板到底允不允许未验证收养"不该靠猜代码
        adoption: {
          allow_unverified: cfg.allowUnverifiedAdoption === true,
        },
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

    /**
     * 0.4：三证据收养。判定在 board 的写事务内完成（server 只搬参数）：
     *   - 判定者身份 = **板服务自己的进程身份**（默认 judgeIdentity）—— 只有板服务
     *     所在的主机才可能用本地 pid 表验证"同机持有者是否已死"。客户端上报的
     *     leaseIdentity 只用于记录**新**持有者，绝不拿来当判定者（否则等于让调用方自证）。
     *   - 是否允许未验证收养只由板服务配置决定（opts/env），请求体里没有这个开关 ——
     *     客户端不能自我授权（与整块板"只发意图、不发结论"的安全线一致）。
     */
    'POST /task/adopt': (_ctx, _p, body) => {
      const res = board.adoptTask(body.taskId, body.actor ?? 'unknown', {
        leaseMs: body.leaseMs,
        identity: readIdentity(body),
        allowUnverifiedAdoption: cfg.allowUnverifiedAdoption === true,
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

    /**
     * 扫描过期 ack / 租约 / 过期建会话请求，并回收无引用的过期 blob。
     * 客户端在注入前调一次，保证看到的是最新真相。
     *
     * 返回体新增 `gc` 段（blob GC 计数）；老字段 ack / lease / session_request 原样保留，
     * 老调用方不认识 `gc` 也不会受影响。
     */
    'POST /sweep': (_ctx, _p, body) => {
      const now = body?.now === undefined ? Date.now() : Number(body.now);
      return { ok: true, ...sweepBoard(now) };
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

  return { routes, sweepState, gcState, sweepBoard };
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
 * blob 相关的三个路由不走 JSON 路由表（二进制 / 独立响应头），但鉴权级别与审计
 * 仍要和普通路由一致。集中在这里，是为了让「这条请求算不算状态变更」只有一个判据。
 */
const BLOB_ROUTES = new Set(['POST /blob/put', 'GET /blob/get', 'GET /blob/stat']);

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
 *
 * 新增配置（全部可省，缺省时行为与改造前一致）：
 *   - host / DSH_TEAM_BOARD_HOST：监听地址，**默认仍是 127.0.0.1**（与改造前一致，
 *     见 README「收窄到 127.0.0.1 的利弊」）。
 *   - blobGc / DSH_TEAM_BOARD_BLOB_GC：true 启用、false 关闭；retention 见下两项。
 *   - blobRetentionMs / DSH_TEAM_BOARD_BLOB_RETENTION_MS：保留期，默认 7 天。
 *   - audit / DSH_TEAM_BOARD_AUDIT：false 关闭落盘审计；auditDir / DSH_TEAM_BOARD_AUDIT_DIR
 *     指定目录（缺省 = 板库同目录下的 audit/）。
 *   - rateLimit / DSH_TEAM_BOARD_RATE_LIMIT、rateLimitWindowMs / DSH_TEAM_BOARD_RATE_WINDOW_MS：
 *     每调用方固定窗口阈值，默认 600 次 / 60000 ms；传 false 或 0 关闭。
 *   - allowUnverifiedAdoption / DSH_TEAM_BOARD_ALLOW_UNVERIFIED_ADOPT：是否放行"身份无法验证"的
 *     三证据收养。**默认 false**（跨机/缺身份一律拒绝）；放行后审计事件里 unverified=true。
 *     环境变量取值接受 `1 / true / yes / on`（trim + 小写），其余一律按关闭处理。
 *
 * @param {{boardPath?:string, host?:string, port?:number, token?:string, board?:Board, logger?:object,
 *   blobGc?:boolean, blobRetentionMs?:number, audit?:boolean, auditDir?:string|null,
 *   rateLimit?:number|false, rateLimitWindowMs?:number, allowUnverifiedAdoption?:boolean}} opts
 */
export async function startBoardService(opts = {}) {
  // 监听地址：**默认值一个字没改**（仍是回环地址）。生产板若显式设置了
  // DSH_TEAM_BOARD_HOST，行为照旧；makeRoutes 里的 /health 会把实际 bind 地址与
  // 安全提示报出来，让"到底暴露没暴露"不再靠猜。
  const host = opts.host ?? process.env.DSH_TEAM_BOARD_HOST ?? '127.0.0.1';
  const port = opts.port ?? 13090;
  // 写密钥：能读能写。沿用旧变量名，旧部署一行不改就能跑。
  const writeToken = opts.token ?? process.env.DSH_TEAM_BOARD_TOKEN ?? '';
  // 只读密钥：只能读。**没配就退化为写密钥** —— 这样默认部署的权限模型与改造前完全等价，
  // 不会因为这次升级就把现网读请求打成 401（向后兼容优先于「默认更严」）。
  const readToken = opts.readToken ?? process.env.DSH_TEAM_BOARD_READ_TOKEN ?? writeToken;
  const token = writeToken; // 兼容旧引用
  const board = opts.board ?? new Board(opts.boardPath);
  const log = opts.logger ?? console;

  // ── blob GC 配置：默认启用、保留 7 天；可关 ──
  const gcDisabled = opts.blobGc === false || isOffValue(process.env.DSH_TEAM_BOARD_BLOB_GC);
  const rawRetention = pickNumber(
    opts.blobRetentionMs,
    process.env.DSH_TEAM_BOARD_BLOB_RETENTION_MS,
    DEFAULT_BLOB_RETENTION_MS,
  );
  // 保留期负数没有意义（等于删全部），按默认值处理而不是照单全收。
  const blobRetentionMs = rawRetention >= 0 ? Math.floor(rawRetention) : DEFAULT_BLOB_RETENTION_MS;
  const gcCfg = { enabled: !gcDisabled, retentionMs: blobRetentionMs };

  // ── 落盘审计配置：默认启用，目录取板库同目录的 audit/ ──
  const auditDisabled = opts.audit === false || isOffValue(process.env.DSH_TEAM_BOARD_AUDIT);
  const auditDirDefault = board.dbPath ? path.join(path.dirname(board.dbPath), 'audit') : null;
  const auditDirRaw = opts.auditDir ?? process.env.DSH_TEAM_BOARD_AUDIT_DIR ?? auditDirDefault;
  const auditDir = auditDisabled || auditDirRaw === null || auditDirRaw === undefined || auditDirRaw === ''
    ? null
    : String(auditDirRaw);
  const auditLogger = createAuditLogger({ dir: auditDir, logger: log });

  // ── 限流配置：默认 600 次 / 60 秒 / 调用方；传 false 或 0 关闭 ──
  const rlDisabled = opts.rateLimit === false || isOffValue(process.env.DSH_TEAM_BOARD_RATE_LIMIT);
  const rlLimitRaw = opts.rateLimit === false
    ? 0
    : pickNumber(
      typeof opts.rateLimit === 'number' ? opts.rateLimit : undefined,
      process.env.DSH_TEAM_BOARD_RATE_LIMIT,
      DEFAULT_RATE_LIMIT,
    );
  const rlWindowMs = pickNumber(
    opts.rateLimitWindowMs,
    process.env.DSH_TEAM_BOARD_RATE_WINDOW_MS,
    DEFAULT_RATE_WINDOW_MS,
  );
  const rlLimit = rlDisabled ? 0 : Math.floor(rlLimitRaw);
  const rateCfg = {
    enabled: !rlDisabled && Number.isFinite(rlLimit) && rlLimit > 0,
    limit: Number.isFinite(rlLimit) && rlLimit > 0 ? rlLimit : 0,
    windowMs: Number.isFinite(rlWindowMs) && rlWindowMs > 0 ? Math.floor(rlWindowMs) : DEFAULT_RATE_WINDOW_MS,
  };
  const limiter = createRateLimiter({ enabled: rateCfg.enabled, limit: rateCfg.limit, windowMs: rateCfg.windowMs });

  // ── 0.4：未验证收养策略 ──
  // 默认关：跨机/身份缺失时，板服务没有资格断言"远端那个进程死了"，只能如实标 unverified。
  // 把"未验证"当"已验证"是这条链路上最危险的失真，所以放行必须由运维显式打开。
  // 取值口径见 isOnValue：`1 / true / yes / on` 都算打开（文档示例写的是 =1）。
  const allowUnverifiedAdoption = opts.allowUnverifiedAdoption === true
    || isOnValue(process.env.DSH_TEAM_BOARD_ALLOW_UNVERIFIED_ADOPT);

  // 监听信息先占位，listen() 成功后填真值；/health 读的是这个可变对象。
  const listenState = { host: null, port: null, configured_host: host, exposed: null, hint: null };
  const { routes, sweepState, gcState, sweepBoard } = makeRoutes(board, {
    listen: listenState,
    gc: gcCfg,
    audit: auditLogger,
    limiter,
    logger: log,
    allowUnverifiedAdoption,
  });

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
    const startedAt = Date.now();
    let pathname = '/';
    let method = 'GET';
    let status = 500;
    let errorCode = null;
    let auditEntry = null;
    try {
      const url = new URL(req.url ?? '/', `http://${host}:${port}`);
      pathname = url.pathname.replace(/\/+$/, '') || '/';
      const params = Object.fromEntries(url.searchParams.entries());
      method = req.method ?? 'GET';
      const routeKey = `${method} ${pathname}`;
      const knownRoute = BLOB_ROUTES.has(routeKey) || routes[routeKey] !== undefined;

      // ── 限流（按调用方）──
      // GET /health 豁免：看门狗靠它判断服务存活，把探活限流掉会把"活着"误报成"死了"。
      if (knownRoute && routeKey !== 'GET /health') {
        const limited = limiter.check(callerKey(req), startedAt);
        if (limited !== null) {
          const err = new TeamError(
            'RATE_LIMITED',
            `调用方请求过于频繁：上限 ${limited.limit} 次 / ${limited.window_ms} ms，请 ${limited.retry_after_ms} ms 后重试`,
          );
          err.detail = limited;
          throw err;
        }
      }

      // ── 审计准备：只对"已知的写路由"落盘 ──
      // 未知路由（扫描器）不记，避免被人乱打路径刷满审计文件。
      if (knownRoute && requiredAuthLevel(method, pathname) === 'write') {
        auditEntry = {
          v: 1,
          ts: new Date(startedAt).toISOString(),
          ts_ms: startedAt,
          method,
          path: pathname,
          level: 'write',
          client_ip: clientIp(req),
          actor: null,
          task_id: null,
          request_id: null,
        };
      }

      // ── blob 上传/下载单独处理：走二进制，不走 JSON ──
      if (pathname === '/blob/put' && method === 'POST') {
        requireAuthIfNeeded(req, method, pathname);
        const bytes = await readBody(req, MAX_BLOB_BYTES);
        if (bytes.length === 0) throw new TeamError('INVALID_INPUT', 'blob 内容为空');
        // key 由服务端算：客户端只给字节，无法指定哈希
        const out = board.backend.putBlob(bytes);
        status = 200;
        return sendJson(res, 200, { ok: true, ...out });
      }
      if (pathname === '/blob/get' && method === 'GET') {
        requireAuthIfNeeded(req, method, pathname);
        const sha = String(params.sha256 ?? '');
        const got = board.backend.getBlob(sha);
        if (got === null) throw new TeamError('BLOB_NOT_FOUND', `板上没有这个对象：${sha}`);
        status = 200;
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
        status = 200;
        return sendJson(res, 200, { ok: true, ...st });
      }

      const handler = routes[routeKey];
      if (handler === undefined) {
        return sendJson(res, 404, {
          ok: false,
          error: { code: 'NO_ROUTE', message: `没有这个接口：${method} ${pathname}` },
        });
      }
      requireAuthIfNeeded(req, method, pathname);
      const body = method === 'POST' ? await readJson(req) : {};
      if (auditEntry !== null) {
        // 只取三个业务标识用于"谁改了哪张卡"的追查；请求体其余内容一律不落盘
        //（session-request 的 prompt 是用户内容，blob 是二进制）。
        auditEntry.actor = typeof body?.actor === 'string' ? body.actor : null;
        auditEntry.task_id = typeof body?.taskId === 'string' ? body.taskId : null;
        auditEntry.request_id = typeof body?.requestId === 'string' ? body.requestId : null;
      }
      const out = handler({}, params, body);
      status = 200;
      return sendJson(res, 200, out);
    } catch (err) {
      errorCode = err instanceof TeamError ? err.code : 'INTERNAL';
      status = sendErr(res, err);
      return undefined;
    } finally {
      // 429 不落盘审计：否则"用限流保护磁盘"就变成"限流自己把磁盘写爆"。
      // 限流拒绝次数在 /health.rate_limit.rejected_total 里可见。
      if (auditEntry !== null && status !== 429) {
        auditEntry.status = status;
        auditEntry.ok = status < 400;
        auditEntry.duration_ms = Date.now() - startedAt;
        auditEntry.error_code = status >= 400 ? (errorCode ?? 'UNKNOWN') : null;
        auditLogger.append(auditEntry);
      }
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
  const boundHost = typeof addr === 'object' && addr !== null ? String(addr.address) : host;
  const boundPort = typeof addr === 'object' && addr !== null ? addr.port : port;
  const security = listenSecurity(boundHost);
  listenState.host = boundHost;
  listenState.port = boundPort;
  listenState.exposed = security.exposed;
  listenState.hint = security.hint;
  if (security.exposed) {
    // 启动时就把风险喊出来：/health 是"可查"，日志是"一定会看到"。
    log.warn?.(`[board] 监听地址 ${boundHost}:${boundPort} ${security.hint}`);
  } else {
    log.info?.(`[board] 监听地址 ${boundHost}:${boundPort}（${security.hint}）`);
  }
  log.info?.(
    gcCfg.enabled
      ? `[board] blob GC 已启用：保留期 ${blobRetentionMs} ms（只删无 evidence 引用且已过期的 blob）`
      : '[board] blob GC 已禁用（DSH_TEAM_BOARD_BLOB_GC=0）—— 无引用 blob 只增不删',
  );
  log.info?.(
    auditLogger.state.enabled
      ? `[board] 落盘审计已启用：${auditLogger.state.dir}（board-audit-YYYY-MM-DD.jsonl，写失败只 warn）`
      : '[board] 落盘审计已禁用（DSH_TEAM_BOARD_AUDIT=0）',
  );
  log.info?.(
    limiter.state.enabled
      ? `[board] 限流已启用：每调用方 ${limiter.state.limit} 次 / ${limiter.state.window_ms} ms（GET /health 不计入）`
      : '[board] 限流已禁用（DSH_TEAM_BOARD_RATE_LIMIT=0）',
  );
  // 收养策略必须开机就说清楚：默认严格时"为什么收养被拒"的答案就在这里
  log.info?.(
    allowUnverifiedAdoption
      ? '[board] 未验证收养已放行（DSH_TEAM_BOARD_ALLOW_UNVERIFIED_ADOPT）：跨机/缺身份的收养会被接受，审计记 unverified=true'
      : '[board] 未验证收养默认拒绝：跨机/缺身份无法验 pid，只能走 claim；确认风险后可设 DSH_TEAM_BOARD_ALLOW_UNVERIFIED_ADOPT=1',
  );

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
      // 与 POST /sweep 走**同一条** sweepBoard 路径：blob GC 不能被定时器漏掉，
      // 否则"进程内定时 sweep"和"外部 sweep"会清出两种不同的板。
      const res = sweepBoard(sweepState.last_run_at);
      sweepState.last_ok_at = sweepState.last_run_at;
      sweepState.last_result = {
        ack_timeouts: res?.ack?.count ?? 0,
        lease_stale: res?.lease?.count ?? 0,
        session_request_expired: typeof res?.session_request === 'number' ? res.session_request : null,
        blob_gc_deleted: typeof res?.gc?.deleted === 'number' ? res.gc.deleted : null,
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
    log.warn?.('[board] 定时 sweep 已禁用（DSH_TEAM_BOARD_SWEEP_MS<=0 或 sweep:false）——过期租约与 blob GC 需外部触发 POST /sweep');
  }

  return {
    server,
    board,
    sweepState,
    gcState,
    auditState: auditLogger.state,
    rateLimitState: limiter.state,
    /** 手动跑一轮 sweep（测试与外部触发用，和定时器走同一条路径）。 */
    runSweepOnce,
    /** 手动跑一轮「主清扫 + blob GC」（不走定时器的测试用）。 */
    sweepBoard,
    port: boundPort,
    host: boundHost,
    listen_host: boundHost,
    listen_host_configured: host,
    listen_exposed: security.exposed,
    listen_hint: security.hint,
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
      console.log(`[board] listen = ${svc.listen_host}:${svc.port}（${svc.listen_hint}）`);
      console.log(
        svc.gcState.enabled
          ? `[board] blob-gc = 启用，保留 ${svc.gcState.retention_ms} ms`
          : '[board] blob-gc = 禁用',
      );
      console.log(`[board] audit = ${svc.auditState.enabled ? svc.auditState.dir : '禁用'}`);
      console.log(
        svc.rateLimitState.enabled
          ? `[board] rate-limit = ${svc.rateLimitState.limit} 次 / ${svc.rateLimitState.window_ms} ms（GET /health 不计入）`
          : '[board] rate-limit = 禁用',
      );
    })
    .catch((err) => {
      console.error(`[board] 启动失败：${err?.message ?? err}`);
      process.exitCode = 1;
    });
}

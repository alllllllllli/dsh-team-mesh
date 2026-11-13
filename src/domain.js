/**
 * domain.js — 全部纯逻辑，不碰磁盘、不碰 DSH、不碰网络。
 *
 * 为什么单独一层：这个原型最容易出错的地方不是 SQLite，也不是 interconnect，
 * 而是"完成"的判定。判定一旦掺进 IO，就只能靠端到端跑一遍才知道对不对，
 * 而端到端要真起两个 DSH 实例。纯函数让判定可以被几十条用例钉死。
 *
 * 判定规则（刻意与 agent-team 那边一致，因为那是踩过坑的结论）：
 *   1. executed / outcome / admissible 三个字段分开存，永不合并成一个"成功"
 *   2. 没有证据 → 不能完成（空义务集不算完成）
 *   3. 只有部分证据可采信 → 按可采信的最后一条判；不可采信的不参与
 *   4. 可采信的 fail 或 unknown → 不能完成
 *   5. admissible 由**代码**算，不由模型自报（模型只能给 executed/outcome/说明）
 *
 * 唯一的外部依赖是 `node:os` 的 hostname()：v4 的租约身份校验需要知道"这台机器是谁"
 * 才能决定要不要验 pid（跨机器 pid 无意义）。它是纯读、无副作用、结果缓存；
 * 而且所有判定函数都接受显式传入的 identity，测试不需要真的读系统。
 */
import os from 'node:os';

export const LIFECYCLES = ['open', 'claimed', 'working', 'blocked', 'done', 'canceled'];
export const OUTCOMES = ['pass', 'fail', 'unknown'];
/** 终态：不能再改，也不能再报证据。 */
export const TERMINAL = new Set(['done', 'canceled']);


export class TeamError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'TeamError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

const MAX_TITLE = 200;
const MAX_BRIEF = 4000;
const MAX_NOTE = 2000;

export function assertNonEmptyString(value, field, maxLen) {
  if (typeof value !== 'string') throw new TeamError('INVALID_FIELD', `${field} 必须是字符串`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new TeamError('INVALID_FIELD', `${field} 不能为空`);
  if (trimmed.length > maxLen) {
    throw new TeamError('INVALID_FIELD', `${field} 过长（${trimmed.length} > ${maxLen}）`);
  }
  return trimmed;
}

export function validateCreateInput(input) {
  if (input === null || typeof input !== 'object') {
    throw new TeamError('INVALID_INPUT', '参数必须是对象');
  }
  const title = assertNonEmptyString(input.title, 'title', MAX_TITLE);
  const brief = input.brief === undefined ? '' : assertNonEmptyString(input.brief, 'brief', MAX_BRIEF);
  const acceptance = input.acceptance === undefined
    ? ''
    : assertNonEmptyString(input.acceptance, 'acceptance', MAX_BRIEF);
  // 幂等键：同一次意图重放不重复建任务
  const requestId = input.requestId === undefined
    ? null
    : assertNonEmptyString(input.requestId, 'requestId', 200);
  return { title, brief, acceptance, requestId };
}

/**
 * 计算一条证据是否可采信。**这是代码的决定，不是模型的**。
 *
 * @param {{executed: unknown, outcome: unknown, evidenceRef: unknown,
 *          refExists: boolean, refKind?: string}} e
 * @returns {{admissible: boolean, reasons: string[]}}
 */
export function decideAdmissibility(e) {
  const reasons = [];
  if (e.executed !== true) reasons.push('未真正执行（executed 不为 true），不能作为证据');
  if (!OUTCOMES.includes(e.outcome)) reasons.push(`outcome 非法：${String(e.outcome)}`);
  const hasRef = typeof e.evidenceRef === 'string' && e.evidenceRef.trim().length > 0;
  // pass 必须有真实物证：哈希由宿主代码算（本地读盘 / 服务端内容寻址），模型无法伪造
  if (e.outcome === 'pass' && !hasRef) reasons.push('判 pass 但没有 evidenceRef（必须指向真实产物）');
  if (e.outcome === 'pass' && hasRef && e.refKind === 'unknown') {
    reasons.push(`evidenceRef 是不受支持的引用形式（只认本机路径、file:// 与 blob://sha256:）：${String(e.evidenceRef)}`);
  }
  if (e.outcome === 'pass' && hasRef && e.refExists !== true && e.refKind !== 'unknown') {
    const what = e.refKind === 'blob' ? '板上没有这个内容寻址对象' : '文件不存在';
    reasons.push(`evidenceRef ${what}：${String(e.evidenceRef)}`);
  }
  return { admissible: reasons.length === 0, reasons };
}

/**
 * 完成门禁。传入该任务的全部证据（按 created_at 升序），返回能否完成与原因。
 *
 * 注意 reasons 里的措辞是给模型看的，必须具体到"缺什么"，不能只说"不通过"。
 */
export function evaluateCompletion(task, evidences) {
  if (task === null || task === undefined) throw new TeamError('TASK_NOT_FOUND', '任务不存在');
  if (TERMINAL.has(task.lifecycle)) {
    return { allowed: false, reasons: [`任务已终结（${task.lifecycle}），不能再次完成`] };
  }
  if (task.lifecycle === 'open') {
    return { allowed: false, reasons: ['任务尚未被认领，不能直接完成'] };
  }

  const usable = evidences.filter((e) => e.admissible === 1);
  if (evidences.length === 0) {
    return { allowed: false, reasons: ['NO_EVIDENCE: 没有任何证据，不能完成'] };
  }
  if (usable.length === 0) {
    return { allowed: false, reasons: ['NO_ADMISSIBLE_EVIDENCE: 有证据但全部不可采信，不能完成'] };
  }

  // 只看最后一条可采信证据：先过后挂不算过，先挂后过算过
  const last = usable[usable.length - 1];
  if (last.outcome === 'fail') {
    return {
      allowed: false,
      reasons: [`LATEST_FAIL: 最后一条可采信证据是失败（#${last.evidence_id}）`],
    };
  }
  if (last.outcome === 'unknown') {
    return {
      allowed: false,
      reasons: [`LATEST_UNKNOWN: 最后一条可采信证据结果未知（#${last.evidence_id}），未知不记过`],
    };
  }

  return { allowed: true, reasons: [] };
}

/**
 * 合法状态迁移（其余一律拒）。
 *
 * `done` 只能从 claimed / working 进入 —— 也就是"有人认领过、并且在门禁里过了"。
 * `open → done` 必须被拒：没人认领就没有负责人，也就没人对结果负责。
 * `blocked → done` 也不给：报来可采信证据时 store 已把它退回 working，
 * 留着这条捷径只会让"受阻未解决"被悄悄标完成。
 */
const TRANSITIONS = {
  open: new Set(['claimed', 'canceled']),
  claimed: new Set(['working', 'open', 'canceled', 'done']),
  working: new Set(['blocked', 'claimed', 'canceled', 'done']),
  blocked: new Set(['working', 'canceled']),
  done: new Set([]),
  canceled: new Set([]),
};

export function assertTransition(from, to) {
  if (!LIFECYCLES.includes(to)) throw new TeamError('INVALID_LIFECYCLE', `非法状态：${to}`);
  if (from === to) return;
  const allowed = TRANSITIONS[from];
  if (allowed === undefined || !allowed.has(to)) {
    throw new TeamError('INVALID_TRANSITION', `不允许从 ${from} 迁移到 ${to}`);
  }
}

/**
 * 任务卡：跨界传递时必须自包含。对方 DSH 会话只能看到这段文字，
 * 看不到我们的库、也看不到调用栈。所以卡里要有：做什么、怎么算完成、怎么回报。
 */
export function formatTaskCard(task, opts = {}) {
  const lines = [];
  lines.push(`【团队任务 ${task.task_id}】${task.title}`);
  if (task.brief.length > 0) {
    lines.push('');
    lines.push(task.brief);
  }
  if (task.acceptance.length > 0) {
    lines.push('');
    lines.push(`验收标准：${task.acceptance}`);
  }
  lines.push('');
  lines.push('完成后请回报：');
  lines.push(`  mesh_task_report({ taskId: "${task.task_id}", executed: true, outcome: "pass",`);
  lines.push('                     note: "做了什么", evidenceRef: "<真实产物的绝对路径>" })');
  lines.push(`  再调 mesh_task_complete({ taskId: "${task.task_id}" })`);
  if (opts.fromInstance !== undefined) {
    lines.push('');
    lines.push(`派发方：${opts.fromInstance}`);
  }
  return lines.join('\n');
}

/** 事件 payload 统一走 JSON，避免把对象塞进 SQLite 时类型漂移。 */
export function eventPayload(obj) {
  return JSON.stringify(obj ?? {});
}

// ─────────────────── v2：派发回执 / 租约的规则与默认值 ───────────────────

/** 默认 ack 超时：60s。可被 dispatch 参数覆盖。 */
export const DEFAULT_ACK_TIMEOUT_MS = 60_000;
/** 默认租约时长：10 分钟。可被 claim 参数覆盖。 */
export const DEFAULT_LEASE_MS = 10 * 60_000;
/** 心跳最大间隔建议值：5 分钟（租约的三分之一留足余量）。 */
export const DEFAULT_HEARTBEAT_MS = 5 * 60_000;

// ─────────────────── v3：远端建会话（newSession） ───────────────────

/**
 * 默认建会话请求的存活时限：60s。
 *
 * 为什么和 ack 超时一样是 60s：这两件事的失败观感相同 —— 派发方发出去了，
 * 对方没反应。60s 足够对方一轮收件箱轮询（默认注入间隔就是每轮），
 * 又不至于让人盯着界面干等。超时后必须能说出"超时"，而不是无限 pending。
 */
export const DEFAULT_SESSION_REQUEST_TTL_MS = 60_000;

/** 建会话请求的生命周期。与 ack_state 分开命名，避免两套语义混在一起看。 */
export const SESSION_REQUEST_STATES = ['pending', 'claimed', 'expired'];

/**
 * 接收端拒绝建会话的原因码。
 *
 * 和 interconnect 的 `resume-refused` / `session-not-live` 同一套风格：
 * **稳定的短码 + 给人看的一句话**，绝不抛裸异常。
 * 派发方要能按码区分"对端没开开关"（该去开）和"对端建失败了"（该换参数）。
 */
export const SESSION_CREATE_REJECT_REASONS = {
  'create-refused': '对端没有开启远端建会话（allowCreate=false），这是默认值',
  'create-unsupported': '对端的 DSH 宿主没有 session/create 能力（没有 sessionController 服务）',
  'create-failed': '对端尝试新建会话但失败了，原因见 message',
  'create-timeout': '对端在时限内没有处理这条建会话请求（可能不在线、或没装支持该功能的版本）',
  'instance-mismatch': '这条请求的目标实例不是本机，不该由我处理',
};

/** 一个短码是否是我们认识的拒绝原因。 */
export function isSessionCreateRejectReason(value) {
  return typeof value === 'string' && Object.hasOwn(SESSION_CREATE_REJECT_REASONS, value);
}

export const ACK_STATES = ['none', 'pending', 'acked', 'timeout'];

/**
 * 投递结果的三种真相，**必须分开显示**：
 *   not-delivered  信没送到（delivered=false，原因在 delivery_reason）
 *   delivered-unacked  信到了，但没人认领（超时后就是这个）
 *   acked          有人接了
 *
 * 把它们合成一个"正常"是最危险的失真 —— 发起方会以为有人在干活。
 */
export function describeDelivery(delivered, ackState, reason) {
  if (delivered !== true) {
    return {
      verdict: 'not-delivered',
      label: '信没送到',
      detail: `投递失败：${reason ?? '未知原因'}`,
    };
  }
  if (ackState === 'acked') return { verdict: 'acked', label: '已回执', detail: '接收端已确认收到' };
  if (ackState === 'timeout') {
    return {
      verdict: 'delivered-unacked',
      label: '送到了没人管',
      detail: '信已投递成功，但在时限内没有任何回执 —— 对方可能没处理，不要当成在做了',
    };
  }
  return { verdict: 'delivered-unacked', label: '等待回执', detail: '信已投递，尚未收到回执' };
}

/**
 * 租约是否还有效。`now` 显式传入，纯函数才好测（不偷偷读时钟）。
 */
export function leaseIsLive(task, now) {
  if (task === null || task === undefined) return false;
  if (typeof task.lease_until !== 'number') return false;
  return task.lease_until > now;
}

/**
 * v4：本进程的租约身份 —— pid + 进程启动时刻（秒）+ 主机名。
 *
 * 为什么要有 startSec：PID 会被系统复用。进程崩掉后，同一个 pid 可能落到
 * 一个完全无关的新进程上；只看 pid 相等就续租，等于把租约交给了一个陌生进程。
 * 进程启动时刻是 pid 之外唯一便宜的区分手段，两者一起才够。
 *
 * startSec 用 `Date.now() - process.uptime()*1000` 反推（Node 没有直接暴露启动时间），
 * 取秒级：毫秒级在同一秒内重启的极端场景下也不可靠，秒级已经足够区分"同一个进程"。
 *
 * @returns {{pid:number, start_sec:number, host:string|null}}
 */
export function processIdentity() {
  const upMs = typeof process.uptime === 'function' ? process.uptime() * 1000 : 0;
  return {
    pid: typeof process.pid === 'number' ? process.pid : 0,
    start_sec: Math.floor((Date.now() - upMs) / 1000),
    host: hostnameOrNull(),
  };
}

let cachedHostname;
function hostnameOrNull() {
  if (cachedHostname !== undefined) return cachedHostname;
  try {
    cachedHostname = os.hostname() || null;
  } catch {
    cachedHostname = null;
  }
  return cachedHostname;
}

/**
 * v4：判断一条租约记录的「持有者身份」是否还属于**当前这个进程**。
 *
 * 三条判定，全部只做**同机**比对：
 *   1. lease_pid 为空 → `{ ok: true, reason: 'no-identity' }`
 *      **老数据（v3 及以前）走这条**：没有身份信息就没有可校验的东西，
 *      一律放行，行为与改前完全一致。这是「新字段可空、老数据零影响」的落点。
 *   2. lease_host 存在且与本机不同 → `{ ok: true, reason: 'other-host' }`
 *      跨机器 pid 无意义（两台机器各有 pid 1，纯属巧合），只认时间，不验 pid。
 *   3. 同机：pid 或 startSec 不符 → `{ ok: false, reason: 'pid-reused' }`
 *
 * @param {object} task 任务行（含 v4 的租约身份字段）
 * @param {{pid:number,start_sec:number,host:string|null}} [identity] 默认取本进程
 * @returns {{ok:boolean, reason:string, detail?:object}}
 */
export function leaseIdentityMatches(task, identity) {
  const me = identity ?? processIdentity();
  if (task === null || task === undefined) return { ok: true, reason: 'no-task' };

  const pid = task.lease_pid === null || task.lease_pid === undefined ? null : Number(task.lease_pid);
  // 老数据：没有 pid 就没有身份可比 —— 放行（零影响）
  if (pid === null) return { ok: true, reason: 'no-identity' };

  const leaseHost = task.lease_host === null || task.lease_host === undefined ? null : String(task.lease_host);
  if (leaseHost !== null && me.host !== null && leaseHost !== me.host) {
    // 跨机器：pid 不可比，只认时间（时间校验在调用方）
    return { ok: true, reason: 'other-host' };
  }

  const startSec = task.lease_start_sec === null || task.lease_start_sec === undefined
    ? null
    : Number(task.lease_start_sec);
  if (pid !== me.pid) {
    return { ok: false, reason: 'pid-reused', detail: { lease_pid: pid, my_pid: me.pid } };
  }
  if (startSec !== null && startSec !== me.start_sec) {
    // 同一个 pid、不同的进程启动时刻 → PID 被系统复用给了别的进程
    return { ok: false, reason: 'pid-reused', detail: { lease_start_sec: startSec, my_start_sec: me.start_sec } };
  }
  return { ok: true, reason: 'same-process' };
}

/**
 * v4：判断一条租约的持有者进程是否**已经死了**（用于"时间还没到也要判 stale"）。
 *
 * 判定规则（与 leaseIdentityMatches 保持同一套边界）：
 *   - 没有 lease_pid（老数据）→ 不判死。没有身份信息就不该凭空判死，只认时间。
 *   - lease_host 与本机不同 → 不判死。**跨机器只认时间**，拿本地 pid 存活表判远端
 *     租约会随机把"远端还活着"判成死了，从而抢走别人的活。这比不做判定更糟。
 *   - 同机且 pid 就是本进程 → 不判死（自己不会杀自己）。
 *   - 同机且 pid 不是本进程 → 交给 isPidAlive 判；不在 = 死了。
 *     如果 startSec 与本进程不符但 pid 号恰好等于本进程 pid，也算"别人"，
 *     因为进程启动时刻不同 —— 那是被复用给我们的一个**旧**记录，不是我们持有的。
 *
 * @param {object} task 任务行
 * @param {{pid:number,start_sec:number,host:string|null}} identity 判定者身份（默认本进程）
 * @param {(pid:number)=>boolean} isPidAlive 注入的存活探测（测试用假实现）
 * @returns {{dead:boolean, reason:string}}
 */
export function leaseHolderIsDead(task, identity, isPidAlive) {
  if (task === null || task === undefined) return { dead: false, reason: 'no-task' };
  const pid = task.lease_pid === null || task.lease_pid === undefined ? null : Number(task.lease_pid);
  if (pid === null) return { dead: false, reason: 'no-identity' };

  const me = identity ?? processIdentity();
  const leaseHost = task.lease_host === null || task.lease_host === undefined ? null : String(task.lease_host);
  if (leaseHost !== null && me.host !== null && leaseHost !== me.host) {
    return { dead: false, reason: 'other-host' };
  }

  const startSec = task.lease_start_sec === null || task.lease_start_sec === undefined
    ? null
    : Number(task.lease_start_sec);
  // 同机且身份完全就是本进程：它活着（就是我）
  if (pid === me.pid && (startSec === null || startSec === me.start_sec)) {
    return { dead: false, reason: 'self' };
  }

  const probe = typeof isPidAlive === 'function' ? isPidAlive : defaultIsPidAlive;
  let alive;
  try {
    alive = probe(pid) === true;
  } catch {
    // 探测本身失败不能当成"死了"——宁可少判，不可误判（误判会抢走别人的活）
    return { dead: false, reason: 'probe-error' };
  }
  if (!alive) return { dead: true, reason: 'holder-pid-gone' };
  // pid 还在，但启动时刻不符：这是被复用的 pid，原持有者已经没了
  if (startSec !== null && pid === me.pid && startSec !== me.start_sec) {
    return { dead: true, reason: 'holder-pid-reused' };
  }
  return { dead: false, reason: 'holder-alive' };
}

/**
 * 默认的 pid 存活探测：`process.kill(pid, 0)` 不发信号，只做权限/存在性检查。
 * EPERM 表示进程存在但属于别人 —— **算活着**（这是最容易写错的一处：
 * 把"没权限杀"当成"已经死了"，会把别人的活抢过来）。
 */
export function defaultIsPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    if (err !== null && typeof err === 'object' && err.code === 'EPERM') return true;
    return false;
  }
}

/**
 * 判断一个任务是否"能被重新认领"。
 * 关键：**stale（租约过期无心跳）才允许被抢**，正常在租期内的不许抢。
 * 这是"它挂了发起方立刻知道"的实现基础。
 */
export function canReclaim(task, now) {
  if (task === null || task === undefined) return { ok: false, why: '任务不存在' };
  if (TERMINAL.has(task.lifecycle)) return { ok: false, why: `任务已终结（${task.lifecycle}）` };
  if (task.owner_session === null || task.owner_session === undefined) return { ok: true, why: '尚无人认领' };
  if (task.stale === 1) return { ok: true, why: '原负责人租约已过期（stale），允许重新认领' };
  if (leaseIsLive(task, now)) {
    return { ok: false, why: `仍由 ${task.owner_session} 持有有效租约（至 ${new Date(task.lease_until).toISOString()}）` };
  }
  return { ok: true, why: '租约已到期，允许重新认领' };
}

/** 收件箱摘要：把事件写成一段人话，条数上限由调用方控制。 */
export function formatInboxDigest(events, opts = {}) {
  if (events.length === 0) return '';
  const lines = [];
  const head = opts.sinceSeq === undefined
    ? `【团队动态】有 ${events.length} 条新事件`
    : `【团队动态】有 ${events.length} 条新事件（seq > ${opts.sinceSeq}）`;
  lines.push(head);
  for (const e of events) {
    const task = e.task_id === null || e.task_id === undefined ? '' : ` ${e.task_id}`;
    lines.push(`  #${e.seq} ${e.kind}${task}`);
  }
  if (opts.tasks !== undefined) {
    for (const t of opts.tasks) {
      lines.push(`  · ${t.task_id} 现在 ${t.lifecycle}${t.stale === 1 ? '（stale，原负责人失联）' : ''}`);
    }
  }
  // 噪声被过滤时要说出来：否则用户会以为"这几轮没动静"，其实是过滤掉了
  if (typeof opts.skipped === 'number' && opts.skipped > 0) {
    lines.push(`  （另有 ${opts.skipped} 条 peer 噪声已过滤；要看用 mesh_events）`);
  }
  lines.push('');
  lines.push('（这是自动注入，不需要你去查。要看全文用 mesh_events；游标已前移到 #' + (opts.nextSeq ?? '?') + '）');
  return lines.join('\n');
}

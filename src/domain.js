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

/**
 * v4：复核方式白名单。
 *
 * 为什么要白名单而不是自由字符串：`verification_method` 存在的意义是让"这条证据
 * 是怎么被验的"变成**可比较的事实**。自由字符串会立刻长出
 * "disk-hash / diskHash / 磁盘哈希 / hash" 四种写法，聚合统计就废了。
 * 三种覆盖现有全部场景：代码自己算的哈希、人工看过的复核、跑过测试。
 */
export const VERIFICATION_METHODS = ['disk-hash', 'manual-review', 'test-run'];

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
  // v4：可选「独立复核」门禁，缺省 false（老调用方不传，行为完全不变）
  const requireIndependentReview = input.requireIndependentReview === true;
  return { title, brief, acceptance, requestId, requireIndependentReview };
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

  // v4：可选的「独立复核」门禁。**默认关闭**（require_independent_review 缺省 0），
  // 老任务走不到这段，行为与 v3 逐字节一致。
  // 打开后要求：最后一条可采信证据有复核人，且复核人**不是**报证据的人。
  // 为什么比的是 evidence.actor 而不是"谁来调 complete"：自验自报的漏洞在**证据本身**，
  // 不在最后点按钮的那个人 —— 换个人点完成并不能让一条自证变独立。
  if (Number(task.require_independent_review ?? 0) === 1) {
    const verifier = typeof last.verified_by === 'string' ? last.verified_by.trim() : '';
    if (verifier.length === 0) {
      return {
        allowed: false,
        reasons: [
          `INDEPENDENT_REVIEW_REQUIRED: 该任务要求独立复核，但最后一条可采信证据（#${last.evidence_id}）没有 verified_by（谁验的）`,
        ],
      };
    }
    if (verifier === String(last.actor ?? '').trim()) {
      return {
        allowed: false,
        reasons: [
          `INDEPENDENT_REVIEW_REQUIRED: 该任务要求独立复核，但证据（#${last.evidence_id}）的复核人就是上报人（${verifier}），属于自验自报`,
        ],
      };
    }
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

// ─────────────────── 0.4：三证据收养（stale 之后"凭什么接手"） ───────────────────

/**
 * 「租约类事件」白名单：只有这些事件能证明**持有者自己**续过租 / 还活着。
 *
 * 为什么必须白名单而不是"kind 里带 lease 就算"：
 *   - `lease.stale` 是**扫描者**写的（宣告租约失效），不是持有者活动；把它算进来，
 *     "过期后没有续租痕迹"这条证据会永远被它自己污染。
 *   - `lease.adopted` 算活动：收养也刷新 lease_until，需求是"这条租约后来被别人正规接管过"。
 *   - `task.claimed` / `lease.taken_over` 是认领轨迹；`lease.renewed` 含 heartbeat 与
 *     claim 去重续租；`lease.revived` 是 stale → live 的复活。
 * 事件 kind 一旦写进库就是审计事实，这里只做**读侧解释**，不改写历史。
 */
export const LEASE_ACTIVITY_EVENT_KINDS = Object.freeze([
  'task.claimed',
  'lease.taken_over',
  'lease.renewed',
  'lease.revived',
  'lease.adopted',
]);

/**
 * 收养的稳定错误码。用对象而不是散落字面量：拒绝码是**对外契约**（模型和脚本按码分流），
 * 写错一个字母就等于把"能自愈的拒绝"变成"看不懂的拒绝"。
 */
export const ADOPT_CODES = Object.freeze({
  NOT_STALE: 'ADOPT_NOT_STALE',
  NOT_CLAIMED: 'ADOPT_NOT_CLAIMED',
  STATE_INVALID: 'ADOPT_STATE_INVALID',
  HOLDER_ALIVE: 'ADOPT_HOLDER_ALIVE',
  EVIDENCE_INSUFFICIENT: 'ADOPT_EVIDENCE_INSUFFICIENT',
  EVIDENCE_UNVERIFIABLE: 'ADOPT_EVIDENCE_UNVERIFIABLE',
});

/**
 * 身份证据"为什么没验成"的人话。这段文案是给模型/人排障用的，必须说清
 * **是能力边界而不是代码缺陷** —— 否则下次还会有人问"为什么不能跨机验 pid"。
 */
function describeUnverifiedIdentity(reason, ev) {
  switch (reason) {
    case 'unverified-cross-host':
      return (
        `租约持有者在主机 ${ev.lease_host}，判定者（板服务）在 ${ev.judge_host}：` +
        '跨机器的 pid 属于两套独立编号空间（两边都有 pid 1，纯属巧合），板服务**不能代替远端机器验 pid**，只能标 unverified'
      );
    case 'unverified-no-identity':
      return '租约记录里没有可比的持有者身份（pid 或主机名为 NULL，多为 v3 及以前的老数据），没有东西可验';
    case 'no-judge-host':
      return '判定者（板服务/本进程）拿不到自己的主机名（os.hostname() 不可用），无法判断"同机"，也就不能用 pid 下结论';
    case 'probe-error':
      return 'pid 存活探测本身失败了（抛错），按"宁可少判、不可误判"处理，不当成已死';
    default:
      return `身份证据未验证（${reason ?? 'unknown'}）`;
  }
}

function adoptionRejected(code, reasons, evidence, policy) {
  return {
    allowed: false,
    code,
    message: `${code}：${reasons.join('；')}`,
    reasons,
    unverified: false,
    verdict: 'rejected',
    evidence: evidence ?? {},
    // 拒绝也要带策略快照：排查时第一个问题就是"是没配放行，还是配了但被别的证据挡住"。
    // 只放在成功响应里，等于让最关键的那次拒绝恰好没有上下文（verifier 实测抓到的缺口）。
    policy: policy ?? { allow_unverified_adoption: false },
  };
}

/**
 * 三证据收养判定（纯函数，不碰 IO/时钟/进程表 —— pid 探测由调用方注入）。
 *
 * 为什么收养比 claim 安全：claim 的判据只有时间（stale / 过期就能抢）。时间只能证明
 * "它没续租"，不能证明"它真的死了"，更不能证明"这段租约没有被别人续过"。收养要求三类
 * 证据同时成立，且**身份证据按能力边界如实降级**：
 *
 *   E1 时间：lease_until 已过期，或已被扫描标记 stale（记 overrun_ms / stale_at）。
 *   E2 身份：只有 `lease_host === 判定者主机` 时才有资格验 pid（跨机验 pid 是伪命题）；
 *            同机 → leaseHolderIsDead（注入 isPidAlive，EPERM 算活着）；
 *            跨机 / 记录缺身份 / 判定者不知道自己在哪 → **一律 unverified**。
 *            unverified 不是"等于死了"，默认拒绝；只有显式 allowUnverifiedAdoption=true
 *            才放行，且 event payload 里 unverified=true 必须如实落地。
 *   E3 事件：审计流里该任务最后一条租约类事件必须早于 lease_until，且过期后没有任何
 *            续租痕迹。这一条防的是"库里的 lease_until 与事件流互相矛盾"（例如有人绕过
 *            正常路径改了时间），仅靠 E1 看 lease_until 是看不出来的。
 *
 * 判定顺序与拒绝码：E1 → E2(活着就拒) → E3 → 未验证策略。顺序刻意固定：
 *   - 持有者明确还活着时，"证据不足/未验证"都是次要信息，先报 ADOPT_HOLDER_ALIVE；
 *   - 事件证据不自洽（E3 失败）时，无论策略是否允许 unverified 都必须拒 —— 先报充分性问题。
 *
 * @param {object} input
 * @param {object|null} input.task 任务行（rowToTask 之后的形状，含 v4 租约身份字段）
 * @param {Array<{kind:string,created_at:number,seq?:number}>} [input.events] 该任务事件，**按 seq 降序**
 * @param {{pid:number|null,start_sec:number|null,host:string|null}|null} [input.identity]
 *        判定者身份；undefined=本进程（本地板），null=不知道（此时不能验 pid）
 * @param {(pid:number)=>boolean} [input.isPidAlive] 注入的 pid 存活探测（测试用）
 * @param {number} [input.now] 判定时刻（显式传入才好测）
 * @param {boolean} [input.allowUnverifiedAdoption] 跨机/缺身份时是否放行（默认 false = 严格）
 * @param {boolean} [input.eventScanTruncated] 事件扫描是否被截断（真值时"找不到租约事件"不许当成证据）
 * @returns {{allowed:boolean, code:string|null, message:string, reasons:string[],
 *            unverified:boolean, verdict:string, evidence:object, policy:object}}
 *          注意 `policy` 在**拒绝时也一定存在**（{allow_unverified_adoption:boolean}），
 *          否则排查时无法区分"策略没放行"与"被别的证据挡住"。
 */
export function evaluateAdoption(input = {}) {
  const {
    task,
    events = [],
    identity,
    isPidAlive,
    allowUnverifiedAdoption = false,
    eventScanTruncated = false,
  } = input;
  const at = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  // 策略快照只算一次：成功与拒绝都带上它，口径不会漂
  const policy = { allow_unverified_adoption: allowUnverifiedAdoption === true };
  const reject = (code, reasons, evidence) => adoptionRejected(code, reasons, evidence, policy);

  if (task === null || task === undefined) {
    return reject('TASK_NOT_FOUND', ['任务不存在']);
  }
  if (TERMINAL.has(task.lifecycle)) {
    return reject('TASK_CLOSED', [`任务已终结（${task.lifecycle}），不能再被收养`]);
  }
  if (task.owner_session === null || task.owner_session === undefined) {
    return reject(ADOPT_CODES.NOT_CLAIMED, ['任务还没有负责人，不存在"接管"这回事 —— 直接 claim 即可']);
  }
  if (!['claimed', 'working', 'blocked'].includes(task.lifecycle)) {
    return reject(ADOPT_CODES.STATE_INVALID, [
      `任务状态是 ${task.lifecycle}，只有 claimed / working / blocked 的租约可以被收养`,
    ]);
  }

  // ── E1 时间证据 ──
  const leaseUntil = typeof task.lease_until === 'number' ? task.lease_until : null;
  const staleFlag = Number(task.stale ?? 0) === 1;
  const expired = leaseUntil !== null && leaseUntil <= at;
  const timeEvidence = {
    lease_until: leaseUntil,
    expired,
    stale: staleFlag,
    stale_at: typeof task.stale_at === 'number' ? task.stale_at : null,
    // 负数表示"时间上还没到期，是 stale 标记放行的"——如实记录，不为了好看抹成 0
    overrun_ms: leaseUntil === null ? null : at - leaseUntil,
  };
  if (!(staleFlag || expired)) {
    return reject(
      ADOPT_CODES.NOT_STALE,
      [
        `租约还没有过期（lease_until=${leaseUntil === null ? 'NULL' : new Date(leaseUntil).toISOString()}，` +
          `还有 ${leaseUntil === null ? '未知' : Math.max(0, leaseUntil - at)}ms），也没有 stale 标记：` +
          '没有时间证据就不能收养。要么等它过期/被扫描标 stale，要么用 heartbeat 证明自己还活着',
      ],
      { time: timeEvidence },
    );
  }

  // ── E2 身份证据 ──
  const judge = identity === undefined ? processIdentity() : identity;
  const leasePid = task.lease_pid === null || task.lease_pid === undefined ? null : Number(task.lease_pid);
  const leaseHost = task.lease_host === null || task.lease_host === undefined ? null : String(task.lease_host);
  const judgeHost = judge === null || judge === undefined || judge.host === null || judge.host === undefined
    ? null
    : String(judge.host);
  const identityEvidence = {
    lease_pid: leasePid,
    lease_start_sec: task.lease_start_sec === null || task.lease_start_sec === undefined
      ? null
      : Number(task.lease_start_sec),
    lease_host: leaseHost,
    judge_host: judgeHost,
    checked_pid: false,
    verdict: 'unverified',
    reason: null,
  };
  let identityVerified = false;
  let holderAlive = false;

  const markUnverified = (reason) => {
    identityEvidence.verdict = 'unverified';
    identityEvidence.reason = reason;
  };

  if (judgeHost === null) {
    markUnverified('no-judge-host');
  } else if (leaseHost === null) {
    markUnverified('unverified-no-identity');
  } else if (leaseHost !== judgeHost) {
    markUnverified('unverified-cross-host');
  } else if (leasePid === null) {
    // 同机但记录里没有 pid：一样没东西可验（不许拿"同机"当已死证据）
    markUnverified('unverified-no-identity');
  } else {
    identityEvidence.checked_pid = true;
    const dead = leaseHolderIsDead(task, judge, isPidAlive);
    identityEvidence.reason = dead.reason;
    if (dead.dead) {
      identityVerified = true;
      identityEvidence.verdict = 'verified-dead';
    } else if (dead.reason === 'probe-error') {
      markUnverified('probe-error');
    } else if (dead.reason === 'self' || dead.reason === 'holder-alive') {
      holderAlive = true;
      identityEvidence.verdict = 'alive';
    } else {
      // 兜底：任何我们无法归类的"没死"都不许升级成 verified
      markUnverified(dead.reason ?? 'unknown');
    }
  }
  if (holderAlive) {
    return reject(
      ADOPT_CODES.HOLDER_ALIVE,
      [
        `租约持有者（${task.owner_session}）的进程还在同机运行（pid=${leasePid}${identityEvidence.reason === 'self' ? '，就是判定者自己' : ''}）：` +
          '它不是死了，只是没心跳。请让它自己 heartbeat；抢一条活着的人的租约不是"收养"',
      ],
      { time: timeEvidence, identity: identityEvidence },
    );
  }

  // ── E3 事件证据 ──
  const leaseEvents = events.filter((e) => LEASE_ACTIVITY_EVENT_KINDS.includes(String(e.kind)));
  const sorted = leaseEvents; // 调用方保证按 seq 降序（板服务/Board 的查询都是新的在前）
  const last = sorted.length > 0 ? sorted[0] : null;
  const renewalsAfter = leaseUntil === null
    ? []
    : leaseEvents.filter((e) => Number(e.created_at) > leaseUntil);
  const lastBefore = last !== null && leaseUntil !== null && Number(last.created_at) < leaseUntil;
  const eventEvidence = {
    scanned: Array.isArray(events) ? events.length : 0,
    truncated: eventScanTruncated === true,
    last_kind: last === null ? null : String(last.kind),
    last_at: last === null ? null : Number(last.created_at),
    last_seq: last === null || last.seq === undefined ? null : Number(last.seq),
    lease_until: leaseUntil,
    last_before_lease_until: lastBefore,
    renewals_after_lease_until: renewalsAfter.length,
  };
  const evidenceSoFar = { time: timeEvidence, identity: identityEvidence, event: eventEvidence };
  if (eventScanTruncated && leaseEvents.length === 0) {
    return reject(
      ADOPT_CODES.EVIDENCE_INSUFFICIENT,
      [
        `事件扫描被截断（只看最近 ${eventEvidence.scanned} 条）且其中没有任何租约类事件：` +
          '不能把"没看到"当成"没有"，先人工核对审计流',
      ],
      evidenceSoFar,
    );
  }
  if (last === null) {
    return reject(
      ADOPT_CODES.EVIDENCE_INSUFFICIENT,
      [
        '审计流里找不到任何租约类事件（claim / renew / heartbeat / revived）：' +
          '无法证明"过期后没有续租痕迹"，这条租约的来历不明',
      ],
      evidenceSoFar,
    );
  }
  if (leaseUntil === null) {
    return reject(
      ADOPT_CODES.EVIDENCE_INSUFFICIENT,
      ['任务有负责人但没有 lease_until：无法把事件时间与租约期限对齐'],
      evidenceSoFar,
    );
  }
  if (!lastBefore) {
    return reject(
      ADOPT_CODES.EVIDENCE_INSUFFICIENT,
      [
        `最后一条租约类事件是 ${eventEvidence.last_kind} @${new Date(eventEvidence.last_at).toISOString()}，` +
          `不早于 lease_until（${new Date(leaseUntil).toISOString()}）：租约记录与事件流互相矛盾，不能当"过期后无续租痕迹"`,
      ],
      evidenceSoFar,
    );
  }
  if (renewalsAfter.length > 0) {
    return reject(
      ADOPT_CODES.EVIDENCE_INSUFFICIENT,
      [
        `lease_until 之后还有 ${renewalsAfter.length} 条租约类事件：原持有者在"过期"之后仍有续租痕迹，` +
          '说明它可能还活着，只是租约时间没被续上',
      ],
      evidenceSoFar,
    );
  }

  // ── 结论：三证据齐了。身份是不是"已验证"决定这是不是一次未验证收养 ──
  const unverified = identityVerified !== true;
  if (unverified && allowUnverifiedAdoption !== true) {
    return reject(
      ADOPT_CODES.EVIDENCE_UNVERIFIABLE,
      [
        `身份证据无法验证：${describeUnverifiedIdentity(identityEvidence.reason, identityEvidence)}`,
        '默认策略拒绝"未验证收养"（allowUnverifiedAdoption=false）。这不是代码做不到，' +
          '而是板服务没有资格替远端机器断言进程死亡 —— 把未验证写成已验证比不做判定更危险',
        '若已通过别的渠道确认持有者真的死了，可在板服务（DSH_TEAM_BOARD_ALLOW_UNVERIFIED_ADOPT=1）' +
          '或单机插件（allowUnverifiedAdoption: true）显式放行，审计里会记 unverified=true',
      ],
      evidenceSoFar,
    );
  }

  return {
    allowed: true,
    code: null,
    message: unverified
      ? '已收养（未验证：板服务无法验证原持有者进程是否真的死了）'
      : '已收养（三证据核验通过）',
    reasons: unverified
      ? [`未验证收养：${describeUnverifiedIdentity(identityEvidence.reason, identityEvidence)}`]
      : [],
    unverified,
    verdict: unverified ? 'adopted-unverified' : 'adopted-verified',
    evidence: evidenceSoFar,
    policy,
  };
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

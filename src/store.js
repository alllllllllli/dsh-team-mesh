/**
 * store.js — 共享任务板（业务层）。判定与不变量都在这里，**存储交给 backend**。
 *
 * 为什么改成"业务 / 存储"两层：原型把板与 SQLite 焊死，于是任务只能活在本机
 * `$DSH_HOME/team/team.db` —— 两台设备各一块互不相通的板，跨机派的活对方查不到。
 * 现在同一份判定逻辑既能跑在本地 SQLite 上（Board），也能被板服务包成 HTTP 操作。
 *
 * **接口为什么保持同步**：本地 SQLite（node:sqlite）是同步的，39 条用例按同步写的。
 * 远端实现（remote.js 的 RemoteBoard）是异步的，但 handlers 里全部 `await`，
 * 而 `await` 对普通值也成立 —— 于是同一套 handler 同时伺候同步与异步两种板，
 * 不需要把本地路径改成异步、也不动摇既有测试。
 *
 * 全部写操作都在 `BEGIN IMMEDIATE` 事务里：拿写锁再改，避免两个实例同时判门禁
 * 然后都认为自己可以完成（经典的 TOCTOU）。这条在远端模式下同样成立，
 * 因为门禁执行在**板服务那一侧**的事务里，客户端没有机会绕过。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  assertNonEmptyString,
  assertTransition,
  canReclaim,
  decideAdmissibility,
  DEFAULT_ACK_TIMEOUT_MS,
  DEFAULT_LEASE_MS,
  DEFAULT_SESSION_REQUEST_TTL_MS,
  defaultIsPidAlive,
  evaluateCompletion,
  leaseHolderIsDead,
  leaseIdentityMatches,
  leaseIsLive,
  OUTCOMES,
  processIdentity,
  TERMINAL,
  TeamError,
  VERIFICATION_METHODS,
} from './domain.js';
import { LocalSqliteBackend, defaultBoardPath } from './backend.js';
import { parseRef } from './refs.js';

export { SCHEMA_VERSION, defaultBoardPath, LocalSqliteBackend } from './backend.js';

/**
 * 把一条 evidence_ref 解析成"到底存不存在、哈希是多少"。
 *
 * 这是**代码的事实判定**，不是模型的声明：
 *   - file 引用：在本机磁盘上 stat + 读字节 + 自己算 sha256
 *   - blob 引用：在板的 blob 表里按内容寻址取，哈希就是 key（上传时服务端算的）
 * 模型既无法决定 blob 的 key，也无法干预文件哈希。
 */
export function resolveRef(backend, ref) {
  const parsed = parseRef(ref);
  if (parsed.kind === 'none') return { ...parsed, exists: false, sha256: null, size: null };
  if (parsed.kind === 'unknown') return { ...parsed, exists: false, sha256: null, size: null };

  if (parsed.kind === 'blob') {
    const got = backend.getBlob(parsed.sha256);
    if (got === null) return { ...parsed, exists: false, sha256: null, size: null };
    // 防御性：内容寻址表里 key 与内容必须自洽，不自洽就当不存在（宁可拒绝也不放行）
    const actual = crypto.createHash('sha256').update(got.bytes).digest('hex');
    if (actual !== parsed.sha256) return { ...parsed, exists: false, sha256: null, size: null };
    return { ...parsed, exists: true, sha256: actual, size: got.size };
  }

  // file：本机路径
  try {
    const abs = path.resolve(parsed.localPath);
    const st = fs.statSync(abs);
    if (!st.isFile()) return { ...parsed, exists: false, sha256: null, size: null };
    const bytes = fs.readFileSync(abs);
    return {
      ...parsed,
      exists: true,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
    };
  } catch {
    return { ...parsed, exists: false, sha256: null, size: null };
  }
}

export class Board {
  /**
   * @param {string|LocalSqliteBackend} target 板文件路径，或一个后端实例
   */
  constructor(target) {
    this.backend = target instanceof LocalSqliteBackend ? target : new LocalSqliteBackend(target);
    this.dbPath = this.backend.dbPath;
  }

  close() {
    this.backend.close();
  }

  /**
   * 直通底层 SQLite 句柄。给测试与运维排障用（原型期的 39 条用例直接查库验证）。
   * 远端后端没有本地句柄 —— 那时抛明确错误，而不是返回 undefined 让调用方莫名其妙。
   */
  get db() {
    if (this.backend.db === undefined) {
      throw new TeamError('NO_LOCAL_DB', '当前是远端板，本机没有 SQLite 句柄可直通');
    }
    return this.backend.db;
  }

  /** 单一写事务入口：BEGIN IMMEDIATE 拿写锁，失败必回滚。 */
  tx(fn) {
    return this.backend.tx(fn);
  }

  appendEvent(kind, taskId, actor, payload) {
    return this.backend.insertEvent({
      kind,
      task_id: taskId ?? null,
      actor: actor ?? null,
      payload: JSON.stringify(payload ?? {}),
      created_at: Date.now(),
    });
  }

  // ───────────────────────── 任务 ─────────────────────────

  createTask(input, actor) {
    const { title, brief, acceptance, requestId } = input;
    // v4：可选门禁开关。老调用方不传 → false → 落库 0 → 门禁行为与 v3 一致。
    const requireIndependentReview = input.requireIndependentReview === true;
    return this.tx(() => {
      if (requestId !== null) {
        const prior = this.backend.findTaskByIdempotencyKey(requestId);
        if (prior !== undefined && prior !== null) {
          // 幂等：同一次意图重放，返回原来那条，不新建
          return { task: this.rowToTask(prior), deduped: true };
        }
      }
      const now = Date.now();
      const taskId = `t-${crypto.randomUUID().slice(0, 8)}`;
      this.backend.insertTask({
        task_id: taskId,
        title,
        brief,
        acceptance,
        lifecycle: 'open',
        created_by: actor,
        request_id: requestId,
        version: 1,
        created_at: now,
        updated_at: now,
      });
      if (requireIndependentReview) {
        // 建完再单独 CAS 一次，而不是改 insertTask 的列清单：
        // insertTask 是 v1 就在用的原语，给它加列会让老路径也走新分支。
        this.backend.updateTaskCas(taskId, 1, { require_independent_review: 1 });
      }
      this.appendEvent('task.created', taskId, actor, {
        title,
        request_id: requestId,
        require_independent_review: requireIndependentReview ? 1 : 0,
      });
      const row = this.backend.readTaskRow(taskId);
      return { task: this.rowToTask(row), deduped: false };
    });
  }

  getTask(taskId) {
    const row = this.backend.readTaskRow(taskId);
    return row === undefined || row === null ? null : this.rowToTask(row);
  }

  listTasks(opts = {}) {
    const where = [];
    const args = [];
    if (opts.lifecycle !== undefined && opts.lifecycle !== '') {
      where.push('lifecycle = ?');
      args.push(opts.lifecycle);
    }
    if (opts.ownerSession !== undefined && opts.ownerSession !== '') {
      where.push('owner_session = ?');
      args.push(opts.ownerSession);
    }
    const limit = Math.min(Math.max(Number(opts.limit ?? 20), 1), 100);
    return this.backend.queryTasks(where, args, limit).map((r) => this.rowToTask(r));
  }

  /**
   * 认领。v2 起带**租约**：认领即拿到 lease_until，到期无心跳就变 stale 可被抢。
   *
   * 为什么必须有租约：v1 里"被认领后死掉的任务会一直挂在 working"，
   * 发起方永远不知道对端是挂了还是还在干。租约让"它还活着吗"变成一个可判定的事实。
   *
   * v4 起租约还带**持有者身份**（pid + 进程启动秒 + 主机名），见 leaseIdentityMatches。
   * 认领时记下本进程身份，心跳时校验它 —— 这样 PID 被系统复用后不会把租约
   * 悄悄续给一个陌生进程。
   *
   * @param {{leaseMs?:number, identity?:{pid:number,start_sec:number,host:string|null}}} [opts]
   */
  claimTask(taskId, actor, opts = {}) {
    const leaseMs = Number(opts?.leaseMs ?? DEFAULT_LEASE_MS);
    // v4：身份三态，见 resolveIdentity。undefined=本进程（本地直连），null=不知道（HTTP），对象=调用方指定。
    const identity = resolveIdentity(opts?.identity);
    return this.tx(() => {
      const row = this.backend.readTaskRow(taskId);
      if (row === undefined || row === null) throw new TeamError('TASK_NOT_FOUND', `任务不存在：${taskId}`);
      const task = this.rowToTask(row);
      if (TERMINAL.has(task.lifecycle)) {
        throw new TeamError('TASK_CLOSED', `任务已终结（${task.lifecycle}），不能认领`);
      }
      const now = Date.now();

      if (task.owner_session === actor) {
        // 已经在你自己名下：认领是幂等的，但**续租**（否则重复 claim 会让自己变 stale）
        this.backend.updateTaskCas(taskId, task.version, {
          lease_owner: actor,
          lease_until: now + leaseMs,
          lease_pid: identity.pid,
          lease_start_sec: identity.start_sec,
          lease_host: identity.host,
          stale: 0,
          stale_at: null,
        });
        this.appendEvent('lease.renewed', taskId, actor, { via: 'claim-dedup', lease_until: now + leaseMs });
        return { task: this.getTask(taskId), deduped: true };
      }

      // 别人持有：只有在租约失效 / stale 时才允许接管
      if (task.owner_session !== null && task.owner_session !== actor) {
        const verdict = canReclaim(task, now);
        if (!verdict.ok) {
          throw new TeamError(
            'ALREADY_CLAIMED',
            `任务已被 ${task.owner_session} 认领，且租约仍然有效（${verdict.why}）。` +
              '要换人请等租约到期、或先 cancel。',
          );
        }
        // 接管：记下原负责人失联这件事，审计要能看出"换过手"
        this.appendEvent('lease.taken_over', taskId, actor, {
          from: task.owner_session,
          reason: verdict.why,
          stale: task.stale === 1,
          // v4：把原租约身份一并留痕，事后能判断"是时间到期"还是"进程已换人"
          prev_lease_pid: task.lease_pid ?? null,
          prev_lease_start_sec: task.lease_start_sec ?? null,
        });
      }

      assertTransition(task.lifecycle, 'claimed');
      assertTransition('claimed', 'working');
      const ok = this.backend.updateTaskCas(taskId, task.version, {
        lifecycle: 'working',
        owner_session: actor,
        lease_owner: actor,
        lease_until: now + leaseMs,
        lease_pid: identity.pid,
        lease_start_sec: identity.start_sec,
        lease_host: identity.host,
        stale: 0,
        stale_at: null,
      });
      if (!ok) throw new TeamError('CONFLICT', `任务 ${taskId} 在你读之后被改过，请重试`);
      this.appendEvent('task.claimed', taskId, actor, {
        from: task.lifecycle,
        lease_until: now + leaseMs,
        lease_ms: leaseMs,
      });
      return { task: this.getTask(taskId), deduped: false };
    });
  }

  /**
   * 心跳续租。只有当前 owner 能续；过期了也能续回（但会记一次 stale→live）。
   *
   * v4：续租前先校验**持有者身份**。同一个 pid 但进程启动时刻不同 → `PID_REUSED`。
   * 这是"防 PID 复用"的核心：进程崩了之后，系统可能把同一个 pid 分给别的进程；
   * 那个新进程如果拿着旧的 owner 名字来续租，会把一条本该 stale 的租约续活，
   * 于是发起方永远等不到"负责人已死"这个结论。拒绝续租让租约如实过期。
   *
   * 拒绝原因分两种，语义不同：
   *   PID_REUSED  —— 身份对不上（同机才可能判定），明确是"换了进程"
   *   NOT_LEASE_OWNER —— 名字就不对，v3 已有行为，保持不变
   */
  heartbeat(taskId, actor, opts = {}) {
    const leaseMs = Number(opts?.leaseMs ?? DEFAULT_LEASE_MS);
    const identity = resolveIdentity(opts?.identity);
    return this.tx(() => {
      const row = this.backend.readTaskRow(taskId);
      if (row === undefined || row === null) throw new TeamError('TASK_NOT_FOUND', `任务不存在：${taskId}`);
      const task = this.rowToTask(row);
      if (TERMINAL.has(task.lifecycle)) {
        throw new TeamError('TASK_CLOSED', `任务已终结（${task.lifecycle}），不需要心跳`);
      }
      if (task.owner_session !== actor) {
        throw new TeamError(
          'NOT_LEASE_OWNER',
          `你不是这个任务的负责人（当前 ${task.owner_session ?? '无人'}），不能续租`,
        );
      }
      // v4：身份校验。老数据（lease_pid 为 NULL）在这里必然 ok=true，行为不变。
      const ident = leaseIdentityMatches(task, identity);
      if (!ident.ok) {
        throw new TeamError(
          'PID_REUSED',
          `租约持有者身份对不上（${ident.reason}），拒绝续租：` +
            `记录的 pid/startSec=${JSON.stringify(task.lease_pid)}/${JSON.stringify(task.lease_start_sec)}，` +
            `本进程=${identity.pid}/${identity.start_sec}。` +
            '这通常意味着原进程已退出、PID 被系统复用。请让原负责人重新 claim。',
          ident.detail,
        );
      }
      const now = Date.now();
      const wasStale = task.stale === 1;
      const ok = this.backend.updateTaskCas(taskId, task.version, {
        lease_owner: actor,
        lease_until: now + leaseMs,
        lease_pid: identity.pid,
        lease_start_sec: identity.start_sec,
        lease_host: identity.host,
        stale: 0,
        stale_at: null,
      });
      if (!ok) throw new TeamError('CONFLICT', `任务 ${taskId} 在你读之后被改过，请重试`);
      this.appendEvent(wasStale ? 'lease.revived' : 'lease.renewed', taskId, actor, {
        lease_until: now + leaseMs,
      });
      return { task: this.getTask(taskId), was_stale: wasStale };
    });
  }

  /**
   * 扫描所有过期租约，标 stale 并留痕。**幂等**，可以被反复调用。
   * 这是"它挂了发起方立刻知道"的实现：不需要对端说话，扫描就能发现。
   *
   * v4 起额外判「持有者已死」：租约**时间还没到**，但同机上记录的进程已经不在了，
   * 这条租约同样应该判 stale —— 否则要白等到期（最长 10 分钟）才有人能接手。
   *
   * 为什么这个判定必须**跨机器只认时间**：`lease_pid` 是本机的 pid 空间里的号，
   * 另一台机器上同号的进程纯属巧合。拿本地 pid 存活表去判远端租约，
   * 会随机把"远端还活着"判成"死了"，把租约抢过来 —— 这比不做判定更糟。
   * 所以只有 `lease_host` 与本机相同（或两边都没有主机名、退化为同机）才验 pid。
   */
  sweepStaleLeases(now = Date.now(), opts = {}) {
    // 扫描者身份同样是三态：本进程（默认）/ null=不知道 / 显式对象
    const identity = resolveIdentity(opts?.identity);
    // 测试可注入「哪些 pid 算活着」；默认用真实的 process.kill(pid, 0)
    const isPidAlive = typeof opts?.isPidAlive === 'function' ? opts.isPidAlive : defaultIsPidAlive;
    return this.tx(() => {
      // 先捞「时间已过期」的，再捞「时间没到但持有者已死」的，两者都要判
      const expired = this.backend.queryExpiredLeases(now);
      const seen = new Set(expired.map((r) => String(r.task_id)));
      const deadOwner = [];
      // 扫描者不知道自己在哪台机器上时（identity 全 null），一律不判死：
      // 无法区分"同机"和"跨机器"，就不能用 pid 存活表下结论。
      const canJudgePid = identity !== null && identity.pid !== null && identity.host !== null;
      if (canJudgePid) {
        for (const row of this.backend.queryLiveLeases(now)) {
          if (seen.has(String(row.task_id))) continue;
          const task = this.rowToTask(row);
          const verdict = leaseHolderIsDead(task, identity, isPidAlive);
          if (verdict.dead) deadOwner.push({ row, task, verdict });
        }
      }

      const marked = [];
      const markOne = (task, extra) => {
        const ok = this.backend.updateTaskCas(task.task_id, task.version, {
          stale: 1,
          stale_at: now,
        });
        if (!ok) return;
        this.appendEvent('lease.stale', task.task_id, task.owner_session, {
          lease_until: task.lease_until,
          overrun_ms: typeof task.lease_until === 'number' ? now - task.lease_until : null,
          ...extra,
        });
        marked.push(task.task_id);
      };

      for (const row of expired) {
        markOne(this.rowToTask(row), {});
      }
      for (const { task, verdict } of deadOwner) {
        markOne(task, {
          // 与"时间到期"区分开：审计里能看出这次是因为持有者进程没了才判 stale
          reason: verdict.reason,
          lease_pid: task.lease_pid ?? null,
          lease_start_sec: task.lease_start_sec ?? null,
        });
      }
      return { marked, count: marked.length, expired_count: expired.length, dead_owner_count: deadOwner.length };
    });
  }

  /**
   * 报证据。
   *
   * 关键：**引用解析在写事务之外**（要读盘或读 blob，不该占写锁），
   * 判定结果（admissible/reasons/sha256）随之定死，然后才进事务落库。
   * 落库时只写"已经算好的事实"，事务里不再做 IO。
   *
   * v4：额外接受四个**可选**的结构化复核字段：
   *   verifiedBy          谁复核的（允许与 actor 不同 —— 这正是它的意义）
   *   verifiedAt          复核时间（缺省用本刻）
   *   acceptanceRef       对应 acceptance 里的哪一条（如 A03）
   *   verificationMethod  disk-hash / manual-review / test-run（白名单）
   * 全部缺省 → 四个字段写 NULL，与 v3 行为一致，老调用方一个字都不用改。
   *
   * @param {object} input 见上；`executed`/`outcome`/`evidenceRef` 是 v3 就有的
   * @param {string} actor 上报人（写进 evidence.actor，门禁判"自验自报"时与 verified_by 比）
   */
  reportEvidence(taskId, input, actor) {
    const executed = input.executed === true;
    const outcome = input.outcome;
    if (!OUTCOMES.includes(outcome)) {
      throw new TeamError('INVALID_OUTCOME', `outcome 必须是 ${OUTCOMES.join(' / ')}`);
    }
    const note = input.note === undefined ? '' : assertNonEmptyString(input.note, 'note', 2000);
    const rawRef = input.evidenceRef === undefined || input.evidenceRef === null
      ? null
      : String(input.evidenceRef).trim();
    const evidenceRef = rawRef !== null && rawRef.length > 0 ? rawRef : null;

    // v4 复核字段：全部可选。给了才校验，不给就是 NULL（老行为）。
    const review = normalizeReviewFields(input);

    const resolved = evidenceRef === null
      ? { kind: 'none', exists: false, sha256: null, size: null, raw: '' }
      : resolveRef(this.backend, evidenceRef);

    const verdict = decideAdmissibility({
      executed,
      outcome,
      evidenceRef,
      refExists: resolved.exists === true,
      refKind: resolved.kind,
    });

    return this.tx(() => {
      const row = this.backend.readTaskRow(taskId);
      if (row === undefined || row === null) throw new TeamError('TASK_NOT_FOUND', `任务不存在：${taskId}`);
      const task = this.rowToTask(row);
      if (task.lifecycle === 'done' || task.lifecycle === 'canceled') {
        throw new TeamError('TASK_CLOSED', `任务已终结（${task.lifecycle}），不能再报证据`);
      }
      const now = Date.now();
      const evidenceId = this.backend.insertEvidence({
        task_id: taskId,
        actor,
        executed,
        outcome,
        admissible: verdict.admissible,
        reasons: verdict.reasons,
        note,
        evidence_ref: evidenceRef,
        ref_sha256: resolved.sha256,
        ref_size: resolved.size,
        created_at: now,
        // v4
        verified_by: review.verifiedBy,
        verified_at: review.verifiedBy === null ? null : (review.verifiedAt ?? now),
        acceptance_ref: review.acceptanceRef,
        verification_method: review.verificationMethod,
      });
      this.appendEvent('evidence.recorded', taskId, actor, {
        evidence_id: evidenceId,
        outcome,
        admissible: verdict.admissible,
        reasons: verdict.reasons,
        ref_sha256: resolved.sha256,
        ref_kind: resolved.kind,
        // v4：复核信息也进审计 —— 事后查"谁验的"不该只依赖 evidence 表
        verified_by: review.verifiedBy,
        acceptance_ref: review.acceptanceRef,
        verification_method: review.verificationMethod,
      });
      if (task.lifecycle === 'blocked' && verdict.admissible) {
        // 报来可采信证据说明又动了工：从 blocked 退回 working
        this.backend.updateTaskCas(taskId, task.version, { lifecycle: 'working' });
      }
      return {
        evidence_id: evidenceId,
        admissible: verdict.admissible,
        reasons: verdict.reasons,
        ref_sha256: resolved.sha256,
        ref_size: resolved.size,
        ref_kind: resolved.kind,
        // v4：原样回显，调用方不必再查一遍库
        verified_by: review.verifiedBy,
        verified_at: review.verifiedBy === null ? null : (review.verifiedAt ?? now),
        acceptance_ref: review.acceptanceRef,
        verification_method: review.verificationMethod,
      };
    });
  }

  listEvidence(taskId) {
    return this.backend.queryEvidence(taskId);
  }

  /**
   * v4：打开/关闭该任务的「独立复核」门禁。
   *
   * 为什么要有这个开关而不是全局强制：门禁一强制，所有现存 24 张卡立刻变成
   * "永远完不成"，而它们的历史证据里根本没有 verified_by。默认关闭 + 逐任务打开，
   * 是唯一不破坏老数据的做法。
   *
   * 谁能改：任务的 created_by 或当前 owner。其他人改等于替别人定验收规则。
   *
   * @param {string} taskId
   * @param {boolean} required
   * @param {string} actor 调用者
   */
  setIndependentReview(taskId, required, actor) {
    return this.tx(() => {
      const row = this.backend.readTaskRow(taskId);
      if (row === undefined || row === null) throw new TeamError('TASK_NOT_FOUND', `任务不存在：${taskId}`);
      const task = this.rowToTask(row);
      if (TERMINAL.has(task.lifecycle)) {
        throw new TeamError('TASK_CLOSED', `任务已终结（${task.lifecycle}），不能改门禁`);
      }
      const allowed = actor === task.created_by || actor === task.owner_session;
      if (!allowed) {
        throw new TeamError(
          'NOT_ALLOWED',
          `只有任务创建者（${task.created_by}）或当前负责人（${task.owner_session ?? '无人'}）能改这个开关，你是 ${actor}`,
        );
      }
      const value = required === true ? 1 : 0;
      const ok = this.backend.updateTaskCas(taskId, task.version, { require_independent_review: value });
      if (!ok) throw new TeamError('CONFLICT', `任务 ${taskId} 在你读之后被改过，请重试`);
      this.appendEvent('task.review_policy_changed', taskId, actor, {
        require_independent_review: value,
      });
      return { task: this.getTask(taskId) };
    });
  }

  /**
   * 请求完成。门禁在写事务内重新判定 —— 这是关键：
   * 先读后判再写会让两个实例都通过（TOCTOU），必须在同一把写锁里判完就写。
   *
   * 拒绝的审计事件**必须在事务外补写**：如果在事务内写然后抛错，整笔回滚会把
   * 拒绝记录一起抹掉，审计里就永远看不到"谁在何时被门禁拒过"。
   * agent-team 那边已经栽过一次（D-1），这里是从设计上避开，不是一个补丁。
   */
  completeTask(taskId, actor) {
    try {
      return this.tx(() => {
        const row = this.backend.readTaskRow(taskId);
        if (row === undefined || row === null) throw new TeamError('TASK_NOT_FOUND', `任务不存在：${taskId}`);
        const task = this.rowToTask(row);
        const evidences = this.listEvidence(taskId);
        const gate = evaluateCompletion(task, evidences);
        if (!gate.allowed) {
          throw new TeamError('GATE_REJECTED', `完成门禁拒绝：${gate.reasons.join(' | ')}`, gate.reasons);
        }
        assertTransition(task.lifecycle, 'done');
        const ok = this.backend.updateTaskCas(taskId, task.version, { lifecycle: 'done' });
        if (!ok) throw new TeamError('CONFLICT', `任务 ${taskId} 在你读之后被改过，请重试`);
        this.appendEvent('task.done', taskId, actor, { evidence_count: evidences.length });
        return { task: this.getTask(taskId), gate };
      });
    } catch (err) {
      if (err instanceof TeamError && err.code === 'GATE_REJECTED') {
        // 主事务已回滚；另起一笔**独立提交**的事务把拒绝写进审计
        try {
          this.tx(() => {
            this.appendEvent('task.gate_rejected', taskId, actor, {
              reasons: Array.isArray(err.detail) ? err.detail : [err.message],
            });
          });
        } catch {
          /* 审计写不进去也不能改变"拒绝"这个结论 */
        }
      }
      throw err;
    }
  }

  cancelTask(taskId, actor, reason) {
    return this.tx(() => {
      const row = this.backend.readTaskRow(taskId);
      if (row === undefined || row === null) throw new TeamError('TASK_NOT_FOUND', `任务不存在：${taskId}`);
      const task = this.rowToTask(row);
      assertTransition(task.lifecycle, 'canceled');
      const ok = this.backend.updateTaskCas(taskId, task.version, { lifecycle: 'canceled' });
      if (!ok) throw new TeamError('CONFLICT', `任务 ${taskId} 在你读之后被改过，请重试`);
      this.appendEvent('task.canceled', taskId, actor, { reason: reason ?? '' });
      return { task: this.getTask(taskId) };
    });
  }

  /**
   * 记录一次派发，并**开启 ack 窗口**。
   *
   * v1 只记"投递成功/失败"就完事了 —— 这正是这次踩到的坑：投递成功不等于
   * 对方知道、更不等于任务完成。v2 起每次投递都开一个回执窗口：
   *   delivered=true  → 等 ack；超时未 ack 判 ack_timeout（"送到了没人管"）
   *   delivered=false → 直接就是"信没送到"，不进等待
   */
  recordDispatch(taskId, peerInstance, peerSession, result, opts = {}) {
    const ackTimeoutMs = Number(opts?.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS);
    return this.tx(() => {
      const now = Date.now();
      const delivered = result.delivered === true;
      const dispatchId = this.backend.insertDispatch({
        task_id: taskId,
        peer_instance: peerInstance,
        peer_session: peerSession,
        delivered,
        reason: result.reason ?? null,
        created_at: now,
        // v3：这条派发投的是"本次新建的会话"还是"现成会话"。
        // 不记下来的话，事后看审计会分不清"任务堵在老会话"和"给新会话派的活"。
        created_session: opts?.createdSession === true ? 1 : 0,
      });

      let ackId = null;
      let ackState;
      if (delivered) {
        ackId = this.backend.insertAck({
          task_id: taskId,
          dispatch_id: dispatchId,
          peer_instance: peerInstance,
          peer_session: peerSession,
          delivered: true,
          delivery_reason: result.reason ?? null,
          dispatched_at: now,
          deadline_at: now + ackTimeoutMs,
        });
        ackState = 'pending';
      } else {
        // 没送到就不该进"等回执"，否则 60s 后会被误判成"送到了没人管"
        ackState = 'none';
      }

      const task = this.getTask(taskId);
      if (task !== null) {
        this.backend.updateTaskCas(taskId, task.version, {
          ack_state: ackState,
          ack_deadline_at: delivered ? now + ackTimeoutMs : null,
          ack_at: null,
        });
      }

      this.appendEvent('task.dispatched', taskId, null, {
        peer_instance: peerInstance,
        peer_session: peerSession,
        delivered,
        reason: result.reason ?? null,
        ack_state: ackState,
        ack_deadline_at: delivered ? now + ackTimeoutMs : null,
        // v3：审计里能直接看出"这是新建的会话"
        created_session: opts?.createdSession === true,
      });
      return { dispatch_id: dispatchId, ack_id: ackId, ack_state: ackState, ack_deadline_at: delivered ? now + ackTimeoutMs : null };
    });
  }

  /**
   * 接收端回执。**这是"我知道了"的唯一凭据**，只能由收到任务卡的那一侧写。
   * 幂等：重复 ack 同一个任务返回失败但不算错误（第一次为准）。
   */
  ackTask(taskId, actor, opts = {}) {
    return this.tx(() => {
      const row = this.backend.readTaskRow(taskId);
      if (row === undefined || row === null) throw new TeamError('TASK_NOT_FOUND', `任务不存在：${taskId}`);
      const pending = this.backend.findPendingAck(taskId);
      if (pending === undefined || pending === null) {
        // 已经 ack 过，或从没派发过 —— 都不是错误，但要如实说
        const task = this.rowToTask(row);
        if (task.ack_state === 'acked') {
          return { acked: false, deduped: true, ack_state: 'acked', task };
        }
        throw new TeamError(
          'NO_PENDING_ACK',
          `这个任务上没有待回执的派发（ack_state=${task.ack_state}）。要么没派发过，要么已经超时。`,
        );
      }
      const now = Date.now();
      const ok = this.backend.markAckAcked(pending.ack_id, actor, now);
      if (!ok) {
        const task = this.rowToTask(row);
        return { acked: false, deduped: true, ack_state: task.ack_state, task };
      }
      this.backend.updateTaskCas(taskId, Number(row.version), {
        ack_state: 'acked',
        ack_at: now,
      });
      this.appendEvent('task.acked', taskId, actor, {
        ack_id: pending.ack_id,
        latency_ms: now - Number(pending.dispatched_at),
        acker: actor,
      });
      return { acked: true, deduped: false, ack_state: 'acked', latency_ms: now - Number(pending.dispatched_at), task: this.getTask(taskId) };
    });
  }

  /**
   * 扫描超时未回执的派发，标 ack_timeout 并留痕。**幂等**。
   * 这一步把"送到了没人管"变成一个显式状态，而不是让发起方一直以为在等。
   */
  sweepAckTimeouts(now = Date.now()) {
    return this.tx(() => {
      const rows = this.backend.queryExpiredAcks(now);
      const timedOut = [];
      for (const a of rows) {
        const ok = this.backend.markAckTimedOut(a.ack_id, now);
        if (!ok) continue;
        const row = this.backend.readTaskRow(a.task_id);
        if (row !== undefined && row !== null) {
          const task = this.rowToTask(row);
          // 只在任务还没完成时标 timeout：已完成的任务不该被事后翻成超时
          if (!TERMINAL.has(task.lifecycle)) {
            this.backend.updateTaskCas(a.task_id, task.version, { ack_state: 'timeout' });
          }
        }
        this.appendEvent('task.ack_timeout', a.task_id, null, {
          ack_id: a.ack_id,
          peer_instance: a.peer_instance,
          peer_session: a.peer_session,
          waited_ms: now - Number(a.dispatched_at),
          verdict: 'delivered-unacked',
          meaning: '信已投递成功但在时限内无人回执 —— 不是"正常"，是"送到了没人管"',
        });
        timedOut.push(a.task_id);
      }
      return { timed_out: timedOut, count: timedOut.length };
    });
  }

  listAcks(taskId) {
    return this.backend.listAcks(taskId);
  }

  /** 把"过期的 ack 与租约"一起扫。inject 之前调用，保证注入的是最新真相。 */
  sweepAll(now = Date.now(), opts = {}) {
    const ack = this.sweepAckTimeouts(now);
    const lease = this.sweepStaleLeases(now, opts);
    const sessionRequest = this.sweepSessionRequests(now);
    return { ack, lease, session_request: sessionRequest };
  }

  // ───────────────────── v2：收件箱游标 ─────────────────────

  getCursor(instanceId, sessionId) {
    return this.backend.getCursor(instanceId, sessionId);
  }

  /**
   * 取"此游标之后的新事件"，并**不自动前移** —— 前移由调用方在确认注入后调用
   * `advanceCursor`。分成两步是为了：注入失败/被跳过时游标不动，下一轮还能补上。
   *
   * @param {string} instanceId
   * @param {string} sessionId
   * @param {number} limit
   * @param {number} [sinceSeq] 覆盖游标起点（收件箱翻页用；不传则用存储的游标）
   */
  pendingEvents(instanceId, sessionId, limit = 20, sinceSeq) {
    const since = sinceSeq === undefined || sinceSeq === null
      ? this.backend.getCursor(instanceId, sessionId)
      : Number(sinceSeq);
    const events = this.backend.queryEventsAfter(since, limit);
    const maxSeq = this.backend.maxEventSeq();
    return { since_seq: since, events, max_seq: maxSeq };
  }

  advanceCursor(instanceId, sessionId, seq) {
    return this.backend.setCursor(instanceId, sessionId, Number(seq), Date.now());
  }


  recentEvents(limit = 20, taskId = null) {
    const n = Math.min(Math.max(Number(limit), 1), 100);
    const rows = this.backend.queryEvents(n, taskId);
    return rows.map((r) => ({ ...r, payload: safeParse(r.payload) }));
  }

  // ──────────────── v3：远端建会话请求（板当信箱） ────────────────

  /**
   * 登记一条"请对端帮我开个新会话"的请求。
   *
   * 为什么要有 deadline：对端可能没装新版、可能没开 allowCreate、可能根本不在线。
   * 没有 deadline 的话派发方只能一直等，表现为"卡住"；有了它就能如实说"超时没人处理"。
   */
  createSessionRequest(input) {
    const targetInstance = assertNonEmptyString(input.targetInstance, 'targetInstance', 256);
    const requesterInstance = assertNonEmptyString(input.requesterInstance, 'requesterInstance', 256);
    const now = Date.now();
    const ttlMs = Number(input.ttlMs ?? DEFAULT_SESSION_REQUEST_TTL_MS);
    const requestId = `sr-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    return this.tx(() => {
      this.backend.insertSessionRequest({
        request_id: requestId,
        target_instance: targetInstance,
        requester_instance: requesterInstance,
        requester_session: input.requesterSession ?? null,
        cwd: input.cwd ?? null,
        title: input.title ?? null,
        agent_preset: input.agentPreset ?? null,
        prompt: input.prompt ?? null,
        created_at: now,
        deadline_at: now + ttlMs,
      });
      this.appendEvent('session.requested', null, input.requesterSession ?? null, {
        request_id: requestId,
        target_instance: targetInstance,
        title: input.title ?? null,
      });
      return { request_id: requestId, deadline_at: now + ttlMs };
    });
  }

  getSessionRequest(requestId) {
    return this.backend.readSessionRequest(requestId);
  }

  /** 对端取自己名下待处理的建会话请求。 */
  pendingSessionRequests(targetInstance, limit = 5) {
    return this.backend.queryPendingSessionRequests(targetInstance, Math.min(Math.max(Number(limit), 1), 20));
  }

  /**
   * 认领并写结果。**结果必须如实写**：建成功写 session_id，失败写 reject_reason。
   * 不允许"建失败但什么都不写"——那会让派发方等到超时，把明确失败说成"没人管"。
   */
  claimSessionRequest(requestId, result) {
    const now = Date.now();
    return this.tx(() => {
      const ok = this.backend.claimSessionRequest(requestId, {
        claimed_by: result.claimedBy ?? null,
        claimed_at: now,
        session_id: result.sessionId ?? null,
        reject_reason: result.rejectReason ?? null,
        reject_message: result.rejectMessage ?? null,
      });
      if (!ok) return { claimed: false };
      this.appendEvent('session.created', null, result.claimedBy ?? null, {
        request_id: requestId,
        session_id: result.sessionId ?? null,
        reject_reason: result.rejectReason ?? null,
      });
      return { claimed: true, request: this.backend.readSessionRequest(requestId) };
    });
  }

  /** 扫超时请求。和 ack/租约清扫一起在收件箱注入前调用。 */
  sweepSessionRequests(now = Date.now()) {
    return this.backend.expireSessionRequests(now);
  }

  rowToTask(row) {
    return {
      task_id: row.task_id,
      title: row.title,
      brief: row.brief,
      acceptance: row.acceptance,
      lifecycle: row.lifecycle,
      owner_session: row.owner_session ?? null,
      created_by: row.created_by,
      request_id: row.request_id ?? null,
      version: Number(row.version),
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
      // v2
      ack_state: row.ack_state ?? 'none',
      ack_deadline_at: row.ack_deadline_at === null || row.ack_deadline_at === undefined ? null : Number(row.ack_deadline_at),
      ack_at: row.ack_at === null || row.ack_at === undefined ? null : Number(row.ack_at),
      lease_owner: row.lease_owner ?? null,
      lease_until: row.lease_until === null || row.lease_until === undefined ? null : Number(row.lease_until),
      stale: Number(row.stale ?? 0),
      stale_at: row.stale_at === null || row.stale_at === undefined ? null : Number(row.stale_at),
      // v4：租约身份（老数据一律 null）+ 独立复核开关（老数据一律 0）
      lease_pid: row.lease_pid === null || row.lease_pid === undefined ? null : Number(row.lease_pid),
      lease_start_sec: row.lease_start_sec === null || row.lease_start_sec === undefined
        ? null
        : Number(row.lease_start_sec),
      lease_host: row.lease_host ?? null,
      require_independent_review: Number(row.require_independent_review ?? 0),
    };
  }
}

/**
 * 「不知道持有者身份」的显式表示（pid / startSec / host 全 null）。
 *
 * 为什么要区分「不知道」和「本进程」：
 * 走 HTTP 的板（RemoteBoard）里，claim/heartbeat 实际执行在**板服务进程**中。
 * 板服务根本看不到调用方 agent 的 pid —— 它只能看到自己的。如果这时把
 * "板服务自己的 pid" 当成持有者身份记下来，会带来两个真实故障：
 *   1. 板服务一重启，所有在跑的租约都被判成 PID 复用，agent 心跳被拒、任务被抢；
 *   2. 同一台板上多个 agent 的租约挤在同一个 pid 上，区分能力等于零。
 * 所以「客户端没告诉我它是谁」时，如实记 NULL —— 与 v3 老数据完全同构，
 * 所有校验遇到 NULL 一律跳过（见 leaseIdentityMatches / leaseHolderIsDead）。
 * 这正是任务要求的「跨机器只认时间」在代码里的落点。
 */
export const UNKNOWN_IDENTITY = Object.freeze({ pid: null, start_sec: null, host: null });

/**
 * 把 `opts.identity` 归一成三态：
 *   undefined → 本进程（本地 SQLite 直连路径，守卫真正生效的地方）
 *   null      → 不知道（HTTP 路径，如实记 NULL）
 *   对象      → 调用方指定（远端将来带上 pid 时，或测试注入）
 */
function resolveIdentity(identity) {
  if (identity === null) return UNKNOWN_IDENTITY;
  if (identity === undefined) return processIdentity();
  return identity;
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: String(text) };
  }
}

/**
 * v4：把 reportEvidence 的四个可选复核字段规范化。
 *
 * 全部缺省 → 四个 null，落库写 NULL，行为与 v3 一致。
 * 给了就校验，宁可报错也不落半条：一个拼错的 verification_method 混进库里，
 * 事后做统计时才发现，那时已经分不清哪些是笔误、哪些是真的。
 *
 * @param {object} input
 * @returns {{verifiedBy:string|null, verifiedAt:number|null, acceptanceRef:string|null, verificationMethod:string|null}}
 */
export function normalizeReviewFields(input) {
  const pick = (v) => (v === undefined || v === null ? null : String(v).trim());

  const verifiedBy = pick(input.verifiedBy);
  const acceptanceRef = pick(input.acceptanceRef);
  const verificationMethod = pick(input.verificationMethod);
  const rawVerifiedAt = input.verifiedAt;

  if (verifiedBy !== null && verifiedBy.length === 0) {
    throw new TeamError('INVALID_FIELD', 'verifiedBy 不能是空字符串（要么给一个复核人，要么不传）');
  }
  if (verifiedBy !== null && verifiedBy.length > 256) {
    throw new TeamError('INVALID_FIELD', `verifiedBy 过长（${verifiedBy.length} > 256）`);
  }
  if (acceptanceRef !== null && acceptanceRef.length === 0) {
    throw new TeamError('INVALID_FIELD', 'acceptanceRef 不能是空字符串（要么给条目号，要么不传）');
  }
  if (acceptanceRef !== null && acceptanceRef.length > 64) {
    throw new TeamError('INVALID_FIELD', `acceptanceRef 过长（${acceptanceRef.length} > 64）`);
  }
  if (verificationMethod !== null && !VERIFICATION_METHODS.includes(verificationMethod)) {
    throw new TeamError(
      'INVALID_FIELD',
      `verificationMethod 必须是 ${VERIFICATION_METHODS.join(' / ')} 之一，收到：${verificationMethod}`,
    );
  }

  let verifiedAt = null;
  if (rawVerifiedAt !== undefined && rawVerifiedAt !== null) {
    const n = Number(rawVerifiedAt);
    if (!Number.isFinite(n) || n <= 0) {
      throw new TeamError('INVALID_FIELD', `verifiedAt 必须是正的毫秒时间戳，收到：${String(rawVerifiedAt)}`);
    }
    verifiedAt = Math.floor(n);
  }
  // verifiedAt 只在有 verifiedBy 时才有意义；单给时间没有复核人等于没说谁验的
  if (verifiedBy === null && verifiedAt !== null) {
    throw new TeamError('INVALID_FIELD', '给了 verifiedAt 就必须同时给 verifiedBy（否则不知道是谁验的）');
  }

  return { verifiedBy, verifiedAt, acceptanceRef, verificationMethod };
}

export function openBoard(boardPath) {
  return new Board(boardPath ?? defaultBoardPath());
}

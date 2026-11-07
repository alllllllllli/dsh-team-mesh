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

import {
  assertNonEmptyString,
  assertTransition,
  canReclaim,
  decideAdmissibility,
  DEFAULT_ACK_TIMEOUT_MS,
  DEFAULT_LEASE_MS,
  evaluateCompletion,
  leaseIsLive,
  OUTCOMES,
  TERMINAL,
  TeamError,
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
      this.appendEvent('task.created', taskId, actor, { title, request_id: requestId });
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
   * @param {{leaseMs?:number}} [opts]
   */
  claimTask(taskId, actor, opts = {}) {
    const leaseMs = Number(opts?.leaseMs ?? DEFAULT_LEASE_MS);
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
        });
      }

      assertTransition(task.lifecycle, 'claimed');
      assertTransition('claimed', 'working');
      const ok = this.backend.updateTaskCas(taskId, task.version, {
        lifecycle: 'working',
        owner_session: actor,
        lease_owner: actor,
        lease_until: now + leaseMs,
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

  /** 心跳续租。只有当前 owner 能续；过期了也能续回（但会记一次 stale→live）。 */
  heartbeat(taskId, actor, opts = {}) {
    const leaseMs = Number(opts?.leaseMs ?? DEFAULT_LEASE_MS);
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
      const now = Date.now();
      const wasStale = task.stale === 1;
      const ok = this.backend.updateTaskCas(taskId, task.version, {
        lease_owner: actor,
        lease_until: now + leaseMs,
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
   */
  sweepStaleLeases(now = Date.now()) {
    return this.tx(() => {
      const rows = this.backend.queryExpiredLeases(now);
      const marked = [];
      for (const row of rows) {
        const task = this.rowToTask(row);
        const ok = this.backend.updateTaskCas(task.task_id, task.version, {
          stale: 1,
          stale_at: now,
        });
        if (!ok) continue;
        this.appendEvent('lease.stale', task.task_id, task.owner_session, {
          lease_until: task.lease_until,
          overrun_ms: typeof task.lease_until === 'number' ? now - task.lease_until : null,
        });
        marked.push(task.task_id);
      }
      return { marked, count: marked.length };
    });
  }

  /**
   * 报证据。
   *
   * 关键：**引用解析在写事务之外**（要读盘或读 blob，不该占写锁），
   * 判定结果（admissible/reasons/sha256）随之定死，然后才进事务落库。
   * 落库时只写"已经算好的事实"，事务里不再做 IO。
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
      });
      this.appendEvent('evidence.recorded', taskId, actor, {
        evidence_id: evidenceId,
        outcome,
        admissible: verdict.admissible,
        reasons: verdict.reasons,
        ref_sha256: resolved.sha256,
        ref_kind: resolved.kind,
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
      };
    });
  }

  listEvidence(taskId) {
    return this.backend.queryEvidence(taskId);
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
  sweepAll(now = Date.now()) {
    const ack = this.sweepAckTimeouts(now);
    const lease = this.sweepStaleLeases(now);
    return { ack, lease };
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
    };
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: String(text) };
  }
}

export function openBoard(boardPath) {
  return new Board(boardPath ?? defaultBoardPath());
}

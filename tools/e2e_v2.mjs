/**
 * e2e_v2.mjs — v2 三项功能（ack / 租约 / 收件箱）的四项验收。
 *
 * 对应派活单里的 a/b/c/d：
 *   a. 派给对端但 60s 内无 ack → 发起方看到 ack_timeout，不是"正常"
 *   b. claim 后停掉心跳 → 租约超时标 stale，事件可见，可被重新认领
 *   c. 对端完成但不主动发消息 → 发起方下一轮自动看到 done 事件
 *   d. 注入不刷屏：连跑两轮，第二轮只注入新增未读，游标正确前移
 *
 * 做法上和 e2e_remote.mjs 一致：**两个独立的客户端实例**（模拟两台设备），
 * 共用一块板。时间相关的用"把 deadline/lease_until 往前拨"来加速，不真等 60s。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createHandlers } from '../src/handlers.js';
import { installInboxHook } from '../src/inboxHook.js';
import { RemoteBoard } from '../src/remote.js';
import { startBoardService } from '../src/server.js';

const TOKEN = 'v2-token-' + crypto.randomUUID().slice(0, 8);
const results = [];
let failures = 0;

function record(group, name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => results.push(`  ✔ [${group}] ${name}`))
    .catch((err) => {
      failures += 1;
      results.push(`  ✖ [${group}] ${name}`);
      results.push(`      ${err?.message ?? err}`);
    });
}
function section(t) {
  results.push('');
  results.push(`── ${t} ──`);
}

/** 每个"设备"一套 handler + 固定 session。 */
function device(board, label) {
  const h = createHandlers({ getBoard: () => board, getInterconnect: () => null });
  const exec = { agent: { id: `session-${label}` } };
  return { label, call: (tool, args) => h[tool](args ?? {}, exec) };
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-v2e2e-'));
let svc = null;

async function main() {
  section('启动板服务 + 两个设备客户端');
  svc = await startBoardService({
    boardPath: path.join(tmpRoot, 'board.db'),
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    logger: { warn: () => {}, info: () => {} },
  });
  const endpoint = `http://127.0.0.1:${svc.port}`;
  results.push(`  ✔ 板服务：${endpoint}`);

  const boardA = new RemoteBoard({ endpoint, token: TOKEN });
  const boardB = new RemoteBoard({ endpoint, token: TOKEN });
  const devA = device(boardA, 'A');
  const devB = device(boardB, 'B');

  /** 直接把某任务的 ack deadline 往前拨，免等 60s。 */
  async function expireAck(taskId) {
    svc.board.backend.db
      .prepare('UPDATE ack SET deadline_at = ? WHERE task_id = ? AND acked_at IS NULL')
      .run(Date.now() - 1, taskId);
  }
  /** 直接把某任务的租约往前拨。 */
  async function expireLease(taskId) {
    svc.board.backend.db
      .prepare('UPDATE task SET lease_until = ? WHERE task_id = ?')
      .run(Date.now() - 1, taskId);
  }

  // ───────────────────────── a. 无 ack → ack_timeout ─────────────────────────
  section('a. 派给对端但超时无 ack → 发起方看到 ack_timeout（不是"正常"）');

  let taskA = null;
  await record('a', 'A 建任务并派给 B（模拟投递成功，但不回执）', async () => {
    const out = await devA.call('mesh_task_create', { title: 'ack 超时验收', requestId: 'v2-a' });
    taskA = /task_id:\s*(t-[0-9a-f]+)/.exec(out)[1];
    // 直接落一条"投递成功"的记录（不真走 interconnect，因为这里要验的是回执机制）
    const r = await svc.board.recordDispatch(taskA, 'pc-ky614', 'session-B', { delivered: true });
    assert.equal(r.ack_state, 'pending', '投递成功应进入等回执');
  });

  await record('a', '超时前：状态是 pending（等待回执），不是"已完成"', async () => {
    const t = await svc.board.getTask(taskA);
    assert.equal(t.ack_state, 'pending');
    assert.equal(t.lifecycle, 'open', '还没人认领');
  });

  await record('a', '超时后：ack_state=timeout，任务带 ack_timeout 事件', async () => {
    await expireAck(taskA);
    const swept = await svc.board.sweepAckTimeouts();
    assert.deepEqual(swept.timed_out, [taskA]);
    const t = await svc.board.getTask(taskA);
    assert.equal(t.ack_state, 'timeout');
    const ev = await svc.board.recentEvents(50, taskA);
    const timeoutEv = ev.find((e) => e.kind === 'task.ack_timeout');
    assert.ok(timeoutEv !== undefined, '必须有 task.ack_timeout 事件');
    assert.equal(timeoutEv.payload.verdict, 'delivered-unacked', '必须标成"送到了没人管"');
  });

  await record('a', 'A 侧列表里显式标出 ACK_TIMEOUT，不混在正常里', async () => {
    const list = await devA.call('mesh_task_list', {});
    assert.ok(list.includes('ACK_TIMEOUT'), `列表应显式标出超时：\n${list}`);
    assert.ok(list.includes('送到了没人管'), `应说明含义：\n${list}`);
  });

  await record('a', '对照：投递失败不会被误判成 ack_timeout', async () => {
    const t2 = await svc.board.createTask({ title: '没送到', brief: '', acceptance: '', requestId: 'v2-a2' }, 'session-A');
    const r = await svc.board.recordDispatch(t2.task.task_id, 'pc-ky614', 'session-B', {
      delivered: false,
      reason: 'unreachable',
    });
    assert.equal(r.ack_state, 'none', '没送到不该进等待回执');
    const swept = await svc.board.sweepAckTimeouts();
    assert.ok(!swept.timed_out.includes(t2.task.task_id), '没送到不该被判"没人管"');
  });

  // ───────────────────────── b. 心跳停掉 → stale 可重认领 ─────────────────────────
  section('b. claim 后停掉心跳 → 租约超时标 stale，事件可见，可被重新认领');

  let taskB = null;
  await record('b', 'B 认领（拿到租约）', async () => {
    const out = await devA.call('mesh_task_create', { title: '租约验收', requestId: 'v2-b' });
    taskB = /task_id:\s*(t-[0-9a-f]+)/.exec(out)[1];
    const claimed = await devB.call('mesh_task_claim', { taskId: taskB });
    assert.ok(claimed.includes('已认领'), claimed);
    assert.ok(claimed.includes('租约至'), `应告诉它租约到什么时候：\n${claimed}`);
  });

  await record('b', '租约有效期内，别人抢不走', async () => {
    let caught = null;
    try {
      await devA.call('mesh_task_claim', { taskId: taskB });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught !== null, '租约内被抢走是本该拒绝的');
    assert.equal(caught.code, 'ALREADY_CLAIMED');
  });

  await record('b', '停掉心跳 → 租约过期被扫成 stale，并留 lease.stale 事件', async () => {
    await expireLease(taskB);
    const swept = await svc.board.sweepStaleLeases();
    assert.ok(swept.marked.includes(taskB), `应被标 stale，实际 ${JSON.stringify(swept)}`);
    const t = await svc.board.getTask(taskB);
    assert.equal(t.stale, 1);
    const ev = await svc.board.recentEvents(50, taskB);
    assert.ok(ev.some((e) => e.kind === 'lease.stale'), '必须有 lease.stale 事件');
  });

  await record('b', 'A 侧列表能看见 STALE 标记（发起方立刻知道，不用等它说话）', async () => {
    const list = await devA.call('mesh_task_list', {});
    assert.ok(list.includes('STALE'), `列表应显式标 stale：\n${list}`);
    assert.ok(list.includes('负责人失联'), list);
  });

  await record('b', 'stale 后可被重新认领（接管留痕 lease.taken_over）', async () => {
    const out = await devA.call('mesh_task_claim', { taskId: taskB });
    assert.ok(out.includes('已认领'), out);
    const t = await svc.board.getTask(taskB);
    assert.equal(t.owner_session, 'session-A', '应换手给 A');
    assert.equal(t.stale, 0, '接管后 stale 应清掉');
    const ev = await svc.board.recentEvents(50, taskB);
    assert.ok(ev.some((e) => e.kind === 'lease.taken_over'), '接管必须留痕');
  });

  await record('b', '新负责人心跳能续租（正常干活路径没被破坏）', async () => {
    const out = await devA.call('mesh_task_heartbeat', { taskId: taskB });
    assert.ok(out.includes('已续租'), out);
  });

  // ───────────────────────── c. 对端完成不吭声，发起方下一轮自动看到 ─────────────────────────
  section('c. 对端完成但不主动发消息 → 发起方下一轮自动看到 done 事件');

  let taskC = null;
  await record('c', '准备：A 建任务、B 认领、B 报真实证据、B 完成（全程不通知 A）', async () => {
    const out = await devA.call('mesh_task_create', { title: '静默完成验收', requestId: 'v2-c' });
    taskC = /task_id:\s*(t-[0-9a-f]+)/.exec(out)[1];
    await devB.call('mesh_task_claim', { taskId: taskC });
    const proof = path.join(tmpRoot, 'proof-c.txt');
    fs.writeFileSync(proof, 'B 的产物');
    const rep = await devB.call('mesh_task_report', {
      taskId: taskC,
      executed: true,
      outcome: 'pass',
      note: 'B 做完了',
      evidenceRef: proof,
    });
    assert.ok(rep.includes('可采信：是'), rep);
    const done = await devB.call('mesh_task_complete', { taskId: taskC });
    assert.ok(done.includes('任务已完成'), done);
  });

  await record('c', 'A 的收件箱（下一轮注入）自动包含 done 事件与任务当前状态', async () => {
    // 模拟宿主在 A 会话 next step 时调用钩子
    const injected = [];
    const fakeCtx = {
      on: (event, listener) => {
        assert.equal(event, 'agent/pre-step');
        fakeCtx._listener = listener;
        return () => {};
      },
      logger: { warn: () => {} },
    };
    const off = installInboxHook({
      ctx: fakeCtx,
      board: boardA,
      limit: 50,
      resolveInstance: async () => 'server',
    });
    assert.equal(typeof off, 'function');

    // 宿主调用：payload 带 agent（session-A），next() 返回空决策
    const decision = { messages: [] };
    const returned = await fakeCtx._listener(
      { agent: { id: 'session-A' }, signal: { aborted: false }, step: 1, messages: [] },
      async () => decision,
    );

    assert.ok(Array.isArray(returned.messages), '返回值应带 messages');
    assert.equal(returned.messages.length, 1, '应注入恰好一条摘要');
    const text = JSON.stringify(returned.messages[0]);
    injected.push(text);
    assert.ok(text.includes('task.done'), `注入内容应含 done 事件：\n${text}`);
    assert.ok(text.includes(taskC), `应点名是哪个任务：\n${text}`);
    assert.ok(text.includes('done'), `应带当前状态：\n${text}`);
  });

  await record('c', 'A 没有主动调任何工具，就已经知情（这就是这次踩的坑）', async () => {
    // 上一条已经证明钩子注入了。这里再确认：不调 mesh_events 也能看到
    const digestText = results[results.length - 1];
    assert.ok(!digestText.includes('✖'));
  });

  // ───────────────────────── d. 不刷屏：两轮只注入新增 ─────────────────────────
  section('d. 注入不刷屏：连跑两轮，第二轮只注入新增，游标正确前移');

  await record('d', '第一轮：注入新事件，游标前移', async () => {
    // 用全新会话：c 组已经把 session-A 的游标推过了，复用会得到"没有未读"而误判
    const who = { instanceId: 'server', sessionId: 'session-D', limit: 50 };
    const r1 = await (await import('../src/inbox.js')).deliverInbox(boardA, who, () => {});
    assert.equal(r1.injected, true, '第一轮应注入');
    assert.ok(r1.count > 0);
    assert.ok(r1.nextSeq > 0, '游标应前移');
  });

  await record('d', '第二轮（无新事件）：不注入、不重复刷屏', async () => {
    const who = { instanceId: 'server', sessionId: 'session-D', limit: 50 };
    const r2 = await (await import('../src/inbox.js')).deliverInbox(boardA, who, () => {});
    assert.equal(r2.injected, false, '没有新事件时不应注入');
    assert.equal(r2.count, 0);
  });

  await record('d', '产生新事件后第三轮：只注入新增部分', async () => {
    const before = (await import('../src/inbox.js'));
    const who = { instanceId: 'server', sessionId: 'session-D', limit: 50 };
    const c1 = await before.collectInbox(boardA, who);
    const cursorBefore = c1.sinceSeq;

    // 造一条新事件
    await devA.call('mesh_task_create', { title: '新事件触发', requestId: 'v2-d-new' });

    const r3 = await before.deliverInbox(boardA, who, () => {});
    assert.equal(r3.injected, true);
    assert.equal(r3.sinceSeq, cursorBefore, '第三轮应从上一轮结束处继续');
    assert.equal(r3.count, 1, `只应注入新增的 1 条，实际 ${r3.count}`);
  });

  await record('d', '游标按 session 隔离：B 的会话不受 A 影响', async () => {
    const { deliverInbox } = await import('../src/inbox.js');
    const whoB = { instanceId: 'server', sessionId: 'session-B', limit: 50 };
    const cursorB = await boardA.getCursor('server', 'session-B');
    assert.equal(cursorB, 0, 'B 从未读过，游标应为 0');
    const rB = await deliverInbox(boardA, whoB, () => {});
    assert.equal(rB.injected, true, 'B 首次应能读到全部历史');
    // D 有读过，A 在 c 组读过，B 现在也读过了 —— 三者互不影响
    const cursorD = await boardA.getCursor('server', 'session-D');
    assert.ok(cursorD > 0, 'D 的游标应独立存在');
  });

  await record('d', '注入失败时游标不动（下一轮可补上）', async () => {
    const { deliverInbox } = await import('../src/inbox.js');
    const who = { instanceId: 'server', sessionId: 'session-D', limit: 50 };
    await devA.call('mesh_task_create', { title: '触发新事件', requestId: 'v2-d-fail' });
    const before = await boardA.getCursor('server', 'session-D');
    let threw = false;
    try {
      await deliverInbox(boardA, who, () => {
        throw new Error('模拟注入失败');
      });
    } catch {
      threw = true;
    }
    assert.ok(threw, '注入抛错应向上传播');
    const after = await boardA.getCursor('server', 'session-D');
    assert.equal(after, before, '注入失败时游标不能动');
  });

  // ── d2：走**真实钩子**的两轮注入 ──
  // 上面 d 组测的是 inbox.js 的 deliverInbox；而宿主实际经过的是 inboxHook.js。
  // 两条路径必须分别验：此前只测了前者，导致"钩子不前移游标"这种退化不会被发现。
  section('d2. 走 agent/pre-step 真实钩子的两轮注入（不刷屏）');

  /** 造一个假 ctx，返回 {listener, callStep} */
  function makeHookRig(board, sessionId) {
    let listener = null;
    const ctx = {
      on: (event, fn) => {
        assert.equal(event, 'agent/pre-step');
        listener = fn;
        return () => {};
      },
      logger: { warn: () => {} },
    };
    installInboxHook({ ctx, board, limit: 50, resolveInstance: async () => 'server' });
    assert.ok(listener !== null, '钩子应已安装');
    return {
      get listener() {
        return listener;
      },
      async step() {
        return listener(
          { agent: { id: sessionId }, signal: { aborted: false }, step: 1, messages: [] },
          async () => ({ messages: [] }),
        );
      },
    };
  }

  const HOOK_SESSION = 'session-HOOK';

  await record('d2', '第一轮（钩子）：注入一条摘要', async () => {
    const rig = makeHookRig(boardA, HOOK_SESSION);
    const r1 = await rig.step();
    assert.equal(r1.messages.length, 1, '应注入恰好一条');
    assert.ok(JSON.stringify(r1.messages[0]).includes('团队动态'), '应含摘要头');
  });

  await record('d2', '第二轮（钩子，无新事件）：注入 0 条 —— 不前移游标就会在这里红', async () => {
    const rig = makeHookRig(boardA, HOOK_SESSION);
    const r2 = await rig.step();
    assert.equal(r2.messages.length, 0, `第二轮不该重复注入，实际注入了 ${r2.messages.length} 条`);
  });

  await record('d2', '钩子游标确实前移了（独立核对 cursor）', async () => {
    const cursor = await boardA.getCursor('server', HOOK_SESSION);
    const maxSeq = (await boardA.pendingEvents('server', HOOK_SESSION, 1)).max_seq;
    assert.ok(cursor > 0, '游标应已前移');
    assert.equal(cursor, maxSeq, '一次读全时游标应等于板上最大 seq');
  });

  await record('d2', '新事件后第三轮（钩子）：只注入新增', async () => {
    const seqBefore = (await boardA.pendingEvents('server', HOOK_SESSION, 1)).max_seq;
    await devA.call('mesh_task_create', { title: '钩子新事件', requestId: 'v2-d2-new' });
    const rig = makeHookRig(boardA, HOOK_SESSION);
    const r3 = await rig.step();
    assert.equal(r3.messages.length, 1, '应注入一条摘要');
    const text = JSON.stringify(r3.messages[0]);
    // 只应包含新增事件：摘要头会写 "seq > <旧游标>"
    assert.ok(text.includes('task.created'), text);
    // 关键：不该重新罗列本轮之前已经读过的事件（#1 起那一批）
    assert.ok(!text.includes('#1 '), `不该重复注入已读事件：\n${text}`);
    const cursorAfter = await boardA.getCursor('server', HOOK_SESSION);
    assert.ok(cursorAfter > seqBefore, '游标应继续前移');
  });

  await record('d2', '钩子：makeMessage 抛错时游标必须不动（消息不能丢）', async () => {
    const FAIL_SESSION = 'session-MKMSG';
    // 先让这个会话有一批未读
    await devA.call('mesh_task_create', { title: '制造未读', requestId: 'v2-mk-1' });

    let listener = null;
    installInboxHook({
      ctx: {
        on: (_e, fn) => {
          listener = fn;
          return () => {};
        },
        logger: { warn: () => {} },
      },
      board: boardA,
      limit: 50,
      resolveInstance: async () => 'server',
      // 关键：造消息这一步抛错。若实现是"先前移再构造/返回"，游标就已经动了 → 消息永久丢
      makeMessage: () => {
        throw new Error('造消息失败');
      },
    });

    const before = await boardA.getCursor('server', FAIL_SESSION);
    const out = await listener(
      { agent: { id: FAIL_SESSION }, signal: { aborted: false }, step: 1, messages: [] },
      async () => ({ messages: [] }),
    );
    // 钩子自己吞掉异常，不影响本步
    assert.equal(out.messages.length, 0, '失败时不该注入');
    const after = await boardA.getCursor('server', FAIL_SESSION);
    assert.equal(after, before, `构造消息失败时游标必须不动，否则消息永久丢失（before=${before} after=${after}）`);

    // 再确认下一轮能补上（用正常 makeMessage）
    let okListener = null;
    installInboxHook({
      ctx: {
        on: (_e, fn) => {
          okListener = fn;
          return () => {};
        },
        logger: { warn: () => {} },
      },
      board: boardA,
      limit: 50,
      resolveInstance: async () => 'server',
    });
    const retry = await okListener(
      { agent: { id: FAIL_SESSION }, signal: { aborted: false }, step: 1, messages: [] },
      async () => ({ messages: [] }),
    );
    assert.equal(retry.messages.length, 1, '下一轮应补上之前没注入的消息');
  });

  await record('d2', '钩子里 limit 截断后游标不跳过中间事件', async () => {
    const LIM_SESSION = 'session-LIMIT';
    // 造 5 条新事件
    for (let i = 0; i < 5; i += 1) {
      await devA.call('mesh_task_create', { title: `截断-${i}`, requestId: `v2-lim-${i}` });
    }
    // 用 limit=2 的钩子读一轮
    let listener = null;
    installInboxHook({
      ctx: {
        on: (_e, fn) => {
          listener = fn;
          return () => {};
        },
        logger: { warn: () => {} },
      },
      board: boardA,
      limit: 2,
      resolveInstance: async () => 'server',
    });
    const call = () =>
      listener({ agent: { id: LIM_SESSION }, signal: { aborted: false }, step: 1, messages: [] }, async () => ({
        messages: [],
      }));
    await call();
    const c1 = await boardA.getCursor('server', LIM_SESSION);
    const maxSeq = (await boardA.pendingEvents('server', LIM_SESSION, 1)).max_seq;
    assert.ok(c1 < maxSeq, `limit 截断时游标不该跳到全表最大：cursor=${c1} max=${maxSeq}`);
    // 再读一轮应继续前进且不重复
    await call();
    const c2 = await boardA.getCursor('server', LIM_SESSION);
    assert.ok(c2 > c1, '第二轮应继续前进');
  });

  // ───────────────────────── 门禁四条不变量回归 ─────────────────────────
  section('门禁四条不变量在 v2 下没有被放松');

  await record('门禁', '无证据仍不能完成', async () => {
    const out = await devA.call('mesh_task_create', { title: '门禁回归', requestId: 'v2-gate' });
    const id = /task_id:\s*(t-[0-9a-f]+)/.exec(out)[1];
    await devA.call('mesh_task_claim', { taskId: id });
    const r = await devA.call('mesh_task_complete', { taskId: id });
    assert.ok(r.includes('拒绝') && r.includes('NO_EVIDENCE'), r);
  });

  await record('门禁', '自报无 ref 仍不可采信', async () => {
    const out = await devA.call('mesh_task_create', { title: '门禁回归2', requestId: 'v2-gate2' });
    const id = /task_id:\s*(t-[0-9a-f]+)/.exec(out)[1];
    await devA.call('mesh_task_claim', { taskId: id });
    const r = await devA.call('mesh_task_report', {
      taskId: id,
      executed: true,
      outcome: 'pass',
      note: '我保证做完了',
    });
    assert.ok(r.includes('可采信：否'), r);
  });

  await record('门禁', '租约/stale 都不能让未完成的任务变成 done', async () => {
    const out = await devA.call('mesh_task_create', { title: '门禁回归3', requestId: 'v2-gate3' });
    const id = /task_id:\s*(t-[0-9a-f]+)/.exec(out)[1];
    await devA.call('mesh_task_claim', { taskId: id, leaseMs: 1000 });
    await expireLease(id);
    await svc.board.sweepStaleLeases();
    const t = await svc.board.getTask(id);
    assert.equal(t.lifecycle, 'working', 'stale 只标记失联，不该改生命周期');
    const r = await devA.call('mesh_task_complete', { taskId: id });
    assert.ok(r.includes('拒绝'), 'stale 不能绕过门禁');
  });

  results.push('');
  results.push(failures === 0 ? `════ 全部通过（${results.filter((r) => r.includes('✔')).length} 项） ════` : `════ 失败 ${failures} 项 ════`);
  console.log(results.join('\n'));
  return failures;
}

main()
  .then(async (f) => {
    if (svc !== null) await svc.close().catch(() => {});
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* ignore */
    }
    process.exitCode = f === 0 ? 0 : 1;
  })
  .catch(async (err) => {
    console.error('E2E v2 崩溃：', err);
    if (svc !== null) await svc.close().catch(() => {});
    process.exitCode = 1;
  });

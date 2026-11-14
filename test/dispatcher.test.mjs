/**
 * dispatcher.test.mjs — v0.4「总管（dispatcher）角色」的硬要求。
 *
 * 总管要解决的真实病灶：对端只有一个活会话，所有任务都堵进它 → 前一个没干完，
 * 后一个 ack 超时。总管只做三件事：接信、建一个新子会话去干活、代签回执；**自己永不动手**。
 *
 * 这个文件按"最危险的失败方式"来写用例，而不是按函数覆盖率：
 *   ① 一次派发只 spawn 一次 —— 而且去重要落在板上（**重启后不重复**），不能只存内存
 *   ② spawn 失败不许假装受理 —— 不 ack，让派发方拿到 ack_timeout；失败事件要如实落
 *   ③ 总管永不执行任务 —— claim 必须被明确拒绝（稳定错误码），别变成"租约被占"的模糊失败
 *   ④ 只处理"派给本实例总管"的派发 —— 别人的派发、没送到的派发、已终结/已有人接手的任务都不碰
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildDispatcherPrompt,
  dispatcherCursorKey,
  normalizeDispatcherSessions,
  serviceDispatchRequests,
  startDispatcher,
} from '../src/dispatcher.js';
import { createHandlers, DISPATCHER_NOT_EXECUTOR } from '../src/handlers.js';
import { Board } from '../src/store.js';

const tmpDirs = [];
function newBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-dispatcher-'));
  tmpDirs.push(dir);
  return new Board(path.join(dir, 'team.db'));
}
process.on('exit', () => {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* ignore */
    }
  }
});

const BOSS = 'session-boss';
const INSTANCE = 'instance-a';

function makeTask(board, title = '总管分流用例') {
  return board.createTask(
    { title, brief: '把 report.txt 写到工作目录并给出绝对路径', acceptance: 'report.txt 存在且内容非空', requestId: null },
    'session-peer',
  ).task;
}

/** 假宿主：只提供 sessionController.create / prompt —— 没有 resume，走错路径就会红。 */
function makeHost({ create, prompt } = {}) {
  const createCalls = [];
  const promptCalls = [];
  /** prompt 收到的第二个参数（真实宿主里是 AbortSignal）；单独收集，便于断言"每次 spawn 新建一个"。 */
  const promptSignals = [];
  const sc = {};
  sc.create = create ?? (async (payload) => {
    createCalls.push(payload);
    return { sessionId: `child-${createCalls.length}` };
  });
  if (prompt !== 'skip') {
    sc.prompt = prompt ?? (async (payload, signal) => {
      promptCalls.push(payload);
      promptSignals.push(signal);
      return { accepted: true };
    });
  }
  const logs = [];
  const ctx = {
    get: (n) => (n === 'sessionController' ? sc : undefined),
    logger: { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]) },
  };
  return { ctx, sc, createCalls, promptCalls, promptSignals, logs };
}

function makeDeps(host, board, overrides = {}) {
  return {
    board,
    ctx: host.ctx,
    instanceId: INSTANCE,
    sessions: [BOSS],
    ...overrides,
  };
}

/** 在板上制造一条"别人派给总管"的派发记录（recordDispatch 的 peer_instance 是**目标**实例）。 */
function seedDispatch(board, taskId, opts = {}) {
  return board.recordDispatch(
    taskId,
    opts.instance ?? INSTANCE,
    opts.session ?? BOSS,
    opts.delivered === false
      ? { delivered: false, reason: 'unreachable' }
      : { delivered: true, delivery: 'followup' },
    { ackTimeoutMs: opts.ackTimeoutMs ?? 180_000 },
  );
}

function eventsOf(board, taskId) {
  return board.recentEvents(100, taskId);
}

function kindsOf(board, taskId) {
  return eventsOf(board, taskId).map((e) => e.kind);
}

// ───────────── 配置规整 ─────────────

test('配置：dispatcherSessions 只接受非空字符串、去重；写错不炸（当没配）', () => {
  assert.deepEqual(normalizeDispatcherSessions([' a ', 'a', '', '  ', 42, null, 'b']), ['a', 'b']);
  assert.deepEqual(normalizeDispatcherSessions('session-boss'), []);
  assert.deepEqual(normalizeDispatcherSessions(undefined), []);
});

// ───────────── ① 命中：建一个子会话、投任务书、代签回执、写审计 ─────────────

test('① 命中：恰好建一个子会话，任务书带任务号/标题/要点，总管身份代签回执并落审计', async () => {
  const board = newBoard();
  const task = makeTask(board);
  seedDispatch(board, task.task_id);
  const host = makeHost();

  const r = await serviceDispatchRequests(makeDeps(host, board, { cwd: 'C:/work', agentPreset: 'dev' }));

  assert.equal(r.spawned.length, 1, '一次派发只该 spawn 一次');
  assert.equal(host.createCalls.length, 1, '宿主 create 必须恰好调用一次');
  assert.deepEqual(host.createCalls[0], { cwd: 'C:/work', agentPreset: 'dev' }, 'cwd/preset 透传给宿主');
  assert.equal(host.promptCalls.length, 1, '新会话是空白会话，必须把任务书作为 prompt 投进去');

  const prompt = host.promptCalls[0];
  assert.equal(prompt.sessionId, 'child-1');
  assert.equal(prompt.mode, 'queue');
  assert.equal(typeof prompt.requestId, 'string');
  const text = prompt.content[0].text;
  assert.match(text, new RegExp(task.task_id), '任务书必须带任务号');
  assert.match(text, /总管分流用例/, '任务书必须带标题');
  assert.match(text, /report\.txt/, '任务书必须带任务书要点（brief）');
  assert.match(text, /mesh_task_claim/);
  assert.match(text, /mesh_task_report/);
  assert.match(text, /mesh_task_complete/);
  assert.match(text, /不用再调 mesh_task_ack/, '回执已由总管代签：要明确告诉子会话不用 ack');

  // 代签回执：ack 的 acker 是总管会话，不是子会话
  const ackRow = board.db.prepare('SELECT * FROM ack WHERE task_id = ? ORDER BY ack_id DESC LIMIT 1').get(task.task_id);
  assert.notEqual(ackRow.acked_at, null, '总管必须代签回执');
  assert.equal(ackRow.acker, BOSS, '回执人必须是总管会话身份');
  assert.equal(board.getTask(task.task_id).ack_state, 'acked');

  // 审计：intent + spawned，spawned 里带子会话 id 与派发序号
  const kinds = kindsOf(board, task.task_id);
  assert.ok(kinds.includes('dispatcher.spawn_intent'), 'spawn 之前要先落 intent 事件');
  assert.ok(kinds.includes('dispatcher.spawned'), '成功 spawn 要落 spawned 事件');
  const spawned = eventsOf(board, task.task_id).find((e) => e.kind === 'dispatcher.spawned');
  assert.equal(spawned.payload.child_session, 'child-1');
  assert.equal(spawned.payload.task_id, task.task_id);
  assert.equal(spawned.payload.peer_session, BOSS);
  assert.equal(spawned.payload.ack_deadline_at, ackRow.deadline_at);

  // 去重游标落板
  const cursor = board.getCursor(INSTANCE, dispatcherCursorKey(BOSS));
  assert.ok(cursor > 0, '去重游标必须落在板上（重启后靠它不重复）');

  board.close();
});

test('① 补充：prompt 正文由 buildDispatcherPrompt 生成，含执行顺序与派发方', () => {
  const text = buildDispatcherPrompt({
    task: { task_id: 't-abc12345', title: '标题', brief: '要点', acceptance: '验收' },
    dispatcherSession: BOSS,
    fromInstance: INSTANCE,
  });
  assert.match(text, /【总管分流任务 t-abc12345】标题/);
  assert.match(text, /要点/);
  assert.match(text, /验收/);
  assert.match(text, new RegExp(`派发方实例：${INSTANCE}`));
  assert.match(text, /mesh_task_heartbeat/, '长跑任务要提示续租，别让租约过期');
});

// ───────────── ① 契约锁：prompt(request, signal) 的 signal 是必填的 ─────────────

test('① 契约锁：prompt 必须收到真实 AbortSignal（宿主实现第一行就是 signal.throwIfAborted）', async () => {
  const board = newBoard();
  const task = makeTask(board);
  seedDispatch(board, task.task_id);
  const prompts = [];
  let created = 0;
  // 桩**按 app.asar 里 SessionController.prompt 的真实用法消费入参**：
  // 少了 signal 就直接 TypeError（宿主 lib/types/index.js:538-539 的行为），
  // 于是 spawn 会被判失败 —— 这条用例就是为了让"忘了传 signal"在单测里就变红，而不是等真机。
  const host = makeHost({
    create: async () => {
      created += 1;
      return { sessionId: `child-${created}` };
    },
    prompt: async (request, signal) => {
      signal.throwIfAborted(); // ← 宿主 prompt 的第一行（lib/types/index.js:539）
      if (!Array.isArray(request?.content) || request.content.length === 0) {
        throw new Error('prompt content 不能为空'); // ← 宿主同款校验（lib/types/index.js:540）
      }
      prompts.push({ request, signal });
      return { accepted: true };
    },
  });

  const r = await serviceDispatchRequests(makeDeps(host, board));

  assert.equal(r.spawned.length, 1, 'prompt 拿不到 signal 时宿主会抛 TypeError；这里还必须能 spawn 成功');
  assert.equal(prompts.length, 1);
  const signal = prompts[0].signal;
  assert.equal(typeof signal, 'object', 'prompt 的第二个参数必须是对象（AbortSignal）');
  assert.ok(signal !== null, 'prompt 的第二个参数不能是 null/undefined');
  assert.equal(
    typeof signal.throwIfAborted,
    'function',
    '必须是 AbortSignal 形状 —— 宿主实现直接调 signal.throwIfAborted()',
  );
  assert.equal(signal.aborted, false, '新建的 signal 不该已经是取消状态');
  assert.equal(prompts[0].request.mode, 'queue', 'mode 必须是宿主认识的 queue/steer');
  assert.ok(prompts[0].request.requestId.length > 0, 'requestId 必须是非空字符串（宿主记进 source.rpcId）');

  board.close();
});

test('① 契约锁：每次 spawn 各自新建 AbortSignal，不复用同一个 controller', async () => {
  const board = newBoard();
  const task = makeTask(board);
  const host = makeHost();
  const deps = makeDeps(host, board);

  seedDispatch(board, task.task_id);
  await serviceDispatchRequests(deps);
  seedDispatch(board, task.task_id); // 派发方重派 → 第二次 spawn
  const r = await serviceDispatchRequests(deps);

  assert.equal(r.spawned.length, 1);
  assert.equal(host.promptSignals.length, 2, '两次 spawn 各投一次 prompt');
  assert.notEqual(host.promptSignals[0], host.promptSignals[1], '两次 spawn 不能复用同一个 signal');
  for (const signal of host.promptSignals) {
    assert.equal(typeof signal?.throwIfAborted, 'function');
  }

  board.close();
});

// ───────────── ② 未命中 / 跨实例 / 没送到：都不许建会话 ─────────────

test('② 未命中：派给非总管会话的派发不建子会话、不代签', async () => {
  const board = newBoard();
  const task = makeTask(board);
  seedDispatch(board, task.task_id, { session: 'session-worker' });
  const host = makeHost();

  const r = await serviceDispatchRequests(makeDeps(host, board));

  assert.equal(r.spawned.length, 0);
  assert.equal(host.createCalls.length, 0);
  assert.equal(host.promptCalls.length, 0);
  assert.equal(board.getTask(task.task_id).ack_state, 'pending', '不是我不该动它：回执还得留给真正的接收端');
  board.close();
});

test('② 补充：别的实例的总管不归我处理（同一块板上可能配多个实例的总管）', async () => {
  const board = newBoard();
  const task = makeTask(board);
  seedDispatch(board, task.task_id, { instance: 'instance-other' });
  const host = makeHost();

  const r = await serviceDispatchRequests(makeDeps(host, board));

  assert.equal(r.spawned.length, 0);
  assert.equal(host.createCalls.length, 0);
  board.close();
});

test('② 补充：delivered=false 的派发没有回执窗口，总管不处理（由派发方按"信没送到"收尾）', async () => {
  const board = newBoard();
  const task = makeTask(board);
  seedDispatch(board, task.task_id, { delivered: false });
  const host = makeHost();

  const r = await serviceDispatchRequests(makeDeps(host, board));

  assert.equal(r.spawned.length, 0);
  assert.equal(host.createCalls.length, 0);
  board.close();
});

// ───────────── ③ 去重：轮询不重复、重启不重复、一次派发只 spawn 一次 ─────────────

test('③ 重复轮询同一次派发：只 spawn 一次（去重游标在板上）', async () => {
  const board = newBoard();
  const task = makeTask(board);
  seedDispatch(board, task.task_id);
  const host = makeHost();
  const deps = makeDeps(host, board);

  const first = await serviceDispatchRequests(deps);
  const second = await serviceDispatchRequests(deps);
  const third = await serviceDispatchRequests(deps);

  assert.equal(first.spawned.length, 1);
  assert.equal(second.spawned.length, 0, '第二次轮询不该再建会话');
  assert.equal(third.spawned.length, 0);
  assert.equal(host.createCalls.length, 1, '宿主 create 总共只能被调一次');
  assert.equal(host.promptCalls.length, 1);
  assert.equal(kindsOf(board, task.task_id).filter((k) => k === 'dispatcher.spawned').length, 1);
  board.close();
});

test('③ 重启后不重复：新进程（全新宿主桩）拿同一块板也不再 spawn —— 证明去重不是只存内存', async () => {
  const board = newBoard();
  const task = makeTask(board);
  seedDispatch(board, task.task_id);

  const hostA = makeHost();
  await serviceDispatchRequests(makeDeps(hostA, board));
  assert.equal(hostA.createCalls.length, 1);

  // 模拟重启：内存里的任何状态都没了，只剩板上持久化的游标/事件
  const hostB = makeHost();
  const r = await serviceDispatchRequests(makeDeps(hostB, board));
  assert.equal(r.spawned.length, 0, '重启后不许再 spawn 一次');
  assert.equal(hostB.createCalls.length, 0);
  board.close();
});

test('③ 一次派发只 spawn 一次：派发方重派（第二次派发记录）→ 新的一条派发再 spawn 一次，不是漏掉也不是重复', async () => {
  const board = newBoard();
  const task = makeTask(board);
  seedDispatch(board, task.task_id);
  const host = makeHost();
  const deps = makeDeps(host, board);

  const first = await serviceDispatchRequests(deps);
  assert.equal(first.spawned.length, 1);
  assert.equal(board.getTask(task.task_id).ack_state, 'acked');

  // 派发方看到第一次超时/想重派：板上再来一条派发记录（新的回执窗口）
  seedDispatch(board, task.task_id);
  assert.equal(board.getTask(task.task_id).ack_state, 'pending', '重派会重新开一个回执窗口');
  const second = await serviceDispatchRequests(deps);

  assert.equal(second.spawned.length, 1, '每一条派发各 spawn 一次（重派不能漏掉）');
  assert.equal(host.createCalls.length, 2);
  assert.equal(kindsOf(board, task.task_id).filter((k) => k === 'dispatcher.spawned').length, 2);
  board.close();
});

// ───────────── ④ spawn 失败不许假装受理 ─────────────

test('④ create 抛错：不 ack（保持 pending 等 ack_timeout）、不投 prompt、落 failed 事件、且不重试', async () => {
  const board = newBoard();
  const task = makeTask(board);
  seedDispatch(board, task.task_id);
  const host = makeHost({
    create: async () => {
      const err = new Error('cwd 不可写');
      err.code = 'gateway/bad-request';
      throw err;
    },
  });
  const deps = makeDeps(host, board);

  const r = await serviceDispatchRequests(deps);

  assert.equal(r.spawned.length, 0);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].stage, 'create');
  assert.equal(r.failed[0].reason, 'create-failed');
  assert.match(r.failed[0].message, /gateway\/bad-request/);
  assert.equal(host.promptCalls.length, 0);

  // 核心：绝不能假装受理。ack 保持 pending → 到时限变 timeout，这是派发方该看到的诚实结论
  assert.equal(board.getTask(task.task_id).ack_state, 'pending', 'spawn 失败时 ack 必须保持 pending');
  const ackRow = board.db.prepare('SELECT * FROM ack WHERE task_id = ? ORDER BY ack_id DESC LIMIT 1').get(task.task_id);
  assert.equal(ackRow.acked_at, null);

  const kinds = kindsOf(board, task.task_id);
  assert.ok(kinds.includes('dispatcher.failed'), 'spawn 失败必须如实落事件');
  const failed = eventsOf(board, task.task_id).find((e) => e.kind === 'dispatcher.failed');
  assert.equal(failed.payload.stage, 'create');
  assert.match(failed.payload.message, /gateway\/bad-request/);

  // 去重提交点在 spawn 之前 → 下一轮不会把同一派发再试一遍（否则会对端反复建会话）
  const again = await serviceDispatchRequests(deps);
  assert.equal(again.spawned.length, 0);
  assert.equal(again.failed.length, 0, '已经处理过的派发不重复尝试');
  board.close();
});

test('④ 宿主没有 sessionController：不 ack、落 create-unsupported（不是抛异常）', async () => {
  const board = newBoard();
  const task = makeTask(board);
  seedDispatch(board, task.task_id);
  const host = makeHost();
  host.ctx.get = () => undefined;

  const r = await serviceDispatchRequests(makeDeps(host, board));

  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].reason, 'create-unsupported');
  assert.equal(host.createCalls.length, 0);
  assert.equal(board.getTask(task.task_id).ack_state, 'pending');
  board.close();
});

test('④ 会话建出来了但 prompt 投不进去：算失败（不 ack），并记下子会话 id 便于排查', async () => {
  const board = newBoard();
  const task = makeTask(board);
  seedDispatch(board, task.task_id);
  const host = makeHost({
    prompt: async () => {
      throw new Error('session inbox closed');
    },
  });

  const r = await serviceDispatchRequests(makeDeps(host, board));

  assert.equal(r.spawned.length, 0);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].stage, 'prompt');
  assert.equal(r.failed[0].childSessionId, 'child-1', '要记下已建出来的子会话，避免"凭空多了个会话"说不清');
  assert.equal(host.promptCalls.length, 0, 'prompt 抛错时没记到调用记录，用 create 次数断言');
  assert.equal(host.createCalls.length, 1);
  assert.equal(board.getTask(task.task_id).ack_state, 'pending');
  const failed = eventsOf(board, task.task_id).find((e) => e.kind === 'dispatcher.failed');
  assert.equal(failed.payload.stage, 'prompt');
  assert.equal(failed.payload.child_session, 'child-1');
  board.close();
});

test('④ 宿主没有 prompt 方法：同样算失败（子会话是空白会话，建出来也不知道要干什么）', async () => {
  const board = newBoard();
  const task = makeTask(board);
  seedDispatch(board, task.task_id);
  const host = makeHost({ prompt: 'skip' });

  const r = await serviceDispatchRequests(makeDeps(host, board));

  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].reason, 'prompt-unsupported');
  assert.equal(board.getTask(task.task_id).ack_state, 'pending');
  board.close();
});

// ───────────── ⑤ 去重提交点必须早于 spawn（游标写不上就绝不建会话）─────────────

test('⑤ 板写游标失败时绝不 spawn —— 否则重启后会对同一派发再建一个会话', async () => {
  const board = newBoard();
  const task = makeTask(board);
  seedDispatch(board, task.task_id);
  const host = makeHost();

  // 同一个板，只让 advanceCursor 坏掉：模拟"读得到派发、写不上去重位点"
  const broken = Object.create(board);
  broken.advanceCursor = () => {
    throw new Error('board write timeout');
  };

  const r = await serviceDispatchRequests({ ...makeDeps(host, board), board: broken });

  assert.equal(r.spawned.length, 0, '去重位点没落板就不许 spawn');
  assert.equal(r.failed.length, 0);
  assert.equal(host.createCalls.length, 0);
  assert.match(String(r.error), /推进总管游标失败/);
  assert.equal(board.getTask(task.task_id).ack_state, 'pending');
  board.close();
});

// ───────────── ⑥ 总管永不执行任务 ─────────────

test('⑥ claim 被明确拒绝：总管会话拿稳定错误码，任务状态不变；普通会话不受影响', async () => {
  const board = newBoard();
  const task = makeTask(board);
  const handlers = createHandlers({
    getBoard: () => board,
    getInterconnect: () => null,
    getDispatcherSessions: () => [BOSS],
  });

  await assert.rejects(
    () => handlers.mesh_task_claim({ taskId: task.task_id }, { agent: { id: BOSS } }),
    (err) => err.code === DISPATCHER_NOT_EXECUTOR && /总管/.test(err.message) && /不执行任务/.test(err.message),
    '总管认领必须被拒绝，且错误码/原因要清晰',
  );
  const after = board.getTask(task.task_id);
  assert.equal(after.lifecycle, 'open', '被拒后任务状态不能变');
  assert.equal(after.owner_session, null, '被拒后不能留下负责人');

  // 非总管会话照常可认领（别把门禁做成了误伤）
  const claimed = await handlers.mesh_task_claim({ taskId: task.task_id }, { agent: { id: 'session-worker' } });
  assert.match(claimed, /已认领/);
  assert.equal(board.getTask(task.task_id).owner_session, 'session-worker');
  board.close();
});

test('⑥ 补充：没配 dispatcherSessions 时（旧行为）任何会话都能正常认领', async () => {
  const board = newBoard();
  const task = makeTask(board);
  const handlers = createHandlers({ getBoard: () => board, getInterconnect: () => null });

  const out = await handlers.mesh_task_claim({ taskId: task.task_id }, { agent: { id: BOSS } });
  assert.match(out, /已认领/, '没配总管时不认人，行为与旧版一致');
  board.close();
});

// ───────────── ⑦ 任务状态：已终结不碰；已有人接手只代签不重复开工 ─────────────

test('⑦ 任务已终结：不建子会话、不代签（总管不该为死任务烧额度）', async () => {
  const board = newBoard();
  const task = makeTask(board);
  seedDispatch(board, task.task_id);
  board.cancelTask(task.task_id, 'session-peer', '不做了');
  const host = makeHost();

  const r = await serviceDispatchRequests(makeDeps(host, board));

  assert.equal(r.spawned.length, 0);
  assert.equal(host.createCalls.length, 0);
  assert.equal(r.skipped[0].reason, 'task-closed');
  board.close();
});

test('⑦ 已有人接手：只代签回执，不再建第二个子会话（同一任务双开工只会互相抢租约）', async () => {
  const board = newBoard();
  const task = makeTask(board);
  seedDispatch(board, task.task_id);
  board.claimTask(task.task_id, 'session-worker'); // 上一轮的子会话已经认领
  const host = makeHost();

  const r = await serviceDispatchRequests(makeDeps(host, board));

  assert.equal(r.spawned.length, 0);
  assert.equal(host.createCalls.length, 0);
  assert.equal(r.skipped[0].reason, 'task-already-owned');
  assert.equal(board.getTask(task.task_id).ack_state, 'acked', '已经有人接手时，总管可以代签"收到"');
  board.close();
});

// ───────────── ⑧ 定时器封装 ─────────────

test('⑧ startDispatcher：serviceOnce 可手动驱动；dispose 之后不再干活', async () => {
  const board = newBoard();
  const task = makeTask(board);
  seedDispatch(board, task.task_id);
  const host = makeHost();

  const dispatcher = startDispatcher({ ...makeDeps(host, board), pollMs: 60_000 });
  assert.equal(dispatcher.pollMs, 60_000, 'pollMs 应可配');
  const first = await dispatcher.serviceOnce();
  assert.equal(first.spawned.length, 1);
  assert.equal(host.createCalls.length, 1);

  dispatcher.dispose();
  const after = await dispatcher.serviceOnce();
  assert.equal(after, null, 'dispose 之后 serviceOnce 直接返回 null（不再读板/建会话）');
  assert.equal(host.createCalls.length, 1);
  board.close();
});

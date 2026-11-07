/**
 * e2e_remote.mjs — 两台机器共用一块板的端到端验收（A/B/C/D 四组）。
 *
 * 这不是"跑一遍看看"，是把派活单上的每条验收都变成可复跑的断言：
 *   A. 跨机闭环：A 建 → 派 → B 认领 → B 报真实证据 → B 完成 → A 看到 done，事件可回放
 *   B. 反例：无证据 / 自报无 ref / 路径不存在 / 哈希不符，四种全拒且留痕
 *   C. 断板与断隧道：明确失败、可诊断、不静默成功、不卡死
 *   D. 单机模式回归（由 tools/verify.mjs + 39 条测试覆盖，这里只断言不受影响）
 *
 * 用例里的 A、B 是**两个独立的 RemoteBoard 客户端**，指向同一个板服务 ——
 * 这正是两台设备的最小模型：各自进程、各自 session、共享一块板。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createHandlers } from '../src/handlers.js';
import { RemoteBoard } from '../src/remote.js';
import { startBoardService } from '../src/server.js';

const TOKEN = 'e2e-token-' + crypto.randomUUID().slice(0, 8);
const results = [];
let failures = 0;

function record(group, name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push(`  ✔ [${group}] ${name}`);
    })
    .catch((err) => {
      failures += 1;
      results.push(`  ✖ [${group}] ${name}`);
      results.push(`      ${err?.message ?? err}`);
    });
}

function section(title) {
  results.push('');
  results.push(`── ${title} ──`);
}

/** 每个"设备"一个 handler 集合，彼此不共享内存状态，只共享板服务。 */
function device(board, label) {
  const h = createHandlers({ getBoard: () => board, getInterconnect: () => null });
  const exec = { agent: { id: `session-${label}` } };
  return {
    label,
    call: (tool, args) => h[tool](args ?? {}, exec),
  };
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-e2e-'));
const dbPath = path.join(tmpRoot, 'board.db');

let svc = null;
let devA = null;
let devB = null;

async function main() {
  section('启动板服务（模拟 server 本机）');
  svc = await startBoardService({
    boardPath: dbPath,
    host: '127.0.0.1',
    port: 0, // 0 = 让系统挑空闲端口，避免与真实 13090 冲突
    token: TOKEN,
    logger: { warn: () => {}, info: () => {} },
  });
  const endpoint = `http://127.0.0.1:${svc.port}`;
  results.push(`  ✔ 板服务已起：${endpoint}`);
  results.push(`  ✔ 板文件：${dbPath}`);

  // 两个独立客户端 = 两台设备
  const boardA = new RemoteBoard({ endpoint, token: TOKEN });
  const boardB = new RemoteBoard({ endpoint, token: TOKEN });
  devA = device(boardA, 'A');
  devB = device(boardB, 'B');

  // ─────────────────────────── A. 跨机闭环 ───────────────────────────
  section('A. 两台机器闭环');

  let taskId = null;
  await record('A', 'A 建任务', async () => {
    const out = await devA.call('mesh_task_create', {
      title: '跨机闭环验收',
      brief: '由设备A建，设备B做',
      acceptance: 'B 报真实证据并完成',
      requestId: 'e2e-1',
    });
    const m = /task_id:\s*(t-[0-9a-f]+)/.exec(out);
    assert.ok(m, `没从输出里解析出 task_id：\n${out}`);
    taskId = m[1];
  });

  await record('A', 'B 能看到 A 建的任务（这就是"共用一块板"）', async () => {
    const list = await devB.call('mesh_task_list', {});
    assert.ok(list.includes(taskId), `设备的列表里没有 ${taskId}：\n${list}`);
  });

  await record('A', 'B 认领（不是 A 自己认领）', async () => {
    const out = await devB.call('mesh_task_claim', { taskId });
    assert.ok(out.includes('已认领'), out);
    assert.ok(out.includes('session-B'), `负责人应该是 B：\n${out}`);
  });

  // B 在自己的机器上造一个真实产物，报证据时只给本机路径
  const proofB = path.join(tmpRoot, 'proof-from-B.txt');
  const proofBytes = Buffer.from(`设备B的真实产物 ${crypto.randomUUID()}\n`, 'utf8');
  fs.writeFileSync(proofB, proofBytes);
  const proofSha = crypto.createHash('sha256').update(proofBytes).digest('hex');

  await record('A', 'B 报真实证据（给本机路径，客户端自动上传并转内容寻址）', async () => {
    const out = await devB.call('mesh_task_report', {
      taskId,
      executed: true,
      outcome: 'pass',
      note: '在设备B上生成了产物',
      evidenceRef: proofB,
    });
    assert.ok(out.includes('可采信：是'), `应该可采信：\n${out}`);
    assert.ok(out.includes('blob://sha256:'), `引用应被改写成内容寻址：\n${out}`);
    assert.ok(out.includes(proofSha), `服务端算出的哈希应与本地独立计算一致：\n期望 ${proofSha}\n实际输出:\n${out}`);
  });

  await record('A', 'B 完成（门禁在服务端判定）', async () => {
    const out = await devB.call('mesh_task_complete', { taskId });
    assert.ok(out.includes('任务已完成'), out);
    assert.ok(out.includes('done'), out);
  });

  await record('A', 'A 侧看到 done（闭环成立）', async () => {
    const out = await devA.call('mesh_task_list', { lifecycle: 'done' });
    assert.ok(out.includes(taskId), `A 的 done 列表里没有 ${taskId}：\n${out}`);
  });

  await record('A', '事件流可完整回放且顺序正确', async () => {
    const out = await devA.call('mesh_events', { taskId, limit: 50 });
    for (const kind of ['task.created', 'task.claimed', 'evidence.recorded', 'task.done']) {
      assert.ok(out.includes(kind), `事件流缺少 ${kind}：\n${out}`);
    }
    // 回放顺序：created 必须早于 done
    const seqOf = (kind) => {
      const m = new RegExp(`#(\\d+)[^\\n]*${kind}`).exec(out);
      return m === null ? -1 : Number(m[1]);
    };
    const created = seqOf('task.created');
    const done = seqOf('task.done');
    assert.ok(created > 0 && done > created, `created(${created}) 应早于 done(${done})：\n${out}`);
  });

  // ─────────────────────────── B. 反例必须仍被拒 ───────────────────────────
  section('B. 反例仍被拒（四条不变量不许放松）');

  let taskB = null;
  await record('B', '准备：A 建第二个任务并派给 B', async () => {
    const out = await devA.call('mesh_task_create', { title: '反例验收', requestId: 'e2e-2' });
    taskB = /task_id:\s*(t-[0-9a-f]+)/.exec(out)[1];
    await devB.call('mesh_task_claim', { taskId: taskB });
  });

  await record('B', '反例1：无证据直接完成 → 拒绝，且拒绝被记录', async () => {
    const out = await devB.call('mesh_task_complete', { taskId: taskB });
    assert.ok(out.includes('拒绝'), out);
    assert.ok(out.includes('NO_EVIDENCE'), out);
    // 拒绝必须留痕：单独查事件流里有没有 gate_rejected
    const ev = await devA.call('mesh_events', { taskId: taskB, limit: 50 });
    assert.ok(ev.includes('task.gate_rejected'), `拒绝没有留下审计记录：\n${ev}`);
  });

  await record('B', '反例2：自报 pass 但没有 evidenceRef → 不可采信', async () => {
    const out = await devB.call('mesh_task_report', {
      taskId: taskB,
      executed: true,
      outcome: 'pass',
      note: '我保证做完了',
    });
    assert.ok(out.includes('可采信：否'), out);
  });

  await record('B', '反例2 续：仍然不能完成（不可采信证据不算证据）', async () => {
    const out = await devB.call('mesh_task_complete', { taskId: taskB });
    assert.ok(out.includes('拒绝'), out);
    assert.ok(out.includes('NO_ADMISSIBLE_EVIDENCE'), out);
  });

  await record('B', '反例3：evidenceRef 指向不存在的路径 → 不可采信', async () => {
    const ghost = path.join(tmpRoot, 'does-not-exist-' + crypto.randomUUID() + '.txt');
    const out = await devB.call('mesh_task_report', {
      taskId: taskB,
      executed: true,
      outcome: 'pass',
      evidenceRef: ghost,
    });
    assert.ok(out.includes('可采信：否'), out);
  });

  await record('B', '反例4：哈希不一致（伪造 blob 引用）→ 不可采信', async () => {
    // 伪造一个形状合法、但板上不存在的 sha256
    const fakeSha = crypto.createHash('sha256').update('never-uploaded').digest('hex');
    const out = await devB.call('mesh_task_report', {
      taskId: taskB,
      executed: true,
      outcome: 'pass',
      evidenceRef: `blob://sha256:${fakeSha}`,
    });
    assert.ok(out.includes('可采信：否'), out);
    assert.ok(out.includes('板上没有这个内容寻址对象') || out.includes('不存在'), out);
  });

  await record('B', '反例5：blob 表里 key 与内容不自洽 → 判不存在（防御纵深）', async () => {
    // 正常路径下 putBlob 自己算 key，两者必然自洽；但库里被人改过、或将来 putBlob
    // 出了 bug 时，key 与内容就会对不上。这里直接造这种坏行，确认解析层不放行。
    const { resolveRef } = await import('../src/store.js');
    const fakeContent = Buffer.from('real bytes but wrong key');
    const fakeKey = crypto.createHash('sha256').update('completely different content').digest('hex');
    svc.board.backend.db
      .prepare('INSERT OR REPLACE INTO blob(sha256, size, bytes, created_at) VALUES (?,?,?,?)')
      .run(fakeKey, fakeContent.length, fakeContent, Date.now());
    const r = resolveRef(svc.board.backend, `blob://sha256:${fakeKey}`);
    svc.board.backend.db.prepare('DELETE FROM blob WHERE sha256 = ?').run(fakeKey);
    assert.equal(r.exists, false, 'key 与内容不自洽时必须判不存在，不能只信 key');
  });

  await record('B', '反例6：blob 哈希形状非法 → 明确判"不受支持"', async () => {
    const out = await devB.call('mesh_task_report', {
      taskId: taskB,
      executed: true,
      outcome: 'pass',
      evidenceRef: 'blob://sha256:not-a-real-hash',
    });
    assert.ok(out.includes('可采信：否'), out);
    assert.ok(out.includes('不受支持'), `形状非法的引用必须被明确拒绝：\n${out}`);
  });

  await record('B', '反例汇总：任务仍未完成（四条反例没有一条把它推过门禁）', async () => {
    const tasks = await devA.call('mesh_task_list', { lifecycle: 'done' });
    assert.ok(!tasks.includes(taskB), `反例任务不该出现在 done 里：\n${tasks}`);
    const all = await devA.call('mesh_task_list', {});
    assert.ok(all.includes(taskB), '任务本身应该还在板上');
  });

  // ─────────────────────────── C. 断板与断隧道 ───────────────────────────
  section('C. 断板 / 断隧道：明确失败、可诊断、不静默、不卡死');

  const deadEndpoint = 'http://127.0.0.1:1'; // 保证没人监听
  const deadBoard = new RemoteBoard({ endpoint: deadEndpoint, token: TOKEN, timeoutMs: 1500 });
  const devDead = device(deadBoard, 'DEAD');

  await record('C', '连不上板：明确报 BOARD_UNREACHABLE 且带诊断提示', async () => {
    const t0 = Date.now();
    let caught = null;
    try {
      await devDead.call('mesh_task_list', {});
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - t0;
    assert.ok(caught !== null, '不该静默成功');
    assert.equal(caught.code, 'BOARD_UNREACHABLE', `错误码应为 BOARD_UNREACHABLE，实际 ${caught.code}: ${caught.message}`);
    assert.ok(/板服务|隧道|endpoint/.test(caught.message), `错误信息应可诊断：${caught.message}`);
    assert.ok(elapsed < 8000, `不该卡死，实际耗时 ${elapsed}ms`);
  });

  await record('C', '密钥错误：明确报 UNAUTHORIZED，不静默放行', async () => {
    const bad = new RemoteBoard({ endpoint, token: 'wrong-token' });
    const devBad = device(bad, 'BAD');
    let caught = null;
    try {
      await devBad.call('mesh_task_list', {});
    } catch (err) {
      caught = err;
    }
    assert.ok(caught !== null, '密钥错误必须失败');
    assert.equal(caught.code, 'UNAUTHORIZED', `应为 UNAUTHORIZED，实际 ${caught?.code}: ${caught?.message}`);
  });

  await record('C', '板服务中途停掉：操作立刻失败，不返回假成功', async () => {
    const liveBoard = new RemoteBoard({ endpoint, token: TOKEN, timeoutMs: 2000 });
    const devLive = device(liveBoard, 'LIVE');
    // 先确认此刻是通的
    const before = await devLive.call('mesh_task_list', {});
    assert.ok(typeof before === 'string');

    await svc.close();
    svc = null;

    const t0 = Date.now();
    let caught = null;
    try {
      await devLive.call('mesh_task_list', {});
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - t0;
    assert.ok(caught !== null, '板停了却操作成功 —— 这就是静默成功，绝不允许');
    assert.ok(
      caught.code === 'BOARD_UNREACHABLE' || caught.code === 'TIMEOUT',
      `应为 BOARD_UNREACHABLE/TIMEOUT，实际 ${caught.code}: ${caught.message}`,
    );
    assert.ok(elapsed < 8000, `不该卡死，实际 ${elapsed}ms`);
  });

  await record('C', '超时是显式配置的，不是无限等', async () => {
    // 指向一个会接受连接但不回应的地址：用本地起一个只 listen 不回包的 server
    const net = await import('node:net');
    const silent = net.createServer(() => {
      /* 故意不回任何字节 */
    });
    await new Promise((r) => silent.listen(0, '127.0.0.1', r));
    const silentPort = silent.address().port;
    const slowBoard = new RemoteBoard({ endpoint: `http://127.0.0.1:${silentPort}`, token: TOKEN, timeoutMs: 800 });
    const devSlow = device(slowBoard, 'SLOW');
    const t0 = Date.now();
    let caught = null;
    try {
      await devSlow.call('mesh_task_list', {});
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - t0;
    silent.close();
    assert.ok(caught !== null, '对端不回应必须超时失败');
    assert.equal(caught.code, 'TIMEOUT', `应为 TIMEOUT，实际 ${caught?.code}: ${caught?.message}`);
    assert.ok(elapsed < 5000, `应在配置的超时附近返回，实际 ${elapsed}ms`);
  });

  // ─────────────────────────── D. 单机模式未被破坏 ───────────────────────────
  section('D. 单机模式回归（不启用远端后端）');
  await record('D', '本地 Board 仍然同步可用（39 条既有用例由 npm test 覆盖）', async () => {
    const { Board } = await import('../src/store.js');
    const localPath = path.join(tmpRoot, 'local.db');
    const local = new Board(localPath);
    const { task } = local.createTask({ title: '本机', brief: '', acceptance: '', requestId: null }, 's1');
    assert.equal(task.lifecycle, 'open');
    local.claimTask(task.task_id, 's1');
    const f = path.join(tmpRoot, 'local-proof.txt');
    fs.writeFileSync(f, 'ok');
    const ev = local.reportEvidence(task.task_id, { executed: true, outcome: 'pass', evidenceRef: f }, 's1');
    assert.equal(ev.admissible, true);
    const done = local.completeTask(task.task_id, 's1');
    assert.equal(done.task.lifecycle, 'done');
    local.close();
  });

  await record('D', 'file:// 引用与裸路径指向同一文件，哈希一致', async () => {
    const { Board } = await import('../src/store.js');
    const local = new Board(path.join(tmpRoot, 'local2.db'));
    const { task } = local.createTask({ title: 'uri', brief: '', acceptance: '', requestId: null }, 's1');
    local.claimTask(task.task_id, 's1');
    const f = path.join(tmpRoot, 'uri-proof.txt');
    fs.writeFileSync(f, 'uri-content');
    const asPath = local.reportEvidence(task.task_id, { executed: true, outcome: 'pass', evidenceRef: f }, 's1');
    const fileUri = 'file:///' + f.replace(/\\/g, '/');
    const asUri = local.reportEvidence(task.task_id, { executed: true, outcome: 'pass', evidenceRef: fileUri }, 's1');
    assert.equal(asPath.ref_sha256, asUri.ref_sha256, `裸路径与 file:// 应算出同一个哈希：${asPath.ref_sha256} vs ${asUri.ref_sha256}`);
    local.close();
  });

  // ─────────────────────────── 汇总 ───────────────────────────
  results.push('');
  results.push(failures === 0 ? `════ 全部通过（${results.filter((r) => r.includes('✔')).length} 项） ════` : `════ 失败 ${failures} 项 ════`);
  console.log(results.join('\n'));
  return failures;
}

main()
  .then(async (failures) => {
    if (svc !== null) await svc.close().catch(() => {});
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    process.exitCode = failures === 0 ? 0 : 1;
  })
  .catch(async (err) => {
    console.error('E2E 崩溃：', err);
    if (svc !== null) await svc.close().catch(() => {});
    process.exitCode = 1;
  });

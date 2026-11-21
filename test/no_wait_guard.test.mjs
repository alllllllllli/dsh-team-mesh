/**
 * no_wait_guard.test.mjs — 0.7「禁等待守卫」。
 *
 * 为什么值得单测：守卫一旦误伤，主人自己的长命令会被拦；一旦漏拦，
 * 派出去的子会话又用 `sleep 60` 把租约和发起方的等待一起拖长。
 * 所以三件事必须分别钉死：命中 / 不命中 / 关闭开关。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createWorkerRegistry,
  DEFAULT_NO_WAIT_MODE,
  evaluateNoWaitCall,
  FOREGROUND_TIMEOUT_LIMIT_MS,
  installNoWaitGuard,
  JOB_WAIT_LIMIT_MS,
  normalizeNoWaitMode,
} from '../src/noWait.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TOOLS_ENTRY = path.join(ROOT, 'vendor', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');

const tmps = [];
function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-nowait-'));
  tmps.push(d);
  return d;
}
process.on('exit', () => {
  for (const d of tmps) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* ignore */
    }
  }
});

// ───────────────────────── 纯函数：命中 / 不命中 ─────────────────────────

test('命中：bash / pwsh 命令里出现 sleep（含 Start-Sleep）被拒，原因可读', () => {
  for (const command of ['sleep 60', 'sleep 0.5 && ls', 'Start-Sleep -Seconds 30', 'echo x; sleep(5)']) {
    const reason = evaluateNoWaitCall('bash', { command });
    assert.ok(typeof reason === 'string' && reason.includes('noWait'), `应拒绝 ${command}`);
    assert.match(reason, /sleep/, '原因里必须点名 sleep');
    assert.match(reason, /run_in_background|job_output|heartbeat/, '原因里必须给可执行的改法');
  }
  assert.ok(evaluateNoWaitCall('pwsh', { command: 'Start-Sleep -Milliseconds 100' }) !== null);
});

test('命中：前台 timeoutMs > 30000 被拒；跑后台或小 timeout 放行', () => {
  const over = FOREGROUND_TIMEOUT_LIMIT_MS + 1;
  assert.notEqual(evaluateNoWaitCall('bash', { command: 'npm test', timeoutMs: over }), null);
  assert.notEqual(evaluateNoWaitCall('pwsh', { command: 'npm test', timeoutMs: 600_000 }), null);
  // 后台：不受前台超时限制（宿主语义：后台任务没有 timeout）
  assert.equal(evaluateNoWaitCall('bash', { command: 'npm test', timeoutMs: over, run_in_background: true }), null);
  // 正好 30000 与更小值放行
  assert.equal(evaluateNoWaitCall('bash', { command: 'npm test', timeoutMs: FOREGROUND_TIMEOUT_LIMIT_MS }), null);
  assert.equal(evaluateNoWaitCall('bash', { command: 'npm test', timeoutMs: 5000 }), null);
  // 不传 timeoutMs 放行（由宿主默认值决定，守卫不猜）
  assert.equal(evaluateNoWaitCall('bash', { command: 'npm test' }), null);
});

test('命中：job_output wait 的有效等待 > 5000 被拒；短等待/不等待放行', () => {
  // wait:true 不传 timeout_ms → 宿主默认 30s > 5s 上限
  assert.notEqual(evaluateNoWaitCall('job_output', { job_id: 'j-1', wait: true }), null);
  assert.notEqual(evaluateNoWaitCall('job_output', { job_id: 'j-1', wait: true, timeout_ms: JOB_WAIT_LIMIT_MS + 1 }), null);
  assert.equal(evaluateNoWaitCall('job_output', { job_id: 'j-1', wait: true, timeout_ms: JOB_WAIT_LIMIT_MS }), null);
  assert.equal(evaluateNoWaitCall('job_output', { job_id: 'j-1', wait: true, timeout_ms: 1000 }), null);
  // 不等待：读一眼就走，放行
  assert.equal(evaluateNoWaitCall('job_output', { job_id: 'j-1' }), null);
  assert.equal(evaluateNoWaitCall('job_output', { job_id: 'j-1', wait: false }), null);
  // 其它工具一律不碰
  assert.equal(evaluateNoWaitCall('mesh_task_heartbeat', { taskId: 't-1' }), null);
  assert.equal(evaluateNoWaitCall('job_list', {}), null);
});

test('配置规整：默认 mesh-workers；all / off 可用；拼错回默认并 WARN', () => {
  assert.equal(DEFAULT_NO_WAIT_MODE, 'mesh-workers');
  assert.equal(normalizeNoWaitMode(undefined), 'mesh-workers');
  assert.equal(normalizeNoWaitMode(''), 'mesh-workers');
  assert.equal(normalizeNoWaitMode('ALL'), 'all');
  assert.equal(normalizeNoWaitMode(' off '), 'off');
  const logs = [];
  assert.equal(normalizeNoWaitMode('offf', { warn: (m) => logs.push(m) }), 'mesh-workers');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /noWaitGuard/);
});

// ───────────────────────── 登记表 ─────────────────────────

test('worker 登记表：mark/release/has 正确，完成一个任务不会误删同会话的另一个', () => {
  const reg = createWorkerRegistry();
  assert.equal(reg.has('s-1'), false);
  reg.mark('s-1', 't-a');
  reg.mark('s-1', 't-b');
  assert.equal(reg.has('s-1'), true);
  reg.release('s-1', 't-a');
  assert.equal(reg.has('s-1'), true, '另一个任务还在，仍算持有');
  reg.release('s-1', 't-b');
  assert.equal(reg.has('s-1'), false);
  assert.equal(reg.has('s-2'), false);
  assert.equal(reg.size, 0);
});

// ───────────────────────── 守卫安装 ─────────────────────────

function fakeTools() {
  const guards = [];
  return {
    guards,
    tools: {
      register: () => () => {},
      guard(fn) {
        guards.push(fn);
        return () => {
          const i = guards.indexOf(fn);
          if (i >= 0) guards.splice(i, 1);
        };
      },
    },
  };
}

test('关闭开关：off 不注册任何 guard；宿主没有 guard 时也不抛（只 WARN）', () => {
  const { guards, tools } = fakeTools();
  const dispose = installNoWaitGuard({ ctx: { tools }, mode: 'off' });
  assert.equal(guards.length, 0, 'off 不许注册守卫');
  dispose();

  const logs = [];
  const dispose2 = installNoWaitGuard({
    ctx: { tools: {} },
    mode: 'all',
    logger: { warn: (m) => logs.push(m) },
  });
  assert.equal(typeof dispose2, 'function');
  assert.doesNotThrow(() => dispose2());
  assert.equal(logs.length, 1);
  assert.match(logs[0], /guard/);
});

test('mesh-workers：非 worker 会话放行，worker 会话命中；all：谁都拦', () => {
  // mesh-workers
  const mesh = fakeTools();
  const isWorker = (sessionId) => sessionId === 's-worker';
  const dispose = installNoWaitGuard({ ctx: { tools: mesh.tools }, mode: 'mesh-workers', isMeshWorker: isWorker });
  assert.equal(mesh.guards.length, 1);
  const guard = mesh.guards[0];
  const exec = (sessionId, name, args) => ({ name, arguments: args, agent: { id: sessionId } });
  assert.equal(guard(exec('s-boss', 'bash', { command: 'sleep 10' })), undefined, '非 worker 不拦');
  const denial = guard(exec('s-worker', 'bash', { command: 'sleep 10' }));
  assert.equal(typeof denial, 'string');
  assert.match(denial, /noWait/);
  // 守卫自身内部异常一律放行（不是安全边界，不能把工具全卡死）
  assert.equal(
    guard({ name: 'bash', arguments: { command: 'sleep 1' }, get agent() { throw new Error('boom'); } }),
    undefined,
    '读取 exec 出错时必须放行而不是抛出去',
  );
  dispose();

  // all
  const all = fakeTools();
  installNoWaitGuard({ ctx: { tools: all.tools }, mode: 'all' });
  assert.equal(all.guards.length, 1);
  assert.equal(typeof all.guards[0](exec('s-boss', 'pwsh', { command: 'sleep 30' })), 'string');
});

// ───────────────────────── 端到端：apply 真的装上守卫，按"持有任务"生效 ─────────────────────────

test('配置别名：applyTo 与 noWaitGuard 同义；off 时不装守卫', async () => {
  const prev = process.env.DSH_TOOLS_PATH;
  process.env.DSH_TOOLS_PATH = TOOLS_ENTRY;
  try {
    const { apply } = await import('../src/index.js');
    const run = async (config) => {
      const { guards, tools } = fakeTools();
      const ctx = {
        tools: { ...tools, register: () => () => {} },
        on: () => () => {},
        logger: { info() {}, warn() {}, error() {} },
      };
      const dispose = await apply(ctx, { boardPath: path.join(tempDir(), 'team.db'), ...config });
      const count = guards.length;
      dispose();
      return count;
    };
    assert.equal(await run({ noWaitGuard: 'off' }), 0, 'noWaitGuard:off 不装');
    assert.equal(await run({ applyTo: 'off' }), 0, 'applyTo:off 同样不装');
    assert.equal(await run({ applyTo: 'all' }), 1, 'applyTo 别名生效');
  } finally {
    if (prev === undefined) delete process.env.DSH_TOOLS_PATH;
    else process.env.DSH_TOOLS_PATH = prev;
  }
});

test('apply 集成：持有 mesh 任务的会话被拦，完成/取消后放行', async () => {
  const prev = process.env.DSH_TOOLS_PATH;
  process.env.DSH_TOOLS_PATH = TOOLS_ENTRY;
  try {
    const { apply } = await import('../src/index.js');
    const { guards, tools } = fakeTools();
    const registered = [];
    const logs = [];
    const ctx = {
      tools: {
        ...tools,
        register(tool) {
          registered.push(tool);
          return () => {};
        },
      },
      on: () => () => {},
      logger: { info: (m) => logs.push(`info: ${m}`), warn: (m) => logs.push(`warn: ${m}`), error: (m) => logs.push(`error: ${m}`) },
    };
    const dispose = await apply(ctx, { boardPath: path.join(tempDir(), 'team.db'), noWaitGuard: 'mesh-workers' });
    assert.equal(guards.length, 1, '应装上 noWait 守卫');
    const guard = guards[0];
    const exec = (sessionId) => ({ name: 'bash', arguments: { command: 'sleep 30' }, agent: { id: sessionId } });
    const byName = new Map(registered.map((t) => [t.name, t]));

    // 还没认领任务 → 不拦
    assert.equal(guard(exec('s-worker')), undefined);

    const created = await byName.get('mesh_task_create').execute({ title: '守卫测试' }, { agent: { id: 's-boss' } });
    const taskId = created.match(/task_id: (t-[0-9a-f]{8})/)[1];
    await byName.get('mesh_task_claim').execute({ taskId }, { agent: { id: 's-worker' } });
    // 认领后 → 拦
    const denial = guard(exec('s-worker'));
    assert.equal(typeof denial, 'string', '持有任务的会话必须被拦');
    assert.match(denial, /sleep/);
    // 别的会话（没持有任务）不拦
    assert.equal(guard(exec('s-boss')), undefined);

    // 取消（放行出口）后不再拦
    await byName.get('mesh_task_cancel').execute({ taskId, reason: 'dropped: 测试收尾' }, { agent: { id: 's-worker' } });
    assert.equal(guard(exec('s-worker')), undefined, '任务收尾后不再拦截');
    dispose();
  } finally {
    if (prev === undefined) delete process.env.DSH_TOOLS_PATH;
    else process.env.DSH_TOOLS_PATH = prev;
  }
});

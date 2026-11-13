/**
 * lease_client_child.mjs — 以**独立进程**充当"另一台设备上的客户端"，跑一次租约操作。
 *
 * 用法：node lease_client_child.mjs '<json>'
 *   json = {
 *     endpoint, token, taskId, actor, leaseMs,
 *     mode: 'claim' | 'heartbeat' | 'claim-then-heartbeat',
 *     identity?: {pid,start_sec,host},   // 伪造"我是谁"（模拟 PID 复用）
 *     legacy?: true                      // 模拟 0.3.3 老客户端：body 里不带 leaseIdentity
 *   }
 *
 * 为什么是独立进程：租约身份的核心是 pid。同一个进程里造不出"另一个 pid"，
 * 而伪造 `process.pid` 又会让测试失去意义。真起一个进程，pid 就是真的不同 ——
 * 于是"板服务记的是调用方 pid 还是它自己的 pid"这件事才有可判定的差别。
 *
 * **HTTP 层一律真实**：真 socket、真板服务、真 JSON 往返。本文件只做两件不涉及传输的事：
 *   - `identity`：替换"我要声称我是谁"（不改请求结构，只改字段值）
 *   - `legacy`  ：把 body 里的 leaseIdentity 键整个去掉（0.3.3 老客户端就是这个样子）
 *
 * 结果以一行 JSON 打到 stdout。
 */
import os from 'node:os';

import { RemoteBoard } from '../../src/remote.js';

const args = JSON.parse(process.argv[2] ?? '{}');
const board = new RemoteBoard({ endpoint: args.endpoint, token: args.token, timeoutMs: 8000 });

// 记住"默认身份"——即 remote.js 自己算出来的那个，用于证明字段真的过了线
const builtinIdentity = board.leaseIdentity();

if (args.identity !== undefined) {
  // 只替换身份值：请求结构、序列化、鉴权全部走真实代码路径
  board.leaseIdentity = () => ({ ...args.identity });
}

if (args.legacy === true) {
  // 复刻 0.3.3 的请求体：同一个 body，只是没有 leaseIdentity 这个键。
  // 这不是 mock HTTP —— 请求照样真发出去，只是少一个字段（正是改动前的实际行为）。
  const origCall = board.call.bind(board);
  board.call = (method, p, opts = {}) => {
    if (opts.body !== null && typeof opts.body === 'object' && 'leaseIdentity' in opts.body) {
      const { leaseIdentity: _dropped, ...rest } = opts.body;
      return origCall(method, p, { ...opts, body: rest });
    }
    return origCall(method, p, opts);
  };
}

const reportedIdentity = board.leaseIdentity();

async function run() {
  const out = { mode: args.mode, child_pid: process.pid, child_host: os.hostname() };

  if (args.mode === 'claim' || args.mode === 'claim-then-heartbeat') {
    const r = await board.claimTask(args.taskId, args.actor, { leaseMs: args.leaseMs });
    out.claim = { ok: true, deduped: r.deduped, lease_pid: r.task?.lease_pid ?? null };
  }
  if (args.mode === 'heartbeat' || args.mode === 'claim-then-heartbeat') {
    const r = await board.heartbeat(args.taskId, args.actor, { leaseMs: args.leaseMs });
    out.heartbeat = { ok: true, was_stale: r.was_stale, lease_pid: r.task?.lease_pid ?? null };
  }

  process.stdout.write(JSON.stringify({ ok: true, ...out, reported_identity: reportedIdentity }) + '\n');
}

run().catch((err) => {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      mode: args.mode,
      code: err?.code ?? 'UNKNOWN',
      message: String(err?.message ?? err),
      detail: err?.detail ?? null,
      child_pid: process.pid,
      child_host: os.hostname(),
      reported_identity: reportedIdentity,
    }) + '\n',
  );
  process.exitCode = 1;
});

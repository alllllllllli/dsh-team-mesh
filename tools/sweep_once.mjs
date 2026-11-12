/**
 * sweep_once.mjs — P0-1 **方案 B（外部触发）**。
 *
 * 不依赖板服务进程里的定时器：自己周期性地 `POST /sweep`，
 * 让「谁负责清扫」从服务进程解耦出去。
 *
 * 为什么要有这个方案：方案 A（进程内 setInterval）有两个结构性弱点 ——
 *   1. 它和板服务同生共死。板服务挂住（事件循环卡死、库锁死等）时，清扫也一起停，
 *      而且此时正是最需要有人在外面戳它的时候。
 *   2. 它无法在服务启动之前或崩溃之后工作。
 * 外部触发把清扫变成「另一个故障域的事」，用进程隔离换取故障隔离。
 *
 * 代价也写清楚（别只讲好处）：
 *   - 多一个要维护的进程/计划任务，多一个会悄悄死掉的东西（所以要带 --watch 心跳）。
 *   - 密钥要再复制一份到外部（这里从环境变量或启动脚本读，不硬编码）。
 *   - 跨进程写同一个 SQLite：靠板服务的 HTTP 接口串行化，不自己开库，所以不抢锁。
 *
 * 用法：
 *   node tools/sweep_once.mjs --once                     # 跑一次（适合计划任务）
 *   node tools/sweep_once.mjs --watch --interval 60      # 常驻，每 60s 一次
 *   node tools/sweep_once.mjs --once --endpoint http://127.0.0.1:13090
 *
 * 退出码：0 = 成功；1 = 失败（计划任务据此报警，不静默吞错）。
 * 密钥来源优先级：--token > DSH_TEAM_BOARD_TOKEN 环境变量 > 启动脚本解析（可选）。
 * **绝不把密钥打进日志或 stdout。**
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { URL } from 'node:url';

function parseArgs(argv) {
  const out = { endpoint: 'http://127.0.0.1:13090', once: false, watch: false, interval: 60, token: null, quiet: false, timeoutMs: 10000 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--once') out.once = true;
    else if (a === '--watch') out.watch = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--interval') { out.interval = Number(argv[++i]); }
    else if (a === '--endpoint') { out.endpoint = argv[++i]; }
    else if (a === '--token') { out.token = argv[++i]; }
    else if (a === '--timeout-ms') { out.timeoutMs = Number(argv[++i]); }
    else if (a === '--help' || a === '-h') { out.help = true; }
    else throw new Error(`未知参数：${a}`);
  }
  if (!out.once && !out.watch && !out.help) out.once = true; // 默认跑一次
  return out;
}

/** 从启动脚本里取密钥。只取，不打印。取不到返回 ''。 */
function tokenFromLauncher(scriptPath) {
  try {
    if (!fs.existsSync(scriptPath)) return '';
    const text = fs.readFileSync(scriptPath, 'utf8');
    const line = text.split(/\r?\n/).find((l) => l.includes('DSH_TEAM_BOARD_TOKEN'));
    if (!line) return '';
    const v = line.slice(line.indexOf('=') + 1).trim().replace(/^['"]/, '').replace(/['"]$/, '');
    return v;
  } catch {
    return '';
  }
}

function postSweep(endpoint, token, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL('/sweep', endpoint);
    const body = Buffer.from('{}', 'utf8');
    const headers = { 'content-type': 'application/json', 'content-length': String(body.length) };
    if (token !== '') headers['x-team-token'] = token;
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* ignore */ }
          resolve({ status: res.statusCode, json, text });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`请求超时（${timeoutMs}ms）`)));
    req.write(body);
    req.end();
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法：node tools/sweep_once.mjs [--once|--watch] [--interval 60] [--endpoint URL] [--token T] [--quiet]');
    return 0;
  }
  const token = args.token ?? process.env.DSH_TEAM_BOARD_TOKEN ?? tokenFromLauncher('C:\\Users\\admin\\dsh-team-board.ps1');
  if (token === '') {
    console.error('[sweep] 没有可用密钥：设 DSH_TEAM_BOARD_TOKEN 或传 --token。写路由会 401。');
    // 不直接退出：让服务端的 401 成为真实证据，而不是本地猜。
  }

  const tick = async () => {
    const startedAt = Date.now();
    try {
      const r = await postSweep(args.endpoint, token, args.timeoutMs);
      const ms = Date.now() - startedAt;
      if (r.status === 200 && r.json?.ok === true) {
        const ack = r.json.ack?.count ?? 0;
        const lease = r.json.lease?.count ?? 0;
        const sr = r.json.session_request ?? 0;
        if (!args.quiet) {
          console.log(`[sweep] ok ${new Date().toISOString()} ${ms}ms ack_timeouts=${ack} lease_stale=${lease} session_request_expired=${sr}`);
        }
        return true;
      }
      // 401 是配置问题（密钥不对），不是「暂时性失败」——要显式喊出来。
      console.error(`[sweep] FAIL HTTP ${r.status} ${r.json?.error?.code ?? ''} ${r.json?.error?.message ?? ''}`.trim());
      return false;
    } catch (err) {
      console.error(`[sweep] FAIL ${err?.message ?? err}`);
      return false;
    }
  };

  if (args.once) {
    const ok = await tick();
    return ok ? 0 : 1;
  }

  // --watch：常驻。单次失败不退出，但连续失败会累计上报（便于看门狗抓）。
  let consecutive = 0;
  const run = async () => {
    const ok = await tick();
    consecutive = ok ? 0 : consecutive + 1;
    if (consecutive >= 5) {
      console.error(`[sweep] 连续失败 ${consecutive} 次 —— 板服务可能已死，需要重启`);
    }
  };
  await run();
  const timer = setInterval(() => { void run(); }, Math.max(1, args.interval) * 1000);
  if (typeof timer.unref === 'function') timer.unref();
  // 常驻时保持进程活着
  await new Promise(() => {});
  return 0;
}

main().then((code) => { process.exitCode = code; }).catch((err) => {
  console.error(`[sweep] 致命错误：${err?.message ?? err}`);
  process.exitCode = 1;
});

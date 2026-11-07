/**
 * client_cli.mjs — 板服务的运维客户端（跨机自检 / 手工验证 / 排障）。
 *
 * 为什么需要它：模型侧的 mesh_* 工具在 DSH 里跑，运维想"不启动 DSH 也能确认
 * 第二台设备能不能连上"就需要一个命令行入口。它也是 README 里
 * "怎么在第二台设备上验证接入成功"那条命令的实现。
 *
 * 用法（全部走环境变量，避免密钥出现在命令行历史里）：
 *   set DSH_TEAM_BOARD_ENDPOINT=http://127.0.0.1:13090
 *   set DSH_TEAM_BOARD_TOKEN=<共享密钥>
 *   node tools/client_cli.mjs health
 *   node tools/client_cli.mjs list
 *   node tools/client_cli.mjs events --limit 20
 *   node tools/client_cli.mjs create --title "测试" [--brief "..." --acceptance "..."]
 *   node tools/client_cli.mjs claim --task t-xxxx
 *   node tools/client_cli.mjs report --task t-xxxx --ref "C:\path\proof.txt" --note "..."
 *   node tools/client_cli.mjs complete --task t-xxxx
 *   node tools/client_cli.mjs cancel --task t-xxxx --reason "..."
 *   node tools/client_cli.mjs put --file "C:\path\proof.txt"     # 只上传物证，返回 blob 引用
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { RemoteBoard } from '../src/remote.js';
import { TeamError } from '../src/domain.js';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i += 1;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function fail(msg, code = 1) {
  console.error(`✖ ${msg}`);
  process.exitCode = code;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const endpoint = process.env.DSH_TEAM_BOARD_ENDPOINT ?? args.endpoint ?? '';
  const token = process.env.DSH_TEAM_BOARD_TOKEN ?? args.token ?? '';

  if (cmd === undefined) {
    console.error('用法：node tools/client_cli.mjs <health|list|events|create|claim|report|complete|cancel|put> [选项]');
    process.exitCode = 1;
    return;
  }
  if (endpoint === '') {
    console.error('✖ 没给 endpoint：设置 DSH_TEAM_BOARD_ENDPOINT（例如 http://127.0.0.1:13090）');
    process.exitCode = 1;
    return;
  }

  let board;
  try {
    board = new RemoteBoard({ endpoint, token, timeoutMs: Number(process.env.DSH_TEAM_BOARD_TIMEOUT_MS ?? 10000) });
  } catch (err) {
    return fail(err.message);
  }

  const actor = process.env.DSH_TEAM_ACTOR ?? `cli-${crypto.randomUUID().slice(0, 8)}`;

  try {
    switch (cmd) {
      case 'health': {
        const h = await board.health();
        console.log(`✔ 板服务可达：${endpoint}`);
        console.log(`  service=${h.service} version=${h.version} schema=${h.schema_version}`);
        console.log(`  board=${h.board}  blobs=${h.blobs}`);
        if (token === '') console.log('  ⚠ 未设置 DSH_TEAM_BOARD_TOKEN：写操作会被拒绝（fail-closed）');
        break;
      }
      case 'list': {
        const tasks = await board.listTasks({ lifecycle: args.lifecycle, limit: args.limit ?? 20 });
        if (tasks.length === 0) {
          console.log('（板上没有符合条件的任务）');
          break;
        }
        for (const t of tasks) {
          console.log(`${t.task_id}  ${t.lifecycle.padEnd(8)}  owner=${t.owner_session ?? '-'}  ${t.title}`);
        }
        break;
      }
      case 'events': {
        const rows = await board.recentEvents(Number(args.limit ?? 20), args.task ?? null);
        for (const r of rows) {
          console.log(`#${r.seq} ${new Date(Number(r.created_at)).toISOString()} ${r.kind} ${r.task_id ?? '-'} ${JSON.stringify(r.payload)}`);
        }
        break;
      }
      case 'create': {
        if (args.title === undefined) return fail('create 需要 --title');
        const r = await board.createTask(
          { title: args.title, brief: args.brief ?? '', acceptance: args.acceptance ?? '', requestId: args['request-id'] ?? null },
          actor,
        );
        console.log(`${r.deduped ? '（幂等命中，返回原任务）' : '已建任务'}：${r.task.task_id}`);
        console.log(`  ${r.task.title}  lifecycle=${r.task.lifecycle}`);
        break;
      }
      case 'claim': {
        if (args.task === undefined) return fail('claim 需要 --task');
        const r = await board.claimTask(args.task, actor);
        console.log(`${r.deduped ? '本来就在你名下' : '已认领'}：${r.task.task_id}  lifecycle=${r.task.lifecycle}  owner=${r.task.owner_session}`);
        break;
      }
      case 'report': {
        if (args.task === undefined) return fail('report 需要 --task');
        const r = await board.reportEvidence(
          args.task,
          { executed: true, outcome: args.outcome ?? 'pass', note: args.note ?? '', evidenceRef: args.ref },
          actor,
        );
        console.log(`已记录证据 #${r.evidence_id}  可采信=${r.admissible ? '是' : '否'}`);
        if (r.uploaded !== null && r.uploaded !== undefined) {
          console.log(`  已上传并按内容寻址：${r.uploaded.ref}`);
          console.log(`  sha256（服务端算）=${r.uploaded.sha256}  ${r.uploaded.size} 字节`);
        }
        if (r.reasons !== undefined && r.reasons.length > 0) {
          for (const why of r.reasons) console.log(`  - ${why}`);
        }
        break;
      }
      case 'complete': {
        if (args.task === undefined) return fail('complete 需要 --task');
        const r = await board.completeTask(args.task, actor);
        console.log(`任务已完成：${r.task.task_id}  lifecycle=${r.task.lifecycle}`);
        break;
      }
      case 'cancel': {
        if (args.task === undefined) return fail('cancel 需要 --task');
        const r = await board.cancelTask(args.task, actor, args.reason ?? '');
        console.log(`已取消：${r.task.task_id}  lifecycle=${r.task.lifecycle}`);
        break;
      }
      case 'put': {
        const file = args.file;
        if (file === undefined) return fail('put 需要 --file');
        const abs = path.resolve(file);
        if (!fs.existsSync(abs)) return fail(`文件不存在：${abs}`);
        const r = await board.uploadLocalFile(abs);
        const local = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
        console.log(`已上传：${r.ref}`);
        console.log(`  size=${r.size}`);
        console.log(`  sha256（服务端算）=${r.sha256}`);
        console.log(`  sha256（本地算）  =${local}`);
        console.log(`  ${r.sha256 === local ? '✔ 两边一致' : '✖ 不一致（传输或存储有问题）'}`);
        break;
      }
      default:
        return fail(`未知命令：${cmd}`);
    }
  } catch (err) {
    if (err instanceof TeamError) {
      console.error(`✖ ${err.code}: ${err.message}`);
      if (Array.isArray(err.detail)) for (const d of err.detail) console.error(`    - ${d}`);
      process.exitCode = err.code === 'GATE_REJECTED' ? 2 : 1;
      return;
    }
    console.error(`✖ ${err?.stack ?? err}`);
    process.exitCode = 1;
  }
}

main();

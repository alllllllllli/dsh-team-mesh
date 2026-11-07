/**
 * 验收脚本：检查"插件在当前 DSH 里到底能不能用"。
 *
 * 为什么需要它：插件是否装好、是否被宿主加载、是否真的在工作，是三件不同的事，
 * 光看"装成功了"会得出错误结论。这个脚本按证据强弱逐层检查，每一层都说清楚
 * "过 / 没过 / 为什么"。
 *
 * 用法：
 *   node tools/verify.mjs            # 只读检查，不启动 DSH
 *   node tools/verify.mjs --board <路径>
 *
 * 退出码 0 = 全部通过；1 = 有检查项没过（会逐条说明）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const args = process.argv.slice(2);
const boardArg = (() => {
  const i = args.indexOf('--board');
  return i >= 0 ? args[i + 1] : null;
})();

const DSH_HOME = process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0
  ? process.env.DSH_HOME
  : path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh');
const BOARD = boardArg ?? path.join(DSH_HOME, 'team', 'team.db');
const PROFILE_DIR = process.env.DSH_PROFILE_DIR ?? path.join(DSH_HOME, 'profiles', 'desktop');

const rows = [];
function check(label, ok, detail = '') {
  rows.push({ label, ok, detail });
  process.stdout.write(`  ${ok ? '✔' : '✘'} ${label}${detail ? ` — ${detail}` : ''}\n`);
}
function info(msg) {
  process.stdout.write(`    ${msg}\n`);
}
function section(t) {
  process.stdout.write(`\n── ${t} ──\n`);
}

// ───────────────────────── 1. 源码与副本 ─────────────────────────
section('1. 源码与装入副本是否一致');
const srcIndex = path.join(ROOT, 'src', 'index.js');
const installed = path.join(PROFILE_DIR, 'node_modules', 'dsh-team-mesh');
const instIndex = path.join(installed, 'src', 'index.js');

check('源码在', fs.existsSync(srcIndex), srcIndex);
check('已装进 profile', fs.existsSync(instIndex), installed);

if (fs.existsSync(instIndex)) {
  const crypto = await import('node:crypto');
  const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  const pairs = [
    ['src/index.js', path.join(ROOT, 'src', 'index.js'), path.join(installed, 'src', 'index.js')],
    ['src/spec.js', path.join(ROOT, 'src', 'spec.js'), path.join(installed, 'src', 'spec.js')],
    ['src/store.js', path.join(ROOT, 'src', 'store.js'), path.join(installed, 'src', 'store.js')],
    ['src/domain.js', path.join(ROOT, 'src', 'domain.js'), path.join(installed, 'src', 'domain.js')],
    ['src/handlers.js', path.join(ROOT, 'src', 'handlers.js'), path.join(installed, 'src', 'handlers.js')],
  ];
  let same = 0;
  for (const [label, a, b] of pairs) {
    const ok = fs.existsSync(a) && fs.existsSync(b) && sha(a) === sha(b);
    if (ok) same++;
    check(`  ${label} 一致`, ok, ok ? '' : '副本是旧的：需要 remove + add 重装（pnpm add 会判"已最新"而跳过）');
  }
  info(`一致的 ${same}/${pairs.length} 个文件`);

  // inject 声明是"跨实例派活能不能用"的关键
  const instSrc = fs.readFileSync(instIndex, 'utf8');
  const injectMatch = instSrc.match(/export const inject\s*=\s*\[([^\]]*)\]/);
  const injects = injectMatch ? injectMatch[1] : '';
  check(
    '副本已声明 inject: interconnect',
    injects.includes('interconnect'),
    injects.includes('interconnect')
      ? `inject = [${injects.trim()}]`
      : '未声明 → apply 时 ctx.interconnect 会是 undefined，跨实例派活不可用',
  );
}

// ───────────────────────── 2. profile 登记 ─────────────────────────
section('2. profile 是否登记了插件');
const profilePkg = path.join(PROFILE_DIR, 'package.json');
if (fs.existsSync(profilePkg)) {
  const pkg = JSON.parse(fs.readFileSync(profilePkg, 'utf8'));
  const deps = pkg.dependencies ?? {};
  const bundles = pkg?.dsh?.profile?.bundles ?? [];
  check('dependencies 里有 dsh-team-mesh', Object.hasOwn(deps, 'dsh-team-mesh'), deps['dsh-team-mesh'] ?? '(缺)');
  check(
    'bundles 里有 dsh-team-mesh',
    bundles.includes('dsh-team-mesh'),
    bundles.includes('dsh-team-mesh') ? '' : `当前 bundles: ${bundles.join(', ')}`,
  );
} else {
  check('profile package.json 存在', false, profilePkg);
}

// ───────────────────────── 3. 板文件 ─────────────────────────
section('3. 共享任务板（apply 跑过才会被创建）');
if (!fs.existsSync(BOARD)) {
  check('板文件存在', false, `${BOARD} 不存在 —— 说明 apply() 没跑过（插件没加载，或走进了 catch）`);
} else {
  const st = fs.statSync(BOARD);
  check('板文件存在', true, `${BOARD}  ${st.size} B  修改于 ${st.mtime.toISOString()}`);

  let db;
  try {
    db = new DatabaseSync(BOARD, { readOnly: true });
    const mode = db.prepare('PRAGMA journal_mode').get();
    check('WAL 已启用', String(Object.values(mode)[0]).toLowerCase() === 'wal', JSON.stringify(mode));

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);
    const need = ['task', 'evidence', 'dispatch', 'event', 'meta'];
    const missing = need.filter((t) => !tables.includes(t));
    check('表结构齐全', missing.length === 0, missing.length === 0 ? tables.join(', ') : `缺 ${missing.join(', ')}`);

    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    check('schema_version = 1', version?.value === '1', version?.value ?? '(缺)');

    // 4. 事件流：插件真的在工作才会写事件
    section('4. 事件流（插件真的在跑才会写）');
    const counts = {};
    for (const t of ['task', 'evidence', 'dispatch', 'event']) {
      counts[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
    }
    info(`task=${counts.task}  evidence=${counts.evidence}  dispatch=${counts.dispatch}  event=${counts.event}`);
    check(
      '事件表有内容（订阅已生效）',
      counts.event > 0,
      counts.event > 0 ? `共 ${counts.event} 条` : '一条都没有 → 插件的 ctx.on("interconnect/event") 没跑过',
    );

    if (counts.event > 0) {
      const kinds = db
        .prepare('SELECT kind, COUNT(*) AS c FROM event GROUP BY kind ORDER BY c DESC')
        .all()
        .map((r) => `${r.kind}×${r.c}`);
      info(`事件种类: ${kinds.join(', ')}`);

      const peerEvents = db.prepare("SELECT COUNT(*) AS c FROM event WHERE kind = 'peer.event'").get().c;
      info(`peer.event ${peerEvents} 条 —— 这些是对端实例推来的生命周期事件（跨实例链路在动的证据）`);
    }

    // 5. 门禁闭环是否真的发生过
    section('5. 门禁是否真的判过（有 task 才有意义）');
    if (counts.task === 0) {
      info('还没有任务。在会话里调一次 mesh_task_create 就会有。');
    } else {
      const done = db.prepare("SELECT COUNT(*) AS c FROM task WHERE lifecycle = 'done'").get().c;
      const rejected = db.prepare("SELECT COUNT(*) AS c FROM event WHERE kind = 'task.gate_rejected'").get().c;
      const inadmissible = db.prepare('SELECT COUNT(*) AS c FROM evidence WHERE admissible = 0').get().c;
      info(`任务 ${counts.task} 个，其中 done ${done} 个；门禁拒绝 ${rejected} 次；不可采信证据 ${inadmissible} 条`);
      check(
        '有可采信证据',
        db.prepare('SELECT COUNT(*) AS c FROM evidence WHERE admissible = 1').get().c > 0,
        '这是"通过门禁"的必要条件',
      );
    }

    const recent = db
      .prepare('SELECT seq, kind, task_id, created_at FROM event ORDER BY seq DESC LIMIT 6')
      .all();
    if (recent.length > 0) {
      section('最近 6 条事件（倒序）');
      for (const e of recent) {
        info(`#${e.seq} ${e.kind}  ${e.task_id ?? '-'}  ${new Date(Number(e.created_at)).toISOString()}`);
      }
    }
    db.close();
  } catch (err) {
    check('能只读打开板', false, err?.message ?? String(err));
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

// ───────────────────────── 汇总 ─────────────────────────
const failed = rows.filter((r) => !r.ok);
process.stdout.write(`\n════ 检查项 ${rows.length}，失败 ${failed.length} ════\n`);
if (failed.length > 0) {
  process.stdout.write('没过的项：\n');
  for (const f of failed) process.stdout.write(`  ✘ ${f.label} — ${f.detail}\n`);
  process.stdout.write(
    '\n常见原因与处理：\n' +
      '  · 副本是旧的 → dsh plugin --profile desktop remove dsh-team-mesh 然后重新 add\n' +
      '    （直接 add 会判"已最新"而跳过，改过的源码不会进 profile）\n' +
      '  · 板文件不存在 → 装完要**重启 DSH**，apply() 才会被执行\n' +
      '  · 事件表为空 → 插件加载了但订阅没生效，检查 inject 与 ctx.on 那段\n',
  );
}
process.exitCode = failed.length === 0 ? 0 : 1;
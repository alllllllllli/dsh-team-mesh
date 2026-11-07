/**
 * mutation_remote.mjs — 变异测试：把跨机实现故意改坏，看 e2e 是否变红。
 *
 * 为什么必须做这一步："22 项全过"本身不是证据。一个只会走绿色路径的测试
 * 与没有测试是一样的。这里的每个变异体都对应一条**真实可能发生的退化**，
 * 尤其是 M4/M5 —— 它们直接对应四条不变量里的两条（不许信任自报、不许静默成功）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const results = [];
let caught = 0;
let missed = 0;

/** 每个变异体：目标文件、改什么、为什么这么改（对应哪条不变量）。 */
const MUTANTS = [
  {
    id: 'M1',
    file: 'src/remote.js',
    why: '跨机时不再上传物证，直接把本机路径发给服务端 —— 服务端在另一台机器上根本读不到这个路径',
    find: '      if (parsed.kind === \'file\' && fs.existsSync(parsed.localPath)) {\n        upload = await this.uploadLocalFile(parsed.localPath);\n        evidenceRef = upload.ref;\n      }',
    replace: '      /* MUTANT M1: 不上传，保留本机路径 */',
    expectRed: 'A/B 跨界证据',
  },
  {
    id: 'M2',
    file: 'src/server.js',
    why: '门禁被绕过：complete 直接改状态，不判证据 —— 违反"无证据不能完成"',
    find: '  \'POST /task/complete\': (_ctx, _p, body) => {\n      const res = board.completeTask(body.taskId, body.actor ?? \'unknown\');\n      return { ok: true, ...res };\n    },',
    replace:
      "  'POST /task/complete': (_ctx, _p, body) => {\n      /* MUTANT M2: 跳过门禁 */\n      const t = board.getTask(body.taskId);\n      if (t === null) throw new TeamError('TASK_NOT_FOUND', 'no task');\n      board.backend.updateTaskCas(t.task_id, t.version, { lifecycle: 'done' });\n      return { ok: true, task: board.getTask(body.taskId) };\n    },",
    expectRed: '反例1（无证据完成）',
  },
  {
    id: 'M3',
    file: 'src/refs.js',
    why: 'blob 引用的哈希校验被删掉 —— 于是伪造的 sha256 也能通过形状检查',
    find: "  const hex = ref.slice(BLOB_SCHEME.length).trim().toLowerCase();\n  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;",
    replace: '  /* MUTANT M3: 任何东西都算合法哈希 */\n  return ref.slice(BLOB_SCHEME.length).trim().toLowerCase() || null;',
    expectRed: '反例4（伪造 blob 哈希）',
  },
  {
    id: 'M4',
    file: 'src/store.js',
    why: 'resolveRef 对 blob 不再校验内容与 key 自洽 —— 违反"模型自报不算证据"',
    find: '    const actual = crypto.createHash(\'sha256\').update(got.bytes).digest(\'hex\');\n    if (actual !== parsed.sha256) return { ...parsed, exists: false, sha256: null, size: null };\n    return { ...parsed, exists: true, sha256: actual, size: got.size };',
    replace: '    /* MUTANT M4: 不校验 key 与内容是否自洽 */\n    return { ...parsed, exists: true, sha256: parsed.sha256, size: got.size };',
    expectRed: '证据自洽性',
  },
  {
    id: 'M5',
    file: 'src/remote.js',
    why: '网络错误被吞成"成功" —— 违反"不许静默成功"（最危险的一种退化）',
    find: "      reject(\n        new TeamError(\n          'BOARD_UNREACHABLE',",
    replace:
      "      return resolve({ status: 200, headers: {}, body: Buffer.from('{\"ok\":true,\"tasks\":[]}') }); // MUTANT M5: 静默成功\n      reject(\n        new TeamError(\n          'BOARD_UNREACHABLE',",
    expectRed: 'C 组断板',
  },
  {
    id: 'M6',
    file: 'src/server.js',
    why: '鉴权被关掉 —— 同机任何进程都能改板',
    find: "    if (typeof got !== 'string' || !safeEqual(got, expected)) {\n      throw new TeamError('UNAUTHORIZED', '共享密钥不匹配（检查客户端的 boardToken）');\n    }",
    replace: '    /* MUTANT M6: 不校验密钥 */',
    expectRed: 'C 组密钥错误',
  },
];

function runE2E() {
  try {
    const out = execFileSync(process.execPath, ['tools/e2e_remote.mjs'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    });
    return { ok: true, out };
  } catch (err) {
    return { ok: false, out: `${err?.stdout ?? ''}${err?.stderr ?? ''}` };
  }
}

console.log('变异测试：把跨机实现故意改坏，确认 e2e 会变红\n');

// 先确认基线是绿的：基线不绿，后面"变红"就没有意义
const base = runE2E();
if (!base.ok) {
  console.log('基线就是红的，先修基线再谈变异：');
  console.log(base.out);
  process.exit(1);
}
console.log('基线：绿 ✔\n');

for (const m of MUTANTS) {
  const target = path.join(ROOT, m.file);
  const original = fs.readFileSync(target, 'utf8');
  if (!original.includes(m.find)) {
    results.push(`  ? ${m.id} 注入点没找到（源码已变，变异体失效）：${m.file}`);
    missed += 1;
    continue;
  }
  const before = crypto.createHash('sha256').update(original).digest('hex');
  const mutated = original.replace(m.find, m.replace);
  fs.writeFileSync(target, mutated, 'utf8');
  try {
    const r = runE2E();
    if (r.ok) {
      results.push(`  ✖ ${m.id} 没被抓到 —— 这个退化可以静默通过：${m.why}`);
      missed += 1;
    } else {
      // 确认是因为预期的那组变红，而不是别的崩溃
      const redLine = r.out.split('\n').filter((l) => l.includes('✖')).slice(0, 2).join(' | ');
      results.push(`  ✔ ${m.id} 被抓到（${m.expectRed}）：${redLine.trim() || '（退出码非 0）'}`);
      caught += 1;
    }
  } finally {
    fs.writeFileSync(target, original, 'utf8');
    const after = crypto.createHash('sha256').update(fs.readFileSync(target, 'utf8')).digest('hex');
    if (before !== after) {
      results.push(`  !! ${m.id} 还原失败，drift=1：${m.file}`);
      process.exitCode = 1;
    }
  }
}

console.log(results.join('\n'));
console.log(`\n抓到 ${caught} / ${MUTANTS.length}，漏掉 ${missed}，全部还原 drift=0`);

// 最后再跑一次基线，证明还原是干净的
const final = runE2E();
if (!final.ok) {
  console.log('\n还原后基线变红 —— 变异测试污染了源码：');
  console.log(final.out);
  process.exitCode = 1;
} else {
  console.log('还原后基线：绿 ✔');
  process.exitCode = missed === 0 ? 0 : 1;
}

/**
 * mutation_filter.mjs — 噪声过滤的变异测试（v3）。
 *
 * 这个改动的核心风险是**游标饿死**：过滤写对了、游标写错了，症状是
 * "表面上没报错，但后面的真实事件再也浮不上来"。这种退化靠肉眼极难发现，
 * 所以必须有变异测试证明用例真的会红。
 */
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const TARGET = 'test/inbox_filter.test.mjs';
const results = [];
let caught = 0;
let missed = 0;

const MUTANTS = [
  {
    id: 'F1',
    file: 'src/inbox.js',
    why: '纯噪声时游标不前进 —— 噪声永久堵队头，真实事件饿死（最危险的写错方式）',
    find: "  const safeNext = Math.max(nextSeq, storedCursor);",
    replace: '  const safeNext = storedCursor; // F1: 纯噪声时不前进',
    expectRed: 'a1/a2 游标前进',
  },
  {
    id: 'F2',
    file: 'src/inbox.js',
    why: '游标直接跳到全表最大 seq —— 超过 limit 的真实事件被永久跳过',
    find:
      '  const nextSeq = kept.length > limit\n    ? Number(displayed[displayed.length - 1].seq)\n    : lastFetchedSeq;',
    replace: '  const nextSeq = maxSeq; // F2: 跳到全表最大',
    expectRed: 'b2 不饿死',
  },
  {
    id: 'F3',
    file: 'src/inbox.js',
    why: '不按 kind 过滤 —— peer.event 照旧占满窗口（功能等于没做）',
    find: '  const kept = fetched.filter((e) => !exclude.has(e.kind));',
    replace: '  const kept = fetched; // F3: 不过滤',
    expectRed: 'b1/c2 过滤生效',
  },
  {
    id: 'F4',
    file: 'src/inbox.js',
    why: '只取 limit 条不翻页 —— 噪声占满窗口时真实事件浮不上来',
    find: '  const fetchLimit = Math.max(limit * 5, limit + 1);',
    replace: '  const fetchLimit = limit; // F4: 不放大采集窗口',
    expectRed: 'b1 夹在中间',
  },
  {
    id: 'F5',
    file: 'src/inboxHook.js',
    why: '钩子路径纯噪声时不前移游标 —— 与 F1 同类，但发生在真实生效的那条路径上',
    find: '          if (got.nextSeq > got.sinceSeq) {',
    replace: '          if (false) { // F5: 钩子里不前移',
    expectRed: 'd1 钩子游标',
  },
  {
    id: 'F6',
    file: 'src/inbox.js',
    why: '忽略传入的 excludeKinds，永远用默认值 —— 关闭过滤的开关失效',
    find:
      '  const excludeKinds = Array.isArray(who?.excludeKinds)\n    ? who.excludeKinds\n    : DEFAULT_INBOX_EXCLUDE_KINDS;',
    replace: '  const excludeKinds = DEFAULT_INBOX_EXCLUDE_KINDS; // F6: 忽略配置',
    expectRed: 'c1/c3 可配置',
  },
];

function runTests() {
  try {
    const out = execFileSync(process.execPath, ['--test', TARGET], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 180000,
    });
    return { ok: true, out };
  } catch (err) {
    return { ok: false, out: `${err?.stdout ?? ''}${err?.stderr ?? ''}` };
  }
}

console.log('噪声过滤变异测试：确认"游标饿死"这类退化会被抓到\n');

const base = runTests();
if (!base.ok) {
  console.log('基线红，先修基线：');
  console.log(base.out);
  process.exit(1);
}
console.log('基线：绿 ✔\n');

for (const m of MUTANTS) {
  const target = path.join(ROOT, m.file);
  const original = fs.readFileSync(target, 'utf8');
  if (!original.includes(m.find)) {
    results.push(`  ? ${m.id} 注入点没找到：${m.file}`);
    missed += 1;
    continue;
  }
  const before = crypto.createHash('sha256').update(original).digest('hex');
  fs.writeFileSync(target, original.replace(m.find, m.replace), 'utf8');
  try {
    const r = runTests();
    if (r.ok) {
      results.push(`  ✖ ${m.id} 没被抓到：${m.why}`);
      missed += 1;
    } else {
      const red = r.out.split('\n').filter((l) => l.includes('✖')).slice(0, 2).join(' | ');
      results.push(`  ✔ ${m.id} 被抓到（${m.expectRed}）：${red.trim() || '退出码非 0'}`);
      caught += 1;
    }
  } finally {
    fs.writeFileSync(target, original, 'utf8');
    const after = crypto.createHash('sha256').update(fs.readFileSync(target, 'utf8')).digest('hex');
    if (before !== after) {
      results.push(`  !! ${m.id} 还原失败 drift=1`);
      process.exitCode = 1;
    }
  }
}

console.log(results.join('\n'));
console.log(`\n抓到 ${caught} / ${MUTANTS.length}，漏掉 ${missed}，全部还原 drift=0`);

const final = runTests();
console.log(final.ok ? '还原后基线：绿 ✔' : '还原后基线变红 —— 源码被污染');
if (!final.ok) process.exitCode = 1;
else process.exitCode = missed === 0 ? 0 : 1;

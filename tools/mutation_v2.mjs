/**
 * mutation_v2.mjs — 把 v2 三项功能故意改坏，确认 e2e_v2 会变红。
 *
 * 为什么必须做：ack / 租约 / 收件箱这三样最容易"看起来做完了"。
 * 比如"超时没收到 ack"如果只写个字段不扫，字段永远是 pending，
 * 一切测试都还是绿的。这里的每个变异体都对应一种**静默失效**。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const results = [];
let caught = 0;
let missed = 0;

const MUTANTS = [
  {
    id: 'N1',
    file: 'src/store.js',
    why: '超时扫描不再标 ack_timeout —— 于是"送到了没人管"永远显示成 pending（静默失效）',
    find: '        const ok = this.backend.markAckTimedOut(a.ack_id, now);\n        if (!ok) continue;',
    replace: '        const ok = true; this.backend.markAckTimedOut(a.ack_id, now);\n        if (!ok) continue;\n        continue; // N1: 只标记但不发事件/不改任务状态',
    expectRed: 'a. ack_timeout',
  },
  {
    id: 'N2',
    file: 'src/store.js',
    why: '租约过期不再标 stale —— 负责人挂了发起方永远不知道（最危险的失效）',
    find: '      const rows = this.backend.queryExpiredLeases(now);',
    replace: '      const rows = []; // N2: 永远扫不到过期租约',
    expectRed: 'b. stale',
  },
  {
    id: 'N3',
    file: 'src/store.js',
    why: 'stale 后仍不允许重新认领 —— 任务会永远卡在一个死掉的负责人手里',
    find: '        const verdict = canReclaim(task, now);\n        if (!verdict.ok) {',
    replace: '        const verdict = canReclaim(task, now);\n        if (true) { // N3: 无论租约状态都拒绝接管',
    expectRed: 'b. 重新认领',
  },
  {
    id: 'N4',
    file: 'src/inboxHook.js',
    why: '注入后不前移游标 —— 每轮重复刷屏同一批事件',
    find: '          await board.advanceCursor(instanceId, sessionId, got.nextSeq);',
    replace: '          /* N4: 不前移游标 */',
    expectRed: 'd. 不刷屏',
  },
  {
    id: 'N5',
    file: 'src/inbox.js',
    why: '游标前移到全表最大 seq 而不是实际读到的 —— limit 截断时会永久跳过事件',
    find: '  const lastFetched = Number(events[events.length - 1].seq);',
    replace: '  const lastFetched = Number(maxSeq); // N5: 跳过未取出的中间事件',
    expectRed: 'd. limit 截断',
  },
  {
    id: 'N6',
    file: 'src/inboxHook.js',
    why: '注入失败也前移游标 —— 消息永久丢失且无人知道',
    find: '        if (got.count === 0 || got.text === \'\') return decision;',
    replace:
      '        if (got.count === 0 || got.text === \'\') return decision;\n        try { await board.advanceCursor(instanceId, sessionId, got.nextSeq); } catch {} // N6: 先前移',
    expectRed: 'd. 注入失败不动游标',
  },
  {
    id: 'N7',
    file: 'src/handlers.js',
    why: '列表不再显示 ACK_TIMEOUT/STALE 标记 —— 状态在库里但人看不见，等于没有',
    find: '        if (t.stale === 1) flags.push(\'STALE(负责人失联)\');',
    replace: '        // N7: 不显示任何警示标记',
    expectRed: 'a/b 列表可见性',
  },
];

function runE2E() {
  try {
    const out = execFileSync(process.execPath, ['tools/e2e_v2.mjs'], {
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

console.log('v2 变异测试：把 ack / 租约 / 收件箱故意改坏，确认 e2e_v2 会变红\n');

const base = runE2E();
if (!base.ok) {
  console.log('基线就是红的，先修基线：');
  console.log(base.out);
  process.exit(1);
}
console.log('基线：绿 ✔\n');

for (const m of MUTANTS) {
  const target = path.join(ROOT, m.file);
  const original = fs.readFileSync(target, 'utf8');
  if (!original.includes(m.find)) {
    results.push(`  ? ${m.id} 注入点没找到（源码已变）：${m.file}`);
    missed += 1;
    continue;
  }
  const before = crypto.createHash('sha256').update(original).digest('hex');
  fs.writeFileSync(target, original.replace(m.find, m.replace), 'utf8');
  try {
    const r = runE2E();
    if (r.ok) {
      results.push(`  ✖ ${m.id} 没被抓到 —— 这个退化可以静默通过：${m.why}`);
      missed += 1;
    } else {
      const red = r.out.split('\n').filter((l) => l.includes('✖')).slice(0, 2).join(' | ');
      results.push(`  ✔ ${m.id} 被抓到（${m.expectRed}）：${red.trim() || '（退出码非 0）'}`);
      caught += 1;
    }
  } finally {
    fs.writeFileSync(target, original, 'utf8');
    const after = crypto.createHash('sha256').update(fs.readFileSync(target, 'utf8')).digest('hex');
    if (before !== after) {
      results.push(`  !! ${m.id} 还原失败 drift=1：${m.file}`);
      process.exitCode = 1;
    }
  }
}

console.log(results.join('\n'));
console.log(`\n抓到 ${caught} / ${MUTANTS.length}，漏掉 ${missed}，全部还原 drift=0`);

const final = runE2E();
if (!final.ok) {
  console.log('\n还原后基线变红 —— 变异污染了源码：');
  console.log(final.out);
  process.exitCode = 1;
} else {
  console.log('还原后基线：绿 ✔');
  process.exitCode = missed === 0 ? 0 : 1;
}

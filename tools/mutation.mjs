/**
 * 变异测试：把关键分支故意改坏，确认测试真的会变红；还原后确认 drift=0 且复跑全绿。
 *
 * 为什么值得单独一个脚本：手打容易漏掉"还原后哈希是不是真的一字不差"，
 * 而一旦没还原干净，后面所有结论都建立在被改过的源码上。
 *
 * 用法：node tools/mutation.mjs
 * 退出码 0 = 每个变异都被抓住且全部干净还原；1 = 有变异没被抓住（假绿灯）
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const MUTANTS = [
  {
    id: 'M1',
    why: '完成门禁：没有证据也放行（空证据即完成）',
    file: 'src/domain.js',
    old: `  if (evidences.length === 0) {
    return { allowed: false, reasons: ['NO_EVIDENCE: 没有任何证据，不能完成'] };
  }`,
    replacement: `  if (evidences.length === 0) {
    return { allowed: true, reasons: [] };
  }`,
    tests: ['test/domain.test.mjs', 'test/store.test.mjs'],
  },
  {
    id: 'M2',
    why: '可采信判定：pass 不需要物证（等于相信模型自报）',
    file: 'src/domain.js',
    old: `  if (e.outcome === 'pass' && !hasRef) reasons.push('判 pass 但没有 evidenceRef（必须指向真实产物）');`,
    replacement: `  if (false) reasons.push('判 pass 但没有 evidenceRef（必须指向真实产物）');`,
    tests: ['test/domain.test.mjs'],
  },
  {
    id: 'M3',
    why: '门禁拒绝的审计写回事务内（agent-team 的 D-1 回归）',
    file: 'src/store.js',
    old: `      if (err instanceof TeamError && err.code === 'GATE_REJECTED') {
        // 主事务已回滚；另起一笔**独立提交**的事务把拒绝写进审计
        try {
          this.tx(() => {
            this.appendEvent('task.gate_rejected', taskId, actor, {
              reasons: Array.isArray(err.detail) ? err.detail : [err.message],
            });
          });
        } catch {
          /* 审计写不进去也不能改变"拒绝"这个结论 */
        }
      }
      throw err;`,
    replacement: `      throw err;`,
    tests: ['test/store.test.mjs'],
  },
  {
    id: 'M4',
    why: '认领：允许抢占别人已认领且租约有效的任务',
    file: 'src/store.js',
    // v2 起认领走租约判定，这里变异成"永远可以接管"
    old: `        const verdict = canReclaim(task, now);
        if (!verdict.ok) {
          throw new TeamError(
            'ALREADY_CLAIMED',`,
    replacement: `        const verdict = canReclaim(task, now);
        if (false) {
          throw new TeamError(
            'ALREADY_CLAIMED',`,
    tests: ['test/store.test.mjs'],
  },
  {
    id: 'M5',
    why: '门禁：只看第一条可采信证据（先过后挂被判成成功）',
    file: 'src/domain.js',
    old: `  const last = usable[usable.length - 1];`,
    replacement: `  const last = usable[0];`,
    tests: ['test/domain.test.mjs', 'test/store.test.mjs'],
  },
];

function runTests(files) {
  let raw = '';
  try {
    // Force the spec reporter: the default reporter differs between Node lines
    // (22 => TAP '# pass N', 24 => spec 'ℹ pass N'), and a parse that only
    // knows one of them silently reports pass=-1 and aborts as "baseline not
    // green" -- a broken mutation gate that looks like a broken baseline.
    raw = execFileSync(process.execPath, ['--test', '--test-reporter=spec', ...files], {
      cwd: ROOT,
      encoding: 'utf8',
    });
  } catch (err) {
    raw = String(err?.stdout ?? '') || String(err?.message ?? '');
  }
  // Accept both shapes so an unexpected fallback to TAP still yields numbers
  // instead of a silent -1.
  const stat = (name) => {
    const m =
      raw.match(new RegExp('^\u2139 ' + name + ' (\\d+)', 'm')) ??
      raw.match(new RegExp('^# ' + name + ' (\\d+)', 'm'));
    return m ? Number(m[1]) : -1;
  };
  const pass = stat('pass');
  const fail = stat('fail');
  if (pass === -1 || fail === -1) {
    // Never let an unparseable run masquerade as a green or a red baseline.
    throw new Error('cannot parse test summary from runner output (reporter mismatch?)');
  }
  return { pass, fail, green: fail === 0 && pass > 0 };
}

const sha = (rel) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex');

function main() {
  let problems = 0;

  process.stdout.write('基线：先跑一遍确认全绿\n');
  const base = runTests(['test/domain.test.mjs', 'test/store.test.mjs', 'test/contract.test.mjs']);
  process.stdout.write(`  pass=${base.pass} fail=${base.fail}\n`);
  if (!base.green) {
    process.stdout.write('  基线不绿，先修基线\n');
    return 1;
  }

  for (const m of MUTANTS) {
    const abs = path.join(ROOT, m.file);
    const original = fs.readFileSync(abs, 'utf8');
    const before = sha(m.file);

    if (!original.includes(m.old)) {
      process.stdout.write(`\n${m.id} ✘ 找不到要变异的片段（变异写错了，不能算通过）\n`);
      problems++;
      continue;
    }

    process.stdout.write(`\n${m.id} ${m.why}\n`);
    fs.writeFileSync(abs, original.replace(m.old, m.replacement), 'utf8');
    const mutatedHash = sha(m.file);
    const out = runTests(m.tests);
    const caught = !out.green && out.fail > 0;
    process.stdout.write(`  pass=${out.pass} fail=${out.fail} → ${caught ? '变红（正确）' : '仍绿（假绿灯！）'}\n`);
    if (!caught) problems++;

    fs.writeFileSync(abs, original, 'utf8');
    const after = sha(m.file);
    const clean = after === before;
    process.stdout.write(
      `  还原：${clean ? 'drift=0' : 'drift≠0（没还原干净！）'}  前=${before.slice(0, 16)} 中=${mutatedHash.slice(0, 16)} 后=${after.slice(0, 16)}\n`,
    );
    if (!clean) problems++;
  }

  process.stdout.write('\n还原后复跑\n');
  const final = runTests(['test/domain.test.mjs', 'test/store.test.mjs', 'test/contract.test.mjs']);
  process.stdout.write(`  pass=${final.pass} fail=${final.fail}\n`);
  if (!final.green) problems++;

  process.stdout.write(`\n════ ${MUTANTS.length} 个变异，问题 ${problems} 个 ════\n`);
  return problems === 0 ? 0 : 1;
}

process.exitCode = main();
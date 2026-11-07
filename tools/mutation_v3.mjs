/**
 * mutation_v3.mjs — 验证 v3 的新测试**真的会红**，而不是摆设。
 *
 * 前面做 mutation 时踩了个坑：用 PowerShell 的 Set-Content 回写 UTF-8 中文源码，
 * 编码被转成 ANSI，166 个汉字变成 U+FFFD，文件直接语法错误。
 * 所以这个脚本一律用 node 的 fs 读写（UTF-8 显式指定），并在每次回写后
 * 校验字节完全等于原文，不等就立刻报错停手 —— 绝不留一个写坏的源码在后面。
 *
 * 用法：node tools/mutation_v3.mjs
 * 退出码 0 = 每个变异都被抓到（这是期望结果）
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TESTS = ['test/new_session.test.mjs'];

/** 每个变异：文件 + 原文（必须唯一命中）+ 替身 + 应该挂哪条用例 */
const MUTANTS = [
  {
    name: 'M1 建会话失败时降级投给现成会话',
    file: 'src/handlers.js',
    from: '          return created.text;\n',
    to: '          sessionId = "session-old";\n          createdNote = "MUTANT";\n',
    expect: '不许降级',
  },
  {
    name: 'M2 接收端偷偷用 resume 冒充 create',
    file: 'src/createSession.js',
    from: '    const created = await sc.create(payload);\n',
    to: '    const created = { sessionId: "fake-from-resume" };\n',
    expect: '不是 resume',
  },
  {
    name: 'M3 allowCreate 默认值改成开（破坏"默认关闭"）',
    file: 'src/createSession.js',
    from: '  if (allowCreate !== true) {\n',
    to: '  if (allowCreate === "never") {\n',
    expect: '默认关闭',
  },
  {
    name: 'M4 缺省 newSession 时也走建会话路径（破坏向后兼容）',
    file: 'src/handlers.js',
    from: '      if (wantsNewSession) {\n',
    to: '      if (true) {\n',
    expect: '缺省行为不变',
  },
];

function runTests() {
  try {
    const out = execFileSync(process.execPath, ['--test', ...TESTS], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out };
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

function readUtf8(p) {
  return fs.readFileSync(p, 'utf8');
}
function writeUtf8(p, text) {
  fs.writeFileSync(p, text, 'utf8');
}

let bad = 0;
for (const m of MUTANTS) {
  const file = path.join(ROOT, m.file);
  const original = readUtf8(file);

  if (!original.includes(m.from)) {
    process.stdout.write(`✘ ${m.name}\n  变异点找不到（源码变了？）：${JSON.stringify(m.from.slice(0, 60))}\n`);
    bad += 1;
    continue;
  }
  const mutated = original.replace(m.from, m.to);
  writeUtf8(file, mutated);

  const res = runTests();
  let restored = false;
  try {
    writeUtf8(file, original);
    restored = readUtf8(file) === original;
  } finally {
    if (!restored) {
      process.stdout.write(`‼ 回写失败，${m.file} 可能已损坏，请从 src.orig-0.3.1-pristine/ 恢复\n`);
      process.exit(2);
    }
  }

  if (res.ok) {
    // 变异体活着 = 测试没抓到 = 假绿灯
    process.stdout.write(`✘ ${m.name} → 测试仍然全绿（假绿灯！期望它挂：${m.expect}）\n`);
    bad += 1;
  } else {
    const failedNames = [...res.out.matchAll(/✖ ([^\n(]+)/g)].map((x) => x[1].trim());
    const uniq = [...new Set(failedNames)].slice(0, 3);
    process.stdout.write(`✔ ${m.name} → 被抓到（${uniq.join(' | ') || '有用例失败'}）\n`);
  }
}

// 终检：所有文件都回到原样，且测试全绿
const final = runTests();
process.stdout.write(`\n复原后跑一遍：${final.ok ? '全绿 ✔' : '仍然有红 ✘'}\n`);
if (!final.ok) bad += 1;

process.stdout.write(bad === 0 ? '\n全部变异都被抓到。\n' : `\n有 ${bad} 项没被抓住。\n`);
process.exitCode = bad === 0 ? 0 : 1;

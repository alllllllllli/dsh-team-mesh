/**
 * 从 app.asar 里把 `@deepseek-ai/dsh-tools` 连同它需要的依赖解出来，
 * 目的只有一个：**在普通 node 进程里 import 到真实的 `defineTool`**，
 * 好让插件作者在装进用户 profile 之前就能验证自己的 spec 能不能被编译。
 *
 * 为什么必须这么干：schema 用了宿主不认的关键字时，`ctx.tools.register()` 会在 apply
 * 阶段抛错，连带整个插件树起不来（用户看到的是"应用打不开"）。这种错误不能等到安装后才发现。
 *
 * 做法：迭代——尝试 import，`ERR_MODULE_NOT_FOUND` 会指名下一个缺的包，
 * 就把它从 asar 解出来，再来一遍。限次防死循环，每步都打印解了谁。
 *
 * 用法：node tools/vendor_deps.mjs [目标目录]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { flatten, readAsarHeader, readEntry } from './asar.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ASAR = process.env.DSH_ASAR
  ?? 'C:\\Users\\admin\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar';
// 必须是 node_modules 布局，否则 node 解析不到 vendor 里的包
const VENDOR = path.resolve(ROOT, process.argv[2] ?? 'vendor/node_modules');

/** 包名 → asar 里的包目录前缀候选。 */
function prefixCandidates(pkgName) {
  const inDsh = `dsh/node_modules/${pkgName}`;
  return [inDsh, `node_modules/${pkgName}`];
}

let index = null;
function ensureIndex() {
  if (index !== null) return index;
  const { header, contentBase } = readAsarHeader(ASAR);
  index = { entries: flatten(header), contentBase };
  return index;
}

/** 提取一个包到 VENDOR 下（保持 @scope/name 结构）。返回是否解出内容。 */
function extractPackage(pkgName) {
  const { entries, contentBase } = ensureIndex();
  for (const prefix of prefixCandidates(pkgName)) {
    const hit = entries.filter((e) => e.path === prefix || e.path.startsWith(`${prefix}/`));
    if (hit.length === 0) continue;
    let bytes = 0;
    for (const e of hit) {
      const rel = e.path === prefix ? '' : e.path.slice(prefix.length + 1);
      if (rel.length === 0) continue;
      const target = path.join(VENDOR, pkgName, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const data = readEntry(ASAR, e, contentBase);
      fs.writeFileSync(target, data);
      bytes += data.length;
    }
    return { prefix, files: hit.length, bytes };
  }
  return null;
}

function resolveEntry(spec) {
  // 找到已解出包的入口文件
  const pkgJson = path.join(VENDOR, spec, 'package.json');
  if (!fs.existsSync(pkgJson)) return null;
  const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
  const main = pkg.main ?? 'index.js';
  const entry = path.join(VENDOR, spec, main);
  return fs.existsSync(entry) ? entry : null;
}

function main() {
  if (!fs.existsSync(ASAR)) {
    process.stderr.write(`找不到 asar：${ASAR}\n`);
    return 1;
  }
  fs.mkdirSync(VENDOR, { recursive: true });

  const wanted = ['@deepseek-ai/dsh-tools'];
  const MAX_ROUNDS = 14;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    // 缺什么解什么
    let progressed = false;
    for (const spec of [...new Set(wanted)]) {
      if (fs.existsSync(path.join(VENDOR, spec, 'package.json'))) continue;
      const got = extractPackage(spec);
      if (got === null) {
        process.stderr.write(`  asar 里找不到包：${spec}\n`);
        return 1;
      }
      process.stdout.write(`  解出 ${spec} ← ${got.prefix}（${got.files} 文件 / ${got.bytes} 字节）\n`);
      progressed = true;
    }
    if (!progressed && round > 0) break;

    // 试探能否加载
    const entry = resolveEntry('@deepseek-ai/dsh-tools');
    if (entry === null) {
      process.stderr.write('dsh-tools 没有可加载入口\n');
      return 1;
    }
    const probe = path.join(VENDOR, '.probe.mjs');
    fs.writeFileSync(
      probe,
      `import { pathToFileURL } from 'node:url';
try {
  const m = await import(pathToFileURL(${JSON.stringify(entry)}).href);
  console.log('OK ' + (typeof m.defineTool));
} catch (e) {
  console.log('MISS ' + (e.code ?? '') + ' ' + String(e.message).split('\\n')[0]);
}
`,
      'utf8',
    );
    const out = execFileSync(process.execPath, [probe], { encoding: 'utf8' }).trim();
    fs.rmSync(probe, { force: true });
    process.stdout.write(`  试探（第 ${round + 1} 轮）：${out.slice(0, 160)}\n`);

    if (out.startsWith('OK')) {
      process.stdout.write(`\n完成：defineTool 可加载（${out}）\n`);
      process.stdout.write(`路径：${entry}\n`);
      return 0;
    }
    const m = out.match(/Cannot find package '([^']+)'/);
    if (m === null) {
      process.stderr.write(`\n加载失败且不是缺包问题：${out}\n`);
      return 1;
    }
    wanted.push(m[1]);
  }

  process.stderr.write('\n轮次用尽仍未加载成功\n');
  return 1;
}

process.exitCode = main();
/**
 * 极简 asar 读取器（零依赖，只读）。
 *
 * 为什么需要：`@deepseek-ai/dsh-tools` 的 `defineTool` 打在 app.asar 里，
 * 普通 node 进程 import 不到。但插件开发必须拿真实的 defineTool 编译一遍 spec ——
 * schema 用了宿主不认的关键字时，`ctx.tools.register()` 会在 apply 阶段抛错，
 * 连带整个插件树（甚至应用）都起不来。这种错不能等到装进用户 profile 才发现。
 *
 * asar 头部实测布局（本机 213 MB 的 app.asar，逐字段验过）：
 *   0..4    uint32 = 4               第一个 pickle 字段的长度
 *   4..8    uint32 = 5748132         头部 pickle 的总 payload 长度
 *   8..12   uint32 = 5748128         = JSON 长度 + 4
 *   12..16  uint32 = 5748124         JSON 的字节数
 *   16..    header JSON              （以 `{"files":{` 开头）
 *   16+N... 文件内容区                （索引里的 offset 相对这里）
 *
 * 一开始我把 JSON 当成从 offset 8 开始，于是吃到 4 字节长度前缀、JSON.parse 直接崩。
 * 记在这里，免得下次再从同一个坑里爬一遍。
 *
 * 用法：
 *   node tools/asar.mjs list <asar> [子串过滤]
 *   node tools/asar.mjs extract <asar> <前缀> <目标目录>
 */
import fs from 'node:fs';
import path from 'node:path';

/** 读头部，返回 { header, contentBase }。 */
export function readAsarHeader(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    if (head.readUInt32LE(0) !== 4) {
      throw new Error(`不像 asar：offset 0 应为 4，实际 ${head.readUInt32LE(0)}`);
    }
    const jsonLen = head.readUInt32LE(12);
    if (jsonLen <= 0 || jsonLen > 256 * 1024 * 1024) {
      throw new Error(`asar 头部长度不合理: ${jsonLen}（不是 asar 文件？）`);
    }
    const headerBuf = Buffer.alloc(jsonLen);
    fs.readSync(fd, headerBuf, 0, jsonLen, 16);
    if (headerBuf[0] !== 0x7b) {
      throw new Error(`asar 头部不是 JSON 对象（首字节 ${headerBuf[0]}）`);
    }
 const header = JSON.parse(headerBuf.toString('utf8'));
    const contentBase = 16 + jsonLen;
    return { header, contentBase };
  } finally {
    fs.closeSync(fd);
  }
}

/** 把嵌套的文件树摊平成 [{ path, size, offset }]。目录本身不带 offset。 */
export function flatten(header) {
  const out = [];
  const walk = (node, prefix) => {
    const files = node.files ?? {};
    for (const [name, entry] of Object.entries(files)) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (entry.files) {
        walk(entry, rel);
        continue;
      }
      // 符号链接条目没有 offset，跳过但记下
      if (entry.link !== undefined) continue;
      out.push({ path: rel, size: entry.size ?? 0, offset: Number(entry.offset ?? 0), unpacked: entry.unpacked === true });
    }
  };
  walk(header, '');
  return out;
}

export function readEntry(asarPath, entry, contentBase) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const buf = Buffer.alloc(entry.size);
    fs.readSync(fd, buf, 0, entry.size, contentBase + entry.offset);
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

function main(argv) {
  const [cmd, asarPath, ...rest] = argv;
  if (cmd === 'list') {
    const filter = rest[0] ?? '';
    const { header } = readAsarHeader(asarPath);
    const all = flatten(header);
    const hit = filter ? all.filter((e) => e.path.includes(filter)) : all;
    process.stdout.write(`总条目 ${all.length}，匹配 ${hit.length}\n`);
    for (const e of hit.slice(0, 200)) process.stdout.write(`  ${e.size.toString().padStart(9)}  ${e.path}\n`);
    if (hit.length > 200) process.stdout.write(`  …还有 ${hit.length - 200} 条\n`);
    return 0;
  }

  if (cmd === 'extract') {
    const prefix = rest[0];
    const dest = rest[1];
    const { header, contentBase } = readAsarHeader(asarPath);
    const all = flatten(header);
    const hit = all.filter((e) => e.path === prefix || e.path.startsWith(`${prefix}/`));
    if (hit.length === 0) {
      process.stderr.write(`没匹配到任何条目：${prefix}\n`);
      return 1;
    }
    let bytes = 0;
    for (const e of hit) {
      const rel = e.path === prefix ? path.basename(prefix) : e.path.slice(prefix.length + 1);
      const target = path.join(dest, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const data = readEntry(asarPath, e, contentBase);
      fs.writeFileSync(target, data);
      bytes += data.length;
    }
    process.stdout.write(`解出 ${hit.length} 个文件，共 ${bytes} 字节 → ${dest}\n`);
    return 0;
  }

  process.stderr.write('用法: node tools/asar.mjs list <asar> [过滤] | extract <asar> <前缀> <目录>\n');
  return 2;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('asar.mjs')) {
  // 允许直接运行，也允许被 import 复用
  if (process.argv[1]?.endsWith('asar.mjs')) {
    process.exitCode = main(process.argv.slice(2));
  }
}
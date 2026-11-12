# mutation_v2 结构性防护方案（L1 唯一命中断言 / L2 失败分类 + 退出码 / L3 --check 模式）

- 任务：`t-2319a5cc`（派发方 pc-ky614）
- 撰写：2026-11-08 00:3x +08:00，server（DESKTOP-QLO0LSC）
- 状态：**方案已备好，等 `t-d56cb5e8` 结束**（该任务仍 working，同一文件 `tools/mutation_v2.mjs` 正被它改）
- 本文件是**只读分析产物**：没有修改 `tools/mutation_v2.mjs`、`src/`、`test/`、`package.json`

---

## 0. 开工前的现场核对（只读）

### 0.1 板上并发状况

| 任务 | 状态 | 说明 |
|---|---|---|
| `t-b06865f6` | **done** | 同一 owner 已修完 N4/N5/N6 锚点，留证据 `docs/evidence/mutation-fix-20261108.log` |
| `t-d56cb5e8` | **working** | 与上一条是同一件事的重复派发，owner 相同 |
| `t-2319a5cc` | working（本任务） | 被顺序要求挡住，只做只读分析 |

> 结论：**锚点问题本身已经修好了**（见 0.3）。`t-d56cb5e8` 是重复任务，它一旦结束，本任务的开工前提即满足；
> 若它被取消，前提同样满足。真正剩下的活是 L1 措辞/分类、L2 退出码分离、L3 `--check`。

### 0.2 文件指纹（开工前基线，供事后 drift 比对）

```
tools\mutation_v2.mjs
  SHA256 3A8C821D51AADE13D4A9A8842EA626F664DE568BA0820D54E34EF39D597B3FAE
  11812 bytes   mtime 2026-11-08 00:18:51

src/backend.js  C64BB550A1DFBD80BC1B5E989A8F7E8348190935CC73D8300C8709989361BFCF
src/domain.js   1C707856DE4AF7A308141B40EFEFE835B49B5C9CF5E47D661A7A220FE808C605
src/handlers.js 52A6A4AF71E65239076E218C6D79DCC8B1EC50F88B3FBA317E8C416426904615
src/inbox.js    B2F9FF82D7EEB73D899E3A494ED1CD576C0AB2F08238BA79F96BEE90260412FD
src/inboxHook.js FDA0139E591AA02CE9CE1BCB604F15E621EF01E59EFB743ED816447C51151FF1
src/index.js    0C76BC45E5895945F30C99150EA063CD02BAAA77AC88BFE176855FD5AA73CE4C
src/refs.js     1CD37738D925824B95A7BB14E3CBFF82DD6BDD3A933DCA958783B61EBCB57E0D
src/remote.js   8C72D39B3FA4A1D65070DBC54F31FB7387D0E99E00B6AE37077ACEF72DDF2632
src/server.js   77FB0E5453507EDFD41BF9D3CB75251C5237E2ED6CD56C27A4E5B26549F78EAA
src/session.js  198470BBC2EF95BBCBCE4989845BDFD004EBB25322EAA9BFF7B7167429B8761A
src/spec.js     B334C2BF34AA6ACE04AFE8C0BCCC48A3853A416988E58D5815CA1012CA5B3695
src/store.js    4E05F39239A6ECD3FDF45050C8479001AD36294716CAB98736EE978F83537441
```

### 0.3 七个锚点当前的命中次数（`node tools/dump_finds.mjs tools/mutation_v2.mjs --n4-check`）

```
N1 src/store.js     1 ✔ 唯一
N2 src/store.js     1 ✔ 唯一
N3 src/store.js     1 ✔ 唯一
N4 src/inboxHook.js 1 ✔ 唯一    （14 空格 advanceCursor=1 处 / 10 空格=2 处，N4 锚点覆盖 69-74 行块，锁定第 74 行）
N5 src/inbox.js     1 ✔ 唯一    （105-107 行三元块）
N6 src/inboxHook.js 1 ✔ 唯一    （69-72 行注释 + makeMessage）
N7 src/handlers.js  1 ✔ 唯一
```

`--n4-check` 里「10 空格出现 2 处」不是缺陷：第 57 行（噪声分支，14 空格）与第 74 行（注入后前移，10 空格）之外，
10 空格的 `await board.advanceCursor(instanceId, sessionId, got.nextSeq);` 在 `inboxHook.js` 里还出现在第 74 行，
而 N4 的 find 是**跨行块**（含 `const msg = makeMessage(got.text);` 前缀），所以仍唯一。

---

## 1. 现状诊断：为什么现在的脚本仍然会「含混」

现在 `tools/mutation_v2.mjs` 已经比上一版强（`preflight()` 会断言唯一命中），但还剩三个结构性缺口：

### 缺口 A — 唯一命中断言存在，但**没有独立指出「实际几处」**
`preflight()` 现在的措辞是
`注入片段在 ${m.file} 里出现 ${occurrences} 次（要求恰好 1 次，否则会改错分支）`，
派发单要求的是能一眼看懂的形式 `N4 锚点应唯一命中，实际 2 处`。
更关键的是：**它和「测试太弱」共用同一个出口**（见缺口 B），仍然会被用户读成一个数字。

### 缺口 B — 锚点问题与覆盖缺口**都走 exit 1**
```js
if (preflightFail > 0) { … process.exit(1); }      // 锚点问题 → 1
…
process.exitCode = missed === 0 ? 0 : 1;           // 覆盖缺口 → 1
```
两种情况的处理动作完全相反（改脚本 vs 补断言），却给同一个退出码。CI/脚本无法区分。

### 缺口 C — 没有 `--check` 快速通道
现在想看锚点漂了没有，只能跑完整套（7 次 e2e，约 90s+）。`src/` 一被重写，
要等整轮跑完才看到一个含混数字。

### 缺口 D — 写入路径仍然是 `original.replace(m.find, m.replace)`
虽然 `preflight()` 已经断言了「改之前唯一」，但**改之前**和**改之时**之间仍有理论窗口
（同一进程内读两次文件、别的东西插进来）。加固方式：一次读、一次算 hits、命中数不符就**不写**，
用同一个 `original` 字符串做替换，不重新读盘。

---

## 2. L1：唯一命中断言（改成显式 hits + 点名措辞）

### 2.1 目标形态

新增一个纯函数，`--check` 与正式跑共用它（这是「结构性」的核心：一套判定，两个入口）：

```js
/**
 * 只读检查一个变异体的锚点是否「活着且唯一」。
 * 返回 null 表示 OK；返回 {reason:string} 表示锚点问题（L2 的 anchorFailures）。
 * 绝不写文件。
 */
function checkAnchor(m, srcCache) {
  const target = path.join(ROOT, m.file);
  let text = srcCache.get(m.file);
  if (text === undefined) {
    text = fs.readFileSync(target, 'utf8');
    srcCache.set(m.file, text);
  }

  // L1 核心：先算命中次数，命中数 !== 1 一律是锚点问题，且说清实际几处
  const hits = text.split(m.find).length - 1;
  if (hits === 0) {
    return { reason: `${m.file} 里找不到注入片段（锚点已漂移，需要重新对齐）` };
  }
  if (hits !== 1) {
    return { reason: `${m.id} 锚点应唯一命中，实际 ${hits} 处（${m.file}）` };
  }

  // 行号锚点（N4/N5/N6 用）：目标行内容要含 expect，且必须被 find 覆盖
  if (m.locate?.line !== null && m.locate?.line !== undefined) {
    const lines = text.split('\n');
    const line = lines[m.locate.line - 1];
    if (line === undefined || !line.includes(m.locate.expect)) {
      return {
        reason:
          `第 ${m.locate.line} 行不含预期内容` +
          `（期望含 ${JSON.stringify(m.locate.expect)}，实际 ${JSON.stringify(line ?? '')}）`,
      };
    }
    const startLine = text.slice(0, text.indexOf(m.find)).split('\n').length;
    const endLine = startLine + m.find.split('\n').length - 1;
    if (m.locate.line < startLine || m.locate.line > endLine) {
      return { reason: `锚点落在第 ${m.locate.line} 行，但注入片段覆盖 ${startLine}-${endLine} 行，对不上` };
    }
  }
  return null;
}
```

> `srcCache` 是 `Map<relPath, text>`，一次进程内每个文件只读一次。
> 好处：`--check` 天然只读；正式跑里「检查的文本」与「替换用的文本」是**同一个字符串**，
> 消灭缺口 D 的窗口。

### 2.2 顺带修掉 `dump_finds.mjs` 的一个小坑（只登记，不在本任务改）

`node tools/dump_finds.mjs --n4-check` 会把 `--n4-check` 当成**文件路径**去 `readFileSync`
（`args[0] ?? default` → 见 `dump_finds.mjs:16`），必须写成
`node tools/dump_finds.mjs tools/mutation_v2.mjs --n4-check` 才能跑。
它不在本任务授权范围内，**这里只记录**，等派发方决定要不要修。

---

## 3. L2：失败分类 + 退出码分离

### 3.1 退出码约定（新增，写进脚本头注释）

| 退出码 | 含义 | 输出前缀 | 谁来修 |
|---|---|---|---|
| `0` | 全绿：7/7 抓到、还原后基线绿 | — | 不用修 |
| `3` | **锚点需要更新**：找不到 / 命中数 ≠ 1 / 行号对不上 | `锚点需要更新：` | 改 `tools/mutation_v2.mjs` |
| `1` | **测试覆盖缺口**：变异体写进去了但 e2e 仍绿 | `测试覆盖缺口：` | 补 `tools/e2e_v2.mjs` 断言 |
| `2` | 脚本/环境自身问题：基线本来就是红的、还原 drift≠0、子进程超时 | `先修基线：` / `还原失败：` | 先排除环境 |

> 3 优先于 1（锚点问题更根本）。`2` 是新增的旁路：基线红/污染没有资格被说成「覆盖缺口」，
> 也不能被说成「锚点问题」，单列一类，不参与 1/3 的取舍。

### 3.2 主流程骨架（替换现有第 185-252 行）

```js
const CHECK_ONLY = process.argv.slice(2).includes('--check');

// ── 0. 锚点预检（--check 模式到此处就返回）──
const srcCache = new Map();
const anchorFailures = [];
const anchorOk = [];

for (const m of MUTANTS) {
  const bad = checkAnchor(m, srcCache);
  if (bad === null) {
    anchorOk.push(m);
  } else {
    anchorFailures.push({ id: m.id, file: m.file, reason: bad.reason });
  }
}

if (CHECK_ONLY) {
  for (const m of anchorOk) {
    console.log(`✔ ${m.id} ${m.file}`);
  }
  if (anchorFailures.length === 0) {
    console.log(`\n${MUTANTS.length} 个锚点全部唯一命中`);
    process.exit(0);
  }
  console.log();
  for (const f of anchorFailures) console.log(`✖ ${f.id} ${f.reason}`);
  console.log(`\n锚点需要更新：${anchorFailures.length} / ${MUTANTS.length} 个变异体锚点不可用`);
  process.exit(3);
}

// ── 1. 正式跑：锚点不全 → 直接 3，一条 e2e 都不跑 ──
if (anchorFailures.length > 0) {
  for (const f of anchorFailures) console.log(`  ✖ ${f.id} ${f.reason}`);
  console.log(`\n锚点需要更新：${anchorFailures.length} / ${MUTANTS.length} 个锚点不可用（脚本缺陷，不是产品缺陷）`);
  console.log('先跑 node tools/mutation_v2.mjs --check 逐个对齐，再回来跑正式变异测试。');
  process.exit(3);
}
console.log(`锚点预检：${MUTANTS.length} / ${MUTANTS.length} 唯一命中 ✔\n`);
```

### 3.3 每个变异体的执行段（含 L1 的「不唯一就不写」）

```js
for (const m of MUTANTS) {
  const target = path.join(ROOT, m.file);
  const original = srcCache.get(m.file);          // 与 checkAnchor 同一份文本
  const before = sha256(original);

  // 二次断言：读盘后、写盘前再算一遍（防御并发/外部改动）
  const hits = original.split(m.find).length - 1;
  if (hits !== 1) {
    anchorFailures.push({ id: m.id, file: m.file, reason: `${m.id} 锚点应唯一命中，实际 ${hits} 处（写入前复查）` });
    continue;                                      // 关键：不写文件
  }

  fs.writeFileSync(target, original.replace(m.find, m.replace), 'utf8');
  try {
    const r = runE2E();
    if (r.ok) {
      missed += 1;
      gapResults.push(`  ✖ ${m.id} 没被抓到 —— 这个退化可以静默通过：${m.why}`);
    } else {
      caught += 1;
      okResults.push(`  ✔ ${m.id} 被抓到（${m.expectRed}）：${红线摘要(r)}`);
    }
  } finally {
    fs.writeFileSync(target, original, 'utf8');     // 用同一份 original 还原，不重读
    if (sha256(fs.readFileSync(target, 'utf8')) !== before) {
      driftFailures.push(`${m.id} 还原失败 drift=1：${m.file}`);
    }
  }
}
```

### 3.4 收尾与退出码判定

```js
// 打印分组：先锚点，再覆盖缺口，最后正常项，避免「7 里混一个 3」看不清
if (anchorFailures.length > 0) {
  console.log('锚点需要更新：');
  for (const f of anchorFailures) console.log(`  ✖ ${f.id} ${f.reason}`);
  console.log();
}
if (gapResults.length > 0) {
  console.log('测试覆盖缺口：');
  console.log(gapResults.join('\n'));
  console.log();
}
if (okResults.length > 0) {
  console.log(okResults.join('\n'));
  console.log();
}
console.log(`抓到 ${caught} / ${MUTANTS.length}，漏掉 ${missed}，锚点失效 ${anchorFailures.length}，还原 drift=${driftFailures.length}`);

const final = runE2E();
if (!final.ok) {
  console.log('\n还原后基线变红 —— 变异污染了源码（先修基线，别当成覆盖缺口）：');
  console.log(final.out);
  process.exit(2);
}
if (driftFailures.length > 0) {
  console.log(`\n还原失败：${driftFailures.join(' | ')}`);
  process.exit(2);
}
console.log('还原后基线：绿 ✔');
process.exit(anchorFailures.length > 0 ? 3 : missed === 0 ? 0 : 1);
```

> 注意：原来的「抓到 X / 7，漏掉 Y，全部还原 drift=0」总结行**保留**（见最后一行 `console.log`），
> 只是在后面多了「锚点失效 N」一项。派发单要求「原来的总结行保留」，这里满足。

### 3.5 基线为红的处理（原有行为，但要归类）

原来：
```js
const base = runE2E();
if (!base.ok) { console.log('基线就是红的，先修基线：'); … process.exit(1); }
```
改成 `process.exit(2)`，并加前缀 `先修基线：`，理由见 3.1 —— 基线红不是「覆盖缺口」，
把它算成 1 会让「e2e 本来就崩了」伪装成「变异体没被抓到」。

---

## 4. L3：`--check` 模式

### 4.1 行为契约

`node tools/mutation_v2.mjs --check`

- 只 `fs.readFileSync`（`src/` 三个文件），**一次 e2e 都不跑**，不写任何文件，秒级返回（实测目标 < 300ms）
- 全部唯一命中：
  ```
  ✔ N1 src/store.js
  ✔ N2 src/store.js
  ✔ N3 src/store.js
  ✔ N4 src/inboxHook.js
  ✔ N5 src/inbox.js
  ✔ N6 src/inboxHook.js
  ✔ N7 src/handlers.js

  7 个锚点全部唯一命中
  ```
  `exit 0`
- 有任何一个不唯一 / 找不到：
  ```
  ✖ N4 src/inboxHook.js 里找不到注入片段（锚点已漂移，需要重新对齐）

  锚点需要更新：1 / 7 个变异体锚点不可用
  ```
  `exit 3`，**点名到具体变异体 id + 文件 + 原因**
- 参数解析：`process.argv.slice(2).includes('--check')`，未知参数忽略（不实现 `--help`，避免范围膨胀）

### 4.2 为什么要「秒级」
`src/` 一被重写（噪声过滤那次就是），锚点会静默漂移。有了 `--check`，
改完 `src/` 立刻能知道「漂了几个、哪几个」，不用等 7 次 e2e（~90s）跑完才看到一个含混数字。

### 4.3 `package.json` 的 `scripts` 增补

```json
"mutation:v2": "node tools/mutation_v2.mjs",
"mutation:check": "node tools/mutation_v2.mjs --check",
```

> 只加一行。`dependencies` 保持为空（派发单第 4 条验收）。`peerDependencies` 不动。

**注意**：任务卡正文写「只改 `tools/mutation_v2.mjs` 一个文件」，但 L3 明确要求给
`package.json` 加 `mutation:check`。按「更具体的要求优先」，实际改动范围 =
`tools/mutation_v2.mjs` + `package.json`（仅 `scripts` 一行），`src/`、`test/`、`e2e_v2.mjs` 零改动。
执行时会把这句写进证据 log 的抬头，避免事后被当成越界。

---

## 5. 待跑清单（锚点解锁后按此顺序执行，输出全部进 log）

log 路径（派发单指定）：
`F:\DeepSeek work space\dsh-team-plugin\docs\evidence\mutation-harness-hardening-20261108.log`

| # | 命令 | 期望 | 失败含义 |
|---|---|---|---|
| 1 | `node tools/mutation_v2.mjs --check` | 7 个锚点全部唯一命中，`exit 0` | 3 → 锚点漂了 |
| 2 | `node tools/mutation_v2.mjs` | 抓到 7 / 7、还原后基线绿、`exit 0` | 1 → 覆盖缺口；3 → 锚点；2 → 基线/污染 |
| 3 | `node tools/e2e_v2.mjs` | 29 / 29，`exit 0` | 断言被改坏了 |
| 4 | 人工制造失败 ① | 把某个 `find` 改成不存在的字符串 → `--check` 与正式跑都应 `exit 3` | 退出码没分开 |
| 5 | 人工制造失败 ② | 把某个 `replace` 改成与原 `find` 等价（空操作）→ 变异体其实没生效 → `exit 1` | 同上 |
| 6 | 人工制造失败 ③ | 全部改回 → `--check` `exit 0`、正式跑 `exit 0` | 还原不干净 |
| 7 | `src/` 12 文件 SHA256 逐一比对 | 与 §0.2 全部一致 | 污染源码 |

每次人工制造失败**验完立刻还原**，并当场重算 `tools/mutation_v2.mjs` 的 SHA256 确认回到已知版本
（改动中会有多个中间版本，log 里逐版本记 hash）。

「人工制造失败 ②」的具体做法（避免与 ① 混淆）：
取 N7，把 `find` 与 `replace` 改成同一个字符串
（即 `replace: "        if (t.stale === 1) flags.push('STALE(负责人失联)');"`）。
锚点仍唯一命中（所以不是 3），但注入后源码完全没变，e2e 必然还是绿 → 应判 1 覆盖缺口。
验完立刻把 `replace` 改回 `'        // N7: 不显示任何警示标记'`。

---

## 6. 不改的东西（红线）

- `src/` 12 个 `.js`：**零改动**（本任务只给它算 SHA256）
- `tools/e2e_v2.mjs`：任何断言都不动（它是被测对象，不是被改对象）
- 不新增任何 npm 依赖；`dependencies` 仍为空
- 不动 `cordis.patch.yml`、`dsh.plugin.json`、`README.md`
- 不重启 DSH、不动共享板 SQLite、不动计划任务

---

## 7. 解锁后一句话确认（给派发方）

`t-d56cb5e8` 一旦 done/canceled，且
`sha256sum tools/mutation_v2.mjs` 稳定（连续两次读一致、`src/` 12 文件 hash 等于 §0.2），
即可按 §5 清单开工，预计 20-30 分钟（其中 7 次 e2e 约占 90-120s，三次人工失败各再跑一遍 e2e）。

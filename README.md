# dsh-team-mesh

**跨 DSH 实例 / 跨设备**的任务协作插件（Windows 优先）。

一个 DSH 实例里已经有 Agent Teams（`spawn_teammate`、任务板、Team UI），那是**实例内**的。
这个插件补的是它没有的那一半：**不同 DSH 实例之间怎么派活、怎么交接、怎么验收** —— 而且验收这件事
不接受模型自报，只认代码算得出来的物证。

两种模式，共用同一套工具与同一条门禁：

| 模式 | 板在哪 | 适用 |
| --- | --- | --- |
| **单机**（默认） | 本机 `$DSH_HOME/team/team.db` | 同一台机器上的多个 DSH 实例 |
| **远端**（多设备） | 一台主机的板服务（HTTP），各设备连它 | 跨设备共用**同一块**板 |

> **为什么需要远端模式**：板是本地 SQLite 文件，每台设备各写各的。
> 实测过：设备A 建任务派给设备B，投递成功；设备B 报证据得到 `TASK_NOT_FOUND` ——
> 任务在A的板里，B查的是自己的板。而且门禁要去磁盘读文件算哈希，
> 对方机器上根本没有那个文件，跨机永远无法完成。
> 远端模式把板挪到一处、把物证改成内容寻址，两个问题一起解掉。

## 两种模式怎么选

```yaml
# 单机（不写 boardEndpoint 就是单机，行为与 0.1.0 完全一致）
- id: dsh-team-mesh
  config:
    boardPath: 'C:\Users\you\.dsh\team\team.db'   # 可省，默认 $DSH_HOME/team/team.db

# 远端（多设备共用一块板）
- id: dsh-team-mesh
  config:
    boardEndpoint: 'http://127.0.0.1:13090'
    boardToken: '<共享密钥，或留空走 DSH_TEAM_BOARD_TOKEN 环境变量>'
    boardTimeoutMs: 10000
```

## 为什么可行（单机的关键前提）

同一台机器上所有 DSH 实例共享 `DSH_HOME`。于是：

- **共享任务板** = 一份 SQLite 文件 `$DSH_HOME/team/team.db`，谁写谁读都看见（WAL + `busy_timeout`）。
- **通知** = 复用已有的 `dsh-interconnect` 服务（`ctx.interconnect`），把任务卡推到对端某个会话。

不需要另造协议、不需要端口、不需要账号：这两样机器上都已经有了。

## 工具（全部 `mesh_` 前缀）

| 工具 | 作用 |
| --- | --- |
| `mesh_peers` | 列对端实例与链路状态；`includeSessions` 再列对端活会话 |
| `mesh_task_create` | 在共享板上建任务（`requestId` 幂等） |
| `mesh_task_list` | 列任务（按状态 / 负责人过滤）；显式标出 `STALE` / `ACK_TIMEOUT` |
| `mesh_task_claim` | 认领 + **拿租约**（默认 10 分钟）；租约内不可被抢，stale 后可接管 |
| `mesh_task_adopt` | **三证据收养**：租约失效后用时间 + 身份 + 事件三类证据接管（比 claim 更安全，见下文） |
| `mesh_task_ack` | **收到任务卡后回执**，告诉派发方"有人接了" |
| `mesh_task_heartbeat` | 续租，表示"我还在干"（建议 ≤5 分钟一次） |
| `mesh_task_report` | 记录证据：`executed` / `outcome` / `note` / `evidenceRef` |
| `mesh_task_complete` | 请求完成（门禁在写事务内重判） |
| `mesh_task_cancel` | 取消（终态） |
| `mesh_dispatch` | 把自包含任务卡推到对端实例的某个会话，并**开启回执窗口** |
| `mesh_inbox` | 查看未读动态（按游标增量，不重复刷屏）；正常情况下会自动注入 |
| `mesh_events` | 看审计事件流 |

共 **13** 个工具，注册名以 `src/spec.js` 的 `TOOL_NAMES` 为准（`toolNames()` 与 `allSpecs()` 逐条对齐，
契约测试锁住条数）。

> **为什么用 `mesh_` 而不是 `team_`**：DSH 自带的 Agent Teams 已经占了 `team_task_create` /
> `team_task_list` 这些名字。同名注册会互相遮蔽，所以刻意避让。

## 四件事必须分开：投递 / 知情 / 干活 / 完成

这是 v2 补的核心。v1 只做了前两件的"投递"，结果踩到真实的坑：
**对端把活做完了，但它不会主动发消息，于是发起方一直不知道。**

| 状态 | 怎么产生 | 谁看得见 |
| --- | --- | --- |
| **信没送到** | `mesh_dispatch` 返回 `delivered:false` | 投递方立刻看到原因 |
| **送到了没人管** | 投递成功但 `ackTimeoutMs`（默认 60s）内无 `mesh_task_ack` | 扫出 `ack_state=timeout` + `task.ack_timeout` 事件 |
| **有人接了但在干** | 收到 `mesh_task_ack` 并 `mesh_task_claim` | `ack_state=acked`，租约有效 |
| **人挂了/跑偏** | 租约到期无 `mesh_task_heartbeat` | 标 `stale` + `lease.stale` 事件，**可被接管** |
| **真的做完了** | 有可采信证据 + 门禁通过 | `lifecycle=done`，**下一轮自动注入**给发起方 |

**这五种状态在 `mesh_task_list` 里用不同标记显示，不会被抹平成"正常"。**

### 收件箱：发起方怎么"自动知情"

不用模型主动查。插件挂在宿主的 `agent/pre-step` 上（内置"模型切换提示"用的同一个扩展点），
在会话每一步之前：

1. 先扫一遍过期的 ack / 租约（保证注入的是**现在**的真相）
2. 取本会话游标之后的新事件
3. 若是新增，追加一条摘要消息进本步上下文
4. 游标前移到最后一条**已读**的 seq

游标存在板上（`cursor` 表，主键 `instance_id + session_id`），所以：

- 进程重启不丢，也不会重复刷屏
- 多会话互不干扰
- **注入失败游标不动**，下一轮能补上（宁可重复一次，也不永久丢）

`config.inbox === false` 可关闭自动注入（排障用）。

### 噪声过滤：`inboxExcludeKinds`

多台机器同时开着时，`peer.event`（别处会话的 created / disposed / running 状态）会
**占满注入窗口**，把真正关心的 `task.*` / `evidence.*` / `gate_rejected` 挤到 20 条之后——
实测过：真实任务事件要过两轮才浮上来。

```yaml
- id: dsh-team-mesh
  config:
    inboxExcludeKinds: ['peer.event']   # 默认值；传 [] 表示不过滤
    inboxLimit: 20
```

实现上有两个**必须同时成立**的点，缺一个就会退化成"饿死"：

1. **取更多、过滤后再截断**：单轮取 `limit × 5`，需要时继续向后翻页，
   保证噪声再多也能捞到真事件。
2. **被过滤的事件也算"看过"，游标必须越过它们**：否则噪声永久堵在队头，
   后面的事件永远读不到。

游标前移规则（这是正确性核心）：

| 情况 | 游标前移到 |
| --- | --- |
| 过滤后剩余 ≤ `limit` | 本轮**全部取出**的最后一条（噪声一并越过） |
| 过滤后剩余 > `limit` | 本轮**实际显示**的最后一条（未显示的真实事件绝不越过） |
| 过滤后一条不剩 | 本轮取出的最后一条（不注入内容，但游标必须前进） |

摘要里会写明 `（另有 N 条 peer 噪声已过滤；要看用 mesh_events）`，
所以"没动静"和"有噪声被滤掉"不会混为一谈。



## 四条不变量（这是这个插件真正的价值）

**远端模式下这四条一条都没有放松**，而且实现方式比单机更硬：

1. **模型自报不算证据。** `mesh_task_report` 里 `executed` / `outcome` 是模型给的，
   但**是否可采信由代码判定**：判 pass 必须给 `evidenceRef`，且物证得真的存在，
   sha256 由代码实算。模型说"我保证成了"没有用。
   - 单机：读本机磁盘算哈希。
   - 远端：客户端只递**字节**，`sha256` 由**板服务**算，客户端连指定哈希的机会都没有。
2. **没证据不能完成。** 空证据集、证据全不可采信、最后一条可采信证据是 `fail` 或 `unknown`，
   四种情况一律拒绝，原因具体到代码（`NO_EVIDENCE` / `NO_ADMISSIBLE_EVIDENCE` / `LATEST_FAIL` / `LATEST_UNKNOWN`）。
   - 远端：门禁跑在**板服务的写事务里**，客户端没有绕过路径。

3. **被拒不吞审计。** 门禁拒绝的 `task.gate_rejected` 事件写在**另一笔已提交事务**里——
   写在主事务里会被回滚吃掉（同一个坑在另一个项目已经踩过）。
4. **投递成功 ≠ 任务完成。** `mesh_dispatch` 如实返回 `delivered` 与 `reason`
   （`session-not-live` / `unreachable` / `peer-not-configured` …），绝不把没投出去说成派出去了。

## 安装

```powershell
dsh plugin --profile <profile> add "file:F:\DeepSeek work space\dsh-team-plugin"
```

`dsh plugin` 只是把参数转给 pnpm；顺手会把 `dsh-team-mesh` 加到该 profile
`package.json` 的 `dsh.profile.bundles` 里，插件因此进入合成树。

### 当前状态：已装进 `desktop`（2026-11-07 18:55）

```
dsh plugin --profile desktop add "file:..."   → exit 0
dsh.profile.bundles 末尾出现 dsh-team-mesh
node_modules/dsh-team-mesh/ 落地，8 个关键文件与源哈希逐条一致
```

装之前备份了 `package.json.bak-20261107-185517-premesh` 与 `pnpm-lock.yaml.bak-...`。

**生效需要重启 DSH**：`desktop` profile 由 Electron 应用独占管理，
`dsh --profile desktop --dump-config` 会直接报
`profile "desktop" is managed exclusively by the Electron application`，
所以"合成树里有没有它"只能等应用重启后从插件页/工具列表确认。

> pnpm 顺带把 `dsh-ops 0.4.4` 移除了（它本来就不在 bundles 里，属于之前遗留的孤立依赖）。
> 如果发现哪个功能因此少了什么，用上面两个备份文件回滚。

卸载：

```powershell
dsh plugin --profile desktop remove dsh-team-mesh
```

板文件位置：`$DSH_HOME\team\team.db`（默认，即 `C:\Users\admin\.dsh\team\team.db`）。
要换位置，在 profile 里给插件加 `config: { boardPath: '...' }`。

## 验证过什么（2026-11-07 本机实测）

```
node --test "test/*.test.mjs"      → 77 tests / 77 pass / 0 fail      （v1 39 + v2 22 + v3 16）
node tools/e2e_remote.mjs          → 24 项跨机，0 失败                （A/B/C/D 四组）
node tools/e2e_v2.mjs              → 29 项 v2，0 失败                 （a/b/c/d + d2 + 门禁）
node tools/mutation_remote.mjs     → 6 个跨机变异全被抓，drift=0
node tools/mutation_v2.mjs         → 7 个 v2 变异全被抓，drift=0
node tools/mutation_filter.mjs     → 6 个噪声过滤变异全被抓，drift=0
node tools/mutation.mjs            → 5 个单机变异全被抓，drift=0
node tools/smoke.mjs               → 13 项端到端，0 失败
node tools/verify.mjs              → 17 项验收（源/装哈希一致、v2 列已迁移等）
node tools/client_cli.mjs health   → 板服务可达
```

### v3 噪声过滤（`test/inbox_filter.test.mjs`，16 项 + 6 个变异）

| 组 | 验什么 |
| --- | --- |
| **a** | 全是 `peer.event` 的两轮：不注入内容，但游标前进；下一轮真实事件能浮出 |
| **b** | `peer.event` 夹在中间：后面的 task 事件下一轮就浮出，**不被饿死**（逐轮推进验证 10 条真实事件全读到） |
| **c** | `excludeKinds: []` → 不过滤，行为与改动前一致；自定义种类只排它 |
| **d** | 走真实 `agent/pre-step` 钩子：纯噪声不产生注入消息 |
| **e** | 摘要如实写明过滤掉多少条 |

变异测试 F1~F6 覆盖：纯噪声不前移、游标跳到全表最大、不按 kind 过滤、
不放大采集窗口、钩子路径不前移、忽略 `excludeKinds` 配置。
**F2（游标跳全表最大）第一次没被抓到** —— 因为我的 b2 断言太宽松，第二轮只要
"还能注入"就算过，而实际上注入的可能是重复的旧事件。改成"必须读到全部 10 条真实事件"
后才抓到。这条记在下面。


### v2 的四项验收（`tools/e2e_v2.mjs`，29 项）

| 组 | 验什么 | 结果 |
| --- | --- | --- |
| **a** | 投递成功但 60s 内无 ack → `ack_state=timeout`，留 `task.ack_timeout` 事件，列表显式标 `ACK_TIMEOUT`；且投递失败**不会**被误判成超时 | 5/5 |
| **b** | claim 后停心跳 → 租约过期标 `stale` + `lease.stale` 事件，列表标 `STALE`，可被接管并留 `lease.taken_over` | 6/6 |
| **c** | 对端完成但**不主动发消息** → 发起方下一轮经 `agent/pre-step` 自动看到 done 事件与任务状态 | 3/3 |
| **d** | 连跑两轮：第二轮无新事件不注入；有新事件只注入新增；游标正确前移；按 session 隔离；注入失败游标不动 | 5/5 |
| **d2** | 同上但走**真实钩子**路径（不是 `deliverInbox` 直调），含 `makeMessage` 抛错与 limit 截断 | 6/6 |
| **门禁** | 四条不变量在 v2 下没有被放松 | 3/3 |

### v2 变异测试（`tools/mutation_v2.mjs`，7/7）

| 变异 | 改坏什么 | 结果 |
| --- | --- | --- |
| N1 | 超时不标 `ack_timeout`（永远 pending） | 被抓 |
| N2 | 租约过期不标 `stale` | 被抓 |
| N3 | stale 后仍不许接管 | 被抓 |
| N4 | 注入后不前移游标（每轮刷屏） | 被抓 |
| N5 | 游标跳到全表最大 seq（跳过中间事件） | 被抓 |
| N6 | 注入失败也前移游标（消息永久丢） | 被抓 |
| N7 | 列表不显示 STALE/ACK_TIMEOUT 标记 | 被抓 |

**N4/N5/N6 第一次全部漏网。** 原因不是脚本坏了，而是我的 d 组测的是 `inbox.js` 的
`deliverInbox`，而被变异的代码在 `inboxHook.js` —— **测的不是被改的那条路径**。
补了 d2 组（走真实 `agent/pre-step` 钩子）后才 7/7。这条错误值得记：
"测试全绿"和"测试覆盖到你改的那行"是两件事。


### 跨机 e2e 的四组验收（`tools/e2e_remote.mjs`，24 项）

| 组 | 验什么 | 结果 |
| --- | --- | --- |
| **A** | A建任务 → B看见 → B认领 → B报真实证据 → B完成 → A看到 done → 事件流可回放且顺序对 | 7/7 |
| **B** | 无证据 / 自报无 ref / 路径不存在 / 伪造 blob 哈希 / blob 不自洽 / 哈希形状非法 —— 全拒且留痕 | 8/8 |
| **C** | 断板、密钥错、服务中途停、对端只收不回：全部明确失败、可诊断、不卡死、不静默成功 | 4/4 |
| **D** | 单机模式未被破坏（本地板同步可用、`file://` 与裸路径哈希一致） | 2/2 |

其中 C 组是**最关键的一组**：它证明"连不上"不会变成一个假的成功。
实测数据：板服务停掉后 `list` 在 **338ms** 内返回 `BOARD_UNREACHABLE` 并带诊断提示
（"检查板服务是否在跑、隧道是否断开、endpoint 是否写对"）。

### 跨机变异测试（`tools/mutation_remote.mjs`，6/6）

"24 项全过"本身不算证据 —— 得证明这些测试真的会红。所以把实现故意改坏：

| 变异 | 改坏什么 | 结果 |
| --- | --- | --- |
| M1 | 跨机时不上传物证，直接发本机路径 | 被抓（A组证据步骤红） |
| M2 | `complete` 跳过门禁直接改状态 | 被抓（反例1红） |
| M3 | 删掉 blob 哈希的形状校验 | 被抓（反例6红） |
| M4 | 不校验 blob 的 key 与内容自洽 | 被抓（反例5红） |
| M5 | 网络错误吞成"成功" | 被抓（C组断板红） |
| M6 | 关掉共享密钥校验 | 被抓（C组密钥错红） |

M3/M4 第一次**没被抓到** —— 因为当时的用例只覆盖了"形状合法但板上没有"这条路径，
没有覆盖"形状非法"和"库里 key 与内容不自洽"。补了两条针对性用例后 6/6。
这一步是必要的：如果不做变异测试，这两条防御纵深等于没测。

- **契约**：13 个 spec 全部用**宿主真实的 `defineTool`**（从 `app.asar` 解出来的同一版本）编译通过；
  另有一条反向对照，证明"用宿主不认的 schema 关键字会抛错"，以免这条测试变成摆设。
- **门禁**：`working → done` 缺迁移、抢占、空证据、先过后挂、unknown、审计丢失——每一项都有用例，
  而且对应变异确认会变红。


### 在真实 DSH 宿主里跑通过（2026-11-07 18:44）

装进隔离 profile 后启动该 profile，**板文件被真实创建**，这是 `apply()` 在宿主里跑成功的硬证据：

```
C:\Users\admin\.dsh\team\team.db        4096 B   创建于 18:44:51
表: dispatch, event, evidence, meta, sqlite_sequence, task
meta: [{"key":"schema_version","value":"1"}]
journal_mode: wal
```

由此确认三件事，都不是推测：

1. 宿主里 `import('@deepseek-ai/dsh-tools')` **能解析**，不需要 `DSH_TOOLS_PATH`。
   （profile 的 `node_modules/@deepseek-ai/` 下只有 cosmokit 与 schemastery，没有 dsh-tools；
   说明宿主加载插件时把自己的模块图暴露给了插件 —— `dsh-video-storyboard` 能工作也是同一个原因。）
2. `apply(ctx, config)` 被调用且**没有走进我的 catch 分支**——走进去了只会返回空 disposer，
   不会 `mkdir` + 建表。
3. 建表 DDL 在真实宿主的 `node:sqlite`（Node 24.21）下执行成功，`journal_mode` 真的是 `wal`。

## 远端模式：在第二台设备上开启

三件事：主机起板服务 → 第二台设备配 endpoint → 用 CLI 确认通。

### 1. 主机起板服务

只有**一台**主机需要起它（板就住在这台上）。要不要占端口由你定，这里默认 `13090`，
刻意避开 `13080/13081/13084/13085/13087`。

```powershell
# 密钥：两边必须一致。没有密钥时所有写操作会被拒绝（fail-closed，不是放开）
$env:DSH_TEAM_BOARD_TOKEN = "<自己定一个足够长的随机串>"
$env:DSH_TEAM_BOARD_PORT  = "13090"          # 可选，默认 13090
$env:DSH_TEAM_BOARD_HOST  = "127.0.0.1"      # 走 SSH 隧道就绑回环，别直接暴露到 0.0.0.0
$env:DSH_TEAM_BOARD_DB    = "C:\path\to\team.db"  # 可选，默认 $DSH_HOME/team/team.db

node src/server.js
```

起来后会打印：

```
[board] listening on http://127.0.0.1:13090
[board] db = C:\...\team.db
[board] auth = token 已配置
```

> **为什么绑 127.0.0.1**：板服务本身没有 TLS。走 SSH 隧道时它只需要在本机回环上可达，
> 对外由隧道负责加密。直接 `0.0.0.0` 暴露等于把明文密钥送出去。

### 2. 第二台设备配 endpoint

在第二台设备的 profile 里给插件加两项配置：

```yaml
- id: dsh-team-mesh
  config:
    boardEndpoint: 'http://127.0.0.1:13090'   # 隧道在本机落地的地址
    boardToken: '<与主机相同的密钥>'
```

或用环境变量（避免密钥写进配置文件）：`DSH_TEAM_BOARD_ENDPOINT`、`DSH_TEAM_BOARD_TOKEN`。

关键点：**`boardEndpoint` 指向的是"本机上隧道落地的那个地址"，不是主机的公网 IP。**
本仓库验证时看到的就是这种形态 —— `127.0.0.1:13081` 实际是 `sshd` 在 `Listen`，
`cordis.patch.yml` 里写明"经 PC 侧反向隧道落在本机 13081"。板服务同理，只是换个端口。

装配期就会做一次 `/health` 自检：连不上、或密钥不对，**插件加载时直接报错并说明原因**，
不会拖到模型第一次调用才炸。

### 3. 确认真的通了（不用启动 DSH）

```powershell
$env:DSH_TEAM_BOARD_ENDPOINT = "http://127.0.0.1:13090"
$env:DSH_TEAM_BOARD_TOKEN    = "<同一密钥>"

node tools/client_cli.mjs health
```

期望看到 `✔ 板服务可达`、`service=dsh-team-mesh board`、`schema=1`。
然后可以用 CLI 走完整闭环（这一步跨进程、跨机器都成立）：

```powershell
node tools/client_cli.mjs create --title "跨机测试"
node tools/client_cli.mjs claim  --task t-xxxxxxxx
node tools/client_cli.mjs report --task t-xxxxxxxx --ref "C:\path\proof.txt" --note "做完了"
node tools/client_cli.mjs complete --task t-xxxxxxxx
node tools/client_cli.mjs events --task t-xxxxxxxx
```

`report` 会给物证算哈希并打印**服务端算的**和**本地算的**两个值，两边必须一致：

```
已上传并按内容寻址：blob://sha256:60071572...7d88
  sha256（服务端算）=60071572901e...ee7d88  52 字节
  ✔ 两边一致
```

### 回滚到单机

把 `boardEndpoint` 从配置里删掉（或注释掉），重启 DSH 即可。
板服务可以一直停着 —— 单机模式根本不连它，行为与 0.1.0 完全一致：

```powershell
# 完全卸载
dsh plugin --profile <profile> remove dsh-team-mesh
```

回滚不影响数据：单机的 `team.db` 一直在原地没被改动；远端板的数据在板服务那台机器上。

## 跨机证据是怎么校验的（这块值得单独说）

单机模式里 `evidenceRef` 是本机绝对路径，比如 `F:\proof.txt`。**这在别的机器上不存在**，
于是门禁只会判"文件不存在"，跨机永远无法完成。

远端模式改成两段：

```
产出端（B 机器）                        板服务（主机）                      验收端（A 机器）
  本机文件 F:\proof.txt
        │ 读字节
        ▼
  POST /blob/put  ────字节───────▶  自己算 sha256
                                    存进 blob 表（key = sha256）
                                           │
                                    返回 blob://sha256:<hash>
        ◀──────────────────────────────────┘
        │ 用这个引用报证据
        ▼
  POST /task/report  ─────────────────▶  按 key 取字节、再算一次哈希核对
                                           │ 自洽才判可采信
                                           ▼
                                    门禁通过 → done
```

关键性质：

- **模型没有机会自报哈希。** 它只给一个本机路径或一段说明；哈希是板服务对字节算的。
- **`blob://sha256:<hex>` 是内容寻址。** 引用本身就是哈希，所以"哈希不一致"这件事
  在表示层就不可表达 —— 想伪造只能伪造一个板上不存在的 key，而那会被判"对象不存在"。
- **防御纵深**：取出的字节还会再算一次哈希与 key 比对。就算 blob 表被人改过，
  key 与内容不自洽也照样拒绝（有专门用例，见 `docs/evidence/`）。
- **不存在的路径不会被"上传失败"变成合格证据。** 客户端只在 `fs.existsSync` 为真时上传；
  不存在就原样发给服务端，由服务端判"不存在"并拒绝。

## 没验证什么（不隐瞒）

| 项 | 状态 | 原因 |
| --- | --- | --- |
| 真实两台物理机（各自独立的 DSH + 真实 SSH 隧道）跨机闭环 | **已验证（0.4.0 双机验证）** | 真实 mcloud ↔ server 两台机器、临时板 + 真实 HTTP：**8/8 场景、154/154 断言通过、exit 0**；证据 `verify/evidence/run-20261114171435-364d85609d/`。注意：验证客户端是独立 Node 进程，不是真实 DSH 宿主（见下一行） |
| 真实两个 DSH 实例之间的 `mesh_dispatch` | **未实测** | 双机验证的客户端是独立 Node 进程（`RemoteBoard` / 裸 HTTP），没走 `mesh_dispatch` → interconnect → 对端 DSH 会话；需要两个真实 DSH 宿主加载本插件并重启 |
| 真实 DSH 宿主里的总管分流（`sessionController.create()` / `prompt()`） | **未验证** | 签名与字段按 `app.asar` 编译产物核对 + 契约锁测试钉住 AbortSignal；首次 `mode:'queue'` prompt 是否被新会话接受、是否真的起跑并 ack，未在活宿主跑 |
| 生产板服务换新代码（GC / 落盘审计 / 限流 / `POST /task/adopt`） | **未做** | 需部署 + 重启板服务才生效；本版只改工作副本，没碰生产 13090、没重启任何进程 |
| 生产库上的真实 blob GC（会删多少 / 下游是否报"对象不存在"） | **未验证** | 只给了只读预检 SQL，没在生产库执行 |
| 0.4 三块功能的变异测试（mutation） | **未做** | dispatcher / 板硬化 / adopt 只有针对性用例与断言，既有 mutation 脚本未扩展；"这些用例真的会变红"没有变异证明 |
| 真实 OS 级 PID 复用 | **未验证** | 双机验证用"同 pid + 不同 start_sec"精确触发 `PID_REUSED` 判定分支（等价输入），没制造 OS 真把同一 pid 分配给新进程的巧合（不可控、低概率）；建议以单测注入覆盖为准 |
| 板服务在租约存续期间重启 | **未验证** | 板进程身份变化对 stale / 先占判定的影响，未在两机场景覆盖 |
| 进程内定时 sweep 路径 | **未验证** | 双机验证用确定性显式 `POST /sweep`（`DSH_TEAM_BOARD_SWEEP_MS=0`）；`>0` 的定时器长驻路径未跑 |
| 审计 JSONL 原始文件进证据 | **未验（证据链缺口）** | 双机验证的板审计 `.jsonl` 原始文件因远程采集一次超时未进证据目录；审计事实改以 `/events` HTTP 导出为准（覆盖了全部断言）。非产品缺陷 |
| 审计跨天滚动 / 断电丢行 / 高并发限流 | **未验** | 只验了单日文件命名与追加、静态阈值；没有跨天等待、没有压测、没做掉电测试 |
| 对端会话被唤醒（`resume: true`）的行为 | **未实测** | 会真的花对端的模型额度 |
| 并发的两个实例同时认领 / 两个总管同时处理同一条派发 | **部分** | 用两个 `Board` 指向同一文件 + 两个 CLI 进程验了互斥；总管竞态靠"cursor 先写"降低风险，没做并发压力测试 |
| 板服务长期运行的稳定性（内存/连接泄漏） | **未验** | 只做了秒级验证，没有长跑 |
| Linux/macOS | 未验 | 本次范围只要 Windows |

> 0.4.0 的双机交叉验证**已完成**（8/8 场景、154/154 断言，见下文「0.4 双机交叉验证」）。
> 它覆盖的是"真实两台机器 + 真实 HTTP 板 + 真实子进程 worker"，**不等于**"两个真实 DSH 宿主 + interconnect 派活"，
> 后者仍在表里标未实测。


## 我要怎么测

分三层，从便宜到贵。**第 1 层不用重启、不用花钱**，出问题基本都在那里。

### 第 1 层：环境检查（10 秒，随时可跑）

```powershell
cd "F:\DeepSeek work space\dsh-team-plugin"
node tools/verify.mjs
```

它按证据强弱查 16 项，全绿才说明"装对了 + 加载了 + 在跑"：

| 查什么 | 不过说明什么 |
| --- | --- |
| 源码与装入副本哈希一致 | **最常见**：改过代码但副本是旧的（`pnpm add` 会判"已最新"而跳过，必须 `remove` 再 `add`） |
| 副本声明了 `inject: interconnect` | 跨实例派活会不可用（`ctx.interconnect` 读到 undefined） |
| profile 的 dependencies 与 bundles 都有它 | 装了但没进组合，宿主不会加载 |
| 板文件存在 + 表齐全 + WAL | `apply()` 没跑过 → 没重启，或走进了 catch 分支 |
| 事件表有内容 | 插件加载了但事件订阅没生效 |
| 有可采信证据 | 门禁闭环没真正跑过 |

### 第 2 层：在会话里让模型真调（验证"工具对模型可见"）

这一步只能在新会话里做，因为工具列表在会话启动时固定。**随便开一个新会话**，说：

> 用 mesh_task_create 建一个任务，标题叫"测试"，然后 mesh_task_list 列出来

看到建出 `t-xxxxxxxx` 并能列出来，就说明工具真的注册到模型侧了。

想验门禁，接着按这个顺序说（每一步的**预期**都写好了，对不上就是有问题）：

| 你说 | 预期结果 |
| --- | --- |
| `mesh_task_complete`（不报证据直接完成） | 拒绝，原因含 `NO_EVIDENCE` |
| `mesh_task_report` executed=true, outcome=pass, note="我保证做完了"（**不给 evidenceRef**） | 记录成功但**可采信：否**，理由"判 pass 但没有 evidenceRef" |
| `mesh_task_complete` 再试一次 | 仍然拒绝，原因含 `NO_ADMISSIBLE_EVIDENCE` |
| `mesh_task_report` 带一个真实文件的绝对路径 + outcome=pass | **可采信：是**，并打印实算的 sha256 |
| 自己用 `Get-FileHash` 算同一个文件 | 两个哈希**必须一致**——一致才证明它是真读盘算的，不是抄模型自报的 |
| `mesh_task_complete` | 完成，状态 `done` |

### 第 3 层：跨实例派活（最贵，会打扰另一个实例）

```powershell
# 另开一个 DSH 实例（比如 headless profile），确认它也有本插件
dsh plugin --profile headless add "file:F:\DeepSeek work space\dsh-team-plugin"
```

然后在会话里：

> 用 mesh_peers 带上 includeSessions，告诉我有哪些对端和活会话

能列出 `pc-ky614` 与它的会话 id，就说明 `ctx.interconnect` 通了。
再用 `mesh_dispatch` 把任务派到那个会话 id，看返回的是 `已投递` 还是 `未投递 + 原因`
（`session-not-live` / `unreachable` / `peer-not-configured`）。

### 只想看板里有什么

```powershell
node tools/verify.mjs          # 含最近 6 条事件
```

或者直接读 `C:\Users\admin\.dsh\team\team.db`（SQLite，WAL 模式）。

### 回归：不能压坏原有功能

```powershell
node --test "test/*.test.mjs"      # 39 tests，应全绿
node tools/mutation.mjs            # 5 个单机变异必须全被抓、drift=0
node tools/smoke.mjs               # 13 项端到端
node tools/e2e_remote.mjs          # 24 项跨机（A/B/C/D 四组）
node tools/mutation_remote.mjs     # 6 个跨机变异必须全被抓、drift=0
```

## 实测记录：踩到并修掉的四个真问题

**① `pnpm add` 不会更新已装的 `file:` 依赖。** 改完源码直接 `dsh plugin add` 输出 `Already up to date`，
装入副本的哈希仍是旧的 —— 重启也不会生效。**必须 `remove` 再 `add`**，并用 `verify.mjs` 的哈希对照确认。

**② `inject` 少写一个服务，跨实例派活会静默失效。** 最初写的是 `inject: ['tools']`，
结果 `mesh_peers` 报"本实例上没有 interconnect 服务"，但同一时刻 `peer.event` 事件照收不误
——因为订阅事件走 `ctx.on`（不要求注入），读 Service 走 `ctx.interconnect`（**要求注入**）。
两者表现不一致正好把它暴露出来。改成 `inject: ['tools', 'interconnect']`。

**③ 变异测试第一次没抓到两条防御纵深。** 跨机变异里 M3（删掉 blob 哈希形状校验）和
M4（不校验 key 与内容自洽）**首次全部漏网** —— 因为当时的用例只覆盖"形状合法但板上没有"，
没覆盖"形状非法"和"库里 key 与内容不自洽"。补了两条针对性用例后 6/6。
教训：变异测试不是走形式，它恰好指出"哪些代码写了但从没被执行过"。

**④ 反例用例一度因为别的原因失败，看起来却像通过。** 用 CLI 测"路径不存在"时忘了给 `--note`，
结果报的是 `INVALID_FIELD: note 不能为空` —— 它**确实失败了**，但失败原因不对，
等于那条证据校验根本没被测到。补上 note 后才真正验到 `evidenceRef 文件不存在`。

## 开发

`@deepseek-ai/dsh-tools` 打在 `app.asar` 里，普通 node 进程 import 不到。
`tools/vendor_deps.mjs` 会把它连同依赖从 asar 解到 `vendor/node_modules/`（迭代解析缺包），
契约测试就用这一份真实 `defineTool`。

```powershell
node tools/vendor_deps.mjs        # 解 dsh-tools 及其依赖（约 11 个包）
node --test "test/*.test.mjs"     # 全量测试
node tools/mutation.mjs           # 单机变异测试
node tools/smoke.mjs              # 端到端冒烟（不启动 DSH）
node tools/e2e_remote.mjs         # 跨机 e2e（自己起板服务，随机端口）
node src/server.js                # 起板服务
node tools/client_cli.mjs health  # 板服务运维客户端
```

- `tools/asar.mjs` — 零依赖 asar 读取器（`list` / `extract`）。头部布局踩过坑，注释里写了实测值。
- `DSH_TEAM_DEBUG=1` — 让 `apply()` 把加载错误抛出来（默认吞掉并记日志，因为插件坏了不该让应用起不来）。
- `DSH_TOOLS_PATH` — 本地开发时指向 `dsh-tools/lib/index.js`，让 `apply()` 能解析到它。
- `DSH_TEAM_BOARD_TOKEN` / `DSH_TEAM_BOARD_PORT` / `DSH_TEAM_BOARD_DB` — 板服务的配置。
- `DSH_TEAM_BOARD_ENDPOINT` / `DSH_TEAM_BOARD_TOKEN` — 客户端配置（CLI 用）。

## 已知限制

- 单机模式下板是**单机共享**的（跨机请用远端模式，见上文）。网络盘共享 SQLite **不推荐**：
  SQLite over SMB 的锁不可靠，WAL 尤其容易损坏。
- 远端模式**只有一个板服务**（单点）。板服务停了，所有设备的写操作都会失败 —— 但它是
  **明确失败**（`BOARD_UNREACHABLE`），不是静默成功。没有做多副本 / 故障转移。
- 租约过期只会标 `stale` 并留痕，**没有自动重派**：重新认领（`claim`）或收养（`adopt`）仍要人 / 模型
  发起，不存在"调度器自动把死掉的任务再派出去"。
- 没有成员/角色概念：只有会话（session）与任务。原型阶段刻意不引入（总管 dispatcher 是**会话级配置**，
  不是角色系统）。
- `mesh_dispatch` 的跟踪止于**回执**（`ack`）：对方接了之后是否真的在干、干到哪一步，只能看共享板上的
  租约 / 证据 / 事件；派发方不会收到主动推送。
- 板服务硬化后仍有边界：审计 append **不 fsync**（崩溃/断电可能丢最后几行）；限流是固定窗口
  （边界允许约 2 倍突发），按 `socket` IP + token 指纹分桶 —— 前面若加了反向代理，所有调用方会共用
  代理 IP（此时 token 指纹仍能区分密钥）。
- 总管（dispatcher）在**远端板**模式下只做了代码路径设计（`cursor` 读写都是 `RemoteBoard` 已有方法），
  没对真实板服务跑过；且远端板禁止客户端写审计，`dispatcher.*` 事件只在本地板可写。
- 收养（adopt）的"允许未验证"是**策略开关，没有审批流**：谁在什么情况下有权打开
  `allowUnverifiedAdoption` / `DSH_TEAM_BOARD_ALLOW_UNVERIFIED_ADOPT` 属于运维决策；代码只保证
  "不把未验证写成已验证"。

> 上一版列过的两条限制（`blob` 只增不删、板服务没有速率限制与落盘审计）自 0.4 起不再成立，
> 见下文「板服务安全与硬化（0.4）」对应小节。

## 板服务安全与硬化（0.4）：监听地址 / blob GC / 落盘审计 / 限流

上面「已知限制」里有两条自本版起不再成立：`blob` 不再是"只增不删"，板服务也补上了速率限制与落盘审计。四项都是**保护**，默认值按「不改变现有行为、不打断正常轮询」来定，且都能用环境变量关掉。

| 能力 | 默认 | 配置 | 要点 |
| --- | --- | --- | --- |
| 监听地址 | `127.0.0.1`（**与改造前一致**） | `DSH_TEAM_BOARD_HOST` | `/health` 新增 `listen_host` / `listen_port` / `listen_host_configured` / `listen_exposed` / `listen_hint`，启动日志也打印实际 bind 地址 |
| blob GC | **启用**，保留 7 天 | `DSH_TEAM_BOARD_BLOB_GC=0` 关；`DSH_TEAM_BOARD_BLOB_RETENTION_MS` 改保留期 | 随 `POST /sweep` 与进程内定时 sweep 一起跑；**只要 blob 还被任意 evidence 的 `ref_sha256` / `blob://sha256:` 引用就永不删除**；幂等；sweep 响应与 `/health.gc` 报计数 |
| 落盘审计 | **启用**，写板库同目录 `audit/` | `DSH_TEAM_BOARD_AUDIT=0` 关；`DSH_TEAM_BOARD_AUDIT_DIR` 改目录 | 状态变更请求追加 `board-audit-YYYY-MM-DD.jsonl`（按天滚动）；只记路由/状态/耗时/IP/actor/task_id，**不记 token、不记请求体**；写失败只 warn，请求照常成功 |
| 限流 | **启用**，每调用方 600 次 / 60 秒 | `DSH_TEAM_BOARD_RATE_LIMIT`、`DSH_TEAM_BOARD_RATE_WINDOW_MS`；`=0` 关闭 | 按「客户端 IP + token 指纹」分桶；超限回 `429` + `error.code=RATE_LIMITED` + `retry-after`；`GET /health` 豁免（看门狗不能被自己的探活打死） |

### 租约接管：`claim` 宽松 / `adopt` 三证据（0.4）

`claim` 的判据只有**时间**：`stale` 或租约过期就能接管（行为与改造前完全一致，`lease.taken_over` 留痕）。它回答不了两个问题：**原持有者是不是真的死了**、**这段租约过期后有没有被别人续过**。`mesh_task_adopt` 把这两个问题变成必须同时成立的三类证据：

| 证据 | 判据 | 记进 `lease.adopted` payload |
| --- | --- | --- |
| E1 时间 | `lease_until` 已过期，或任务已被扫描标 `stale=1` | `time.lease_until` / `expired` / `stale` / `overrun_ms`（负数表示时间上还没到、是 stale 标记放行的） |
| E2 身份 | **只有板服务与租约持有者同机时才有资格验 pid**（`os.hostname() == lease_host` 且记录里有 pid）：同机判 pid 是否消失/被复用；跨机、记录缺身份、判定者不知道自己在哪 → 一律 `unverified` | `identity.verdict` / `reason` / `checked_pid` |
| E3 事件 | 该任务最后一条租约类事件（claim / renew / heartbeat / revived）早于 `lease_until`，且之后没有任何续租痕迹 | `event.last_kind` / `last_at` / `renewals_after_lease_until` |

拒绝码是稳定契约：`ADOPT_NOT_STALE` / `ADOPT_HOLDER_ALIVE` / `ADOPT_EVIDENCE_INSUFFICIENT` / `ADOPT_EVIDENCE_UNVERIFIABLE` / `ADOPT_NOT_CLAIMED` / `ADOPT_STATE_INVALID`（HTTP 层 409）。`claim` 的旧行为未改动 —— 能证明原持有者已死时优先用 `adopt`，被拒时不要用 `claim` 绕过同一个判断。

**诚实边界（这条比功能本身重要）**：板服务在 A 机，就永远不能替 B 机断言"`pid 1234` 已经不存在了"——两台机器各有 pid 1，跨机验 pid 是伪命题。所以 E2 跨机时只能标 `unverified`，**默认策略直接拒绝**（`ADOPT_EVIDENCE_UNVERIFIABLE`）；把未验证写成已验证，比不做判定更危险。确认风险后要放行时：

```yaml
# 单机板（插件配置）
- id: dsh-team-mesh
  config:
    allowUnverifiedAdoption: true   # 默认 false
```

```powershell
# 远端板（板服务进程）：远端模式下的放行策略由板服务决定，客户端无法自我授权
# 取值 1 / true / yes / on 均可（解析口径已在本次发布前修正，见下方 P1）
$env:DSH_TEAM_BOARD_ALLOW_UNVERIFIED_ADOPT = "1"
```

放行后 `lease.adopted` 的 payload 里 `unverified=true`，工具返回文本会醒目标注"未验证收养"，`/health.adoption.allow_unverified` 报当前策略。

> **P1（本次发布前已修正，同一 0.4.0）**：早期解析只认 `true`（`=1` 会被忽略 —— 安全方向仍是默认拒绝，但会让人误以为已放行）；现在接受 `1/true/yes/on`。
> **P2（本次发布前已修正，同一 0.4.0）**：`ADOPT_EVIDENCE_UNVERIFIABLE` 的拒绝响应 detail 现在也带 `policy` 字段（与成功响应同口径），可从拒绝响应直接判断当前策略。

### 收窄到 `127.0.0.1` 的利弊

**利**：板服务没有 TLS，只有共享密钥。绑回环时网络上看不到它，跨机由 SSH 隧道负责加密与认证；隧道一断，暴露面自然归零。这是推荐部署方式，也是默认值。

**弊**：别的设备不能直连，每台设备都要各建一条 SSH 隧道/端口转发（`ssh -L 13090:127.0.0.1:13090 ...`），多一层要维护的东西；隧道挂了客户端只会看到 `BOARD_UNREACHABLE`，需要人判断是隧道问题还是板服务问题。

**什么时候才绑 `0.0.0.0`**：只有确认端口落在**受信内网或已有的加密隧道**里、且接受"共享密钥明文过网络"时才这么做。绑了之后 `/health.listen_exposed` 为 `true`，启动日志也会警告——把它接进告警，比事后发现好。

```powershell
# 推荐：只在本机回环提供服务，跨机走 SSH 隧道
$env:DSH_TEAM_BOARD_HOST = "127.0.0.1"
# 仅在受信内网/加密隧道里才这么绑（/health 会标 exposed=true）
# $env:DSH_TEAM_BOARD_HOST = "0.0.0.0"
```

## 总管（dispatcher）角色（0.4）：只 ack + spawn，不执行

多台机器一起用时，对端常常**只有一个活会话**，所有任务都堵在它那里：前一个任务没干完，后一个任务卡在
同一个上下文里排队，表现就是一串 `ack_timeout`。总管角色把"接信"和"干活"拆开：

```yaml
- id: dsh-team-mesh
  config:
    dispatcherSessions: ['<总管会话 id>']   # 命中列表的会话 = 总管，只分流不执行
    dispatcherCwd: 'C:\work'                # 可选：子会话的工作目录（缺省用宿主默认 cwd）
    dispatcherAgentPreset: 'default'        # 可选：子会话使用的 agent preset
    dispatcherPollMs: 3000                  # 可选：轮询共享板的间隔（默认 3000ms，250–60000）
```

派发给**本实例某个总管会话**（`task.dispatched` 的 `peer_session` 命中、`peer_instance` 是本实例、
且 `delivered=true`）的任务，插件会：

1. 从共享板读派发事件，**先把去重位点写进 `cursor` 表**（键 `dispatcher@<会话id>`，与真会话的收件箱
   游标隔离），再去建会话 —— 顺序反了会留下"建完会话但没记上 → 重启再建一个"的双开窗口；
2. 用 `sessionController.create()` 建**一个**专属子会话，用 `prompt(request, signal)` 投任务书
   （任务号 + 标题 + brief/验收标准 + claim → 干活 → 心跳 → report → complete 的固定指令）；
3. 由总管会话身份**代签回执**（`ack.acker` 落的是总管，不是子会话）。子会话任务书里已写明
   "回执已由总管代签，你不用再调 `mesh_task_ack`"。

**总管永不执行任务**：`mesh_task_claim` / `mesh_task_adopt` 命中总管会话时抛 `DISPATCHER_NOT_EXECUTOR`，
任务状态与负责人都不变。未配置 `dispatcherSessions` 时，行为与 0.3.x 完全一致（旧调用方不受影响）。

**spawn 失败不许假装受理**：create / prompt 任何一步失败 → **不 ack**、落 `dispatcher.failed`
（`stage` + `reason`，prompt 失败时带 `child_session`），那条派发保持 pending，最终由板的清扫判成
`ack_timeout`。这比"已经回执但没人干"诚实得多。

**审计事件**：`dispatcher.spawn_intent` / `dispatcher.spawned` / `dispatcher.failed` /
`dispatcher.ack_failed` / `dispatcher.skipped`。远端板禁止客户端写审计（`REMOTE_AUDIT_READONLY`），
所以远端模式下这几类事件降级为本机日志；去重位点仍走 `cursor`（`Board` 与 `RemoteBoard` 都有）。

**哪些派发总管不碰**：派给非总管会话、`peer_instance` 不是本实例、`delivered=false`（没有回执窗口，
由派发方按"信没送到"收尾）、任务已 `done`/`canceled`（落 `dispatcher.skipped` `task-closed`）、
任务已有负责人（只代签回执，不建第二个子会话，避免同一任务双开工互相抢租约）、派发窗口已结束
（`ack_state` 不是 `pending`，已 ack / 已超时）。

**诚实边界**：`sessionController.create()` / `prompt(request, signal)` 的签名与字段是对着装好的
`app.asar` 编译产物（`@deepseek-ai/dsh-api-session-controller`）逐行核对的，并用契约锁测试钉住
"prompt 第二个参数必须是 `AbortSignal`"（少传在真机必炸，桩测试不会报）；但**没有在真实 DSH 宿主里
跑过**。剩下的未验证点：新会话是否接受首次 `mode:'queue'` 的 prompt、是否真的起跑并最终 ack。
首次真机验证时盯三处：`dispatcher.spawned` 的 `child_session`、子会话是否出现 running/claim、
该任务最终是否被认领。

## `newSession` 派发的回执窗口下限 180s（0.4）

`mesh_dispatch` 的 `ackTimeoutMs` 同时牵扯两件不同的事，必须分开：

| 等什么 | 用哪个时限 | 行为 |
| --- | --- | --- |
| **建会话等待**（仅 `newSession=true`）：等对端把会话建出来 | `ackTimeoutMs`，缺省 60s | **不受下限影响**：轮询周期 3s，60s 本来就够；混成一件事会让旧用例空等 180s |
| **回执窗口**：投递成功后等对面新会话的模型起跑并 ack | `newSession=true` 时强制 **≥180000ms** | 实测一次要 **99s**，60s 必然误判成 `ack_timeout` |

- 配置项 `newSessionAckFloorMs` 可覆盖 180000；**显式给的更大值仍然生效**（取 `max(你给的, 下限)`）。
- 返回文本**永远写明实际生效的窗口**；你给的值被下限抬掉时会明确提示（`⚠ …已按 …ms 生效`），
  不让调用方以为自己的值被采纳了。
- 非 `newSession` 派发行为不变：仍是 `ackTimeoutMs`，缺省 60s。

## 0.4 双机交叉验证（已完成：8/8 场景、154/154 断言）

真实双机：客户端 mcloud ↔ 板服务 server（LAN 直连；server 上起临时板，随机端口 / 临时库 / 随机 token，
审计落盘开启，`DSH_TEAM_BOARD_SWEEP_MS=0` 由测试显式 `POST /sweep` 驱动）。
**阶段一 4/4 + 阶段二 4/4、154/154 断言通过、exit 0**；证据 `verify/evidence/run-20261114171435-364d85609d/`
（`summary.json` overall=PASS、`exit-code.txt`=0）。八个场景：

1. **跨机闭环**：`lease_host` = 客户端主机 ≠ 板服务主机；服务端实算 sha256 与客户端一致；本机绝对路径跨机
   不可采信（必须走内容寻址）；门禁放行、任务 `done`。
2. **真进程崩溃 → stale → 接管**：`taskkill /F` 真杀 worker；租约未到期 claim → 409 `ALREADY_CLAIMED`
   （不提前抢活）；到期 sweep 标 stale（跨机只认时间，`overrun_ms` 248ms）；接管留 `lease.taken_over`
   （`prev_lease_pid/start_sec` 完整）。
3. **PID 复用**：冒用旧 owner 身份 / 同 pid 不同 start_sec 两种形态均 400 `PID_REUSED`，拒绝无副作用。
4. **门禁不放松**：无证据 → 409 `NO_EVIDENCE`；最后一条可采信为 `fail` → 409 `LATEST_FAIL`；补 `pass` 后可完成。
5. **同机收养 verified**：持有者在板服务同机，硬杀后 sweep 走 dead-holder 分支（`reason=holder-pid-gone`，
   `overrun_ms` 为负）；adopt → 200：`unverified=false`、`checked_pid=true`、`verdict=adopted-verified`。
6. **跨机收养默认拒绝**：adopt → 409 `ADOPT_EVIDENCE_UNVERIFIABLE`（`unverified-cross-host`）；owner/stale 不变、
   无 `lease.adopted` 事件。
7. **显式放行（未验证收养）**：另起一块设放行策略的板 → adopt 200，但返回与审计都标 `unverified=true`、
   `verdict=adopted-unverified`、`checked_pid=false`；不存在"看起来已验证"的字段。
8. **拒绝路径非永久**：`ADOPT_NOT_STALE` / `ADOPT_NOT_CLAIMED` / `ADOPT_HOLDER_ALIVE` 均 409；随后真杀持有者
   再 adopt → 200 `adopted-verified`（判定随事实变化）。

**诚实边界**：验证客户端是独立 Node 进程而非真实 DSH 宿主，`mesh_dispatch`/interconnect 链路未覆盖；
临时板不是生产 13090，生产部署/重启与生产库 GC 仍未做（见上文「没验证什么」）。
P1/P2 两个实现缺口已在本次 0.4.0 发布前修正（同一版本，见上文「租约接管」小节）。


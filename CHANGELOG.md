# 变更日志

本文件记录 `dsh-team-mesh` 的对外可见变更。写法与 README 一致：**先说结论，再写验证到什么程度，
没验证的事单独列出来，不写成"已支持"**。

版本号在本仓有三处必须同步：`package.json` 的 `version`、`dsh.plugin.json` 的 `version`、
`src/index.js` 的 `PLUGIN_VERSION`。三处不一致视为发布事故（见 `docs/dev/` 下的变更片段与
`reports/` 报告）。

---

## 0.5.0（2026-11-21）

本版收三件事：**修掉 0.4 遗留的"加载失败静默空壳"缺陷**、**stale 任务自动重派（默认关）**、
**任务完成主动通知派发方（默认开）**。`schema_version` 仍为 **4**，**无 schema 变更、无数据迁移**；
不新增第三方依赖；两项新功能的默认值按"不改变现有行为"来定（重派关、通知只在派过活的实例上生效）。

### 修复：`apply()` 吞异常导致插件静默空壳（2026-11-14 已定性为真缺陷）

- 装载失败时在**板库同目录**写 `mesh-load-error.json`（`time` / `version` / `boardEndpoint` /
  `error.message` + `error.stack` 前 2000 字符 / `hint`），日志 error 级并**带文件路径**；
  装载成功时删除上一份遗留的诊断文件。
- 新增 `DSH_TEAM_STRICT=1`：加载失败**抛错**让 DSH 启动失败（运维能看见）；默认仍吞错，
  保持"插件坏了不拖垮宿主"的初衷。`DSH_TEAM_DEBUG=1` 行为不变（也抛错）。
- README 新增「插件没加载上怎么查（0.5）」，写清诊断文件字段、排查顺序与 strict 开关的代价。
- 测试（`test/load_error.test.mjs`，5 条）：失败写诊断文件 / 成功删旧文件 / strict 抛错 /
  默认不抛且返回可调用 disposer / 路径与 defaultBoardPath 同源且**不含 boardToken**。

### 新增：stale 任务自动重派（`autoRedispatch`，默认 `false`）

- 配置：`autoRedispatch: false`、`maxRedispatch: 1`、`redispatchPollMs: 15000`（与完成通知共用定时器）。
- **四条同时满足才重派**：任务未终结 + 已 stale + 重派次数 < `maxRedispatch` + 该次派发是本实例发出的
  （进程内登记表，只有 `mesh_dispatch` **真的投递成功**才登记）。
- 重派 = 同一张任务卡再投回**原** `instanceId` / `sessionId`，并 `recordDispatch` 开一个新的 ack 窗口
  —— 不偷偷改投别的会话，也不新增数据库字段（次数按板上 `task.redispatched` 事件计）。
- 审计：成功 `task.redispatched`（`reason` / `attempt` / `original_instance` / `original_session` /
  `delivered` / `ack_state`）；失败 `task.redispatch_failed`（含 `reason`），**不把失败写成成功**。
- 关闭（默认）时行为与 0.4 一字不差：不读、不写、不发。

### 新增：任务完成主动通知派发方（`notifyOnComplete`，默认 `true`）

- 本实例派出去的任务在板上变成 `done` **或** `canceled` 时，经 `ctx.interconnect.send` 给
  **原派发方会话**发一条 ≤200 字短消息（任务号 / 标题 / 最终状态 / 耗时 / 证据数量，不发整段 payload）。
- **同一任务只通知一次**：按板上 `task.notify_sent` / `task.notify_failed` / `task.notify_skipped`
  事件去重（无新增字段），进程内另有兜底，避免远端板写不了审计时每轮重复通知。
- 没有 interconnect 时不报错，落 `task.notify_skipped`（`reason=no-interconnect`），降级为
  "板上事件 + 收件箱注入"；送到落 `task.notify_sent`，没送到落 `task.notify_failed`（含 `reason`）。

### 版本与验证

- 版本 `0.4.0` → `0.5.0`，三处同步：`package.json` `version`、`dsh.plugin.json` `version`、
  `src/index.js` `PLUGIN_VERSION`。
- 全量单测：**263 / 263 通过、0 失败**（新增 19 条：`test/load_error.test.mjs` 5 条、
  `test/lifecycle.test.mjs` 14 条；原 244 条一条没红）。
- **变异验证（证明新测试不是摆设，均先备份后还原）**：删掉"装载成功删旧诊断文件" → 1 条红；
  重派条件去掉 stale 判断 → 1 条红；通知去重条件取反 → 5 条红。
- 未验证（本版不替它背书，单列如下）：
  1. **没有在真实 DSH 宿主里跑过 0.5**：本版只在本仓跑单测，没有重启任何 DSH；在用的三台
     （pc-ky614 / server / mcloud）插件侧仍是 0.4 运行中。
  2. **通知"回到本实例自己的会话"这条路未实测**：按 `dsh-interconnect` 公开类型，`send` 需要
     `peers` 里有以自己 `instanceId` 为键的 `self` 路由；本机 profile 没配 self，所以真实环境里
     预期是 `delivered:false` → `task.notify_failed`（如实降级，不是成功路径）。测试里用的是假
     interconnect，只证明了"delivered/reason 被如实记录"。
  3. **远端板模式下新审计事件未实测**：远端板禁止客户端写审计（`REMOTE_AUDIT_READONLY`），
     `task.redispatched` / `task.notify_*` 只在本地板可写时落盘；远端模式的重派次数靠进程内计数兜底。
     这条没有对真实板服务跑过。
  4. **跨机 true HTTP 场景只跑了本仓脚本**：`node tools/e2e_remote.mjs` **24/24 通过**、
     `node tools/e2e_v2.mjs` **29/29 通过**（脚本自起板服务、随机端口，是"真 HTTP 但同一台机器"，
     不等于两台真实主机）。本版不做跨机双机声明。
  5. 插件重启前派出的任务不会被自动重派 / 主动通知 —— 登记表在内存里，这是"不新增字段不做迁移"
     的既定代价，已写进 README 已知限制。

## 0.4.0（2026-11-14）

本版把三块并行开发的功能收进同一个发布候选：**总管（dispatcher）角色**、**板服务硬化**、
**三证据收养（adopt）**。三块都是"保护性"改动：默认值按"不改变现有行为、不打回正常轮询"来定，
且每一项都能显式关掉。`schema_version` 仍为 **4**，**无 schema 变更、无数据迁移**。

### 新增：总管（dispatcher）角色 —— 只 ack + spawn，不执行

- 新增配置 `dispatcherSessions: string[]`（命中这些会话 id 的派发由插件分流）：可选
  `dispatcherCwd` / `dispatcherAgentPreset` / `dispatcherPollMs`（默认 `3000`ms）。
- 总管收到派发时，插件自动建**一个**子会话（`sessionController.create` + `prompt` 投任务书），
  并由总管会话身份**代签回执**；总管自己永不动手：`mesh_task_claim` / `mesh_task_adopt` 对它抛
  `DISPATCHER_NOT_EXECUTOR`。
- **一次派发只 spawn 一次**：去重位点写在共享板 `cursor` 表（键 `dispatcher@<会话id>`），进程重启后
  不重复；顺序是**先落去重位点、再建会话** —— 宁可"位点过了但会话没建成"（会以 `ack_timeout` 暴露），
  也不重复烧对端模型额度。
- **spawn 失败不许假装受理**：不 ack、落 `dispatcher.failed`，派发方最终看到的是 `ack_timeout`
  （"送到了没人管"是诚实的结论）。
- 新增审计事件：`dispatcher.spawn_intent` / `dispatcher.spawned` / `dispatcher.failed` /
  `dispatcher.ack_failed` / `dispatcher.skipped`（远端板只读时降级为本机日志）。

### 修复：`newSession` 派发的回执窗口下限 180s

- **两种等待必须分开**：建会话等待（等对端把会话建出来）仍用 `ackTimeoutMs`，缺省 60s，**不受下限影响**；
  回执窗口（等对面新会话的模型起跑并 ack，实测要 99s）在 `newSession=true` 时**强制 ≥180s**
  （常量 `NEW_SESSION_ACK_FLOOR_MS`，配置项 `newSessionAckFloorMs` 可覆盖）。
- `mesh_dispatch` 返回**永远写明实际生效的窗口**；调用方给的值被下限抬掉时会明确提示，不让它以为
  自己的值被采纳了。
- 非 `newSession` 派发行为不变（仍是 `ackTimeoutMs`，缺省 60s）。

### 硬化：板服务 blob GC / 落盘审计 / 限流 / 监听地址

- **blob GC**：`POST /sweep` 与进程内定时 sweep 现在会回收「无 evidence 引用且超过保留期（默认 7 天）」
  的 blob；被任意 evidence 引用的一个都不删；幂等；结果在 `POST /sweep` 的 `gc` 段与 `/health.gc` 里报计数；
  `DSH_TEAM_BOARD_BLOB_GC=0` 可关，`DSH_TEAM_BOARD_BLOB_RETENTION_MS` 可改保留期。
- **落盘审计**：状态变更请求追加 JSONL 到板库同目录 `audit/board-audit-YYYY-MM-DD.jsonl`，按天滚动；
  只记路由/状态/耗时/IP/actor/task_id，**不记 token、不记请求体**；写失败只 warn、不影响请求；
  `DSH_TEAM_BOARD_AUDIT=0` 可关，`DSH_TEAM_BOARD_AUDIT_DIR` 可改目录。
- **限流**：按「客户端 IP + token 指纹」固定窗口限流，默认 **600 次 / 60 秒**；超限返回 `429` +
  稳定码 `RATE_LIMITED` + `retry-after`；`GET /health` 豁免（看门狗不能被自己的探活打死）；
  `DSH_TEAM_BOARD_RATE_LIMIT=0` 可关。
- **监听地址**：`/health` 新增 `listen_host` / `listen_port` / `listen_host_configured` /
  `listen_exposed` / `listen_hint`，启动日志打印实际 bind 地址；**默认仍是 `127.0.0.1`，行为不变**，
  `DSH_TEAM_BOARD_HOST` 可配。绑定到 `0.0.0.0` 时 `/health.listen_exposed=true` 且启动日志告警。
- 兼容性：`schema_version` 仍为 4；`POST /sweep` 只**新增** `gc` 段，老字段原样；鉴权三级语义不放松；
  未加第三方依赖。

### 新增：`mesh_task_adopt` —— 三证据收养

- 新增工具 `mesh_task_adopt`（工具契约 + 板服务 `POST /task/adopt` 写类路由；无密钥 / 只读密钥一律 `401`）。
  它给"stale 之后由谁接手"提供一条**比 claim 更严**的路径，回答 claim 回答不了的两个问题：
  原持有者是不是真的死了、这段租约过期后有没有被别人续过。
- 三类证据**同时成立**才接管：
  - **E1 时间**：`lease_until` 已过期，或任务已被扫描标 `stale=1`（记 `overrun_ms`）；
  - **E2 身份**：**只有板服务与租约持有者同机时才可能验 pid**（`os.hostname() == lease_host` 且有 pid）。
    跨机、记录缺身份、判定者不知道自己在哪台机器 —— 一律标 `unverified`，**绝不把未验证写成已验证**
    （两台机器各有 pid 1，跨机验 pid 是伪命题）；
  - **E3 事件**：该任务最后一条租约类事件早于 `lease_until`，且 `lease_until` 之后没有任何续租痕迹。
- 拒绝码是稳定契约：`ADOPT_NOT_STALE` / `ADOPT_HOLDER_ALIVE` / `ADOPT_EVIDENCE_INSUFFICIENT` /
  `ADOPT_EVIDENCE_UNVERIFIABLE` / `ADOPT_NOT_CLAIMED` / `ADOPT_STATE_INVALID`（HTTP 层统一 `409`）。
- **默认严格**：身份无法验证就拒绝。确认风险后要放行时：单机插件配 `allowUnverifiedAdoption: true`
  （默认 `false`），板服务设 `DSH_TEAM_BOARD_ALLOW_UNVERIFIED_ADOPT=1`（`1/true/yes/on` 均可，
  解析口径见「实现说明」）。放行后 `lease.adopted` 事件
  payload 里 `unverified=true`、`verdict="adopted-unverified"`，工具返回文本也醒目标注 ——
  **不把未验证写成已验证**。远端模式下放行策略只由板服务决定，客户端无法自我授权。
- 成功收养落 `lease.adopted` 审计事件：含原负责人 / 原租约身份、三类证据原文、`verdict`、`policy`；
  同时把任务置 `working`、换负责人、按新身份发新租约，并清掉 stale。
- **`claim` 的现有行为一个字没改**（stale / 过期仍可接管并留 `lease.taken_over`）。`adopt` 是可选的安全
  路径；被拒时不要用 `claim` 绕过同一个判断。
- 可观测：`/health.adoption.allow_unverified` 报当前策略；启动日志打印"未验证收养默认拒绝 / 已放行"。

### 发布

- 版本号 `0.3.3-prototype` → **`0.4.0`**（去掉 `-prototype` 后缀），三处同步；npm `files` 增补
  `CHANGELOG.md`。
- 工具总数 **12 → 13**（新增 `mesh_task_adopt`）；注册名以 `src/spec.js` 的 `TOOL_NAMES` 为准。
- `docs/dev/changelog-core.md` / `changelog-board.md` / `changelog-adoption.md` 三份开发期变更片段
  保留在仓库里作为过程材料，对外说明以本文件为准。
- 0.4.0 已提交进 server 权威仓（commit `80156d8`，23 文件 +6518/−43）；该仓原地全量单测
  239 / 239 通过。
- **部署状态（2026-11-15）**：生产板服务已重启加载 0.4.0（板服务侧生效）；server 与 mcloud 的 desktop
  profile 插件文件已升级为 0.4.0，但两边 DSH **未重启**（下次重启才加载）。开关清单与部署事实见
  `docs/dev/0.4.0-开关清单.md` / `docs/dev/0.4.0-部署记录-20261115.md`。

### 已验证（本工作副本实跑）

| 项 | 结果 |
| --- | --- |
| 单测（15 个文件） | **244 / 244 通过**，0 失败（约 46–60s，含 P1/P2 修复新增的 5 条） |
| `tools/e2e_remote.mjs` | 24 / 24 通过 |
| `tools/e2e_v2.mjs` | 29 / 29 通过 |
| **双机独立验证**（真实 mcloud ↔ server 两台机器） | **8 / 8 场景、154 / 154 断言通过，exit 0**（证据 `verify/evidence/run-20261114171435-364d85609d/`；逐条见下文「双机交叉验证」节） |
| **生产板部署**（server 常驻板服务） | 2026-11-15 已重启加载 0.4.0：`/health` 出现 `listen_*`/`gc`/`audit`/`rate_limit`/`adoption` 段，`schema_version=4`，`adoption.allow_unverified=false`；首轮 sweep 回收 1 个无引用孤儿 blob（约 175 小时龄、7775 B），`kept_referenced=6` / `kept_fresh=8` / `remaining=14` / `failures=0`（详见部署记录） |
| **真实 DSH 宿主（隔离实例）激活（激活层）** | 隔离 `DSH_HOME` + profile 真实启动 0.4.0：stderr 无 pending/failed、`apply()` 跑完（板文件被创建、只读验收 16 项 15 通过）、`src/spec.js` 实测 13 个工具；**只到激活/装配层** —— `已加载：13 个工具` 是 info 日志（CLI 不导出），没有宿主注册表级/模型侧证据，不能据此声称工具已注册到宿主（见 `docs/dev/隔离宿主启动与验证.md`） |

说明：本次发布收口**只改版本号与文档**，不改功能代码；上面的单测 / e2e 是收口后重跑的。
双机验证用的是 server 上的**临时板**（随机端口、临时库、随机 token，`DSH_TEAM_BOARD_SWEEP_MS=0`），
客户端是 mcloud 上的独立 Node 进程 —— **不是两台真实 DSH 宿主**，`mesh_dispatch` 经 interconnect 投递
那一段未在双机验证里覆盖（见"未验证"第 2 条）。

### 未验证（诚实边界，别当成已支持）

1. **真实 DSH 宿主里的总管分流没跑过**：隔离实例已验证 0.4.0 能被真实宿主**激活**（stderr 无
   pending/failed、`apply()` 跑完），但**没有做模型调用**：`sessionController.create()` /
   `prompt(request, signal)` 的实际执行、首次 `mode:'queue'` prompt 是否被接受、是否起跑并 ack、
   是否 spawn 子会话，均未在活宿主实测（签名按 `app.asar` 核对 + 契约锁钉住 AbortSignal）。
   另：宿主**工具注册表级 / 模型侧工具目录未直接观测**——`已加载：13 个工具` 是 info 日志，CLI 启动下
   不导出（详见 `docs/dev/隔离宿主启动与验证.md`）。
2. **双机验证不是"两个真实 DSH 宿主"**：验证里的客户端是 mcloud 上的独立 Node 进程（`RemoteBoard` /
   裸 HTTP），`mesh_dispatch` 经 interconnect 投递到对端 DSH 会话这一段仍未在双机上覆盖。
3. **插件侧尚未加载 0.4.0**：板服务侧已换新代码并重启（2026-11-15 生效）；三处 desktop profile
   （server / mcloud / pc-ky614）插件文件都已是 0.4.0，但**三台 DSH 都没重启**，工具/代码仍是旧版，
   下次重启才加载。重启后判据：**stderr 无 pending/failed 诊断**（不要等 `已加载：13 个工具` info 行，
   CLI 启动下它本来就不导出）。
4. **生产库真实 GC 只跑过首轮**：2026-11-15 首次 sweep 回收 1 个无引用孤儿 blob（约 175 小时龄、7775 B）；
   `kept_referenced=6` / `kept_fresh=8` / `remaining=14` / `failures=0`。长期回收节奏、SQLite 文件缩小
   （不会自动缩）与下游引用都仍需观察；被引用的 blob 一个没删。
5. **0.4 的三块功能都没有变异测试（mutation）**：dispatcher / 板硬化 / adopt 只有针对性用例与断言，
   "这些用例真的会变红"没有变异证明（既有 mutation 脚本没扩展）。
6. **真实 OS 级 PID 复用**：双机验证用"同 pid + 不同 start_sec"精确触发了 `PID_REUSED` 判定分支
   （等价输入），但没有制造操作系统把同一 pid 真分配给新进程的巧合（不可控、低概率）；建议以单元测试
   注入覆盖为准。
7. **板服务在租约存续期间重启**：板进程身份变化对 stale / 先占判定的影响，未在两机场景覆盖。
8. **进程内定时 sweep 路径**：双机验证用确定性显式 `POST /sweep`（`DSH_TEAM_BOARD_SWEEP_MS=0`），
   当时未跑定时器；2026-11-15 生产板重启后由**进程内定时 sweep** 完成首轮回收（部署脚本未外部触发
   `POST /sweep`），该路径已真实跑过一轮；多轮长驻 / 空转稳定性仍未长跑。
9. **A1 审计 JSONL 原始文件未进证据**：双机验证的板审计 `.jsonl` 原始文件因远程采集一次超时未进入证据
   目录；审计事实改以 `/events` HTTP 导出为准（覆盖了全部断言）。这是证据链缺口，不是产品缺陷。
10. **板服务长期运行未验**：没有长跑（内存 / 连接泄漏）、没有审计跨天滚动、没有高并发限流压测；
    审计是"尽力而为"（append 不 fsync，崩溃可能丢最后几行）；限流是固定窗口（边界允许 2 倍突发）。
11. **Linux / macOS 未验**：本版范围只要 Windows。

### 双机交叉验证（已完成：8 / 8 场景、154 / 154 断言）

真实双机：客户端 mcloud ↔ 板服务 server（LAN 直连）；server 上起**临时板**（随机高位端口、临时库、
随机 token，审计落盘开启，`DSH_TEAM_BOARD_SWEEP_MS=0` 由测试显式 `POST /sweep` 驱动）。
**阶段一 4/4 + 阶段二 4/4，154/154 断言通过，exit 0**；证据目录
`verify/evidence/run-20261114171435-364d85609d/`（`summary.json` overall=PASS、`exit-code.txt`=0）。
逐条：

1. **跨机闭环**：`lease_host` = 客户端主机名、≠ 板服务主机名；服务端实算 sha256 与客户端本地一致；
   反向对照 —— 客户端本机绝对路径当 `evidenceRef` 会被判不可采信（跨机必须走内容寻址）；门禁放行、任务 `done`。
2. **真实进程崩溃 → stale → 接管**：`taskkill /F` 真杀 worker 子进程；租约未到期时 claim → 409
   `ALREADY_CLAIMED`（不提前抢活）；到期 sweep 标 stale（跨机只认时间：`overrun_ms` 248ms、无 `reason`）；
   接管留 `lease.taken_over`（`stale=true`、`prev_lease_pid/start_sec` 完整），heartbeat 后 `was_stale=false`。
3. **PID 复用被拒**：两种形态（冒用旧 owner 身份 / 同 pid 不同 start_sec）均 400 `PID_REUSED`，拒绝无副作用。
4. **完成门禁不放松**：无证据 → 409 `NO_EVIDENCE` + `task.gate_rejected`；最后一条可采信证据为 `fail` →
   409 `LATEST_FAIL`；补一条可采信 `pass` 后可完成（语义是"最后一条可采信证据"，不会永久卡死）。
5. **同机收养 verified**：持有者跑在板服务同机，硬杀后 sweep 走 **dead-holder 分支**
   （`dead_owner_count=1`、`reason=holder-pid-gone`、`overrun_ms` 为负 = 租约时间没到、按"进程死了"判）；
   `POST /task/adopt` → 200：`unverified=false`、`checked_pid=true`、`verdict=adopted-verified`；
   `lease.adopted` 带三类证据与 `prev_lease_pid/lease_host`；任务 owner 更新、stale 清除。
6. **跨机收养默认拒绝**：跨机只认时间（`dead_owner_count=0, expired_count=1`）；`POST /task/adopt` → 409
   `ADOPT_EVIDENCE_UNVERIFIABLE`（`reason=unverified-cross-host`、`checked_pid=false`、`verdict=unverified`）；
   拒绝后 owner 不变、任务仍 stale、**无 `lease.adopted` 事件**。
7. **显式放行（未验证收养）**：另起一块设放行策略的板（`/health.adoption.allow_unverified=true`），
   同样跨机场景 `POST /task/adopt` → 200，但返回与审计**都明确标注未验证**：`unverified=true`、
   `verdict=adopted-unverified`、`checked_pid=false`、`policy.allow_unverified_adoption=true`；
   不存在任何"看起来已验证"的字段。
8. **收养拒绝路径**：租约有效 → 409 `ADOPT_NOT_STALE`；任务未认领 → 409 `ADOPT_NOT_CLAIMED`；
   同机持有者仍活 → 409 `ADOPT_HOLDER_ALIVE`；随后真杀该持有者，同一任务再 adopt → 200 `adopted-verified`
   （**拒绝不是永久的，判定随事实变化**）。

诚实边界：验证客户端是**独立 Node 进程**而非真实 DSH 宿主，`mesh_dispatch`/interconnect 链路未覆盖；
临时板不是生产 13090 —— 生产部署/重启与生产库 GC 仍未做（见"未验证"第 3、4 条）。

### 实现说明（P1 取值口径与 P2 可观测性已在本次发布前修正）

两机验证抓到两个实现缺口，**修复都合入同一个 0.4.0**（不另升版本号）：

- **P1 取值口径（已修正）**：早期解析只认 `true`（`src/server.js` 用 `toLowerCase() === 'true'`），
  而文档与启动日志写的是 `=1` —— 按文档配置却不生效，会把"默认拒绝"误判成"已放行"
  （安全方向是更严，但会造成误判与排障干扰）。**现在接受 `1 / true / yes / on`**（trim + 小写），
  与文档口径一致。
- **P2 可观测性（已修正）**：`ADOPT_EVIDENCE_UNVERIFIABLE` 的拒绝响应 detail 现在与成功响应同口径
  带 `policy.allow_unverified_adoption`（`domain.js` 的策略快照对成功 / 拒绝只算一次、两处共用），
  调用方可以从拒绝响应直接区分"策略没放行"与"被别的证据挡住"。

这两条都是 verifier 在两机验证里实测发现、并在本次发布前修掉的；0.4.0 只有这一个版本号。

### 升级与回滚

**升级**

1. 板服务那台机器：更新代码后**重启板服务**（新路由、新默认策略、`/health` 新字段都是进程加载期定的）。
2. 各客户端机器：更新插件副本后**重启 DSH**（`PLUGIN_VERSION` 与 dispatcher 装配在插件加载期生效）。
   注意 `pnpm add` / `dsh plugin add` 对已装的 `file:` 依赖不会更新内容，**必须 `remove` 再 `add`**，
   并用 `tools/verify.mjs` 的源/装哈希对照确认。
3. 无数据迁移：`schema_version` 仍是 4，库文件原样可用。

**回滚**

- 板服务侧：还原 `src/backend.js`、`src/server.js`、`tools/sweep_once.mjs`（adopt 还涉及
  `src/{domain,store,spec,handlers,remote}.js` 与 `src/index.js` 的那一行依赖注入），重启板服务。
- 插件侧：还原版本三处与 `src/` 对应文件，重启 DSH。
- 新增的测试、`docs/dev/changelog-*.md`、本 CHANGELOG、README 新节可保留 —— 它们不参与运行。
- 数据库不需要回滚操作（无 schema 变更；GC 只删无引用的 blob）。

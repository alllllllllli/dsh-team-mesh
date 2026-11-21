# 变更日志

本文件记录 `dsh-team-mesh` 的对外可见变更。写法与 README 一致：**先说结论，再写验证到什么程度，
没验证的事单独列出来，不写成"已支持"**。

版本号在本仓有三处必须同步：`package.json` 的 `version`、`dsh.plugin.json` 的 `version`、
`src/index.js` 的 `PLUGIN_VERSION`。三处不一致视为发布事故（见 `docs/dev/` 下的变更片段与
`reports/` 报告）。

---

## 0.7.0（2026-11-21）

**向官方 Agent Teams 对齐任务语义（依赖 / 写域 / 乐观并发），新增 noWait 禁等待守卫，
并对 0.6.1 板服务做能力探测式兼容。** `schema_version` 4 → **5**（新增两列，幂等迁移）；
不新增第三方依赖；工具总数仍 **14**（无新工具，只加可选参数与文案）。

### 新增：任务依赖 `blockedBy`（`mesh_task_create`）

- 可选 `blockedBy: string[]`。**照官方 `task-view.ts` 的 `taskReady`**：所有 blocker 都
  `completed`（本插件 = `done`）才 ready。`canceled` 不算完成（官方只认 completed，本插件同样不把
  "取消"当"做完"），所以创建时拒绝让已取消任务当 blocker。
- `mesh_task_claim` 在未 ready 时拒绝，错误码 `BLOCKED_BY_DEPS`（终局，直到依赖变化）；
  `mesh_task_adopt` 同样不能绕过依赖。
- 创建时全图校验（照官方 `task-graph.ts`）：缺失 → `TASK_NOT_FOUND`、重复 → `INVALID_FIELD`、
  自依赖/成环 → `TASK_DEPENDENCY_CYCLE`。
- `mesh_task_create` / `list` / `claim` 返回带 `ready` 与 `blockedBy`；`ready` 是**派生值**
  （`open && 依赖全 done`），不落冗余状态列。

### 新增：写入范围 `writeScopes`（`mesh_task_create`）

- 可选 `writeScopes: string[]`（workspace 相对路径前缀）。归一化照官方 `validation.ts` 的
  `writeScope`；非法值报 `INVALID_WRITE_SCOPE`。
- 与进行中任务（`working`/`claimed`）写域重叠时返回 `writeScopeWarnings`
  （字段名与官方 `types.ts` 一致），**只警告不阻止** —— 写域是协作提示，不是锁。

### 新增：乐观并发 `expectedRevision`（claim / complete / cancel / report / adopt）

- 可选整数；与当前 `revision`（= 老字段 `version`）不一致 → `REVISION_CONFLICT`（**可重试**），
  detail 带 `expected_revision` / `current_revision` / `retryable: true`，任务不被改动。
- 不给该参数时行为与 0.6.1 逐字节一致（维持既有检查）。
- 注意：revision 包含心跳/派发回执等写操作（每次 +1），`expectedRevision` 适合"读一次马上写"；
  跨心跳的长流程请省略。本插件没有 `mesh_task_update` 工具，依赖只能在创建时定死。

### 新增：错误码分类（终局 vs 可重试）

- `src/domain.js` 新增 `ERROR_CATALOG` / `describeErrorCode()` / `isRetryableError()`；
  HTTP 错误体新增 `retryable` 与 `hint`。**老码一个不改名**，只加官方语义别名：
  `TASK_CLOSED`→`TASK_TERMINAL`、`ALREADY_CLAIMED`→`LEASE_HELD`、
  `REVISION_CONFLICT`→`TEAM_TASK_STALE_REVISION`、`TASK_DEPENDENCY_CYCLE`→`TEAM_TASK_DEPENDENCY_CYCLE`。
  README 有完整「哪些可重试」表。

### 新增：noWait 禁等待守卫（默认只作用于 mesh worker）

- `src/noWait.js`（新文件）：用宿主真实 API `ctx.tools.guard()`（app.asar 内 dsh-tools 已核）；
  拦三类：bash/pwsh 命令含 `sleep`、前台 `timeoutMs > 30000`、`job_output` 有效等待 > 5000ms。
  拒绝原因是可读的一句话（为什么拦 + 怎么改：后台任务 + 短 `job_output` + heartbeat）。
- 默认 `noWaitGuard: 'mesh-workers'`：只作用于**正在持有 mesh 任务的会话**（本进程登记表：
  claim/adopt 记入，complete/cancel 移除），主人自己的长命令不受影响；`'all'` / `'off'` 可改。
- 宿主没有 `guard()` → 不装守卫、只 WARN，**绝不让插件加载失败**。
- 已知边界：登记表进程内，跨实例/重启不回收（只影响是否启用守卫，不影响任务语义）。

### 兼容：0.6.1 板服务（能力探测 + 自动降级）

- 客户端启动时读既有 `/health`：优先 `capabilities` 数组，其次 `schema_version >= 5`，否则 legacy。
- legacy（0.6.1）下：**不发送** `blockedBy` / `writeScopes` / `expectedRevision`；
  返回按空依赖/空写域处理，`ready` 退化为 `open && 无依赖`；**不做 CAS**（退回既有检查）。
- `mesh_task_create` / `mesh_task_list` 明确提示「远端板是 0.6.1 旧服务端，这些字段未生效」。
- 探测失败（health 没有字段）同样按 legacy 处理；**加载绝不因此失败**（0.6.0 事故教训）。

### schema v4 → v5（幂等迁移）

- `task` 表新增 `blocked_by TEXT NOT NULL DEFAULT '[]'`、`write_scopes TEXT NOT NULL DEFAULT '[]'`；
  按 `PRAGMA table_info` 判缺再 ALTER，可反复执行；老行自动 `'[]'`（无依赖/无写域，与 v4 语义一致）。
- 未建关联表：依赖/写域判定都基于全量任务视图，一条 `SELECT *` 更简单。
- 真实数据验证：对**生产共享板**（mcloud，0.6.1 / schema 4）只读拉取 **30 任务 / 177 事件 /
  27 证据**，物化成 v4 快照后迁移 —— 行数逐表一致、schema 4→5、老行 JSON 默认 `'[]'`、
  二次打开幂等。另对在用本地 `$DSH_HOME/team/team.db`（实测 0 行）副本验证了机制与幂等；
  **原件未改**。

### 文档/提示词对齐（纯文案）

- README + 工具 description 写入官方**终态报告五态**（`progress / ready / blocked / failed / dropped`）
  与**人类注意力规则**（只有人能行动 / 结果可用 / 确定做不了才发消息，默认沉默，"删句测试"）。
- 写清与官方 Agent Teams 的分工：单机走官方；mesh 只做跨机 + 租约 + 证据门禁 + 唤醒限速。

### 测试与验证

- 全量 **328 / 328 通过**（`node --test test/*.test.mjs`，node v24.19.0）：0.6.1 基线 299 条**一条没删**
  （其中 5 条 schema 版本断言随 v4→5 更新，见下），新增 **29 条**：
  `test/v5_task_graph.test.mjs`（15：依赖/写域/CAS/错误码分类/取消 blocker 后不锁板/v5 迁移）、
  `test/v5_remote_compat.test.mjs`（5：能力探测 / legacy 不发新字段 / 新版发新字段）、
  `test/no_wait_guard.test.mjs`（9：命中/不命中/开关/别名/登记表/apply 端到端守卫）。
- 既有断言改动（仅版本号相关，未弱化判定）：`adoption.test.mjs` B10、`v4_lease_identity.test.mjs` A1、
  `board_hardening.test.mjs` H1、`v4_health_schema.test.mjs` H1/H4/H11 —— 把"schema 必须还是 4"
  改为"schema 现在应为 5"，并补 v5 列存在性断言；H4 反证目标从 5 改为 6 以保持"非写死"的证明力。
- 未验证：**未在真实 DSH 宿主里加载 0.7.0**（本任务禁止重启 DSH）；宿主内工具可见性与
  `ctx.tools.guard()` 的实际拦截效果需重启后确认（guard API 只对着 app.asar 的 dsh-tools 核对过）。

---

## 0.6.1（2026-11-21）

**行为修复：远端板不可达时默认降级到单机板，不再让整个插件加载失败。**
`schema_version` 仍为 **4**（无 schema 变更、无数据迁移）；不新增第三方依赖；
远端能连上时行为与 0.6.0 完全一致，工具总数仍 **14**。

### 修复：`boardEndpoint` 连不上 → 整插件不加载（2026-11-21 真事故）

- 事故：重启后 `boardEndpoint` 指向的板服务因网络断不可达，`registerAll` 启动自检抛错 →
  `apply()` 吞掉并返回空 disposer，**全部工具一个都没注册**，团队任务工具消失；
  只在 `$DSH_HOME/team/mesh-load-error.json` 里留下一条错误证据。
- 新增配置 `boardFallback: 'local' | 'fail'`，**默认 `'local'`**：
  - `local`：远端健康检查失败（超时 / 拒绝 / 鉴权失败 / 非 JSON / endpoint 非法）时，
    打一条 WARN（含 endpoint 与错误摘要，**不含 boardToken**）→ 改用本地板
    （与单机模式完全相同的 Board 实现与库路径，建目录/建表沿用现有路径）→ **全部工具照常注册**；
    写 `mesh-degraded.json`（`time` / `version` / `mode: 'local-degraded'` / `endpoint` /
    `error.message` / `hint`），并删掉残留的 `mesh-load-error.json`。
  - `fail`：维持 0.6.0 旧行为（装配期抛错 → 写 `mesh-load-error.json`；`DSH_TEAM_STRICT=1` 时抛给宿主）。
  - 其他取值按 `local` 处理并 WARN（拼写错误不该把插件打挂）。
- 降级后本地板初始化失败（库被锁 / 无权限 / 目录不可写）→ **如实按加载失败处理**
  （写 `mesh-load-error.json`），不假装成功。
- 后台恢复探测：默认每 30s（`boardRetryMs` 可覆盖）用 2s 短超时探 `GET /health`；
  恢复只在日志/诊断里记**一次** `remote_available_again: true` 并提示重启切回，
  **不热切换板后端**（本地/远端状态会打架）；定时器 `unref()` 且 dispose 时清掉。
- 可诊断性：`mesh_peers` 输出**首行**给出 `板模式：远端 / 本地 / 本地降级（原因）`；
  降级时 `mesh_dispatch` 提示「当前本地板，跨机任务不会同步；网络恢复后重启 DSH 切回远端」。
  不新增工具（仍 14 个），不改 mesh 语义（租约 / 三证据 / 板模式判定均未动）。
- 测试：新增 `test/board_fallback.test.mjs`（10 条：默认降级 / fail 旧行为 / strict 抛错 /
  取值校验与拼错 / `mesh_peers` 板模式 / `mesh_dispatch` 降级提示 / 远端可用不降级并清旧证据 /
  先失败后成功只记一次恢复 / dispose 后定时器不再跑 / 降级后本地板建任务列任务可用）。
  `test/load_error.test.mjs` 的远端失败用例显式改为 `boardFallback: 'fail'`（它测的就是旧行为）。
  全量 **299 / 299 通过**（0.6.0 基线 289 条一条没删；新增 10 条）。
- 未验证（本版不替它背书，单列如下）：
  1. **真实远端恢复路径未实测**：本机网络断（`172.24.112.14` 不可达），恢复探测只用
     真 HTTP 假板服务（127.0.0.1）验证过；
  2. **没有在真实 DSH 宿主里跑过 0.6.1**：本版只在仓库跑单测，没有重启任何 DSH；
     已装副本仍是 0.6.0，要等用户重启才生效；
  3. **降级期间跨机派活**只验证了"提示出现、投递行为不变"，没有验证对端在远端板上
     查不到任务时的真实表现（这本来就是降级的已知限制，已写进 README）。

## 0.6.0（2026-11-21）

本版收三项 P0 改进，全部来自调研报告（`C:\Users\ky614\mesh-research-report.md`）第 5 节：
**对端可诊断（`mesh_peers` 补证据 + 新工具 `mesh_peer_probe`，工具数 13 → 14）**、
**完成通知改走本机会话直投（失败再降级 interconnect）**、**入站唤醒限速四道闸（默认全关）**。
`schema_version` 仍为 **4**，**无 schema 变更、无数据迁移**；不新增第三方依赖（只用 Node 标准库）；
所有新配置项的默认值都按"不改变现有行为"来定 —— 不配就与 0.5 完全一致。

### 新增：对端可诊断 —— `mesh_peers` 补三种证据 + `mesh_peer_probe`（P0-3）

- `mesh_peers` 每行在原有 `up/down` 与 origin 之外补：**TCP 连通性**（`node:net` 真连一次
  origin 的 host:port，1s 超时，带耗时/错误码）、**链路状态**（`interconnect.peers()` 的 `link`）、
  **可能原因**（down 时并列列出端口不通 / 隧道断了 / token 不一致 / instanceId 不匹配，
  区分不了就并列并标注"本行 TCP 证据能排除什么"，**不瞎猜单一原因**）。
- 新工具 `mesh_peer_probe({ instanceId })`：单点探测，返回配置 origin、解析后 host/port、
  TCP 可达性（耗时/错误）、链路状态、最后错误信息（interconnect `peers()` 不暴露错误字段，
  给的是本轮 TCP 的具体错误；没有就如实说无）、≤3 条可执行建议。
  `instanceId` 未配置时报稳定码 `PEER_NOT_CONFIGURED`（即 `peer-not-configured`）。
- 边界：只读探测（连上即销毁 socket），不改 interconnect 源码/配置、不写状态；
  origin 是 self 解析函数时无法做 TCP 探测，如实标"跳过"。
- 测试（`test/peer_probe.test.mjs`，10 条）：真 `node:net` server 当"通"、刚关闭端口当"不通"；
  TCP 通/不通两种 / 未配置 instanceId 报 `peer-not-configured` / 输出含三种诊断字段 /
  self 解析函数不崩 / 非法 origin 不编 host:port / 契约锁工具总数 14。

### 改进：完成通知改走本机会话直投（P0-1）

- 0.5 的通知只有一条路：`ctx.interconnect.send` 发给原派发方会话。派发方通常就在**本实例**，
  要寻址自己的会话需要 interconnect `peers` 里有 `self` 路由（本机没配），真实环境预期落
  `task.notify_failed`。0.6 起按顺序尝试：
  ① 落点在本实例 → 宿主 `sessionController.prompt(request, signal)` **直投本机会话**；
  ② 直投不可用/会话不活跃（`prompt` 抛错）→ 降级 `ctx.interconnect.send`（0.5 路径）；
  ③ 都不成 → 落 `task.notify_skipped`（`reason=all-channels-failed: local-session=…; interconnect=…`）。
- 每次投递结果都带 **`channel`** 字段：`local-session` / `interconnect` / `none`；
  "本实例通道本来就不适用（远端落点 / 没有 sessionController）且 interconnect 没送到"仍按
  0.5 语义落 `notify_failed`（`channel=interconnect`），"没送到"与"根本没法投"保持可区分。
- 回执落点仍由 0.5 的进程内登记表记录（任务号 / 目标 instance+session / 本实例 id / 派发方会话 id），
  只有 `mesh_dispatch` **真的投递成功**才登记；同一任务只通知一次（去重沿用板上 `task.notify_*`）。
- 测试（`test/notify_local.test.mjs`，5 条）：本实例直投成功（不发 interconnect、正文 ≤200 字）/
  本实例不活跃降级到 interconnect / 两者皆失败落 skipped（reason 写清两边、含 channel=none）/
  远端落点不走直投 / 没有 sessionController 且没有 interconnect 仍是 0.5 的 skipped 语义。

### 新增：入站唤醒限速四道闸（P0-2，默认全关）

- 新增配置：`wakeGuard`（默认 `false` 总开关）、`wakeMinTaskChars`（默认 `0` 不检查）、
  `wakeThreadCooldownMs`（默认 `0`）、`wakeMaxPerThread`（默认 `0`）、`wakeNoWake`（默认 `false`）。
- 闸门在 `mesh_dispatch` **入口、任何投递/建会话动作之前**依次判断（顺序固定：
  SILENT → TOO_SHORT → COOLDOWN → LIMIT）；命中任一就**不投递**，返回稳定码
  `WAKE_SILENT` / `WAKE_TOO_SHORT` / `WAKE_COOLDOWN` / `WAKE_LIMIT`，并落审计事件
  `dispatch.suppressed`（payload 含 `reason`（稳定码）/ `task_id` / `target_instance` /
  `target_session` / `chars` / `min_chars` / `remaining_ms` / `wake_count` / `max_wakes`）。
- 计数只在**真的投递成功**时 +1；进程内 `Map`，**不新增 schema 字段、不改 `schema_version`**、
  不做数据迁移（代价：插件重启计数清零，已写进 README 已知限制）。
- `newSession` 派发没有既有 thread，冷却/上限闸不适用；`WAKE_SILENT` / `WAKE_TOO_SHORT` 仍生效。
- **关闭（默认）时与 0.5 完全一致**：不读表、不落事件、没有闸门判断命中。
- 测试（`test/wake_guard.test.mjs`，11 条）：四道闸各一条 / 命中不投递且落事件 /
  默认全关不触发（连事件都不多一条）/ 非布尔 `true` 不算开 / 投递失败不计唤醒 /
  闸门顺序 / 配置规整与正文计数口径。

### 版本与验证

- 版本 `0.5.0` → `0.6.0`，三处同步：`package.json` `version`、`dsh.plugin.json` `version`、
  `src/index.js` `PLUGIN_VERSION`。
- 全量单测：**289 / 289 通过、0 失败**（原 263 条一条没红；新增 26 条：`peer_probe` 10、
  `notify_local` 5、`wake_guard` 11）。契约测试显式钉住工具总数 **14** 与
  `TOOL_NAMES.probe === 'mesh_peer_probe'`。
- **变异验证（证明新测试不是摆设，均先备份、后还原并校验字节一致）**：
  1. P0-3：关掉 `mesh_peer_probe` 的 `peer-not-configured` 判定 → `peer_probe` **1 条红**
     （未配置 instanceId 用例）；
  2. P0-1：关掉"本实例直投"分支 → `notify_local` **3 条红**（直投成功 / 降级 / 皆失败三条）；
  3. P0-2：让四道闸永不生效 → `wake_guard` **5 条红**（四道闸各一条 + 闸门顺序）。
- 未验证（本版不替它背书，单列如下）：
  1. **没有在真实 DSH 宿主里跑过 0.6**：本版只在本仓跑单测，没重启任何 DSH；运行中的插件仍是 0.5。
  2. **本机会话直投没有真机实测**：`sessionController.prompt(request, signal)` 的签名是对着
     app.asar 与 `dispatcher.js` 已有用法核对的，`sessionController` 用假对象锁形；
     "会话不活跃时 `prompt` 抛稳定错误"这一行为**未在活宿主复现**。
  3. **`mesh_peers` / `mesh_peer_probe` 的 TCP 探测只在 127.0.0.1 上测过**（真 server / 真关闭端口）：
     跨机链路（EasyTier/VNT 隧道、防火墙 drop）的超时表现、以及链路 up 时探测是否会在对端
     webServer 日志里留下无害噪声，**均未实测**。
  4. **唤醒限速的事件落盘未在远端板验证**：远端板禁止客户端写审计（`REMOTE_AUDIT_READONLY`），
     `dispatch.suppressed` 在远端模式下降级为无事件（返回文本仍给稳定码），这条没对真实板服务跑过。
  5. **进程内计数不跨重启**：`wakeThreadCooldownMs` / `wakeMaxPerThread` 的账本在内存里，
     插件重启后清零；本版按"不新增字段、不做迁移"的约束不做持久化。

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

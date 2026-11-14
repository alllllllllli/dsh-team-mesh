# 变更日志

本文件记录 `dsh-team-mesh` 的对外可见变更。写法与 README 一致：**先说结论，再写验证到什么程度，
没验证的事单独列出来，不写成"已支持"**。

版本号在本仓有三处必须同步：`package.json` 的 `version`、`dsh.plugin.json` 的 `version`、
`src/index.js` 的 `PLUGIN_VERSION`。三处不一致视为发布事故（见 `docs/dev/` 下的变更片段与
`reports/` 报告）。

---

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
  （默认 `false`），板服务设 `DSH_TEAM_BOARD_ALLOW_UNVERIFIED_ADOPT=1`。放行后 `lease.adopted` 事件
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

### 已验证（本工作副本实跑）

| 项 | 结果 |
| --- | --- |
| 单测（15 个文件） | **239 / 239 通过**，0 失败（约 44–45s） |
| `tools/e2e_remote.mjs` | 24 / 24 通过 |
| `tools/e2e_v2.mjs` | 29 / 29 通过 |

说明：本次发布收口**只改版本号与文档**，不改功能代码；上面的测试是收口后重跑的
（与三块功能各自交付时的结果一致）。

### 未验证（诚实边界，别当成已支持）

1. **真实 DSH 宿主里的总管分流没跑过**：`sessionController.create()` / `prompt(request, signal)` 的签名与
   字段是对着装好的 `app.asar`（`@deepseek-ai/dsh-api-session-controller`）编译产物逐行核对的，
   并用契约锁测试钉住"prompt 必须传 AbortSignal"；但新会话是否真的接受 `mode:'queue'` 的首次 prompt、
   是否真的起跑并最终 ack，**未在活宿主实测**。症状会是"建出了子会话但子会话不动"。
2. **生产板服务未换新代码**：GC / 落盘审计 / 限流 / 监听地址字段 / `POST /task/adopt` 需**部署 + 重启
   板服务**后才生效；本版没有部署、没有重启生产（13090）。
3. **生产库上的真实 GC 未执行**：会删多少、删后有无下游引用报"板上没有这个内容寻址对象"，
   只给了只读预检 SQL（见板服务硬化报告），没在生产库跑。
4. **0.4 的三块功能都没有变异测试（mutation）**：dispatcher / 板硬化 / adopt 只有针对性用例与断言，
   "这些用例真的会变红"没有变异证明（既有 mutation 脚本没扩展）。
5. **真实双机跨机收养未实测**：跨机边界是用"伪造 `lease_host` 的另一台主机名 + 真实 HTTP"模拟的，
   E2 只比较主机名字符串，这是它能验证的最大范围。
6. **板服务长期运行未验**：没有长跑（内存 / 连接泄漏）、没有审计跨天滚动、没有高并发限流压测；
   审计是"尽力而为"（append 不 fsync，崩溃可能丢最后几行）；限流是固定窗口（边界允许 2 倍突发）。
7. **Linux / macOS 未验**：本版范围只要 Windows。

### 两机交叉验证（进行中，结论待补）

双机（两台互相独立的 DSH + 真实隧道 + 同一块板）交叉验证**仍在进行中**，报告未完成。
在结论补齐之前，本版**不声称**双机闭环已验证 —— 已有结论见上一节"未验证"第 1、5 条。

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

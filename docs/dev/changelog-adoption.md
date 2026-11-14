# 租约接管变更片段（0.4 开发版）

- 新增工具 `mesh_task_adopt`（工具契约 + `POST /task/adopt` 写类路由；板服务无密钥/只读密钥一律 401）。它给"stale 之后谁来接手"提供比 claim 更严的**三证据收养**路径。
- 三证据同时成立才接管：E1 时间（`lease_until` 已过期或 `stale=1`，记 `overrun_ms`）；E2 身份（**只有板服务与持有者同机时才验 pid**；跨机/缺身份/判定者无主机名一律标 `unverified`）；E3 事件（该任务最后一条租约类事件早于 `lease_until`，且过后无续租痕迹）。
- 拒绝有稳定码：`ADOPT_NOT_STALE` / `ADOPT_HOLDER_ALIVE` / `ADOPT_EVIDENCE_INSUFFICIENT` / `ADOPT_EVIDENCE_UNVERIFIABLE` / `ADOPT_NOT_CLAIMED` / `ADOPT_STATE_INVALID`；HTTP 层统一 409。
- **默认严格**：身份无法验证就拒绝。需要放行时，单机插件配 `allowUnverifiedAdoption: true`，板服务设 `DSH_TEAM_BOARD_ALLOW_UNVERIFIED_ADOPT=1`；放行后 `lease.adopted` 事件 payload 里 `unverified=true`，返回文本也会明说，绝不写成"已验证"。
- 成功收养落 `lease.adopted` 审计事件：含原负责人/原租约身份、三类证据原文、`verdict`（`adopted-verified` / `adopted-unverified`）、`policy`；同时把任务置 `working`、换负责人、按新身份发新租约，并清掉 stale。
- `claim` 的现有行为**一个字没改**（stale/过期仍可接管并留 `lease.taken_over`）；adopt 是可选的安全路径，拒绝后不要用 claim 绕过同一判断。
- 可观测：`/health.adoption.allow_unverified` 报当前策略；启动日志打印"未验证收养默认拒绝/已放行"。
- 兼容性：`schema_version` 仍为 4（只复用已有列 + 事件，无迁移）；鉴权分级不放松；未加第三方依赖。
- 生效方式：部署后**需重启板服务**；回滚只需还原 `src/{spec,handlers,remote,server,store,domain}.js` 与 `src/index.js` 的那一行依赖注入（测试与文档可保留）。

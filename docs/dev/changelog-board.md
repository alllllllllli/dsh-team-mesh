# 板服务变更片段（0.4 开发版）

- blob GC：`POST /sweep` 与进程内定时 sweep 现在会回收「无 evidence 引用且超过保留期（默认 7 天）」的 blob；被引用的一个都不删；幂等；结果与 `/health.gc` 报计数；`DSH_TEAM_BOARD_BLOB_GC=0` 可关。
- 落盘审计：状态变更请求追加 JSONL 到板库同目录 `audit/board-audit-YYYY-MM-DD.jsonl`，按天滚动；写失败只 warn、不影响请求；`DSH_TEAM_BOARD_AUDIT=0` 可关。
- 限流：按「客户端 IP + token 指纹」做固定窗口限流，默认 600 次 / 60 秒；超限返回 `429` + 稳定码 `RATE_LIMITED` + `retry-after`；`GET /health` 豁免；`DSH_TEAM_BOARD_RATE_LIMIT=0` 可关。
- 监听地址：新增 `listen_host` / `listen_port` / `listen_exposed` / `listen_hint` 到 `/health`，启动日志打印实际 bind 地址；**默认绑定仍是 `127.0.0.1`，行为不变**；`DSH_TEAM_BOARD_HOST` 可配。
- 兼容性：`schema_version` 仍为 4（无 schema/迁移变更）；`POST /sweep` 只新增 `gc` 段、老字段原样；鉴权三级语义不放松；未加第三方依赖。
- 生效方式：部署后**需重启板服务**才生效；回滚只需还原 `src/server.js`、`src/backend.js`、`tools/sweep_once.mjs`（新增测试与文档可保留）。

## 0.4.0-core（2026-11-14）

- 新增「总管（dispatcher）」角色：配置 `dispatcherSessions: string[]`，可选 `dispatcherCwd` /
  `dispatcherAgentPreset` / `dispatcherPollMs`（默认 3000ms）。
- 总管收到派发时，插件自动建**一个**子会话（`sessionController.create` + `prompt` 投任务书），
  并由总管会话身份代签回执；总管自己永不动手：`mesh_task_claim` 报 `DISPATCHER_NOT_EXECUTOR`。
- 一次派发只 spawn 一次：去重位点写共享板 `cursor` 表（`dispatcher@<会话id>`），重启后不重复；
  **先落去重位点再建会话**，宁可少建也不重复烧对端额度。
- spawn 失败不许假装受理：不 ack、落 `dispatcher.failed`，派发方最终看到的是 `ack_timeout`。
- 新增审计事件：`dispatcher.spawn_intent` / `dispatcher.spawned` / `dispatcher.failed` /
  `dispatcher.ack_failed` / `dispatcher.skipped`（远端板只读时降级为本机日志）。
- `newSession` 派发的**回执窗口**强制下限 180s（配置项 `newSessionAckFloorMs` 可调）；
  **建会话等待不变**（仍 `ackTimeoutMs`，缺省 60s）——两者是两件事，别混。
- `mesh_dispatch` 返回写明实际生效的回执窗口；调用方给的值被下限抬掉时会明确提示。
- 非 `newSession` 派发行为不变（默认 60s）。

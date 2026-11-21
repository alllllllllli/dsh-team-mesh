/**
 * spec.js — 模型的全部契约（只有 schema 与描述，**不含 execute**）。
 *
 * 单列一文件是为了让 `test/contract.test.mjs` 能把同一份 spec 丢给**宿主真实的
 * defineTool** 编译一遍。这一步必须做：schema 用了宿主不认的关键字时，
 * `ctx.tools.register()` 会在 apply 阶段抛错，整个插件树都起不来（用户看到"应用打不开"）。
 *
 * 宿主支持的 schema 子集（对着 @deepseek-ai/dsh-tools 的文档核过）：
 *   string / number / integer / boolean / null / array(items) / object(properties,additionalProperties) / json / oneOf
 * **不支持** minimum、maximum、pattern、maxItems、minLength、format 这类注记式约束。
 * 所以取值范围写在 description 里，越界由 execute 自己兜底校验。
 */

export const TOOL_NAMES = {
  peers: 'mesh_peers',
  create: 'mesh_task_create',
  list: 'mesh_task_list',
  claim: 'mesh_task_claim',
  report: 'mesh_task_report',
  complete: 'mesh_task_complete',
  cancel: 'mesh_task_cancel',
  dispatch: 'mesh_dispatch',
  events: 'mesh_events',
  // v2：闭合"投递成功 / 任务完成 / 发起方知情"这三件事
  ack: 'mesh_task_ack',
  heartbeat: 'mesh_task_heartbeat',
  inbox: 'mesh_inbox',
  // 0.4：三证据收养（比 claim 更安全的 stale 接管路径）
  adopt: 'mesh_task_adopt',
  // 0.6：单点探测（mesh_peers 给全量概览，probe 给一个对端的细节）
  probe: 'mesh_peer_probe',
};

/**
 * `newSession` 派发的**回执窗口**强制下限：180s。
 *
 * 关键区分（这是本轮最容易做错的地方）：
 *   - **建会话等待**：等对端把会话建出来。轮询周期 3s、旧默认 60s 本来就够 → **不受这个下限影响**。
 *   - **回执窗口**：等对面新会话的模型起跑并 ack。实测一次要 99s → 60s 必然误判成 ack_timeout。
 * 所以下限只抬回执窗口，且只在 `newSession=true` 时生效；显式给的更大值仍然生效。
 * 配置项 `newSessionAckFloorMs` 可覆盖（默认就是这里的 180000）。
 *
 * 常量放在 spec 而不是 handlers：这段说明是模型可见契约，取值与说明必须同源，
 * 否则改了代码忘了改文案，模型会按错的时限去等。
 */
export const NEW_SESSION_ACK_FLOOR_MS = 180_000;

const textOut = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
};

/**
 * 0.7：终态报告五态 —— **与官方 Agent Teams 的 orchestrator_report 同一套语义**
 * （来源：官方提示词 `prompts/work.md` 44-49 行，MIT）。放在 spec 里是为了让
 * "模型看的契约"与 README 同源：改了这五个词，两边一起改。
 *
 * 为什么 mesh 需要它：跨机派活最贵的错误不是"做错了"，而是"用一条含糊的进展消息
 * 打断了另一个人"。五态把"内部进展"与"需要人处理"分开，消息才有判据。
 */
const FIVE_STATES_NOTE = [
  '**终态报告五态（与官方 Agent Teams 一致）**：',
  '  progress：还在做，内部进展 —— 继续干活、用 mesh_task_heartbeat 声明活着；不必为此调 complete，也不要打扰人；',
  '  ready：自检通过且证据齐 —— 先 mesh_task_report(pass + evidenceRef)，再 mesh_task_complete（门禁会再判一次）；',
  '  blocked：被**必须由人**解决的事挡住 —— report 里写清具体缺什么、人现在能做什么；',
  '  failed：试过了、确定做不了 —— report(fail, note=原因) 并 mesh_task_cancel(reason)；',
  '  dropped：查无此事 / 无需动作 —— mesh_task_cancel(reason="dropped: …")，不发消息。',
];

/**
 * 0.7：人类注意力规则（官方 `prompts/team/communication.md` 的"默认沉默"口径）。
 * 这是给所有会发消息/会完结任务的工具共用的一段，避免各工具文案各说一套。
 */
const ATTENTION_NOTE = [
  '**人类注意力规则（默认沉默）**：只有三种情况才值得打扰人 —— 人能行动、结果可用、确定做不了；',
  '内部进展、未完成草稿、待跑的检查都不发消息。发之前做"删句测试"：删掉这句，人还能理解结果或采取行动吗？',
];

/**
 * 0.7：mesh 与官方 Agent Teams 的分工（写进工具描述，模型才不会用错层）。
 */
const DIVISION_NOTE = [
  '**与 DSH 官方 Agent Teams 的分工**：单机、同一进程树内的多代理协作**直接用官方 Agent Teams**',
  '（它有任务板、认领、依赖与 Web 面板）；mesh 只补官方没有的那层 —— **跨进程/跨机器**共享板、',
  '租约与心跳、三证据接管、证据门禁、回执与入站唤醒限速。不要把本机单机任务也搬到这里。',
];

export function peersSpec() {
  return {
    name: TOOL_NAMES.peers,
    description: [
      '列出本机这台 DSH 实例配置的对端 DSH 实例（peer），以及每条链路的当前状态；',
      'includeSessions 为 true 时再逐个列出对端**当前活着**的会话，方便挑一个派活目标。',
      '',
      '这是跨 DSH 协作的第一步：不知道有哪些实例、哪些会话活着，就没法派任务。',
      '链路 down 的对端仍然会列出来（它配了但暂时连不上），不要把它当成"不存在"。',
      '',
      '0.6 起每行还带诊断信息：**TCP 连通性**（真连一次 origin 的 host:port，1s 超时）、',
      '**链路状态**（interconnect peers() 的 up/down）、以及 down 时并列列出的**可能原因**',
      '（端口不通 / 隧道断了 / token 不一致 / instanceId 不匹配）。',
      '想深挖某一个对端时用 mesh_peer_probe，它会给出耗时、最后错误与可执行建议。',
      '',
      '0.6.1 起输出**首行给出板模式**：`远端` / `本地` / `本地降级（原因…）`。',
      '看到「本地降级」说明远端共享板连不上、已自动退回本机板 —— 此时跨机任务不会同步，',
      '网络恢复后重启 DSH 才会切回远端。',
      '',
      ...DIVISION_NOTE,
    ].join('\n'),
    parameters: {
      includeSessions: {
        type: 'boolean',
        description: '是否附带每个可达对端的活会话列表（默认 false：只列链路）',
      },
    },
    output: textOut,
  };
}

export function probeSpec() {
  return {
    name: TOOL_NAMES.probe,
    description: [
      '**单点诊断**一个对端实例：mesh_peers 说它 down 时，用这个看细节。',
      '',
      '返回：配置 origin、解析后的 host/port、**真实 TCP 连通性（含耗时与错误码）**、',
      'interconnect 链路状态、最后错误信息（有就给，没有就如实说）、≤3 条可执行诊断建议。',
      '',
      '能区分的：端口不通 / 隧道断了（TCP 层证据）；TCP 通但链路 down（多为 token 或 instanceId 问题）。',
      '不能区分的：TCP 不通时，token 与 instanceId 都没法验证 —— 输出会并列说明，不瞎猜单一原因。',
      '',
      'instanceId 必须是 peers 里配置过的键；没配置会报 `peer-not-configured`（稳定码），',
      '这种情况不该重试，应先改 interconnect 配置。',
    ].join('\n'),
    parameters: {
      instanceId: {
        type: 'string',
        required: true,
        description: '要探测的对端实例 id（来自 mesh_peers；必须是已配置的键）',
      },
    },
    output: textOut,
  };
}

export function createSpec() {
  return {
    name: TOOL_NAMES.create,
    description: [
      '在本机共享任务板上新建一个团队任务。任务对**本机所有 DSH 实例**可见',
      '（板是一份共享 SQLite 文件），但不会自动派给任何人——派发用 mesh_dispatch。',
      '',
      ...DIVISION_NOTE,
      '',
      '0.7 起支持两种可选的任务元信息：',
      '  blockedBy：任务依赖（任务 id 数组）。依赖未全部 completed 时任务不 ready、不能 claim；',
      '             依赖缺失 / 重复 / 自依赖 / 成环 / 引用已取消任务都会被拒。',
      '  writeScopes：工作区相对路径前缀（如 src/parser）。与其他进行中任务写域重叠时**只告警不阻止**，',
      '             列表/查询里会返回 writeScopeWarnings。',
      '',
      'requestId 是幂等键：同一次意图重放（比如网络抖动后重试）不会建出两个任务。',
      '创建只是"登记意图"，不是"完成"；完成必须走 mesh_task_report + mesh_task_complete。',
      '',
      ...FIVE_STATES_NOTE,
    ].join('\n'),
    parameters: {
      title: { type: 'string', required: true, description: '一句话任务标题（≤200 字）' },
      brief: { type: 'string', description: '背景与要求，写清楚对方需要知道的东西（≤4000 字）' },
      acceptance: { type: 'string', description: '验收标准：怎样算做完（≤4000 字）' },
      requestId: { type: 'string', description: '幂等键；同一意图重复提交时填同一个值' },
      blockedBy: {
        type: 'array',
        items: { type: 'string' },
        description:
          '任务依赖（可选）：这些任务 id 必须全部 completed（done）后本任务才 ready、才能 claim。'
          + '不能自依赖、不能成环、不能引用已取消任务；依赖变化前 claim 会返回 BLOCKED_BY_DEPS。',
      },
      writeScopes: {
        type: 'array',
        items: { type: 'string' },
        description:
          '写入范围（可选）：workspace 相对路径前缀数组（如 ["src/parser", "docs"]）。'
          + '与其他进行中任务重叠时只在返回里给 writeScopeWarnings 警告，**不阻止**认领/写入。',
      },
      requireIndependentReview: {
        type: 'boolean',
        description:
          '是否要求独立复核（可选，默认 false）。为 true 时，完成门禁要求最后一条可采信证据的 '
          + 'verifiedBy 存在且不等于上报人；否则拒绝并给出 INDEPENDENT_REVIEW_REQUIRED。',
      },
    },
    output: textOut,
  };
}

export function listSpec() {
  return {
    name: TOOL_NAMES.list,
    description: [
      '列出共享任务板上的任务（按最近更新排序）。',
      '可按生命周期过滤：open（未认领）/ claimed / working / blocked / done / canceled。',
      '已终结（done / canceled）的任务不会再变，别拿它们当待办。',
    ].join('\n'),
    parameters: {
      lifecycle: {
        type: 'string',
        description: '只列某个状态；可填 open / claimed / working / blocked / done / canceled',
      },
      ownerSession: { type: 'string', description: '只列某个会话名下的任务' },
      limit: { type: 'integer', description: '最多返回几条，1-100（默认 20）' },
    },
    output: textOut,
  };
}

export function claimSpec() {
  return {
    name: TOOL_NAMES.claim,
    description: [
      '认领一个任务：把负责人设成当前会话，状态推进到 working，并**拿到一个租约**。',
      '',
      '租约默认 10 分钟。干活期间必须用 mesh_task_heartbeat 定期续租（建议 ≤5 分钟一次）；',
      '租约过期且无心跳，任务会被标 stale 并留事件，**允许被别人重新认领**。',
      '',
      '已被别人认领、租约仍有效、或已终结的任务会被拒绝 —— 拒绝原因会原样返回，不要绕过去。',
      '原负责人租约已过期/stale 时，你可以接管（会在审计里记 lease.taken_over）。',
      '',
      '0.7 起：任务还有未完成的 blockedBy 依赖时**不能认领**，返回 `BLOCKED_BY_DEPS`（终局，直到依赖变化）。',
      '可选 expectedRevision：给一个正整数，与任务当前 revision 不一致就返回 `REVISION_CONFLICT`（**可重试**：',
      '重读任务拿最新 revision 再试）。不给则维持 0.6.1 的既有检查（不做 CAS）。',
    ].join('\n'),
    parameters: {
      taskId: { type: 'string', required: true, description: '任务 id，形如 t-1a2b3c4d' },
      leaseMs: {
        type: 'integer',
        description: '租约时长（毫秒，默认 600000 = 10 分钟）',
      },
      expectedRevision: {
        type: 'integer',
        description:
          '可选乐观并发：任务当前 revision（网格里也叫 version）。不一致返回 REVISION_CONFLICT（可重试）。'
          + '注意心跳/派发回执也会让 revision +1，跨心跳的长流程请省略本参数。',
      },
    },
    output: textOut,
  };
}

export function adoptSpec() {
  return {
    name: TOOL_NAMES.adopt,
    description: [
      '**三证据收养**：在一个任务的租约已经失效（stale 或已过期）后，用比 claim 更严的证据接管它。',
      '',
      '为什么需要它：claim 只要"过期/stale"就能抢 —— 但那只能证明"它没续租"，证明不了',
      '"原持有者真的死了"，也证明不了"过期后没有别人续过租"。adopt 要求三类证据**同时成立**：',
      '  E1 时间：lease_until 已过期，或任务已被扫描标记 stale（payload 记 overrun_ms）；',
      '  E2 身份：**只有板服务与租约持有者在同一台机器上时才可能验 pid**',
      '           （os.hostname() == lease_host，且记录里有 pid）。同机会判 pid 是否还存在 /',
      '           是否被复用；跨机、记录缺身份、判定者不知道自己在哪台机器 —— 一律标 `unverified`，',
      '           **绝不把未验证写成已验证**（两台机器各有 pid 1，跨机验 pid 是伪命题）。',
      '  E3 事件：该任务最后一条租约类事件（claim / renew / heartbeat / revived）必须早于',
      '           lease_until，且 lease_until 之后没有任何续租痕迹。',
      '',
      '拒绝码（稳定，按码分流）：',
      '  ADOPT_NOT_STALE            时间证据不成立（租约还在有效期内且未 stale）',
      '  ADOPT_HOLDER_ALIVE         同机确认持有者进程还活着 —— 该让它 heartbeat，不是抢',
      '  ADOPT_EVIDENCE_INSUFFICIENT 事件证据不成立/被截断（审计流与租约记录矛盾）',
      '  ADOPT_EVIDENCE_UNVERIFIABLE 身份无法验证，且策略不允许未验证收养（**默认**）',
      '  ADOPT_NOT_CLAIMED          任务还没有负责人（直接 claim 即可）',
      '',
      '默认策略是严格的：身份无法验证时**拒绝**。只有显式配置 `allowUnverifiedAdoption: true`',
      '（单机插件）或板服务 `DSH_TEAM_BOARD_ALLOW_UNVERIFIED_ADOPT=1` 才放行未验证收养；',
      '放行后 `lease.adopted` 事件的 payload 里 unverified=true，返回文本也会醒目标注。',
      '',
      '链路：单机板直接在本进程判定；远端板把判定交给**板服务**（只有它所在的主机能验 pid），',
      '所以远端模式下放行策略由板服务配置，不由客户端配置决定。',
      '',
      'claim 的现有行为**没有改动**：它仍然是"过期/stale 即可接管"的宽松路径。',
      '能证明原持有者已死时优先用 adopt（留痕更完整）；adopt 被拒时不要用 claim 绕过同一判断。',
    ].join('\n'),
    parameters: {
      taskId: { type: 'string', required: true, description: '要收养的任务 id' },
      leaseMs: {
        type: 'integer',
        description: '给新持有者的租约时长（毫秒，默认 600000 = 10 分钟）',
      },
      expectedRevision: {
        type: 'integer',
        description: '可选乐观并发：任务当前 revision。不一致返回 REVISION_CONFLICT（可重试）。',
      },
    },
    output: textOut,
  };
}

export function reportSpec() {
  return {
    name: TOOL_NAMES.report,
    description: [
      '为任务记录一条证据。**这是唯一能推动"可以完成"的动作**。',
      '',
      '三个字段的含义必须分开理解，不要合并成一个"成功"：',
      '  executed  你真的执行了吗（false 表示没执行，不可能成为证据）',
      '  outcome   pass / fail / unknown（unknown 表示结果确实不知道，不是"大概成了"）',
      '  evidenceRef  真实产物的绝对路径。判 pass 时**必须**给，且文件必须真的存在；',
      '              哈希与大小由本插件对磁盘实算，模型自报的哈希一律不采信。',
      '',
      '是否"可采信"由插件按上述事实算出来，不由你声明。',
      '',
      ...FIVE_STATES_NOTE,
      '',
      ...ATTENTION_NOTE,
    ].join('\n'),
    parameters: {
      taskId: { type: 'string', required: true, description: '任务 id' },
      executed: { type: 'boolean', required: true, description: '是否真的执行了（false 则本条不可采信）' },
      outcome: { type: 'string', required: true, description: 'pass / fail / unknown 三者之一' },
      note: { type: 'string', description: '你做了什么、看到了什么（≤2000 字）' },
      evidenceRef: {
        type: 'string',
        description: '真实产物的绝对路径（判 pass 时必填；必须是磁盘上真实存在的普通文件）',
      },
      verifiedBy: {
        type: 'string',
        description:
          '谁复核的（可选）。**允许与上报人不同** —— 任务开了 requireIndependentReview 时，'
          + '这一项必须存在且不能等于上报人，否则完成门禁会拒。',
      },
      verifiedAt: {
        type: 'integer',
        description: '复核时间（可选，毫秒时间戳；给了 verifiedBy 才允许给，缺省用当前时间）',
      },
      acceptanceRef: {
        type: 'string',
        description: '对应任务 acceptance 里的哪一条（可选，如 A03）',
      },
      verificationMethod: {
        type: 'string',
        description: '怎么验的（可选）：disk-hash / manual-review / test-run 三者之一',
      },
      expectedRevision: {
        type: 'integer',
        description:
          '可选乐观并发：任务当前 revision。不一致返回 REVISION_CONFLICT（可重试）；'
          + '注意心跳会让 revision +1。',
      },
    },
    output: textOut,
  };
}

export function completeSpec() {
  return {
    name: TOOL_NAMES.complete,
    description: [
      '请求把任务标记为完成。**门禁在写事务内重新判定**，不是你说完成就完成。',
      '',
      '会被拒绝的情况（原因会具体返回）：没有任何证据；证据全部不可采信；',
      '最后一条可采信证据是 fail 或 unknown；任务没被认领；任务已终结。',
      '被拒之后请补证据（mesh_task_report）再试，不要换个说法重试同样的调用。',
      '',
      '只有「ready」才该调它：自检通过且证据齐。还在做（progress）就别调 ——',
      '内部进展不需要打扰任何人。',
      '',
      '可选 expectedRevision：与任务当前 revision 不一致返回 `REVISION_CONFLICT`（**可重试**）。',
      '注意心跳会让 revision +1；刚发出 heartbeat 又带旧 revision 来 complete 会冲突，重读即可。',
    ].join('\n'),
    parameters: {
      taskId: { type: 'string', required: true, description: '任务 id' },
      expectedRevision: {
        type: 'integer',
        description: '可选乐观并发：任务当前 revision。不一致返回 REVISION_CONFLICT（可重试）。',
      },
    },
    output: textOut,
  };
}

export function cancelSpec() {
  return {
    name: TOOL_NAMES.cancel,
    description: [
      '取消一个任务（终态，不可恢复）。已终结的任务会被拒绝。',
      '',
      '取消对应官方五态里的两种收尾：',
      '  failed：试过且确定做不了 —— 先在 mesh_task_report 里写 fail + 原因，再 cancel(reason)；',
      '  dropped：查无此事 / 无需动作 —— 直接 cancel(reason="dropped: …")，不发消息。',
      '',
      '注意：取消**不算完成**。别的任务的 blockedBy 引用它时，那些任务会继续被阻塞（只认 done）；',
      '返回里会如实列出受影响的依赖方。',
    ].join('\n'),
    parameters: {
      taskId: { type: 'string', required: true, description: '任务 id' },
      reason: { type: 'string', description: '取消原因，写进审计（failed / dropped 请注明）' },
      expectedRevision: {
        type: 'integer',
        description: '可选乐观并发：任务当前 revision。不一致返回 REVISION_CONFLICT（可重试）。',
      },
    },
    output: textOut,
  };
}

export function dispatchSpec() {
  return {
    name: TOOL_NAMES.dispatch,
    description: [
      '把任务派给**另一台/另一个 DSH 实例上的某个会话**：通过 interconnect 发一张自包含的任务卡。',
      '',
      '两种派法：',
      '  A) 投给**现成会话**：给 sessionId（来自 mesh_peers({ includeSessions: true })）。',
      '  B) 让对端**新建一个会话**再投：newSession=true，不给 sessionId。',
      '     适合"对端只有一个活会话、所有任务都堵在它那里"的情形 ——',
      '     新建出来的会话专属这条任务，不会和别的活抢同一个上下文。',
      '     注意：必须对端开了 allowCreate 才可用（默认关闭）。被拒时会给明确原因，',
      '     **不会**偷偷改投给现成会话。',
      '     建会话等待与回执窗口是两件事：前者等对端把会话建出来（仍按 ackTimeoutMs，缺省 60s），',
      '     后者等对面新会话的模型起跑并 ack（实测要 99s）—— 所以 newSession 的回执窗口',
      '     **强制 ≥180s**（newSessionAckFloorMs，可配置；显式更大的值仍生效）。',
      '     返回文本会写明实际生效值；若你给的值被下限抬掉，会明确告诉你。',
      '',
      '投递结果**如实返回**：delivered=false 时会给 reason（session-not-live / unreachable /',
      'peer-not-configured 等），不要把它当成派成功。',
      '',
      '**投递成功 ≠ 对方知道，更 ≠ 任务完成。** 每次投递会开一个回执窗口：',
      '接收端应当在 ackTimeoutMs 内调 mesh_task_ack；超时未回执会被判成 ack_timeout，',
      '结果是"送到了没人管"，不是"正常"。',
      '',
      '默认不唤醒对方已休眠的会话（唤醒会真的花对方的模型额度）。确实要唤醒时把 resume 设为 true。',
      '',
      '0.6 起本实例可配置**入站唤醒限速**（wakeGuard / wakeMinTaskChars / wakeThreadCooldownMs /',
      'wakeMaxPerThread / wakeNoWake，默认全关）。命中闸门时**不会投递**，返回稳定码',
      'WAKE_TOO_SHORT / WAKE_COOLDOWN / WAKE_LIMIT / WAKE_SILENT，并落审计事件 dispatch.suppressed。',
      '这是配置命中，不是投递失败；按返回里的处理建议改参数或改配置，不要原样重试。',
      '',
      '派发之前的提醒：只有「ready（结果可用）/ blocked（人能行动）/ 确定做不了」才值得把任务',
      '交出去或催人；还在 progress 的内部活不该派发、也不该发消息。',
    ].join('\n'),
    parameters: {
      taskId: { type: 'string', required: true, description: '要派的任务 id' },
      instanceId: { type: 'string', required: true, description: '对端实例 id（来自 mesh_peers）' },
      sessionId: {
        type: 'string',
        description: '对端会话 id（来自 mesh_peers 的会话列表）。newSession=true 时不要给',
      },
      newSession: {
        type: 'boolean',
        description:
          '让对端新建一个会话再投（默认 false）。为 true 时不要给 sessionId；' +
          '建不出来会如实报错，不会降级投给现成会话。需要对端 allowCreate=true',
      },
      cwd: {
        type: 'string',
        description: '仅 newSession=true：新会话的工作目录（不给就用对端默认目录）',
      },
      agentPreset: {
        type: 'string',
        description: '仅 newSession=true：新会话使用的 agent preset（不给就用对端默认）',
      },
      title: {
        type: 'string',
        description: '仅 newSession=true：给新会话的建议标题（默认用任务标题，便于在对端列表里认出来）',
      },
      resume: { type: 'boolean', description: '对端会话已休眠时是否唤醒它（默认 false，会花对方额度）' },
      delivery: {
        type: 'string',
        description: '投递方式：followup（排队，默认）/ steer（插进正在跑的轮次）/ inject（只写进上下文）',
      },
      ackTimeoutMs: {
        type: 'integer',
        description:
          '时限（毫秒，默认 60000）。两件事分开：① 建会话等待（仅 newSession）用它，缺省 60000；' +
          '② 投递成功后的**回执窗口**也用它，但 newSession=true 时窗口强制下限 180000' +
          '（配置项 newSessionAckFloorMs；显式更大值仍生效）。你给的窗口被下限抬掉时，返回里会写明。',
      },
    },
    output: textOut,
  };
}

export function ackSpec() {
  return {
    name: TOOL_NAMES.ack,
    description: [
      '**收到任务卡后必须调这个**：告诉派发方"我收到了，这里由我接手"。',
      '',
      '为什么必须有：投递成功只说明信送到了，不说明有人管。没有回执，派发方只能',
      '等到超时后判 ack_timeout（"送到了没人管"）—— 那不是它想要的答案。',
      '',
      '回执是幂等的：重复 ack 同一个任务不会报错，但只在第一次生效。',
    ].join('\n'),
    parameters: {
      taskId: { type: 'string', required: true, description: '任务 id' },
    },
    output: textOut,
  };
}

export function heartbeatSpec() {
  return {
    name: TOOL_NAMES.heartbeat,
    description: [
      '认领任务后**定期调这个续租**，表示"我还在干、别把我当死的"。',
      '',
      '认领即拿到租约（默认 10 分钟）。超过租约没有心跳，任务会被标 stale 并留事件，',
      '而且**允许被别人重新认领** —— 这样你挂了或跑偏，派发方不用等你说话就能知道。',
      '',
      '建议每 ≤5 分钟一次（租约的三分之一）。只有当前负责人能续租。',
    ].join('\n'),
    parameters: {
      taskId: { type: 'string', required: true, description: '任务 id' },
      leaseMs: {
        type: 'integer',
        description: '续租时长（毫秒，默认 600000 = 10 分钟）',
      },
    },
    output: textOut,
  };
}

export function inboxSpec() {
  return {
    name: TOOL_NAMES.inbox,
    description: [
      '查看**你还没读过的**团队动态（按游标增量，不会重复刷屏）。',
      '',
      '正常情况下你不需要主动调它：插件会在会话每一轮开始时**自动**把新事件摘要',
      '注入上下文，并把游标前移。这个工具用来手动确认"我到底读到哪了"，',
      '或在怀疑漏读时补一次。',
      '',
      'reset 为 true 可以把游标退回 0（重新全部读一遍），排障用。',
    ].join('\n'),
    parameters: {
      limit: { type: 'integer', description: '最多取几条未读事件，1-100（默认 20）' },
      peek: { type: 'boolean', description: '只看不移游标（默认 false：查看后游标会前移）' },
      reset: { type: 'boolean', description: '把游标重置到 0 再读（排障用）' },
      excludeKinds: {
        type: 'array',
        items: { type: 'string' },
        description:
          '要排除的事件种类（默认 ["peer.event"]）。传 [] 表示不过滤，会看到全部事件。' +
          '被排除的事件仍会让游标正常前进，不会堵住后面的任务事件。',
      },
    },
    output: textOut,
  };
}

export function eventsSpec() {
  return {
    name: TOOL_NAMES.events,
    description: [
      '查看共享任务板的审计事件流（新的在前）。',
      '每次状态变更、每条证据、每次门禁拒绝、每次派发都会留下事件，用来回答"到底发生了什么"。',
    ].join('\n'),
    parameters: {
      taskId: { type: 'string', description: '只看某个任务的事件' },
      limit: { type: 'integer', description: '最多几条，1-100（默认 20）' },
    },
    output: textOut,
  };
}

/** 全部 spec 的集合（注册与契约测试共用同一处）。 */
export function allSpecs() {
  return [
    peersSpec(),
    createSpec(),
    listSpec(),
    claimSpec(),
    reportSpec(),
    completeSpec(),
    cancelSpec(),
    dispatchSpec(),
    eventsSpec(),
    ackSpec(),
    heartbeatSpec(),
    inboxSpec(),
    adoptSpec(),
    probeSpec(),
  ];
}
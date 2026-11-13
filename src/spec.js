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
};

const textOut = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
};

export function peersSpec() {
  return {
    name: TOOL_NAMES.peers,
    description: [
      '列出本机这台 DSH 实例配置的对端 DSH 实例（peer），以及每条链路的当前状态；',
      'includeSessions 为 true 时再逐个列出对端**当前活着**的会话，方便挑一个派活目标。',
      '',
      '这是跨 DSH 协作的第一步：不知道有哪些实例、哪些会话活着，就没法派任务。',
      '链路 down 的对端仍然会列出来（它配了但暂时连不上），不要把它当成"不存在"。',
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

export function createSpec() {
  return {
    name: TOOL_NAMES.create,
    description: [
      '在本机共享任务板上新建一个团队任务。任务对**本机所有 DSH 实例**可见',
      '（板是一份共享 SQLite 文件），但不会自动派给任何人——派发用 mesh_dispatch。',
      '',
      'requestId 是幂等键：同一次意图重放（比如网络抖动后重试）不会建出两个任务。',
      '创建只是"登记意图"，不是"完成"；完成必须走 mesh_task_report + mesh_task_complete。',
    ].join('\n'),
    parameters: {
      title: { type: 'string', required: true, description: '一句话任务标题（≤200 字）' },
      brief: { type: 'string', description: '背景与要求，写清楚对方需要知道的东西（≤4000 字）' },
      acceptance: { type: 'string', description: '验收标准：怎样算做完（≤4000 字）' },
      requestId: { type: 'string', description: '幂等键；同一意图重复提交时填同一个值' },
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
    ].join('\n'),
    parameters: {
      taskId: { type: 'string', required: true, description: '任务 id，形如 t-1a2b3c4d' },
      leaseMs: {
        type: 'integer',
        description: '租约时长（毫秒，默认 600000 = 10 分钟）',
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
    ].join('\n'),
    parameters: {
      taskId: { type: 'string', required: true, description: '任务 id' },
    },
    output: textOut,
  };
}

export function cancelSpec() {
  return {
    name: TOOL_NAMES.cancel,
    description: '取消一个任务（终态，不可恢复）。已终结的任务会被拒绝。',
    parameters: {
      taskId: { type: 'string', required: true, description: '任务 id' },
      reason: { type: 'string', description: '取消原因，写进审计' },
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
      '',
      '投递结果**如实返回**：delivered=false 时会给 reason（session-not-live / unreachable /',
      'peer-not-configured 等），不要把它当成派成功。',
      '',
      '**投递成功 ≠ 对方知道，更 ≠ 任务完成。** 每次投递会开一个回执窗口：',
      '接收端应当在 ackTimeoutMs 内调 mesh_task_ack；超时未回执会被判成 ack_timeout，',
      '结果是"送到了没人管"，不是"正常"。',
      '',
      '默认不唤醒对方已休眠的会话（唤醒会真的花对方的模型额度）。确实要唤醒时把 resume 设为 true。',
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
        description: '等回执的时限（毫秒，默认 60000）。超时未回执判 ack_timeout；newSession 时也用作建会话的时限',
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
  ];
}
/**
 * createSession.js — **接收端**：把"请帮我开个新会话"真正执行掉。
 *
 * 这是 `mesh_dispatch({ newSession: true })` 的另一半。整个设计只为一件事：
 * **不许用 resume 冒充 create。**
 *
 * resume 只能唤醒**已落盘**的会话；它造不出新会话。之前派发的病根就是
 * 只能投给已存在的 sessionId，于是对端只有一个活会话时，所有任务全堵进那一个。
 * 所以这里走的是宿主真正的建会话入口：
 *
 *   ctx.sessionController.create({ cwd, agentPreset }) → { sessionId, agentPreset? }
 *
 * 这是 app.asar 里 `@deepseek-ai/dsh-api-session-controller` 的公开方法
 * （Remote 名 `session/create`，源码 `SessionCommandController.create()`）：
 * 它会在没给 sessionId 时 mint 一个新 id，然后 `ctx.agents.create()` 真正建 agent。
 * 和 `resolve()`（= resume）是两条完全不同的路径。
 *
 * 三条硬约束：
 *
 * 1. **默认关闭。** `allowCreate` 默认 false。这条链路能在对端凭空开进程、
 *    还会真的烧对方的模型额度，不能默认敞开。（与 interconnect 的 allowResume
 *    同一套风格，但那一个默认是 true，因为它只是唤醒已有会话。）
 * 2. **失败必须如实写回。** 拒绝给稳定短码（domain.js 的
 *    SESSION_CREATE_REJECT_REASONS），绝不抛裸异常、也绝不静默丢弃 ——
 *    静默丢弃会让派发方一直等到超时，把"明确失败"说成"没人管"。
 * 3. **只处理给本机的请求。** target_instance 对不上就不碰，避免多实例同板时抢活。
 */
import { randomUUID } from 'node:crypto';

/**
 * 本机是否具备真正建会话的能力（宿主有没有注入 sessionController）。
 * @param {object} ctx
 * @returns {boolean}
 */
export function canCreateSession(ctx) {
  try {
    const sc = ctx?.get?.('sessionController') ?? ctx?.sessionController;
    return sc !== null && sc !== undefined && typeof sc.create === 'function';
  } catch {
    return false;
  }
}

/**
 * 真正建一个会话。**这是唯一会创建新会话的地方。**
 *
 * @param {object} ctx - 宿主上下文
 * @param {{cwd?:string, agentPreset?:string}} request
 * @returns {Promise<{ok:true, sessionId:string, agentPreset?:string} | {ok:false, reason:string, message:string}>}
 */
export async function createSessionViaHost(ctx, request = {}) {
  const sc = ctx?.get?.('sessionController') ?? ctx?.sessionController;
  if (sc === null || sc === undefined || typeof sc.create !== 'function') {
    return {
      ok: false,
      reason: 'create-unsupported',
      message: '宿主没有 sessionController 服务，无法新建会话（这个部署不支持远端建会话）',
    };
  }
  // 只把**明确给了的**字段传下去。cwd 缺省时由宿主用它自己的默认工作目录，
  // 我们绝不在这里猜一个路径 —— 猜错会在别处建出一个诡异的空目录。
  const payload = {};
  if (typeof request.cwd === 'string' && request.cwd.trim().length > 0) payload.cwd = request.cwd.trim();
  if (typeof request.agentPreset === 'string' && request.agentPreset.trim().length > 0) {
    payload.agentPreset = request.agentPreset.trim();
  }

  try {
    const created = await sc.create(payload);
    const sessionId = created?.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      return {
        ok: false,
        reason: 'create-failed',
        message: `宿主 create() 返回了空 sessionId（${JSON.stringify(created)}）`,
      };
    }
    return {
      ok: true,
      sessionId,
      ...(typeof created.agentPreset === 'string' ? { agentPreset: created.agentPreset } : {}),
    };
  } catch (err) {
    // 宿主抛的是 RemoteError（带稳定 code）。原样带上，别把它压成 "failed"。
    const code = typeof err?.code === 'string' ? err.code : undefined;
    return {
      ok: false,
      reason: 'create-failed',
      message: `${code === undefined ? '' : `${code}: `}${err?.message ?? String(err)}`,
    };
  }
}

/**
 * 处理一批待办的建会话请求。**由接收端的收件箱轮询驱动**（不另起定时器：
 * 那样要多一套生命周期与清理，而收件箱本来每轮就会跑一遍）。
 *
 * 开关关着（`allowCreate !== true`）时**照样读、照样回写**，只是不建会话：
 * 回写 `create-refused`。这条是 0.3.3 修的缺陷 —— 旧版在这里直接 `return []`，
 * 于是"对端明确关了开关"和"对端不在线"在派发方眼里都成了等 60s 后的
 * `create-timeout`，把**明确失败**说成了**没人管**。
 *
 * @param {object} deps
 * @param {object} deps.board - 板（本地或远端）
 * @param {object} deps.ctx - 宿主上下文
 * @param {string} deps.instanceId - 本机 instanceId，用来过滤请求
 * @param {boolean} deps.allowCreate - 配置开关，**默认必须由调用方显式传**
 * @param {number} [deps.limit]
 * @returns {Promise<Array<{request_id:string, sessionId?:string, rejected?:string}>>}
 */
export async function serviceSessionRequests({ board, ctx, instanceId, allowCreate, limit = 5 }) {
  let pending;
  try {
    pending = await board.pendingSessionRequests(instanceId, limit);
  } catch {
    return [];
  }
  if (!Array.isArray(pending) || pending.length === 0) return [];

  const done = [];
  for (const row of pending) {
    // 板上可能混着别的实例的请求（同一个 target_instance 才会被查出来），再核一次不亏
    if (row.target_instance !== instanceId) continue;

    let result;
    if (allowCreate !== true) {
      // 开关关着：**不建会话**，但要如实回写"我拒绝了"。
      // 不写回就等于让派发方白等一个 TTL —— 那是 0.3.2 及以前的缺陷。
      result = {
        ok: false,
        reason: 'create-refused',
        message: `对端 ${instanceId} 的 allowCreate=false（默认关闭），没有开启远端建会话`,
      };
    } else if (canCreateSession(ctx)) {
      result = await createSessionViaHost(ctx, {
        cwd: row.cwd ?? undefined,
        agentPreset: row.agent_preset ?? undefined,
      });
    } else {
      result = {
        ok: false,
        reason: 'create-unsupported',
        message: '本机宿主没有 sessionController 服务，无法新建会话',
      };
    }

    const claimedBy = `session-service-${randomUUID().slice(0, 8)}`;
    try {
      const res = await board.claimSessionRequest(row.request_id, {
        claimedBy,
        sessionId: result.ok ? result.sessionId : undefined,
        rejectReason: result.ok ? undefined : result.reason,
        rejectMessage: result.ok ? undefined : result.message,
      });
      if (res?.claimed === true) {
        done.push(
          result.ok
            ? { request_id: row.request_id, sessionId: result.sessionId }
            : { request_id: row.request_id, rejected: result.reason },
        );
      }
    } catch {
      // 写回失败就丢掉这一次：请求会停在 pending，到 deadline 变 expired，
      // 派发方拿到的结论是 create-timeout（"没人处理"），这是诚实的降级 ——
      // 绝不能因为写回失败就在本地假装成功。
    }
  }
  return done;
}

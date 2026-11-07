/**
 * session.js — 从工具执行上下文里取"谁在调用"。
 *
 * 为什么单独一个文件并写成候选链：`exec.agent` 的具体形状是宿主内部约定，
 * 这个原型不该靠猜。`@deepseek-ai/dsh-agent` 的注册表以 sessionId 为键
 * （`registry.get(sessionId)`），且代码里出现 `agent.id`，所以优先取 `agent.id`。
 * 取不到就记 `unknown`，**绝不编一个看起来像会话 id 的字符串**——
 * 审计里把"不知道是谁"写成"某个具体会话"，比留空危险得多。
 */

export const UNKNOWN_ACTOR = 'unknown';

export function sessionIdOf(exec) {
  const agent = exec?.agent;
  const candidates = [
    agent?.id,
    agent?.sessionId,
    agent?.session?.id,
    agent?.session?.sessionId,
  ];
  for (const v of candidates) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return UNKNOWN_ACTOR;
}

/** 本实例 id：interconnect 服务的 `selfSender()` 会带出来；拿不到就记 unknown。 */
export function instanceIdOf(interconnect, sessionId) {
  if (interconnect === null || typeof interconnect !== 'object') return UNKNOWN_ACTOR;
  try {
    const self = interconnect.selfSender?.(sessionId ?? UNKNOWN_ACTOR);
    if (self !== null && typeof self === 'object' && typeof self.instanceId === 'string') {
      return self.instanceId;
    }
  } catch {
    /* 服务未激活或签名不同：不猜 */
  }
  return UNKNOWN_ACTOR;
}
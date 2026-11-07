/**
 * inboxHook.js — 把收件箱摘要挂到宿主的 `agent/pre-step` 上，实现"下一轮自动注入"。
 *
 * 为什么是这个钩子（对着 vendor 里的 dsh-agent 源码确认过，不是猜的）：
 *   `agentCtx.on('agent/pre-step', async ({ agent, messages, signal, step, modelSelection }, next) => …)`
 * 它是**中间件**：`next()` 拿到本步决策，返回值可以带 `messages`，宿主会把它们并进本步上下文。
 * 内置的"模型切换提示"就是这么做的（`modelSwitchNotice` → `createUserMessage`），
 * 所以这里沿用同一形态，风险最低。
 *
 * 三条必须守住的边界：
 *
 * 1. **不能让会话跑不起来。** 注入是锦上添花，任何异常都在这里吞掉并记 warn。
 *    收件箱坏了不该让用户的对话发不出去。
 * 2. **不能重复刷屏。** 只有确定要追加时才前移游标；每轮只取一次。
 * 3. **不能悄悄丢消息。** 游标前移到"本轮实际读到的最大 seq"，不是全表最大 seq
 *    （后者在 limit 截断时会永久跳过中间事件）。
 */

import { randomUUID } from 'node:crypto';

import { collectInbox } from './inbox.js';

/**
 * @param {object} opts
 * @param {object} opts.ctx
 * @param {object} opts.board
 * @param {(sessionId:string)=>Promise<string>} opts.resolveInstance
 * @param {(text:string)=>object} [opts.makeMessage]
 * @param {number} [opts.limit]
 * @returns {Function|undefined} disposer
 */
export function installInboxHook(opts) {
  const { ctx, board, limit = 20 } = opts;
  const makeMessage = opts.makeMessage ?? defaultMakeMessage;

  const off = ctx.on(
    'agent/pre-step',
    async (payload, next) => {
      // 先让内部链路跑完，拿到本步决策
      const decision = await next();

      try {
        // 被中断、或被拒的步骤不注入：那种步骤的内容根本不会送到模型
        if (payload?.signal?.aborted === true) return decision;
        if (decision?.kind === 'reject') return decision;

        const sessionId = pickSessionId(payload?.agent);
        if (sessionId === null) return decision;

        const instanceId = await opts.resolveInstance(sessionId);
        const got = await collectInbox(board, { instanceId, sessionId, limit });
        if (got.count === 0 || got.text === '') return decision;

        // 顺序很关键：先让本步真的带上消息（返回 decision），再前移游标。
        // 如果前移失败，最坏结果是下一轮重复注入一次 —— 比"漏掉"轻。
        // 反之若先前移再返回，一旦 return 之后宿主丢弃本步，消息就永久丢了。
        const msg = makeMessage(got.text);
        try {
          await board.advanceCursor(instanceId, sessionId, got.nextSeq);
        } catch (err) {
          try {
            ctx?.logger?.warn?.(`[dsh-team-mesh] 游标前移失败，下一轮可能重复注入：${err?.message ?? err}`);
          } catch {
            /* ignore */
          }
        }
        return { ...decision, messages: [...(decision.messages ?? []), msg] };
      } catch (err) {
        try {
          ctx?.logger?.warn?.(`[dsh-team-mesh] 注入收件箱失败（不影响本步）：${err?.message ?? err}`);
        } catch {
          /* 日志不可用就算了 */
        }
        return decision;
      }
    },
    // prepend：与内置 modelSelection 的用法一致，排在内置监听器之前
    { prepend: true },
  );

  return off;
}

function pickSessionId(agent) {
  const candidates = [agent?.id, agent?.sessionId, agent?.session?.id, agent?.session?.sessionId];
  for (const v of candidates) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/**
 * 造一条 user 消息。形态对齐内置 `modelSwitchNotice`：
 *   { role:'user', content:[{type:'text',text}], source:{kind,form,summary} }
 * source 说明来源，方便排查"这条是谁插进来的"。
 */
function defaultMakeMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'team-mesh-inbox',
      form: 'inbox',
      summary: '团队动态（自动注入）',
    },
  };
}

/**
 * domain 的纯逻辑测试。不碰磁盘、不碰 DSH，所以又快又能覆盖边界。
 *
 * 重点在"完成判定"：这是这个插件唯一真正重要的判断，也是模型最容易骗过的地方。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertTransition,
  decideAdmissibility,
  evaluateCompletion,
  formatTaskCard,
  TeamError,
  validateCreateInput,
} from '../src/domain.js';

// ───────────────────────── 输入校验 ─────────────────────────

test('create：标题必填、去空白、超长拒绝', () => {
  const ok = validateCreateInput({ title: '  读三份资料  ' });
  assert.equal(ok.title, '读三份资料');
  assert.equal(ok.brief, '');
  assert.equal(ok.acceptance, '');
  assert.equal(ok.requestId, null);

  assert.throws(() => validateCreateInput({ title: '   ' }), /title 不能为空/);
  assert.throws(() => validateCreateInput({ title: 'x'.repeat(201) }), /title 过长/);
  assert.throws(() => validateCreateInput(null), /参数必须是对象/);
  assert.throws(() => validateCreateInput({ title: 123 }), /title 必须是字符串/);
});

// ───────────────────────── 可采信判定 ─────────────────────────

test('可采信：executed 为 true 且 pass 有真实物证', () => {
  assert.equal(decideAdmissibility({ executed: true, outcome: 'pass', evidenceRef: 'a.txt', refExists: true }).admissible, true);
  assert.equal(decideAdmissibility({ executed: true, outcome: 'fail' }).admissible, true);
  assert.equal(decideAdmissibility({ executed: true, outcome: 'unknown' }).admissible, true);
});

test('可采信：没执行、pass 无物证、物证不存在、outcome 非法 —— 一律不可采信', () => {
  assert.equal(decideAdmissibility({ executed: false, outcome: 'pass', evidenceRef: 'a', refExists: true }).admissible, false);
  assert.equal(decideAdmissibility({ executed: true, outcome: 'pass' }).admissible, false);
  const missing = decideAdmissibility({ executed: true, outcome: 'pass', evidenceRef: 'no-such', refExists: false });
  assert.equal(missing.admissible, false);
  assert.match(missing.reasons.join(';'), /不存在/);
  assert.equal(decideAdmissibility({ executed: true, outcome: 'success' }).admissible, false);
});

test('可采信：模型自己说"通过了"不算证据', () => {
  // 这条守的是核心不变量：模型自报不能决定可采信
  const r = decideAdmissibility({ executed: true, outcome: 'pass', evidenceRef: null, refExists: false, claimedAdmissible: true });
  assert.equal(r.admissible, false, '没有物证的 pass 必须不可采信，哪怕模型声称已通过');
});

// ───────────────────────── 完成门禁 ─────────────────────────

const task = (over = {}) => ({
  task_id: 't-1',
  title: 'x',
  lifecycle: 'working',
  ...over,
});

test('门禁：没有任何证据 → 拒绝，且原因具体到 NO_EVIDENCE', () => {
  const g = evaluateCompletion(task(), []);
  assert.equal(g.allowed, false);
  assert.match(g.reasons.join(' '), /NO_EVIDENCE/);
});

test('门禁：有证据但全部不可采信 → 拒绝（NO_ADMISSIBLE_EVIDENCE）', () => {
  const g = evaluateCompletion(task(), [
    { evidence_id: 1, admissible: 0, outcome: 'pass' },
    { evidence_id: 2, admissible: 0, outcome: 'fail' },
  ]);
  assert.equal(g.allowed, false);
  assert.match(g.reasons.join(' '), /NO_ADMISSIBLE_EVIDENCE/);
});

test('门禁：最后一条可采信是 pass → 允许', () => {
  const g = evaluateCompletion(task(), [
    { evidence_id: 1, admissible: 0, outcome: 'fail' },
    { evidence_id: 2, admissible: 1, outcome: 'pass' },
  ]);
  assert.equal(g.allowed, true);
});

test('门禁：先过后挂 → 拒绝（LATEST_FAIL），不能拿历史成功掩盖现在的失败', () => {
  const g = evaluateCompletion(task(), [
    { evidence_id: 1, admissible: 1, outcome: 'pass' },
    { evidence_id: 2, admissible: 1, outcome: 'fail' },
  ]);
  assert.equal(g.allowed, false);
  assert.match(g.reasons.join(' '), /LATEST_FAIL/);
});

test('门禁：最后一条是 unknown → 拒绝（未知不记过）', () => {
  const g = evaluateCompletion(task(), [
    { evidence_id: 1, admissible: 1, outcome: 'pass' },
    { evidence_id: 2, admissible: 1, outcome: 'unknown' },
  ]);
  assert.equal(g.allowed, false);
  assert.match(g.reasons.join(' '), /LATEST_UNKNOWN/);
});

test('门禁：未认领 / 已终结 → 拒绝', () => {
  assert.match(evaluateCompletion(task({ lifecycle: 'open' }), [{ evidence_id: 1, admissible: 1, outcome: 'pass' }]).reasons.join(), /尚未被认领/);
  assert.match(evaluateCompletion(task({ lifecycle: 'done' }), []).reasons.join(), /已终结/);
  assert.match(evaluateCompletion(task({ lifecycle: 'canceled' }), []).reasons.join(), /已终结/);
});

test('门禁：任务不存在抛错，而不是当成"可以完成"', () => {
  assert.throws(() => evaluateCompletion(null, []), TeamError);
});

// ───────────────────────── 状态迁移 ─────────────────────────

test('状态迁移：非法迁移一律拒绝', () => {
  assert.doesNotThrow(() => assertTransition('open', 'claimed'));
  assert.doesNotThrow(() => assertTransition('claimed', 'working'));
  assert.doesNotThrow(() => assertTransition('working', 'blocked'));
  assert.doesNotThrow(() => assertTransition('open', 'canceled'));
  // 已经 done 的不能再动
  assert.throws(() => assertTransition('done', 'working'), /不允许从 done/);
  // 不能从 open 直接跳到 done（必须先有人认领并报证据）
  assert.throws(() => assertTransition('open', 'done'), /不允许从 open/);
  assert.throws(() => assertTransition('working', 'bogus'), /非法状态/);
});

// ───────────────────────── 任务卡 ─────────────────────────

test('任务卡必须自包含：含 id、要求、验收、回报方式', () => {
  const card = formatTaskCard(
    { task_id: 't-ab12', title: '读三份资料', brief: '背景说明', acceptance: '报告字段齐全' },
    { fromInstance: 'pc-a' },
  );
  assert.match(card, /t-ab12/);
  assert.match(card, /读三份资料/);
  assert.match(card, /背景说明/);
  assert.match(card, /验收标准：报告字段齐全/);
  assert.match(card, /mesh_task_report/);
  assert.match(card, /mesh_task_complete/);
  assert.match(card, /派发方：pc-a/);
});

test('任务卡：没有 brief / acceptance 时不出现空段', () => {
  const card = formatTaskCard({ task_id: 't-1', title: 'x', brief: '', acceptance: '' }, {});
  assert.equal(card.includes('验收标准：'), false);
  assert.equal(card.includes('派发方：'), false);
});
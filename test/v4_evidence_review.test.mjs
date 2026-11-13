/**
 * v4_evidence_review.test.mjs — 增强 B：evidence 结构化 + 可选独立复核门禁。
 *
 * 为什么与租约那组分开（v4_lease_identity.test.mjs）：
 * 这一项是「新字段可空、默认关闭、老任务零影响」的增量，测试必须同时钉住
 * 新行为对、以及不传新字段时行为与 v3 逐字节一致。分成两个文件后，
 * "哪条提交保护了什么"在 git log 里一目了然。
 *
 * 覆盖（对应任务书验收项 B：evidence 结构化）：
 *   - evidence 表多出四个复核列
 *   - 四个复核字段落库并可读回
 *   - verificationMethod 白名单
 *   - verifiedAt 没有 verifiedBy 时被拒
 *   - 门禁：require_independent_review=1 + 自验自报 → 拒
 *   - 门禁：require_independent_review=1 + 换人复核 → 通过
 *   - 门禁：require_independent_review=0（默认）→ 与改前完全一致
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Board, normalizeReviewFields } from '../src/store.js';
import { VERIFICATION_METHODS, evaluateCompletion, TeamError } from '../src/domain.js';

const tmpDirs = [];
function newBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-v4-'));
  tmpDirs.push(dir);
  return new Board(path.join(dir, 'team.db'));
}
process.on('exit', () => {
  for (const d of tmpDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* ignore */
    }
  }
});

function makeTask(b, actor = 's-a', extra = {}) {
  return b.createTask({ title: 'v4', brief: '', acceptance: '', requestId: null, ...extra }, actor).task;
}
/** 造一个真实存在的物证文件（判 pass 必须有真实产物） */
function makeArtifact(name = 'artifact.txt', body = 'hello') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-v4-art-'));
  tmpDirs.push(dir);
  const p = path.join(dir, name);
  fs.writeFileSync(p, body, 'utf8');
  return p;
}

test('B0 迁移：evidence 表多出四个复核列，task 表多出 require_independent_review', () => {
  const b = newBoard();
  const evCols = b.db.prepare('PRAGMA table_info(evidence)').all().map((c) => String(c.name));
  for (const c of ['verified_by', 'verified_at', 'acceptance_ref', 'verification_method']) {
    assert.ok(evCols.includes(c), `evidence 表缺列 ${c}`);
  }
  const taskCols = b.db.prepare('PRAGMA table_info(task)').all().map((c) => String(c.name));
  assert.ok(taskCols.includes('require_independent_review'), 'task 表缺 require_independent_review');
  b.close();
});

// ───────────────────────── B. evidence 结构化 ─────────────────────────

test('B1 复核四字段落库并可读回', () => {
  const b = newBoard();
  const t = makeTask(b);
  b.claimTask(t.task_id, 's-a');
  const art = makeArtifact();
  const res = b.reportEvidence(
    t.task_id,
    {
      executed: true,
      outcome: 'pass',
      note: '跑通了',
      evidenceRef: art,
      verifiedBy: 's-reviewer',
      acceptanceRef: 'A03',
      verificationMethod: 'disk-hash',
    },
    's-a',
  );
  assert.equal(res.admissible, true);
  assert.equal(res.verified_by, 's-reviewer');
  assert.equal(res.acceptance_ref, 'A03');
  assert.equal(res.verification_method, 'disk-hash');
  assert.ok(res.verified_at > 0, 'verifiedAt 缺省应用当前时间');

  const [row] = b.listEvidence(t.task_id);
  assert.equal(row.actor, 's-a');
  assert.equal(row.verified_by, 's-reviewer');
  assert.equal(row.acceptance_ref, 'A03');
  assert.equal(row.verification_method, 'disk-hash');
  assert.equal(Number(row.verified_at), res.verified_at);
  b.close();
});

test('B2 不传复核字段 → 四列全 NULL（老调用方零改动）', () => {
  const b = newBoard();
  const t = makeTask(b);
  b.claimTask(t.task_id, 's-a');
  const art = makeArtifact();
  b.reportEvidence(t.task_id, { executed: true, outcome: 'pass', evidenceRef: art }, 's-a');
  const [row] = b.listEvidence(t.task_id);
  assert.equal(row.verified_by, null);
  assert.equal(row.verified_at, null);
  assert.equal(row.acceptance_ref, null);
  assert.equal(row.verification_method, null);
  b.close();
});

test('B3 verificationMethod 白名单：拼错的方法被拒，不落半条', () => {
  const b = newBoard();
  const t = makeTask(b);
  b.claimTask(t.task_id, 's-a');
  const art = makeArtifact();
  const before = b.listEvidence(t.task_id).length;
  assert.throws(
    () => b.reportEvidence(
      t.task_id,
      { executed: true, outcome: 'pass', evidenceRef: art, verifiedBy: 's-x', verificationMethod: 'diskHash' },
      's-a',
    ),
    (err) => {
      assert.equal(err.code, 'INVALID_FIELD');
      assert.match(err.message, new RegExp(VERIFICATION_METHODS.join('|')));
      return true;
    },
  );
  assert.equal(b.listEvidence(t.task_id).length, before, '非法字段不该落库');
  b.close();
});

test('B4 只给 verifiedAt 不给 verifiedBy → 被拒（不知道是谁验的）', () => {
  const b = newBoard();
  const t = makeTask(b);
  b.claimTask(t.task_id, 's-a');
  assert.throws(
    () => b.reportEvidence(
      t.task_id,
      { executed: true, outcome: 'unknown', verifiedAt: Date.now() },
      's-a',
    ),
    (err) => err.code === 'INVALID_FIELD',
  );
  b.close();
});

test('B5 normalizeReviewFields：空串被当成"没给"，非空串被 trim', () => {
  const a = normalizeReviewFields({});
  assert.deepEqual(a, { verifiedBy: null, verifiedAt: null, acceptanceRef: null, verificationMethod: null });
  const c = normalizeReviewFields({ verifiedBy: '  s-b  ', acceptanceRef: ' A01 ' });
  assert.equal(c.verifiedBy, 's-b');
  assert.equal(c.acceptanceRef, 'A01');
  // 全空白的字符串 trim 成空串 → 明确报错，而不是静默当没给
  assert.throws(() => normalizeReviewFields({ verifiedBy: '   ' }), (err) => err.code === 'INVALID_FIELD');
});

test('B6 门禁：require_independent_review=1 + 自验自报 → 拒 INDEPENDENT_REVIEW_REQUIRED', () => {
  const b = newBoard();
  const t = makeTask(b, 's-a', { requireIndependentReview: true });
  assert.equal(b.getTask(t.task_id).require_independent_review, 1);
  b.claimTask(t.task_id, 's-a');
  const art = makeArtifact();
  // 上报人自己当复核人
  b.reportEvidence(
    t.task_id,
    { executed: true, outcome: 'pass', evidenceRef: art, verifiedBy: 's-a', verificationMethod: 'disk-hash' },
    's-a',
  );
  assert.throws(
    () => b.completeTask(t.task_id, 's-a'),
    (err) => {
      assert.equal(err.code, 'GATE_REJECTED');
      assert.ok(err.detail.some((r) => r.includes('INDEPENDENT_REVIEW_REQUIRED')), JSON.stringify(err.detail));
      return true;
    },
  );
  assert.equal(b.getTask(t.task_id).lifecycle, 'working', '被拒后任务不该变 done');
  b.close();
});

test('B7 门禁：require_independent_review=1 + 换人复核 → 通过', () => {
  const b = newBoard();
  const t = makeTask(b, 's-a', { requireIndependentReview: true });
  b.claimTask(t.task_id, 's-a');
  const art = makeArtifact();
  b.reportEvidence(
    t.task_id,
    { executed: true, outcome: 'pass', evidenceRef: art, verifiedBy: 's-reviewer', verificationMethod: 'disk-hash' },
    's-a',
  );
  const out = b.completeTask(t.task_id, 's-a');
  assert.equal(out.task.lifecycle, 'done');
  b.close();
});

test('B8 门禁：require_independent_review=1 但没有 verifiedBy → 拒', () => {
  const b = newBoard();
  const t = makeTask(b, 's-a', { requireIndependentReview: true });
  b.claimTask(t.task_id, 's-a');
  const art = makeArtifact();
  b.reportEvidence(t.task_id, { executed: true, outcome: 'pass', evidenceRef: art }, 's-a');
  assert.throws(
    () => b.completeTask(t.task_id, 's-a'),
    (err) => {
      assert.equal(err.code, 'GATE_REJECTED');
      assert.ok(err.detail.some((r) => r.includes('INDEPENDENT_REVIEW_REQUIRED')));
      return true;
    },
  );
  b.close();
});

test('B9 门禁：默认（require_independent_review=0）行为与改前完全一致 —— 自报自验也能过', () => {
  const b = newBoard();
  const t = makeTask(b);
  assert.equal(b.getTask(t.task_id).require_independent_review, 0, '默认必须关闭');
  b.claimTask(t.task_id, 's-a');
  const art = makeArtifact();
  // 连 verifiedBy 都不给：这正是 v3 的调用方式
  b.reportEvidence(t.task_id, { executed: true, outcome: 'pass', evidenceRef: art }, 's-a');
  const out = b.completeTask(t.task_id, 's-a');
  assert.equal(out.task.lifecycle, 'done');
  b.close();
});

test('B10 setIndependentReview：只有创建者/负责人能改，改动留审计', () => {
  const b = newBoard();
  const t = makeTask(b, 's-a');
  assert.throws(() => b.setIndependentReview(t.task_id, true, 's-stranger'), (err) => err.code === 'NOT_ALLOWED');
  const out = b.setIndependentReview(t.task_id, true, 's-a');
  assert.equal(out.task.require_independent_review, 1);
  const ev = b.recentEvents(20, t.task_id).find((e) => e.kind === 'task.review_policy_changed');
  assert.equal(ev.payload.require_independent_review, 1);
  // 能关回去
  assert.equal(b.setIndependentReview(t.task_id, false, 's-a').task.require_independent_review, 0);
  b.close();
});

test('B11 evaluateCompletion 纯函数：老任务对象（无 v4 字段）照样判定通过', () => {
  const task = { lifecycle: 'working', require_independent_review: undefined };
  const evidences = [{ evidence_id: 1, admissible: 1, outcome: 'pass', actor: 's-a' }];
  assert.deepEqual(evaluateCompletion(task, evidences), { allowed: true, reasons: [] });
});

test('B12 门禁比的是"证据的 actor"，不是"谁来点完成" —— 换人点按钮不能洗白自证', () => {
  const b = newBoard();
  const t = makeTask(b, 's-a', { requireIndependentReview: true });
  b.claimTask(t.task_id, 's-a');
  const art = makeArtifact();
  b.reportEvidence(
    t.task_id,
    { executed: true, outcome: 'pass', evidenceRef: art, verifiedBy: 's-a' },
    's-a',
  );
  // 换一个完全不同的 actor 来调 complete：仍然要拒
  assert.throws(
    () => b.completeTask(t.task_id, 's-other'),
    (err) => {
      assert.equal(err.code, 'GATE_REJECTED');
      assert.ok(err.detail.some((r) => r.includes('INDEPENDENT_REVIEW_REQUIRED')));
      return true;
    },
  );
  b.close();
});

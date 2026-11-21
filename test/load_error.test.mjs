/**
 * load_error.test.mjs — 0.5 P0：apply() 吞异常后必须**可发现**。
 *
 * 背景（2026-11-14 定性的真缺陷）：0.4 的 apply() 连不上远端板时只写一条 logger.error，
 * 然后返回空 no-op —— DSH 照常启动、13 个工具一个不注册、用户毫无感知。
 * 修法不是"让插件把宿主拖垮"（那会违背原来的初衷），而是：
 *   1. 失败在板库同目录写 `mesh-load-error.json`（时间/版本/板地址/错误/hint）；
 *   2. 成功时删掉上次遗留的这份文件；
 *   3. `DSH_TEAM_STRICT=1` 时改为抛错（运维能看见启动失败）；
 *   4. 默认仍然吞错，但日志里必须带诊断文件路径。
 *
 * 这些用例全部把诊断文件放在临时目录里断言，**不碰真实 $DSH_HOME**。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  apply,
  LOAD_ERROR_FILENAME,
  PLUGIN_VERSION,
  resolveLoadErrorPath,
} from '../src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TOOLS_ENTRY = path.join(ROOT, 'vendor', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');

const tmps = [];
function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-load-error-'));
  tmps.push(d);
  return d;
}
process.on('exit', () => {
  for (const d of tmps) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* ignore */
    }
  }
});

function fakeCtx() {
  const logs = [];
  return {
    logs,
    ctx: {
      tools: { register: () => () => {} },
      on: () => () => {},
      logger: {
        info: (m) => logs.push(`info: ${m}`),
        warn: (m) => logs.push(`warn: ${m}`),
        error: (m) => logs.push(`error: ${m}`),
      },
    },
  };
}

test('默认模式：加载失败不抛错、返回可调用 disposer，并写出可发现的诊断文件', async () => {
  const dir = tempDir();
  const { ctx, logs } = fakeCtx();
  const prevTools = process.env.DSH_TOOLS_PATH;
  delete process.env.DSH_TOOLS_PATH;
  try {
    let dispose;
    await assert.doesNotReject(async () => {
      dispose = await apply(ctx, { boardPath: path.join(dir, 'team.db') });
    }, '默认模式必须吞掉加载错误（插件坏了不该让应用起不来）');
    assert.equal(typeof dispose, 'function');
    assert.doesNotThrow(() => dispose(), '返回的必须是可调用的 disposer');

    const file = path.join(dir, LOAD_ERROR_FILENAME);
    assert.ok(fs.existsSync(file), `失败时必须写诊断文件：${file}`);
    const body = JSON.parse(fs.readFileSync(file, 'utf8'));

    assert.ok(!Number.isNaN(Date.parse(body.time)), 'time 必须是可解析的 ISO 时间');
    assert.equal(body.version, PLUGIN_VERSION);
    assert.equal(body.version, '0.5.0');
    assert.equal(body.boardEndpoint, null, '单机模式没有 boardEndpoint，不该编一个');
    assert.match(String(body.error.message), /dsh-tools/, 'error.message 要能说明是哪一步失败');
    assert.ok(typeof body.error.stack === 'string' && body.error.stack.length > 0);
    assert.ok(body.error.stack.length <= 2000, 'stack 只留前 2000 字符');
    assert.match(String(body.hint), /DSH_TEAM_DEBUG/);

    assert.ok(
      logs.some((l) => l.startsWith('error:') && l.includes(file)),
      '日志必须带诊断文件路径，否则用户还是不知道该看哪',
    );
  } finally {
    if (prevTools !== undefined) process.env.DSH_TOOLS_PATH = prevTools;
  }
});

test('加载成功时删掉上次遗留的诊断文件（旧证据不能误导排障）', async () => {
  const dir = tempDir();
  const staleFile = path.join(dir, LOAD_ERROR_FILENAME);
  fs.writeFileSync(staleFile, JSON.stringify({ time: '2026-01-01T00:00:00.000Z', error: { message: 'old' } }), 'utf8');
  assert.ok(fs.existsSync(staleFile));

  const prev = process.env.DSH_TOOLS_PATH;
  process.env.DSH_TOOLS_PATH = TOOLS_ENTRY;
  try {
    const { ctx } = fakeCtx();
    const dispose = await apply(ctx, { boardPath: path.join(dir, 'team.db') });
    assert.equal(typeof dispose, 'function');
    assert.equal(fs.existsSync(staleFile), false, '装载成功必须删掉旧的 mesh-load-error.json');
    dispose();
  } finally {
    if (prev === undefined) delete process.env.DSH_TOOLS_PATH;
    else process.env.DSH_TOOLS_PATH = prev;
  }
});

test('DSH_TEAM_STRICT=1：把加载错误抛出去（让 DSH 启动失败，运维能看见）', async () => {
  const dir = tempDir();
  const prevTools = process.env.DSH_TOOLS_PATH;
  const prevStrict = process.env.DSH_TEAM_STRICT;
  delete process.env.DSH_TOOLS_PATH;
  process.env.DSH_TEAM_STRICT = '1';
  try {
    await assert.rejects(
      () => apply(fakeCtx().ctx, { boardPath: path.join(dir, 'team.db') }),
      /dsh-tools/,
      'strict 模式必须抛出原始加载错误，而不是继续返回空 disposer',
    );
    assert.ok(
      fs.existsSync(path.join(dir, LOAD_ERROR_FILENAME)),
      '抛错前也要把诊断文件写下来（启动失败时更需要它）',
    );
  } finally {
    if (prevTools !== undefined) process.env.DSH_TOOLS_PATH = prevTools;
    if (prevStrict === undefined) delete process.env.DSH_TEAM_STRICT;
    else process.env.DSH_TEAM_STRICT = prevStrict;
  }
});

test('诊断文件路径与板库同目录，默认落在 $DSH_HOME/team/（不硬编码用户路径）', () => {
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = 'Z:\\mesh-home-probe';
  try {
    assert.equal(
      resolveLoadErrorPath({}),
      path.join('Z:\\mesh-home-probe', 'team', LOAD_ERROR_FILENAME),
      '没配 boardPath 时必须走 defaultBoardPath() 同源逻辑',
    );
    assert.equal(
      resolveLoadErrorPath({ boardPath: 'Y:\\custom\\board.db' }),
      path.join('Y:\\custom', LOAD_ERROR_FILENAME),
      '配了 boardPath 时跟着板库走（诊断文件永远在板库旁边）',
    );
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  }
});

test('远端板失败：诊断文件记下 boardEndpoint（但不含 token 等任何密钥）', async () => {
  const dir = tempDir();
  const prevTools = process.env.DSH_TOOLS_PATH;
  const prevHome = process.env.DSH_HOME;
  delete process.env.DSH_TOOLS_PATH;
  process.env.DSH_HOME = dir; // 远端模式没有本地 boardPath，诊断文件按 $DSH_HOME/team 落
  try {
    const { ctx } = fakeCtx();
    const dispose = await apply(ctx, {
      boardEndpoint: 'http://127.0.0.1:1',
      boardToken: 'must-not-be-written',
    });
    assert.equal(typeof dispose, 'function');
    dispose();
    const body = JSON.parse(fs.readFileSync(path.join(dir, 'team', LOAD_ERROR_FILENAME), 'utf8'));
    assert.equal(body.boardEndpoint, 'http://127.0.0.1:1');
    const raw = JSON.stringify(body);
    assert.ok(!raw.includes('must-not-be-written'), '诊断文件不得包含 boardToken');
  } finally {
    if (prevTools !== undefined) process.env.DSH_TOOLS_PATH = prevTools;
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  }
});

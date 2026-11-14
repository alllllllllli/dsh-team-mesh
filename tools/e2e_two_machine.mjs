#!/usr/bin/env node
/**
 * e2e_two_machine.mjs - independent, repeatable two-machine verification for dsh-team-mesh.
 *
 * Master runs on machine A (mcloud). It starts throw-away board services on machine B (server)
 * through tools/board_verify_server.ps1, then drives real HTTP requests across the LAN and
 * asserts server-side decisions. Evidence (scenario JSON, events, audit, logs) is written to a
 * local run directory. Nothing is written into the package under test.
 *
 * PHASE 1 (basic cross-machine behavior)
 *   1. basic link: create -> claim -> blob upload/report -> complete; event sequence; lease_host
 *      must be the client hostname (proves identity really travelled across machines).
 *   2. real process crash: a separate worker process claims, is hard-killed (taskkill /F), the
 *      lease goes stale by time expiry, then another process takes over. Also asserts the
 *      cross-machine dead-holder branch is NOT taken (dead_owner_count == 0, no reason field).
 *   3. PID reuse boundary: heartbeats under the dead worker's actor name are rejected with
 *      PID_REUSED (HTTP 400), both for a real new pid and for same-pid/different-start_sec.
 *   4. completion gate not relaxed: no-evidence and latest-fail completions stay GATE_REJECTED
 *      (HTTP 409); a later admissible pass can still complete.
 *
 * PHASE 2 (three-evidence adoption)
 *   5. same-machine verifiable adopt: holder process runs ON the board host => board can probe
 *      its pid; after hard kill, sweep marks stale via the dead-holder branch and adopt returns
 *      unverified=false, verdict=adopted-verified, checked_pid=true; event lease.adopted.
 *   6. cross-machine default deny: holder is on the client host => lease_host != board host =>
 *      adopt is rejected with ADOPT_EVIDENCE_UNVERIFIABLE (HTTP 409), nothing is adopted.
 *   7. explicit allow path: a second board with DSH_TEAM_BOARD_ALLOW_UNVERIFIED_ADOPT=1 accepts
 *      the same cross-machine situation but must report unverified=true, verdict=adopted-unverified.
 *   8. adoption reject paths: ADOPT_NOT_STALE, ADOPT_HOLDER_ALIVE (then recovery after the holder
 *      really dies), ADOPT_NOT_CLAIMED.
 *
 * The same script doubles as the worker executable (`--role worker-claim-hang` /
 * `--role worker-http-once`). The remote holder role is launched on the server over SSH so that
 * its lease_host is the server hostname (same-machine adopt branch); its token is read from the
 * board's token file, never argv.
 *
 * Secrets: board tokens are generated on the server, read into memory over SSH, passed to local
 * workers through the environment and to remote workers through a token file. They never appear
 * in evidence, logs, or argv.
 *
 * Usage (master):
 *   node tools/e2e_two_machine.mjs [options]
 * Options:
 *   --server-host   server LAN host            (default 172.24.112.14)
 *   --ssh-user      ssh user                    (default admin)
 *   --ssh-key       ssh private key path
 *   --server-root   server temp root            (default C:\Users\admin\mesh-verify)
 *   --server-repo   package snapshot on server  (default <server-root>\repo)
 *   --server-node   node.exe on server          (default C:\Users\admin\.local\node\node.exe)
 *   --client-ip     this machine's LAN IP used in the server firewall rule (default 172.24.112.11)
 *   --evidence-root local evidence root
 *   --keep          keep remote workdirs for debugging
 *   --skip-phase2   run only the phase-1 regression scenarios
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const HERE = path.dirname(SELF);
const LOCAL_REPO = path.resolve(HERE, '..');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  return out;
}

const opts = parseArgs(process.argv.slice(2));
const ROLE = typeof opts.role === 'string' ? opts.role : 'master';

const CFG = {
  serverHost: typeof opts['server-host'] === 'string' ? opts['server-host'] : '172.24.112.14',
  sshUser: typeof opts['ssh-user'] === 'string' ? opts['ssh-user'] : 'admin',
  sshKey: typeof opts['ssh-key'] === 'string' ? opts['ssh-key'] : 'C:\\Users\\Admin\\.ssh\\id_ed25519_mcloud',
  serverRoot: typeof opts['server-root'] === 'string' ? opts['server-root'] : 'C:\\Users\\admin\\mesh-verify',
  serverRepo: typeof opts['server-repo'] === 'string' ? opts['server-repo'] : 'C:\\Users\\admin\\mesh-verify\\repo',
  serverNode: typeof opts['server-node'] === 'string' ? opts['server-node'] : 'C:\\Users\\admin\\.local\\node\\node.exe',
  clientIp: typeof opts['client-ip'] === 'string' ? opts['client-ip'] : '172.24.112.11',
  evidenceRoot: typeof opts['evidence-root'] === 'string'
    ? opts['evidence-root']
    : 'C:\\Users\\Admin\\work-20261114\\mesh-dev\\verify\\evidence',
  keep: opts.keep === true,
  skipPhase2: opts['skip-phase2'] === true,
};

const ACTOR_A = 'agent-team:mcloud:verify-master';
const ACTOR_B = 'agent-team:mcloud:verify-worker-b';
const ACTOR_W = 'agent-team:mcloud:verify-worker-a';
const ACTOR_ADOPT = 'agent-team:mcloud:verify-adopter';
const ACTOR_SERVER = 'agent-team:server:verify-holder';
const REQUIRED_PHASE1 = ['1', '2', '3', '4'];
const REQUIRED_PHASE2 = ['5', '6', '7', '8'];

// ---------------------------------------------------------------- utilities

function isoNow() { return new Date().toISOString(); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function sha256Hex(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function randomHex(n) { return crypto.randomBytes(n).toString('hex'); }
function shortId() { return randomHex(5); }

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function selfIdentity() {
  return {
    pid: process.pid,
    start_sec: Math.floor((Date.now() - process.uptime() * 1000) / 1000),
    host: os.hostname(),
  };
}

const consoleLines = [];
function log(...parts) {
  const line = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  consoleLines.push(line);
  console.log(line);
}

// ---------------------------------------------------------------- ssh/scp helpers

function sshBaseArgs() {
  return [
    '-i', CFG.sshKey,
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=15',
    `${CFG.sshUser}@${CFG.serverHost}`,
  ];
}

function sshCommand(remoteCommand, { timeoutMs = 60000 } = {}) {
  const r = spawnSync('ssh', [...sshBaseArgs(), remoteCommand], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ? String(r.error.message) : null };
}

function sshScript(psScript, { timeoutMs = 60000 } = {}) {
  const b64 = Buffer.from(psScript, 'utf16le').toString('base64');
  return sshCommand(`powershell -NoProfile -EncodedCommand ${b64}`, { timeoutMs });
}

function parseLastJson(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch { /* keep looking */ }
  }
  return null;
}

function scpTo(localPath, remotePath, { timeoutMs = 60000 } = {}) {
  const r = spawnSync('scp', ['-i', CFG.sshKey, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', localPath, `${CFG.sshUser}@${CFG.serverHost}:${remotePath}`], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function scpFrom(remotePath, localPath, { timeoutMs = 60000 } = {}) {
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  const r = spawnSync('scp', ['-i', CFG.sshKey, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', `${CFG.sshUser}@${CFG.serverHost}:${remotePath}`, localPath], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// ---------------------------------------------------------------- HTTP client

let CURRENT_BOARD = { endpoint: '', token: '' };
const httpTrace = [];

function useBoard(board) { CURRENT_BOARD = board; }

async function httpReq(method, pathname, { json, buffer, timeoutMs = 15000, board } = {}) {
  const b = board ?? CURRENT_BOARD;
  const t0 = Date.now();
  const headers = { 'x-team-token': b.token };
  let body;
  if (buffer !== undefined) {
    body = buffer;
    headers['content-type'] = 'application/octet-stream';
  } else if (json !== undefined) {
    body = Buffer.from(JSON.stringify(json), 'utf8');
    headers['content-type'] = 'application/json; charset=utf-8';
  }
  const entry = { t: isoNow(), method, path: pathname, status: null, ms: null, code: null };
  try {
    const res = await fetch(b.endpoint + pathname, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
    const bytes = Buffer.from(await res.arrayBuffer());
    let parsed = null;
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      try { parsed = JSON.parse(bytes.toString('utf8')); } catch { parsed = null; }
    }
    entry.status = res.status;
    entry.ms = Date.now() - t0;
    entry.code = parsed?.error?.code ?? null;
    httpTrace.push(entry);
    return { status: res.status, headers: res.headers, bytes, json: parsed, ms: entry.ms };
  } catch (err) {
    entry.ms = Date.now() - t0;
    entry.code = 'TRANSPORT';
    entry.error = String(err?.message ?? err);
    httpTrace.push(entry);
    return { status: 0, headers: null, bytes: Buffer.alloc(0), json: null, ms: entry.ms, error: entry.error };
  }
}

function postJson(pathname, body, options = {}) { return httpReq('POST', pathname, { json: body, ...options }); }
function getJson(pathname, options = {}) { return httpReq('GET', pathname, options); }
function blobPut(bytes, options = {}) { return httpReq('POST', '/blob/put', { buffer: bytes, ...options }); }

async function fetchEventList(taskId, limit = 100, options = {}) {
  const q = taskId === null ? `?limit=${limit}` : `?taskId=${encodeURIComponent(taskId)}&limit=${limit}`;
  const res = await getJson('/events' + q, options);
  if (res.status !== 200 || res.json?.ok !== true) return null;
  return res.json.events;
}

function eventsAsc(events) { return [...(events ?? [])].sort((a, b) => Number(a.seq) - Number(b.seq)); }
function findEvents(events, kind, taskId) {
  return (events ?? []).filter((e) => e.kind === kind && (taskId === undefined || e.task_id === taskId));
}

// ---------------------------------------------------------------- scenario bookkeeping

function makeScenario(id, phase, title) {
  return { id, phase, title, started_at: isoNow(), finished_at: null, steps: [], assertions: [], pass: null };
}
function assert(sc, name, ok, detail) {
  sc.assertions.push({ name, ok: ok === true, detail: detail === undefined ? null : String(detail) });
  return ok === true;
}
function note(sc, step, data) { sc.steps.push({ t: isoNow(), step, ...data }); }
function finishScenario(sc) {
  sc.finished_at = isoNow();
  sc.pass = sc.assertions.length > 0 && sc.assertions.every((a) => a.ok);
  return sc;
}

// ---------------------------------------------------------------- worker mode (also used on server)

function readTokenArg() {
  if (typeof opts['token-file'] === 'string') {
    const token = fs.readFileSync(opts['token-file'], 'utf8').replace(/\s+/g, '');
    if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('bad token file content');
    return token;
  }
  return process.env.DSH_MESH_VERIFY_TOKEN ?? '';
}

async function runWorker() {
  const endpoint = typeof opts.endpoint === 'string' ? opts.endpoint : process.env.DSH_MESH_VERIFY_ENDPOINT;
  if (!endpoint) { console.error('worker: missing --endpoint'); process.exit(2); }
  const token = readTokenArg();
  if (!token) { console.error('worker: missing token (--token-file or env)'); process.exit(2); }
  const board = { endpoint, token };
  useBoard(board);
  const outFile = typeof opts['out'] === 'string' ? opts['out'] : '';
  const writeOut = (value) => { if (outFile) writeJson(outFile, value); };

  if (ROLE === 'worker-claim-hang') {
    const identity = selfIdentity();
    const res = await postJson('/task/claim', {
      taskId: opts['task-id'],
      actor: opts.actor,
      leaseMs: Number(opts['lease-ms'] ?? 6000),
      leaseIdentity: identity,
    });
    writeOut({ role: ROLE, pid: process.pid, identity, status: res.status, body: res.json, at: isoNow() });
    console.log('WORKER_READY ' + JSON.stringify({ pid: process.pid, status: res.status, identity, taskId: opts['task-id'] }));
    setInterval(() => {}, 1000);
    return;
  }

  if (ROLE === 'worker-http-once') {
    let identity;
    if (typeof opts['identity-json'] === 'string') identity = JSON.parse(opts['identity-json']);
    else if (typeof opts['identity-file'] === 'string') identity = JSON.parse(fs.readFileSync(opts['identity-file'], 'utf8'));
    else identity = selfIdentity();
    const action = typeof opts.action === 'string' ? opts.action : 'heartbeat';
    let res;
    if (action === 'heartbeat') {
      res = await postJson('/task/heartbeat', { taskId: opts['task-id'], actor: opts.actor, leaseMs: 60000, leaseIdentity: identity });
    } else if (action === 'claim') {
      res = await postJson('/task/claim', { taskId: opts['task-id'], actor: opts.actor, leaseMs: Number(opts['lease-ms'] ?? 60000), leaseIdentity: identity });
    } else {
      console.error('worker: unknown action ' + action);
      process.exit(2);
    }
    writeOut({ role: ROLE, action, pid: process.pid, identity, status: res.status, body: res.json, at: isoNow() });
    console.log('WORKER_DONE ' + JSON.stringify({ status: res.status, code: res.json?.error?.code ?? null }));
    process.exit(0);
  }

  if (ROLE === 'worker-claim-exit') {
    const identity = selfIdentity();
    const res = await postJson('/task/claim', {
      taskId: opts['task-id'],
      actor: opts.actor,
      leaseMs: Number(opts['lease-ms'] ?? 1500),
      leaseIdentity: identity,
    });
    writeOut({ role: ROLE, pid: process.pid, identity, status: res.status, body: res.json, at: isoNow() });
    console.log('WORKER_DONE ' + JSON.stringify({ status: res.status, identity }));
    process.exit(0);
  }

  console.error('worker: unknown role ' + ROLE);
  process.exit(2);
}

// ---------------------------------------------------------------- master: preflight

async function preflight(runId) {
  const info = { run_id: runId, started_at: isoNow(), client: {}, server: {}, baseline: {}, features: {}, paths: {} };
  const localHost = os.hostname();
  const identity = selfIdentity();
  info.client = { hostname: localHost, identity, node: process.version, platform: process.platform, arch: process.arch, ip: CFG.clientIp, evidence_root: CFG.evidenceRoot };

  if (!fs.existsSync(CFG.sshKey)) throw new Error('ssh key not found: ' + CFG.sshKey);
  if (!fs.existsSync(path.join(LOCAL_REPO, 'src', 'server.js'))) throw new Error('local repo looks wrong: ' + LOCAL_REPO);

  const remote = sshScript(`
$node = '${CFG.serverNode}'
$repo = '${CFG.serverRepo}'
@{ hostname = $env:COMPUTERNAME; node_version = (& $node --version); repo_server_js = (Test-Path (Join-Path $repo 'src\\server.js')); ts = (Get-Date).ToString('o') } | ConvertTo-Json -Compress
`, { timeoutMs: 30000 });
  const remoteInfo = parseLastJson(remote.stdout);
  if (!remoteInfo || remoteInfo.hostname === undefined) throw new Error('cannot read server info over ssh: ' + remote.stderr);
  info.server = { hostname: remoteInfo.hostname, node_version: remoteInfo.node_version, repo_path: CFG.serverRepo, server_js_present: remoteInfo.repo_server_js === true };
  if (info.server.server_js_present !== true) throw new Error('server snapshot missing src/server.js at ' + CFG.serverRepo);

  // Baseline: compare local and remote snapshot hashes for key files, record feature flags.
  const keyFiles = ['src/server.js', 'src/handlers.js', 'src/remote.js', 'src/store.js', 'src/domain.js', 'src/spec.js', 'package.json'];
  const remoteFiles = sshScript(`
$repo = '${CFG.serverRepo}'
$files = @('src\\server.js','src\\handlers.js','src\\remote.js','src\\store.js','src\\domain.js','src\\spec.js','package.json')
foreach ($f in $files) {
  $p = Join-Path $repo $f
  if (Test-Path $p) { "{0}|{1}" -f $f, (Get-FileHash $p -Algorithm SHA256).Hash.ToLower() }
}
`, { timeoutMs: 30000 });
  const remoteHashes = {};
  for (const line of String(remoteFiles.stdout).split(/\r?\n/)) {
    const m = /^([^|]+)\|([0-9a-f]{64})$/.exec(line.trim());
    if (m) remoteHashes[m[1]] = m[2];
  }
  const localHashes = {};
  for (const f of keyFiles) {
    const p = path.join(LOCAL_REPO, f);
    if (fs.existsSync(p)) localHashes[f] = sha256Hex(fs.readFileSync(p));
  }
  info.baseline = {
    local: localHashes,
    server: remoteHashes,
    equal: keyFiles.every((f) => localHashes[f] !== undefined && localHashes[f] === remoteHashes[f]),
    diffs: keyFiles.filter((f) => localHashes[f] !== remoteHashes[f]),
  };

  const handlersSrc = fs.readFileSync(path.join(LOCAL_REPO, 'src', 'handlers.js'), 'utf8');
  const serverSrc = fs.readFileSync(path.join(LOCAL_REPO, 'src', 'server.js'), 'utf8');
  const specSrc = fs.readFileSync(path.join(LOCAL_REPO, 'src', 'spec.js'), 'utf8');
  const remoteSrc = fs.readFileSync(path.join(LOCAL_REPO, 'src', 'remote.js'), 'utf8');
  info.features = {
    adopt_tool: /mesh_task_adopt/.test(handlersSrc),
    adopt_route: /task\/adopt/.test(serverSrc),
    adopt_spec: /mesh_task_adopt/.test(specSrc),
    adopt_codes: /ADOPT_EVIDENCE_UNVERIFIABLE/.test(fs.readFileSync(path.join(LOCAL_REPO, 'src', 'domain.js'), 'utf8')),
    client_sends_lease_identity: /leaseIdentity\(\)/.test(remoteSrc),
  };

  // Deploy the server-side lifecycle script and the worker script.
  const localPs1 = path.join(HERE, 'board_verify_server.ps1');
  if (!fs.existsSync(localPs1)) throw new Error('missing server script: ' + localPs1);
  const remotePs1 = path.join(CFG.serverRoot, 'board_verify_server.ps1');
  const up1 = scpTo(localPs1, remotePs1.replace(/\\/g, '/'));
  if (up1.status !== 0) throw new Error('scp board_verify_server.ps1 failed: ' + up1.stderr);
  const remotePs1Hash = sshScript(`(Get-FileHash -Algorithm SHA256 -Path '${remotePs1}').Hash.ToLower()`, { timeoutMs: 30000 });
  const localPs1Hash = sha256Hex(fs.readFileSync(localPs1));
  info.baseline.ps1_sha256_local = localPs1Hash;
  info.baseline.ps1_sha256_server = String(remotePs1Hash.stdout).trim();
  info.baseline.ps1_match = info.baseline.ps1_sha256_server === localPs1Hash;

  const remoteWorker = path.join(CFG.serverRoot, 'verify_worker.mjs');
  const up2 = scpTo(SELF, remoteWorker.replace(/\\/g, '/'));
  if (up2.status !== 0) throw new Error('scp worker script failed: ' + up2.stderr);
  const remoteWorkerHash = sshScript(`(Get-FileHash -Algorithm SHA256 -Path '${remoteWorker}').Hash.ToLower()`, { timeoutMs: 30000 });
  info.baseline.worker_sha256_local = sha256Hex(fs.readFileSync(SELF));
  info.baseline.worker_sha256_server = String(remoteWorkerHash.stdout).trim();
  info.baseline.worker_match = info.baseline.worker_sha256_server === info.baseline.worker_sha256_local;

  info.paths = {
    server_script: remotePs1,
    server_worker: remoteWorker,
    remote_workdir: path.join(CFG.serverRoot, 'verify', 'run-' + runId),
    remote_workdir_allow: path.join(CFG.serverRoot, 'verify', 'run-' + runId + '-allow'),
  };
  return { info, localHost, identity };
}

// ---------------------------------------------------------------- master: remote board lifecycle

function remoteStart(remoteWorkDir, { allowUnverified = false } = {}) {
  let cmd = 'powershell -NoProfile -ExecutionPolicy Bypass -File ' + path.join(CFG.serverRoot, 'board_verify_server.ps1')
    + ' -Action Start -WorkDir ' + remoteWorkDir
    + ' -RepoPath ' + CFG.serverRepo
    + ' -NodeExe ' + CFG.serverNode
    + ' -Port 0'
    + ' -ClientIp ' + CFG.clientIp;
  if (allowUnverified) cmd += ' -AllowUnverifiedAdopt 1';
  const r = sshCommand(cmd, { timeoutMs: 120000 });
  const parsed = parseLastJson(r.stdout);
  if (!parsed || parsed.ok !== true) throw new Error('remote board start failed: ' + JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr, parsed }));
  return parsed;
}

function remoteAction(action, remoteWorkDir) {
  const cmd = 'powershell -NoProfile -ExecutionPolicy Bypass -File ' + path.join(CFG.serverRoot, 'board_verify_server.ps1')
    + ' -Action ' + action + ' -WorkDir ' + remoteWorkDir;
  const r = sshCommand(cmd, { timeoutMs: 120000 });
  return { raw: r, parsed: parseLastJson(r.stdout) };
}

async function readTokenFromServer(state) {
  const r = sshScript(`(Get-Content -Raw -Path '${state.token_file}').Trim()`, { timeoutMs: 30000 });
  const token = String(r.stdout ?? '').replace(/\s+/g, '');
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('could not read a valid token from server (stdout length ' + token.length + ')');
  return token;
}

function makeBoard(state, token) {
  return { name: state.workdir, state, endpoint: 'http://' + CFG.serverHost + ':' + state.port, token };
}

// ---------------------------------------------------------------- master: process helpers

const CHILDREN = [];
const REMOTE_HOLDERS = []; // { pid (server-side), sshChild, taskId }
let TEMP_DIR = '';

function hardKill(pid) {
  const r = spawnSync('taskkill', ['/F', '/PID', String(pid)], { encoding: 'utf8', windowsHide: true });
  return { exitCode: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim(), at: isoNow() };
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(fn, { timeoutMs = 15000, intervalMs = 200, label = 'condition' } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(intervalMs);
  }
  throw new Error('timeout waiting for ' + label);
}

function spawnChild(role, args, envExtra = {}) {
  const child = spawn(process.execPath, [SELF, '--role', role, ...args], {
    env: { ...process.env, DSH_MESH_VERIFY_ENDPOINT: CURRENT_BOARD.endpoint, DSH_MESH_VERIFY_TOKEN: CURRENT_BOARD.token, ...envExtra },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const out = [];
  const err = [];
  CHILDREN.push(child.pid);
  child.stdout.on('data', (b) => out.push(b.toString('utf8')));
  child.stderr.on('data', (b) => err.push(b.toString('utf8')));
  child.on('exit', (code, signal) => {
    child._exit = { code, signal, stdout: out.join(''), stderr: err.join('') };
    const i = CHILDREN.indexOf(child.pid);
    if (i >= 0) CHILDREN.splice(i, 1);
  });
  return child;
}

async function spawnClaimHang(taskId, actor, leaseMs, identityFile) {
  const child = spawnChild('worker-claim-hang', ['--task-id', taskId, '--actor', actor, '--lease-ms', String(leaseMs), '--out', identityFile]);
  const info = await waitFor(async () => {
    if (!fs.existsSync(identityFile)) return null;
    try { return JSON.parse(fs.readFileSync(identityFile, 'utf8')); } catch { return null; }
  }, { timeoutMs: 15000, label: 'worker claim output' });
  return { child, info };
}

async function runHttpOnce(args) {
  const outFile = path.join(TEMP_DIR, 'once-' + shortId() + '.json');
  const child = spawnChild('worker-http-once', [...args, '--out', outFile]);
  const code = await new Promise((resolve) => child.on('exit', (c) => resolve(c)));
  let info = null;
  if (fs.existsSync(outFile)) { try { info = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch { info = null; } }
  return { exitCode: code, info, stderr: child._exit?.stderr ?? '' };
}

// ---------------------------------------------------------------- master: remote holder (runs ON the server)

function spawnRemoteHolder(board, taskId, actor, leaseMs) {
  const script = [
    '$node = ' + psQuote(CFG.serverNode),
    '$worker = ' + psQuote(path.join(CFG.serverRoot, 'verify_worker.mjs')),
    '& $node $worker --role worker-claim-hang --task-id ' + psQuote(taskId) + ' --actor ' + psQuote(actor)
      + ' --lease-ms ' + String(leaseMs) + ' --endpoint ' + psQuote('http://127.0.0.1:' + board.state.port)
      + ' --token-file ' + psQuote(board.state.token_file),
  ].join('\n');
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawn('ssh', [...sshBaseArgs(), `powershell -NoProfile -EncodedCommand ${b64}`], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const out = [];
  const err = [];
  child.stdout.on('data', (b) => out.push(b.toString('utf8')));
  child.stderr.on('data', (b) => err.push(b.toString('utf8')));
  child.on('exit', (code) => { child._exit = { code, stdout: out.join(''), stderr: err.join('') }; });
  const holder = { board, taskId, actor, sshChild: child, pid: 0, identity: null, ready: null, task: taskId };
  REMOTE_HOLDERS.push(holder);
  return holder;
}

function psQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

async function waitRemoteHolderReady(holder, timeoutMs = 25000) {
  await waitFor(() => holder.sshChild._exit?.stdout?.includes('WORKER_READY')
    || holder.sshChild._exit?.stderr?.includes('WORKER_READY'), { timeoutMs, intervalMs: 200, label: 'remote holder ready' });
  const text = (holder.sshChild._exit?.stdout ?? '') + (holder.sshChild._exit?.stderr ?? '');
  const m = /WORKER_READY (\{.*\})/.exec(text);
  if (!m) throw new Error('remote holder ready line unparseable: ' + text.slice(0, 500));
  holder.ready = JSON.parse(m[1]);
  holder.pid = holder.ready.pid;
  holder.identity = holder.ready.identity;
  return holder;
}

async function remotePidAlive(pid) {
  const r = sshScript(`if (Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue) { 'ALIVE' } else { 'GONE' }`, { timeoutMs: 20000 });
  return String(r.stdout ?? '').includes('ALIVE');
}

async function killRemoteHolder(holder) {
  if (holder.pid > 0) {
    sshScript(`Stop-Process -Id ${holder.pid} -Force -ErrorAction SilentlyContinue; 'KILL-REQUESTED'`, { timeoutMs: 20000 });
    try {
      await waitFor(async () => !(await remotePidAlive(holder.pid)), { timeoutMs: 15000, intervalMs: 300, label: 'remote holder pid gone' });
    } catch { /* fall through */ }
  }
  try {
    if (!holder.sshChild._exit) holder.sshChild.kill();
  } catch { /* ignore */ }
  return holder.pid;
}

// ---------------------------------------------------------------- scenarios (phase 1)

async function scenarioBasic(sc, ctx) {
  const health = await getJson('/health');
  assert(sc, 'GET /health -> 200', health.status === 200, 'status=' + health.status);
  assert(sc, 'health.ok === true', health.json?.ok === true, JSON.stringify(health.json?.ok));
  assert(sc, 'health.service is the mesh board', health.json?.service === 'dsh-team-mesh board', String(health.json?.service));
  assert(sc, 'health.schema_version is a real number from db', Number.isInteger(health.json?.schema_version), JSON.stringify(health.json?.schema_version));
  assert(sc, 'health.listen_port equals started port', health.json?.listen_port === ctx.board.state.port, 'health=' + health.json?.listen_port + ' state=' + ctx.board.state.port);
  assert(sc, 'default board has unverified adoption disabled', health.json?.adoption?.allow_unverified === false, JSON.stringify(health.json?.adoption));
  note(sc, 'health', { status: health.status, body: health.json });

  const created = await postJson('/task/create', {
    title: 'cross-machine basic link ' + ctx.runId,
    brief: 'created by mcloud verifier, claimed and completed across the LAN',
    acceptance: 'blob evidence hashed on server side, gate passes, events ordered',
    requestId: 'verify-' + ctx.runId + '-basic',
    actor: ACTOR_A,
  });
  assert(sc, 'POST /task/create -> 200', created.status === 200, 'status=' + created.status);
  const task = created.json?.task;
  assert(sc, 'created task starts open', task?.lifecycle === 'open', JSON.stringify(task?.lifecycle));
  assert(sc, 'created_by is the remote client', task?.created_by === ACTOR_A, String(task?.created_by));
  const taskId = task?.task_id;
  assert(sc, 'task id shape t-xxxxxxxx', /^t-[0-9a-f]{8}$/.test(String(taskId)), String(taskId));
  note(sc, 'task.create', { status: created.status, task_id: taskId });

  const claimed = await postJson('/task/claim', { taskId, actor: ACTOR_A, leaseMs: 60000, leaseIdentity: ctx.identity });
  assert(sc, 'POST /task/claim -> 200', claimed.status === 200, 'status=' + claimed.status);
  const claimedTask = claimed.json?.task;
  assert(sc, 'lease_host is the client host (cross-machine identity really travelled)', claimedTask?.lease_host === ctx.localHost, 'lease_host=' + claimedTask?.lease_host + ' client=' + ctx.localHost);
  assert(sc, 'lease_host differs from the board host', claimedTask?.lease_host !== ctx.info.server.hostname, 'lease_host=' + claimedTask?.lease_host + ' server=' + ctx.info.server.hostname);
  assert(sc, 'lease_pid is the client process pid', claimedTask?.lease_pid === ctx.identity.pid, 'lease_pid=' + claimedTask?.lease_pid + ' client=' + ctx.identity.pid);
  assert(sc, 'lease_start_sec is the client process start second', claimedTask?.lease_start_sec === ctx.identity.start_sec, 'lease_start_sec=' + claimedTask?.lease_start_sec + ' client=' + ctx.identity.start_sec);
  assert(sc, 'claim moves task to working and sets owner', claimedTask?.lifecycle === 'working' && claimedTask?.owner_session === ACTOR_A, JSON.stringify({ lifecycle: claimedTask?.lifecycle, owner: claimedTask?.owner_session }));
  note(sc, 'task.claim', { status: claimed.status, task: summarizeTask(claimedTask) });

  const proofBytes = crypto.randomBytes(256);
  const proofPath = path.join(TEMP_DIR, 'proof-' + ctx.runId + '.bin');
  fs.writeFileSync(proofPath, proofBytes);
  const localSha = sha256Hex(proofBytes);
  const directRef = await postJson('/task/report', {
    taskId, executed: true, outcome: 'pass',
    note: 'negative control: client-local path, board host cannot read it',
    evidenceRef: proofPath, actor: ACTOR_A,
  });
  assert(sc, 'report with client-local path is accepted as a record', directRef.status === 200, 'status=' + directRef.status);
  assert(sc, 'client-local path evidence is NOT admissible on the board host', directRef.json?.evidence?.admissible === false, JSON.stringify(directRef.json?.evidence));

  const blob = await blobPut(proofBytes);
  assert(sc, 'POST /blob/put -> 200', blob.status === 200, 'status=' + blob.status);
  assert(sc, 'server-computed sha256 equals client-computed sha256', blob.json?.sha256 === localSha, 'server=' + blob.json?.sha256 + ' client=' + localSha);
  assert(sc, 'server-computed size equals uploaded size', blob.json?.size === proofBytes.length, 'server=' + blob.json?.size + ' client=' + proofBytes.length);

  const reported = await postJson('/task/report', {
    taskId, executed: true, outcome: 'pass',
    note: 'real artifact uploaded from mcloud, hash computed by the server',
    evidenceRef: 'blob://sha256:' + blob.json.sha256, acceptanceRef: 'A01', verificationMethod: 'disk-hash', actor: ACTOR_A,
  });
  assert(sc, 'POST /task/report (blob ref) -> 200', reported.status === 200, 'status=' + reported.status);
  assert(sc, 'blob evidence is admissible', reported.json?.evidence?.admissible === true, JSON.stringify(reported.json?.evidence));
  assert(sc, 'evidence ref_sha256 equals the server-computed hash', reported.json?.evidence?.ref_sha256 === blob.json?.sha256, JSON.stringify(reported.json?.evidence));
  assert(sc, 'evidence ref_kind is blob', reported.json?.evidence?.ref_kind === 'blob', String(reported.json?.evidence?.ref_kind));

  const completed = await postJson('/task/complete', { taskId, actor: ACTOR_A });
  assert(sc, 'POST /task/complete -> 200', completed.status === 200, 'status=' + completed.status);
  assert(sc, 'completion gate allowed', completed.json?.gate?.allowed === true, JSON.stringify(completed.json?.gate));
  assert(sc, 'task lifecycle is done', completed.json?.task?.lifecycle === 'done', String(completed.json?.task?.lifecycle));

  const events = await fetchEventList(taskId);
  const asc = eventsAsc(events);
  assert(sc, 'event seq is strictly increasing', asc.map((e) => Number(e.seq)).every((s, i, a) => i === 0 || s > a[i - 1]), JSON.stringify(asc.map((e) => e.seq)));
  const kinds = asc.map((e) => e.kind);
  const idx = (kind) => kinds.indexOf(kind);
  assert(sc, 'event order created -> claimed -> evidence.recorded -> done',
    idx('task.created') >= 0 && idx('task.created') < idx('task.claimed') && idx('task.claimed') < idx('evidence.recorded') && idx('evidence.recorded') < idx('task.done'), JSON.stringify(kinds));
  const hashEvents = findEvents(events, 'evidence.recorded', taskId).filter((e) => e.payload?.ref_sha256 === blob.json?.sha256);
  assert(sc, 'audit event carries the server-computed hash', hashEvents.length === 1, 'matches=' + hashEvents.length);
  const doneEvent = findEvents(events, 'task.done', taskId)[0];
  assert(sc, 'done event reports 2 evidence records', doneEvent?.payload?.evidence_count === 2, JSON.stringify(doneEvent?.payload));
  writeJson(path.join(ctx.evidenceRun, 'events', taskId + '-events.json'), events);
  ctx.tasks.basic = taskId;
}

async function scenarioCrashPhaseA(sc, ctx) {
  const created = await postJson('/task/create', {
    title: 'crash/stale/takeover ' + ctx.runId,
    brief: 'worker claims, is hard-killed, lease must go stale by expiry, another process takes over',
    acceptance: 'lease.stale event without dead-owner reason; takeover allowed only after stale',
    requestId: 'verify-' + ctx.runId + '-crash', actor: ACTOR_A,
  });
  assert(sc, 'crash task created', created.status === 200, 'status=' + created.status);
  const taskId = created.json?.task?.task_id;

  const identityFile = path.join(TEMP_DIR, 'worker-a-' + shortId() + '.json');
  const { info } = await spawnClaimHang(taskId, ACTOR_W, 6000, identityFile);
  assert(sc, 'separate worker process claimed the task', info?.status === 200, JSON.stringify({ status: info?.status, body: info?.body?.error ?? null }));
  const workerIdentity = info?.identity;
  assert(sc, 'worker claim recorded worker pid', info?.body?.task?.lease_pid === workerIdentity?.pid, JSON.stringify({ lease_pid: info?.body?.task?.lease_pid, pid: workerIdentity?.pid }));
  assert(sc, 'worker claim recorded worker host', info?.body?.task?.lease_host === ctx.localHost, 'lease_host=' + info?.body?.task?.lease_host);
  assert(sc, 'worker is a real live process', pidAlive(workerIdentity?.pid), 'pid=' + workerIdentity?.pid);
  note(sc, 'worker.claim', { pid: workerIdentity?.pid, identity: workerIdentity, lease_until: info?.body?.task?.lease_until });

  const killed = hardKill(workerIdentity.pid);
  assert(sc, 'taskkill /F terminated the worker', killed.exitCode === 0, JSON.stringify(killed));
  await sleep(300);
  assert(sc, 'killed worker pid no longer exists', !pidAlive(workerIdentity.pid), 'pid=' + workerIdentity.pid);
  note(sc, 'worker.kill', { pid: workerIdentity.pid, taskkill: killed });

  const earlyClaim = await postJson('/task/claim', { taskId, actor: ACTOR_B, leaseMs: 60000, leaseIdentity: ctx.identity });
  assert(sc, 'claim before lease expiry is rejected', earlyClaim.status === 409, 'status=' + earlyClaim.status);
  assert(sc, 'rejection code is ALREADY_CLAIMED', earlyClaim.json?.error?.code === 'ALREADY_CLAIMED', String(earlyClaim.json?.error?.code));

  const t0 = Date.now();
  let markedSweep = null;
  let staleTask = null;
  let sweeps = 0;
  while (Date.now() - t0 < 30000) {
    const sweep = await postJson('/sweep', {});
    sweeps += 1;
    assert(sc, 'POST /sweep -> 200 (attempt ' + sweeps + ')', sweep.status === 200, 'status=' + sweep.status);
    const lease = sweep.json?.lease;
    if (Array.isArray(lease?.marked) && lease.marked.includes(taskId)) markedSweep = { res: sweep.json, at: isoNow() };
    const got = await getJson('/task/get?taskId=' + encodeURIComponent(taskId));
    if (got.json?.task?.stale === 1) { staleTask = got.json.task; break; }
    await sleep(400);
  }
  assert(sc, 'expired lease was marked stale', staleTask !== null, 'sweeps=' + sweeps + ' elapsed_ms=' + (Date.now() - t0));
  assert(sc, 'task.stale === 1', staleTask?.stale === 1, JSON.stringify(staleTask?.stale));
  assert(sc, 'stale task keeps the dead worker as owner', staleTask?.owner_session === ACTOR_W, String(staleTask?.owner_session));
  assert(sc, 'sweep response reported the marked task', markedSweep !== null, 'marked=' + JSON.stringify(markedSweep?.res?.lease?.marked ?? null));
  assert(sc, 'sweep used the time-expiry path (expired_count >= 1)', Number(markedSweep?.res?.lease?.expired_count ?? 0) >= 1, JSON.stringify(markedSweep?.res?.lease));
  assert(sc, 'cross-machine dead-holder pid path was NOT used (dead_owner_count === 0)', Number(markedSweep?.res?.lease?.dead_owner_count ?? 0) === 0, JSON.stringify(markedSweep?.res?.lease));

  const events = await fetchEventList(taskId);
  const staleEvents = findEvents(events, 'lease.stale', taskId);
  assert(sc, 'audit contains exactly one lease.stale event', staleEvents.length === 1, 'count=' + staleEvents.length);
  const stalePayload = staleEvents[0]?.payload ?? {};
  assert(sc, 'lease.stale event has numeric overrun_ms', typeof stalePayload.overrun_ms === 'number' && stalePayload.overrun_ms >= 0, JSON.stringify(stalePayload.overrun_ms));
  assert(sc, 'lease.stale event used the expiry branch (no dead-owner reason)', !Object.prototype.hasOwnProperty.call(stalePayload, 'reason'), JSON.stringify(stalePayload));
  writeJson(path.join(ctx.evidenceRun, 'events', taskId + '-events-phaseA.json'), events);
  return { taskId, workerIdentity, killed };
}

async function scenarioPidReuse(sc, ctx, crash) {
  const taskId = crash.taskId;
  const dead = crash.workerIdentity;

  const onceA = await runHttpOnce(['--action', 'heartbeat', '--task-id', taskId, '--actor', ACTOR_W]);
  assert(sc, 'new process heartbeat (own real identity) -> HTTP 400', onceA.exitCode === 0 && onceA.info?.status === 400, JSON.stringify({ exit: onceA.exitCode, status: onceA.info?.status, stderr: onceA.stderr.slice(0, 400) }));
  assert(sc, 'rejection code is PID_REUSED', onceA.info?.body?.error?.code === 'PID_REUSED', String(onceA.info?.body?.error?.code));
  assert(sc, 'detail names the different real pid', onceA.info?.body?.error?.detail?.my_pid === onceA.info?.identity?.pid && onceA.info?.body?.error?.detail?.lease_pid === dead.pid, JSON.stringify(onceA.info?.body?.error?.detail));

  const reusedIdentity = { pid: dead.pid, start_sec: dead.start_sec + 1, host: dead.host };
  const onceB = await runHttpOnce(['--action', 'heartbeat', '--task-id', taskId, '--actor', ACTOR_W, '--identity-json', JSON.stringify(reusedIdentity)]);
  assert(sc, 'same-pid/different-start_sec heartbeat -> HTTP 400', onceB.exitCode === 0 && onceB.info?.status === 400, JSON.stringify({ exit: onceB.exitCode, status: onceB.info?.status }));
  assert(sc, 'same-pid rejection code is PID_REUSED', onceB.info?.body?.error?.code === 'PID_REUSED', String(onceB.info?.body?.error?.code));
  assert(sc, 'detail shows lease_start_sec vs my_start_sec mismatch', onceB.info?.body?.error?.detail?.lease_start_sec === dead.start_sec && onceB.info?.body?.error?.detail?.my_start_sec === dead.start_sec + 1, JSON.stringify(onceB.info?.body?.error?.detail));

  const got = await getJson('/task/get?taskId=' + encodeURIComponent(taskId));
  assert(sc, 'rejected heartbeats did not revive or clear the stale lease', got.json?.task?.stale === 1 && got.json?.task?.owner_session === ACTOR_W, JSON.stringify({ stale: got.json?.task?.stale, owner: got.json?.task?.owner_session }));
  const events = await fetchEventList(taskId);
  assert(sc, 'no lease.revived event was recorded', findEvents(events, 'lease.revived', taskId).length === 0, 'revived=' + findEvents(events, 'lease.revived', taskId).length);
  ctx.tasks.pidReuse = taskId;
}

async function scenarioCrashPhaseB(sc, ctx, crash) {
  const taskId = crash.taskId;
  const dead = crash.workerIdentity;

  const takeover = await postJson('/task/claim', { taskId, actor: ACTOR_B, leaseMs: 60000, leaseIdentity: ctx.identity });
  assert(sc, 'takeover claim after stale -> 200', takeover.status === 200, 'status=' + takeover.status);
  assert(sc, 'takeover owner is the new actor', takeover.json?.task?.owner_session === ACTOR_B, String(takeover.json?.task?.owner_session));
  assert(sc, 'takeover is not a dedup/no-op', takeover.json?.deduped === false, JSON.stringify(takeover.json?.deduped));
  const beat = await postJson('/task/heartbeat', { taskId, actor: ACTOR_B, leaseMs: 60000, leaseIdentity: ctx.identity });
  assert(sc, 'new owner heartbeat -> 200', beat.status === 200, 'status=' + beat.status);
  assert(sc, 'heartbeat reports not-stale after takeover', beat.json?.was_stale === false, JSON.stringify(beat.json?.was_stale));

  const events = await fetchEventList(taskId);
  const asc = eventsAsc(events);
  const takenOver = findEvents(asc, 'lease.taken_over', taskId);
  assert(sc, 'audit contains lease.taken_over', takenOver.length === 1, 'count=' + takenOver.length);
  const payload = takenOver[0]?.payload ?? {};
  assert(sc, 'taken_over records stale=true and previous owner', payload.stale === true && payload.from === ACTOR_W, JSON.stringify(payload));
  assert(sc, 'taken_over records the dead lease pid/start_sec (forensics)', payload.prev_lease_pid === dead.pid && payload.prev_lease_start_sec === dead.start_sec, JSON.stringify(payload));
  const kinds = asc.map((e) => e.kind);
  assert(sc, 'order: lease.stale < lease.taken_over < lease.renewed', kinds.indexOf('lease.stale') >= 0 && kinds.indexOf('lease.stale') < kinds.indexOf('lease.taken_over') && kinds.indexOf('lease.taken_over') < kinds.indexOf('lease.renewed'), JSON.stringify(kinds));
  writeJson(path.join(ctx.evidenceRun, 'events', taskId + '-events-full.json'), events);
  ctx.tasks.crash = taskId;
}

async function scenarioGates(sc, ctx) {
  const created = await postJson('/task/create', {
    title: 'gate not relaxed ' + ctx.runId,
    brief: 'no evidence and latest-fail must both stay rejected',
    requestId: 'verify-' + ctx.runId + '-gate', actor: ACTOR_A,
  });
  const taskId = created.json?.task?.task_id;
  const claimed = await postJson('/task/claim', { taskId, actor: ACTOR_B, leaseMs: 60000, leaseIdentity: ctx.identity });
  assert(sc, 'gate task created and claimed', created.status === 200 && claimed.status === 200, JSON.stringify({ create: created.status, claim: claimed.status }));

  const noEvidence = await postJson('/task/complete', { taskId, actor: ACTOR_B });
  assert(sc, 'complete with no evidence -> HTTP 409', noEvidence.status === 409, 'status=' + noEvidence.status);
  assert(sc, 'no-evidence rejection code is GATE_REJECTED', noEvidence.json?.error?.code === 'GATE_REJECTED', String(noEvidence.json?.error?.code));
  assert(sc, 'no-evidence reasons mention NO_EVIDENCE', JSON.stringify(noEvidence.json?.error?.detail ?? []).includes('NO_EVIDENCE'), JSON.stringify(noEvidence.json?.error?.detail));

  const failBlob = await blobPut(crypto.randomBytes(128));
  const failReport = await postJson('/task/report', {
    taskId, executed: true, outcome: 'fail', note: 'run failed on purpose for gate verification',
    evidenceRef: 'blob://sha256:' + failBlob.json.sha256, actor: ACTOR_B,
  });
  assert(sc, 'report last evidence = fail is accepted', failReport.status === 200, 'status=' + failReport.status);
  assert(sc, 'fail evidence is admissible (executed + real artifact)', failReport.json?.evidence?.admissible === true, JSON.stringify(failReport.json?.evidence));

  const latestFail = await postJson('/task/complete', { taskId, actor: ACTOR_B });
  assert(sc, 'complete with latest=fail -> HTTP 409', latestFail.status === 409, 'status=' + latestFail.status);
  assert(sc, 'latest-fail rejection code is GATE_REJECTED', latestFail.json?.error?.code === 'GATE_REJECTED', String(latestFail.json?.error?.code));
  assert(sc, 'latest-fail reasons mention LATEST_FAIL', JSON.stringify(latestFail.json?.error?.detail ?? []).includes('LATEST_FAIL'), JSON.stringify(latestFail.json?.error?.detail));
  const afterFail = await getJson('/task/get?taskId=' + encodeURIComponent(taskId));
  assert(sc, 'task is still not done after rejected completion', afterFail.json?.task?.lifecycle !== 'done', String(afterFail.json?.task?.lifecycle));

  const passBlob = await blobPut(crypto.randomBytes(128));
  const passReport = await postJson('/task/report', {
    taskId, executed: true, outcome: 'pass', note: 'recovered after fail, latest admissible evidence is pass',
    evidenceRef: 'blob://sha256:' + passBlob.json.sha256, actor: ACTOR_B,
  });
  assert(sc, 'later pass evidence is admissible', passReport.json?.evidence?.admissible === true, JSON.stringify(passReport.json?.evidence));
  const done = await postJson('/task/complete', { taskId, actor: ACTOR_B });
  assert(sc, 'later pass can complete (gate is last-admissible, not stuck)', done.status === 200 && done.json?.task?.lifecycle === 'done', JSON.stringify({ status: done.status, lifecycle: done.json?.task?.lifecycle }));

  const events = await fetchEventList(taskId);
  const gateEvents = findEvents(events, 'task.gate_rejected', taskId);
  assert(sc, 'each rejected completion left a task.gate_rejected audit event', gateEvents.length === 2, 'count=' + gateEvents.length);
  writeJson(path.join(ctx.evidenceRun, 'events', taskId + '-events.json'), events);
  ctx.tasks.gate = taskId;
}

// ---------------------------------------------------------------- scenarios (phase 2)

async function waitTaskStale(taskId, timeoutMs = 30000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    const sweep = await postJson('/sweep', {});
    last = { sweep: sweep.json, at: isoNow() };
    const got = await getJson('/task/get?taskId=' + encodeURIComponent(taskId));
    if (got.json?.task?.stale === 1) return { task: got.json.task, sweep: last };
    await sleep(400);
  }
  return { task: null, sweep: last };
}

async function scenarioAdoptSameHost(sc, ctx) {
  const created = await postJson('/task/create', {
    title: 'same-host verifiable adopt ' + ctx.runId,
    brief: 'holder runs on the board host, is hard-killed, adopt must verify the dead pid',
    requestId: 'verify-' + ctx.runId + '-adopt-same', actor: ACTOR_A,
  });
  const taskId = created.json?.task?.task_id;
  assert(sc, 'adopt task created', created.status === 200, 'status=' + created.status);

  const holder = spawnRemoteHolder(ctx.board, taskId, ACTOR_SERVER, 60000);
  await waitRemoteHolderReady(holder);
  assert(sc, 'remote holder on board host claimed the task', holder.ready?.status === 200, JSON.stringify({ status: holder.ready?.status, pid: holder.ready?.pid }));
  assert(sc, 'holder identity host is the board hostname', holder.identity?.host === ctx.info.server.hostname, 'holder=' + holder.identity?.host + ' server=' + ctx.info.server.hostname);
  const claimedTask = (await getJson('/task/get?taskId=' + encodeURIComponent(taskId))).json?.task;
  assert(sc, 'lease_host is the board host (same-machine branch reachable)', claimedTask?.lease_host === ctx.info.server.hostname, 'lease_host=' + claimedTask?.lease_host);
  assert(sc, 'lease_pid is the remote holder pid', claimedTask?.lease_pid === holder.pid, 'lease_pid=' + claimedTask?.lease_pid + ' holder=' + holder.pid);
  assert(sc, 'holder process is alive on the server', await remotePidAlive(holder.pid), 'pid=' + holder.pid);
  note(sc, 'holder.claim', { pid: holder.pid, identity: holder.identity, task: summarizeTask(claimedTask) });

  await killRemoteHolder(holder);
  assert(sc, 'holder pid is gone on the server after hard kill', !(await remotePidAlive(holder.pid)), 'pid=' + holder.pid);

  const stale = await waitTaskStale(taskId);
  assert(sc, 'lease went stale after the holder died', stale.task?.stale === 1, JSON.stringify(stale.task?.stale));
  const deadOwnerSweep = stale.sweep?.sweep?.lease;
  assert(sc, 'same-machine dead-holder sweep branch used (dead_owner_count >= 1)', Number(deadOwnerSweep?.dead_owner_count ?? 0) >= 1, JSON.stringify(deadOwnerSweep));
  const eventsStale = await fetchEventList(taskId);
  const staleEvent = findEvents(eventsStale, 'lease.stale', taskId)[0];
  assert(sc, 'lease.stale event records the dead-holder reason', typeof staleEvent?.payload?.reason === 'string' && staleEvent.payload.reason.length > 0, JSON.stringify(staleEvent?.payload));

  const adopted = await postJson('/task/adopt', { taskId, actor: ACTOR_ADOPT, leaseMs: 60000, leaseIdentity: ctx.identity });
  assert(sc, 'POST /task/adopt -> 200 for same-machine verified case', adopted.status === 200, 'status=' + adopted.status + ' code=' + String(adopted.json?.error?.code));
  assert(sc, 'adopted flag true', adopted.json?.adopted === true, JSON.stringify(adopted.json?.adopted));
  assert(sc, 'same-machine adopt is verified (unverified=false)', adopted.json?.unverified === false, JSON.stringify(adopted.json?.unverified));
  assert(sc, 'verdict is adopted-verified', adopted.json?.verdict === 'adopted-verified', String(adopted.json?.verdict));
  const idEv = adopted.json?.evidence?.identity ?? {};
  assert(sc, 'evidence identity checked_pid=true', idEv.checked_pid === true, JSON.stringify(idEv));
  assert(sc, 'evidence identity verdict=verified-dead', idEv.verdict === 'verified-dead', JSON.stringify(idEv));
  assert(sc, 'evidence identity lease_host equals judge host', idEv.lease_host === idEv.judge_host && idEv.lease_host === ctx.info.server.hostname, JSON.stringify(idEv));
  assert(sc, 'evidence time shows stale lease', adopted.json?.evidence?.time?.stale === true, JSON.stringify(adopted.json?.evidence?.time));
  assert(sc, 'evidence event stream proves no renewal after lease_until', adopted.json?.evidence?.event?.last_before_lease_until === true && Number(adopted.json?.evidence?.event?.renewals_after_lease_until ?? -1) === 0, JSON.stringify(adopted.json?.evidence?.event));
  assert(sc, 'adopter is now the owner', adopted.json?.task?.owner_session === ACTOR_ADOPT, String(adopted.json?.task?.owner_session));
  assert(sc, 'adopted task is working and not stale', adopted.json?.task?.lifecycle === 'working' && adopted.json?.task?.stale === 0, JSON.stringify({ lifecycle: adopted.json?.task?.lifecycle, stale: adopted.json?.task?.stale }));

  const events = await fetchEventList(taskId);
  const adoptEvents = findEvents(events, 'lease.adopted', taskId);
  assert(sc, 'audit contains lease.adopted', adoptEvents.length === 1, 'count=' + adoptEvents.length);
  const p = adoptEvents[0]?.payload ?? {};
  assert(sc, 'lease.adopted payload unverified=false and verdict=adopted-verified', p.unverified === false && p.verdict === 'adopted-verified', JSON.stringify({ unverified: p.unverified, verdict: p.verdict }));
  assert(sc, 'lease.adopted payload carries the three-evidence verdict', p.evidence?.identity?.checked_pid === true && p.evidence?.identity?.verdict === 'verified-dead' && p.evidence?.time?.stale === true, JSON.stringify(p.evidence));
  assert(sc, 'lease.adopted payload records the dead holder identity', p.prev_lease_pid === holder.pid && p.prev_lease_host === ctx.info.server.hostname, JSON.stringify({ pid: p.prev_lease_pid, host: p.prev_lease_host }));
  writeJson(path.join(ctx.evidenceRun, 'events', taskId + '-events.json'), events);
  ctx.tasks.adoptSame = taskId;
}

async function scenarioAdoptCrossMachineDeny(sc, ctx) {
  const created = await postJson('/task/create', {
    title: 'cross-machine adopt default deny ' + ctx.runId,
    brief: 'holder is on the client host, board host cannot verify its pid, default policy must reject',
    requestId: 'verify-' + ctx.runId + '-adopt-cross', actor: ACTOR_A,
  });
  const taskId = created.json?.task?.task_id;
  const claimed = await postJson('/task/claim', { taskId, actor: ACTOR_W, leaseMs: 1500, leaseIdentity: ctx.identity });
  assert(sc, 'cross-machine holder claimed with a short lease', claimed.status === 200, 'status=' + claimed.status);
  note(sc, 'cross-machine claim', { task: summarizeTask(claimed.json?.task) });

  const stale = await waitTaskStale(taskId);
  assert(sc, 'cross-machine lease marked stale by expiry', stale.task?.stale === 1, JSON.stringify(stale.task?.stale));
  assert(sc, 'cross-machine sweep did NOT use pid death (dead_owner_count === 0)', Number(stale.sweep?.sweep?.lease?.dead_owner_count ?? -1) === 0, JSON.stringify(stale.sweep?.sweep?.lease));

  const denied = await postJson('/task/adopt', { taskId, actor: ACTOR_ADOPT, leaseMs: 60000, leaseIdentity: ctx.identity });
  assert(sc, 'cross-machine adopt by default -> HTTP 409', denied.status === 409, 'status=' + denied.status);
  assert(sc, 'rejection code is ADOPT_EVIDENCE_UNVERIFIABLE', denied.json?.error?.code === 'ADOPT_EVIDENCE_UNVERIFIABLE', String(denied.json?.error?.code));
  const detail = denied.json?.error?.detail ?? {};
  assert(sc, 'reject detail says identity is unverified (cross-host)', detail.evidence?.identity?.verdict === 'unverified' && detail.evidence?.identity?.reason === 'unverified-cross-host', JSON.stringify(detail.evidence?.identity));
  assert(sc, 'reject detail checked_pid=false', detail.evidence?.identity?.checked_pid === false, JSON.stringify(detail.evidence?.identity));
  assert(sc, 'reject detail policy says allow_unverified_adoption=false', detail.policy?.allow_unverified_adoption === false, JSON.stringify(detail.policy));
  const after = await getJson('/task/get?taskId=' + encodeURIComponent(taskId));
  assert(sc, 'nothing was adopted (owner unchanged, task still stale)', after.json?.task?.owner_session === ACTOR_W && after.json?.task?.stale === 1, JSON.stringify(summarizeTask(after.json?.task)));
  const events = await fetchEventList(taskId);
  assert(sc, 'no lease.adopted event was written on rejection', findEvents(events, 'lease.adopted', taskId).length === 0, 'count=' + findEvents(events, 'lease.adopted', taskId).length);
  writeJson(path.join(ctx.evidenceRun, 'events', taskId + '-events.json'), events);
  ctx.tasks.adoptCrossDeny = taskId;
}

async function scenarioAdoptCrossMachineAllow(sc, ctx) {
  useBoard(ctx.boardAllow);
  const health = await getJson('/health');
  assert(sc, 'allow-board health reports adoption.allow_unverified=true', health.json?.adoption?.allow_unverified === true, JSON.stringify(health.json?.adoption));

  const created = await postJson('/task/create', {
    title: 'cross-machine adopt explicit allow ' + ctx.runId,
    brief: 'same cross-machine situation as the deny scenario, but board policy explicitly allows unverified',
    requestId: 'verify-' + ctx.runId + '-adopt-allow', actor: ACTOR_A,
  });
  const taskId = created.json?.task?.task_id;
  const claimed = await postJson('/task/claim', { taskId, actor: ACTOR_W, leaseMs: 1500, leaseIdentity: ctx.identity });
  assert(sc, 'cross-machine holder claimed on allow-board', claimed.status === 200, 'status=' + claimed.status);
  const stale = await waitTaskStale(taskId);
  assert(sc, 'allow-board lease went stale by expiry', stale.task?.stale === 1, JSON.stringify(stale.task?.stale));

  const adopted = await postJson('/task/adopt', { taskId, actor: ACTOR_ADOPT, leaseMs: 60000, leaseIdentity: ctx.identity });
  assert(sc, 'explicitly allowed cross-machine adopt -> 200', adopted.status === 200, 'status=' + adopted.status + ' code=' + String(adopted.json?.error?.code));
  assert(sc, 'allowed adopt is marked unverified=true', adopted.json?.unverified === true, JSON.stringify(adopted.json?.unverified));
  assert(sc, 'verdict is adopted-unverified (never adopted-verified)', adopted.json?.verdict === 'adopted-unverified', String(adopted.json?.verdict));
  const idEv = adopted.json?.evidence?.identity ?? {};
  assert(sc, 'evidence identity remained unverified/cross-host', idEv.verdict === 'unverified' && idEv.reason === 'unverified-cross-host', JSON.stringify(idEv));
  assert(sc, 'evidence identity checked_pid=false (not silently verified)', idEv.checked_pid === false, JSON.stringify(idEv));
  assert(sc, 'policy records allow_unverified_adoption=true', adopted.json?.policy?.allow_unverified_adoption === true, JSON.stringify(adopted.json?.policy));

  const events = await fetchEventList(taskId);
  const adoptEvents = findEvents(events, 'lease.adopted', taskId);
  assert(sc, 'audit contains lease.adopted', adoptEvents.length === 1, 'count=' + adoptEvents.length);
  const p = adoptEvents[0]?.payload ?? {};
  assert(sc, 'lease.adopted event says unverified=true and verdict=adopted-unverified', p.unverified === true && p.verdict === 'adopted-unverified', JSON.stringify({ unverified: p.unverified, verdict: p.verdict }));
  assert(sc, 'lease.adopted event keeps checked_pid=false', p.evidence?.identity?.checked_pid === false, JSON.stringify(p.evidence?.identity));
  const after = await getJson('/task/get?taskId=' + encodeURIComponent(taskId));
  assert(sc, 'allowed adopt transfers ownership', after.json?.task?.owner_session === ACTOR_ADOPT && after.json?.task?.stale === 0, JSON.stringify(summarizeTask(after.json?.task)));
  writeJson(path.join(ctx.evidenceRun, 'events', taskId + '-events.json'), events);
  ctx.tasks.adoptCrossAllow = taskId;
  useBoard(ctx.board);
}

async function scenarioAdoptRejectPaths(sc, ctx) {
  // (a) ADOPT_NOT_STALE: live lease must not be adopted.
  const t1 = (await postJson('/task/create', { title: 'adopt not-stale ' + ctx.runId, requestId: 'verify-' + ctx.runId + '-notstale', actor: ACTOR_A })).json?.task?.task_id;
  await postJson('/task/claim', { taskId: t1, actor: ACTOR_W, leaseMs: 60000, leaseIdentity: ctx.identity });
  const notStale = await postJson('/task/adopt', { taskId: t1, actor: ACTOR_ADOPT, leaseMs: 60000, leaseIdentity: ctx.identity });
  assert(sc, 'adopt with live lease -> HTTP 409', notStale.status === 409, 'status=' + notStale.status);
  assert(sc, 'rejection code is ADOPT_NOT_STALE', notStale.json?.error?.code === 'ADOPT_NOT_STALE', String(notStale.json?.error?.code));
  assert(sc, 'not-stale detail shows time evidence not expired', notStale.json?.error?.detail?.evidence?.time?.expired === false && notStale.json?.error?.detail?.evidence?.time?.stale === false, JSON.stringify(notStale.json?.error?.detail?.evidence?.time));
  note(sc, 'reject.not-stale', { status: notStale.status, code: notStale.json?.error?.code });

  // (b) ADOPT_NOT_CLAIMED: unclaimed task has no lease to adopt.
  const t2 = (await postJson('/task/create', { title: 'adopt not-claimed ' + ctx.runId, requestId: 'verify-' + ctx.runId + '-notclaimed', actor: ACTOR_A })).json?.task?.task_id;
  const notClaimed = await postJson('/task/adopt', { taskId: t2, actor: ACTOR_ADOPT, leaseMs: 60000, leaseIdentity: ctx.identity });
  assert(sc, 'adopt unclaimed task -> HTTP 409', notClaimed.status === 409, 'status=' + notClaimed.status);
  assert(sc, 'rejection code is ADOPT_NOT_CLAIMED', notClaimed.json?.error?.code === 'ADOPT_NOT_CLAIMED', String(notClaimed.json?.error?.code));
  note(sc, 'reject.not-claimed', { status: notClaimed.status, code: notClaimed.json?.error?.code });

  // (c) ADOPT_HOLDER_ALIVE: same-host holder alive inside a stale (expired) lease.
  const t3 = (await postJson('/task/create', { title: 'adopt holder-alive ' + ctx.runId, requestId: 'verify-' + ctx.runId + '-holderalive', actor: ACTOR_A })).json?.task?.task_id;
  const holder = spawnRemoteHolder(ctx.board, t3, ACTOR_SERVER, 1500);
  await waitRemoteHolderReady(holder);
  assert(sc, 'alive holder claimed on board host', holder.ready?.status === 200, JSON.stringify({ status: holder.ready?.status }));
  const stale = await waitTaskStale(t3);
  assert(sc, 'alive holder lease went stale by expiry', stale.task?.stale === 1, JSON.stringify(stale.task?.stale));
  assert(sc, 'alive holder was not misjudged dead by sweep', Number(stale.sweep?.sweep?.lease?.dead_owner_count ?? -1) === 0, JSON.stringify(stale.sweep?.sweep?.lease));
  const holderAlive = await postJson('/task/adopt', { taskId: t3, actor: ACTOR_ADOPT, leaseMs: 60000, leaseIdentity: ctx.identity });
  assert(sc, 'adopt while same-host holder is alive -> HTTP 409', holderAlive.status === 409, 'status=' + holderAlive.status);
  assert(sc, 'rejection code is ADOPT_HOLDER_ALIVE', holderAlive.json?.error?.code === 'ADOPT_HOLDER_ALIVE', String(holderAlive.json?.error?.code));
  assert(sc, 'holder-alive detail says the identity verdict is alive', holderAlive.json?.error?.detail?.evidence?.identity?.verdict === 'alive', JSON.stringify(holderAlive.json?.error?.detail?.evidence?.identity));
  note(sc, 'reject.holder-alive', { status: holderAlive.status, code: holderAlive.json?.error?.code });

  // recovery: once the holder really dies, the same adopt must succeed (rejection is not permanent).
  await killRemoteHolder(holder);
  assert(sc, 'alive holder really died before recovery adopt', !(await remotePidAlive(holder.pid)), 'pid=' + holder.pid);
  await postJson('/sweep', {});
  const recovered = await postJson('/task/adopt', { taskId: t3, actor: ACTOR_ADOPT, leaseMs: 60000, leaseIdentity: ctx.identity });
  assert(sc, 'same task adopt succeeds after holder death (recovery)', recovered.status === 200 && recovered.json?.unverified === false, JSON.stringify({ status: recovered.status, unverified: recovered.json?.unverified, code: recovered.json?.error?.code }));
  assert(sc, 'recovery adopt verdict is adopted-verified', recovered.json?.verdict === 'adopted-verified', String(recovered.json?.verdict));

  // tidy up tasks that are not needed anymore.
  await postJson('/task/cancel', { taskId: t1, actor: ACTOR_W, reason: 'verification cleanup' });
  await postJson('/task/cancel', { taskId: t2, actor: ACTOR_A, reason: 'verification cleanup' });
  ctx.tasks.adoptRejects = { notStale: t1, notClaimed: t2, holderAlive: t3 };
}

function summarizeTask(task) {
  if (!task) return null;
  return {
    task_id: task.task_id, lifecycle: task.lifecycle, owner_session: task.owner_session, version: task.version,
    stale: task.stale, lease_host: task.lease_host, lease_pid: task.lease_pid, lease_start_sec: task.lease_start_sec, lease_until: task.lease_until,
  };
}

// ---------------------------------------------------------------- master: artifacts / main

async function collectArtifacts(remoteWorkDir, destSubdir) {
  const dump = remoteAction('Dump', remoteWorkDir);
  const evidenceServer = path.join(EVIDENCE_RUN, destSubdir);
  fs.mkdirSync(evidenceServer, { recursive: true });
  writeJson(path.join(evidenceServer, 'dump-response.json'), { raw_stdout: dump.raw.stdout, raw_stderr: dump.raw.stderr, parsed: dump.parsed });
  if (!dump.parsed || dump.parsed.ok !== true) return { ok: false, reason: 'dump failed', parsed: dump.parsed, stderr: dump.raw.stderr };
  const localArtifacts = path.join(evidenceServer, 'artifacts.json');
  const down = scpFrom(dump.parsed.artifacts_path.replace(/\\/g, '/'), localArtifacts);
  if (down.status !== 0) return { ok: false, reason: 'scp artifacts failed', stderr: down.stderr };
  let artifacts = null;
  try { artifacts = JSON.parse(fs.readFileSync(localArtifacts, 'utf8')); } catch { artifacts = null; }
  if (artifacts) {
    if (typeof artifacts.stdout_log === 'string') fs.writeFileSync(path.join(evidenceServer, 'board-stdout.log'), artifacts.stdout_log, 'utf8');
    if (typeof artifacts.stderr_log === 'string') fs.writeFileSync(path.join(evidenceServer, 'board-stderr.log'), artifacts.stderr_log, 'utf8');
    const auditDir = path.join(evidenceServer, 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    for (const f of artifacts.audit_files ?? []) {
      if (typeof f?.content === 'string') fs.writeFileSync(path.join(auditDir, String(f.name).replace(/[^\w.-]/g, '_')), f.content, 'utf8');
    }
  }
  return { ok: true, artifacts_path: localArtifacts, audit_files: artifacts?.audit_files?.length ?? 0, repo_manifest: artifacts?.repo_manifest?.length ?? 0, artifacts };
}

let START_STATE = null;
let START_STATE_ALLOW = null;
let EVIDENCE_RUN = '';

async function main() {
  const runStart = isoNow();
  const runId = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + shortId();
  TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-verify-two-machine-'));
  EVIDENCE_RUN = path.join(CFG.evidenceRoot, 'run-' + runId);
  fs.mkdirSync(path.join(EVIDENCE_RUN, 'scenarios'), { recursive: true });
  fs.mkdirSync(path.join(EVIDENCE_RUN, 'events'), { recursive: true });
  fs.mkdirSync(path.join(EVIDENCE_RUN, 'client'), { recursive: true });
  const summary = {
    run_id: runId, role: 'master', started_at: runStart, finished_at: null,
    server_host: CFG.serverHost, evidence_run: EVIDENCE_RUN,
    scenarios: [], overall: 'FAIL', cleanup: {}, errors: [],
    phases: { phase1: { required: REQUIRED_PHASE1 }, phase2: { required: CFG.skipPhase2 ? [] : REQUIRED_PHASE2 } },
  };
  log('=== two-machine verification run ' + runId + ' ===');
  log('client=' + os.hostname() + ' server=' + CFG.serverHost + ' phase2=' + (!CFG.skipPhase2));

  let ctx = null;
  let fatal = null;
  try {
    const pre = await preflight(runId);
    ctx = {
      runId, info: pre.info, localHost: pre.localHost, identity: pre.identity,
      evidenceRun: EVIDENCE_RUN, remoteWorkDir: pre.info.paths.remote_workdir, remoteWorkDirAllow: pre.info.paths.remote_workdir_allow,
      tasks: {},
    };
    summary.env = pre.info;
    log('baseline equal=' + pre.info.baseline.equal + ' diffs=' + JSON.stringify(pre.info.baseline.diffs)
      + ' adopt_tool=' + pre.info.features.adopt_tool + ' adopt_route=' + pre.info.features.adopt_route + ' ps1_match=' + pre.info.baseline.ps1_match + ' worker_match=' + pre.info.baseline.worker_match);

    START_STATE = remoteStart(ctx.remoteWorkDir, { allowUnverified: false });
    ctx.board = makeBoard(START_STATE, await readTokenFromServer(START_STATE));
    useBoard(ctx.board);
    log('default board started on server: port=' + START_STATE.port + ' node_pid=' + START_STATE.node_pid + ' wrapper_pid=' + START_STATE.wrapper_pid + ' rule=' + START_STATE.rule_name);
    if (START_STATE.port === 13090) throw new Error('refusing to test against production port 13090');

    if (!CFG.skipPhase2) {
      START_STATE_ALLOW = remoteStart(ctx.remoteWorkDirAllow, { allowUnverified: true });
      ctx.boardAllow = makeBoard(START_STATE_ALLOW, await readTokenFromServer(START_STATE_ALLOW));
      log('allow-unverified board started on server: port=' + START_STATE_ALLOW.port + ' node_pid=' + START_STATE_ALLOW.node_pid + ' rule=' + START_STATE_ALLOW.rule_name);
    }

    // Real cross-machine reachability check before any scenario.
    const firstHealth = await waitFor(async () => {
      const h = await getJson('/health', { timeoutMs: 4000 });
      return h.status === 200 ? h : null;
    }, { timeoutMs: 20000, intervalMs: 500, label: 'cross-machine /health' });
    log('cross-machine /health reachable from ' + os.hostname() + ' -> ' + CFG.serverHost + ':' + START_STATE.port);
    writeJson(path.join(EVIDENCE_RUN, 'client', 'first-health.json'), firstHealth.json);

    const sc1 = makeScenario('1', 'phase1', 'cross-machine basic link (create/claim/blob-report/complete)');
    await scenarioBasic(sc1, ctx); finishScenario(sc1); summary.scenarios.push(sc1);
    log('scenario 1: ' + (sc1.pass ? 'PASS' : 'FAIL'));

    const sc2 = makeScenario('2', 'phase1', 'real process crash -> stale by expiry -> takeover');
    const crash = await scenarioCrashPhaseA(sc2, ctx);
    const sc3 = makeScenario('3', 'phase1', 'PID reuse rejected (HTTP 400 PID_REUSED)');
    await scenarioPidReuse(sc3, ctx, crash); finishScenario(sc3); summary.scenarios.push(sc3);
    log('scenario 3: ' + (sc3.pass ? 'PASS' : 'FAIL'));
    await scenarioCrashPhaseB(sc2, ctx, crash); finishScenario(sc2); summary.scenarios.push(sc2);
    log('scenario 2: ' + (sc2.pass ? 'PASS' : 'FAIL'));

    const sc4 = makeScenario('4', 'phase1', 'completion gate not relaxed');
    await scenarioGates(sc4, ctx); finishScenario(sc4); summary.scenarios.push(sc4);
    log('scenario 4: ' + (sc4.pass ? 'PASS' : 'FAIL'));

    if (!CFG.skipPhase2) {
      const sc5 = makeScenario('5', 'phase2', 'three-evidence adopt: same-machine verifiable');
      await scenarioAdoptSameHost(sc5, ctx); finishScenario(sc5); summary.scenarios.push(sc5);
      log('scenario 5: ' + (sc5.pass ? 'PASS' : 'FAIL'));

      const sc6 = makeScenario('6', 'phase2', 'three-evidence adopt: cross-machine default deny');
      await scenarioAdoptCrossMachineDeny(sc6, ctx); finishScenario(sc6); summary.scenarios.push(sc6);
      log('scenario 6: ' + (sc6.pass ? 'PASS' : 'FAIL'));

      const sc7 = makeScenario('7', 'phase2', 'three-evidence adopt: explicit allow unverified');
      await scenarioAdoptCrossMachineAllow(sc7, ctx); finishScenario(sc7); summary.scenarios.push(sc7);
      log('scenario 7: ' + (sc7.pass ? 'PASS' : 'FAIL'));

      const sc8 = makeScenario('8', 'phase2', 'three-evidence adopt: reject paths (not-stale/not-claimed/holder-alive)');
      await scenarioAdoptRejectPaths(sc8, ctx); finishScenario(sc8); summary.scenarios.push(sc8);
      log('scenario 8: ' + (sc8.pass ? 'PASS' : 'FAIL'));
    }

    // Final snapshots and server-side artifacts.
    useBoard(ctx.board);
    const health = await getJson('/health');
    writeJson(path.join(EVIDENCE_RUN, 'server', 'default', 'final-health.json'), health.json);
    const tasks = await getJson('/task/list?limit=100');
    writeJson(path.join(EVIDENCE_RUN, 'server', 'default', 'tasks-final.json'), tasks.json);
    const globalEvents = await getJson('/events?limit=100');
    writeJson(path.join(EVIDENCE_RUN, 'server', 'default', 'events-global.json'), globalEvents.json);
    const art1 = await collectArtifacts(ctx.remoteWorkDir, path.join('server', 'default'));
    summary.artifacts = { default: { ok: art1.ok, reason: art1.reason ?? null, audit_files: art1.audit_files ?? null, repo_manifest: art1.repo_manifest ?? null } };
    if (art1.artifacts?.state?.started_at) summary.board_started_at = art1.artifacts.state.started_at;
    if (!CFG.skipPhase2) {
      useBoard(ctx.boardAllow);
      const healthAllow = await getJson('/health');
      writeJson(path.join(EVIDENCE_RUN, 'server', 'allow', 'final-health.json'), healthAllow.json);
      const tasksAllow = await getJson('/task/list?limit=100');
      writeJson(path.join(EVIDENCE_RUN, 'server', 'allow', 'tasks-final.json'), tasksAllow.json);
      const eventsAllow = await getJson('/events?limit=100');
      writeJson(path.join(EVIDENCE_RUN, 'server', 'allow', 'events-global.json'), eventsAllow.json);
      const art2 = await collectArtifacts(ctx.remoteWorkDirAllow, path.join('server', 'allow'));
      summary.artifacts.allow = { ok: art2.ok, reason: art2.reason ?? null, audit_files: art2.audit_files ?? null, repo_manifest: art2.repo_manifest ?? null };
      useBoard(ctx.board);
    }
  } catch (err) {
    fatal = err;
    summary.errors.push(String(err?.stack ?? err));
    log('FATAL: ' + String(err?.message ?? err));
  } finally {
    // Kill remote holders first so their sessions/components are gone.
    for (const h of REMOTE_HOLDERS) { try { await killRemoteHolder(h); } catch { /* best effort */ } }
    // Kill local child worker processes.
    for (const pid of [...CHILDREN]) { try { if (pidAlive(pid)) hardKill(pid); } catch { /* best effort */ } }
    // Stop both boards and verify the endpoint is really unreachable afterwards.
    for (const [label, state, board] of [['default', START_STATE, ctx?.board], ['allow', START_STATE_ALLOW, ctx?.boardAllow]]) {
      if (!state) continue;
      const wd = label === 'default' ? ctx?.remoteWorkDir : ctx?.remoteWorkDirAllow;
      try {
        const stop = remoteAction('Stop', wd);
        summary.cleanup[label] = { stop: stop.parsed, stderr: stop.raw.stderr.slice(0, 2000) };
        log('remote stop (' + label + '): killed=' + JSON.stringify(stop.parsed?.killed) + ' port_closed=' + stop.parsed?.port_closed + ' rule_removed=' + stop.parsed?.rule_removed);
      } catch (e) {
        summary.cleanup[label] = { stop_error: String(e?.message ?? e) };
      }
      try {
        const status = remoteAction('Status', wd);
        summary.cleanup[label] = { ...(summary.cleanup[label] ?? {}), status_after_stop: status.parsed };
      } catch (e) { /* ignore */ }
      if (board) {
        useBoard(board);
        const after = await getJson('/health', { timeoutMs: 3000 });
        summary.cleanup[label].health_after_stop = { status: after.status, reachable: after.status !== 0 };
        log('post-stop reachability (' + label + '): status=' + after.status + ' (0/timeout = unreachable, good)');
      }
      try {
        const clean = remoteAction('Clean', wd);
        summary.cleanup[label].clean = clean.parsed;
      } catch (e) {
        summary.cleanup[label].clean = { error: String(e?.message ?? e) };
      }
    }
    fs.writeFileSync(path.join(EVIDENCE_RUN, 'http-trace.jsonl'), httpTrace.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    summary.finished_at = isoNow();
    const required = [...REQUIRED_PHASE1, ...(CFG.skipPhase2 ? [] : REQUIRED_PHASE2)]
      .map((id) => summary.scenarios.find((s) => s.id === id));
    summary.overall = (fatal === null && required.every((s) => s && s.pass === true)) ? 'PASS' : 'FAIL';
    writeJson(path.join(EVIDENCE_RUN, 'summary.json'), summary);
    writeJson(path.join(EVIDENCE_RUN, 'env.json'), summary.env ?? {});
    fs.writeFileSync(path.join(EVIDENCE_RUN, 'client', 'stdout.log'), consoleLines.join('\n') + '\n', 'utf8');
    fs.writeFileSync(path.join(EVIDENCE_RUN, 'exit-code.txt'), summary.overall === 'PASS' ? '0\n' : '1\n', 'utf8');
    try { fs.rmSync(TEMP_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }

    log('');
    log('=== summary ===');
    for (const s of summary.scenarios) {
      const failed = s.assertions.filter((a) => !a.ok);
      log('scenario ' + s.id + ' [' + s.phase + ']: ' + (s.pass ? 'PASS' : 'FAIL') + ' (' + (s.assertions.length - failed.length) + '/' + s.assertions.length + ' assertions)');
      for (const f of failed) log('  FAILED: ' + f.name + ' :: ' + (f.detail ?? ''));
    }
    log('overall: ' + summary.overall);
    log('evidence: ' + EVIDENCE_RUN);
    if (fatal) log('fatal: ' + String(fatal?.message ?? fatal));
    process.exitCode = summary.overall === 'PASS' ? 0 : 1;
  }
}

if (ROLE === 'master') {
  main().catch((err) => { console.error('unhandled:', err); process.exitCode = 2; });
} else {
  runWorker().catch((err) => { console.error('worker failed:', err); process.exitCode = 2; });
}

// Regression checks for the security containment patch.
// All servers in these tests run inside an ephemeral test checkout.
// Production data/db.json must never be copied into this test environment.
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
// Tests must never initialize or mutate the current checkout's data/db.json.
let ISOLATED_ROOT;
before(() => {
  ISOLATED_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'edu-security-test-'));
  fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(ISOLATED_ROOT, 'server.js'));
  fs.cpSync(path.join(ROOT, 'services'), path.join(ISOLATED_ROOT, 'services'), { recursive: true });
});
after(() => {
  if (ISOLATED_ROOT) fs.rmSync(ISOLATED_ROOT, { recursive: true, force: true });
});

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(err => err ? reject(err) : resolve(port));
    });
  });
}

function request(port, endpoint, method = 'GET', body = undefined) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: endpoint,
      method,
      timeout: 1500,
      headers: data ? { 'Content-Type': 'application/json' } : {}
    }, res => {
      let result = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { result += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: result }));
    });
    req.once('error', reject);
    req.once('timeout', () => req.destroy(new Error('HTTP request timed out')));
    if (data) req.write(data);
    req.end();
  });
}

function startServer(port, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv, PORT: String(port) };
  // Eliminate any externally set debug / network override flags.
  if (!Object.prototype.hasOwnProperty.call(extraEnv, 'ENABLE_DEBUG_ACTIONS')) delete env.ENABLE_DEBUG_ACTIONS;
  if (!Object.prototype.hasOwnProperty.call(extraEnv, 'ALLOW_INSECURE_NETWORK')) delete env.ALLOW_INSECURE_NETWORK;
  if (!Object.prototype.hasOwnProperty.call(extraEnv, 'HOST')) delete env.HOST;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ISOLATED_ROOT, env, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', d => { output += d.toString(); });
  child.stderr.on('data', d => { output += d.toString(); });
  return { child, getOutput: () => output };
}

async function waitForServer(port, child) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Server exited before becoming ready');
    try {
      const response = await request(port, '/api/status');
      if (response.status === 200) return;
    } catch (e) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw new Error('Server startup timed out');
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  await new Promise(resolve => {
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });
}

test('default server: health endpoint works but debug mutations are rejected', async () => {
  const port = await availablePort();
  const { child, getOutput } = startServer(port);
  try {
    await waitForServer(port, child);
    const response = await request(port, '/api/debug/action', 'POST', { action: 'reseed_database' });
    assert.equal(response.status, 403, getOutput());
  } finally {
    await stopServer(child);
  }
});

test('non-loopback bind is refused unless explicitly opted in', async () => {
  const port = await availablePort();
  const { child, getOutput } = startServer(port, { HOST: '0.0.0.0' });
  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Startup refusal timed out'));
    }, 7000);
    child.once('exit', code => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  assert.equal(exitCode, 1, getOutput());
  assert.match(getOutput(), /Refusing non-loopback bind/);
});

test('debug ping is available only with explicit local opt-in', async () => {
  const port = await availablePort();
  const { child, getOutput } = startServer(port, { ENABLE_DEBUG_ACTIONS: '1' });
  try {
    await waitForServer(port, child);
    // Safe no-op diagnostic only; never call reseed_database or mock_attendance_deduct here.
    const response = await request(port, '/api/debug/action', 'POST', { action: 'trigger_broadcast' });
    assert.equal(response.status, 200, getOutput());
  } finally {
    await stopServer(child);
  }
});


test('foreign browser origins cannot read the local database API', async () => {
  const port = await availablePort();
  const { child, getOutput } = startServer(port);
  try {
    await waitForServer(port, child);
    const foreignGet = await new Promise((resolve, reject) => {
      const req = http.get({
        hostname: '127.0.0.1', port, path: '/api/db/all',
        headers: { Origin: 'https://attacker.example' }
      }, res => { res.resume(); res.once('end', () => resolve(res)); });
      req.once('error', reject);
    });
    assert.equal(foreignGet.statusCode, 403, getOutput());
    assert.equal(foreignGet.headers['access-control-allow-origin'], undefined);

    const legitimateGet = await new Promise((resolve, reject) => {
      const req = http.get({
        hostname: '127.0.0.1', port, path: '/api/db/all',
        headers: { Origin: 'http://127.0.0.1:' + port }
      }, res => { res.resume(); res.once('end', () => resolve(res)); });
      req.once('error', reject);
    });
    assert.equal(legitimateGet.statusCode, 200, getOutput());
  } finally {
    await stopServer(child);
  }
});

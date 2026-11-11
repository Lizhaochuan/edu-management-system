'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

let root;
let child;
let port;
const PASSWORD = 'Test-Strong-Password-2026!';

async function reservePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const number = srv.address().port;
      srv.close(err => err ? reject(err) : resolve(number));
    });
  });
}
async function call(route, method = 'GET', payload, headers = {}) {
  const body = payload === undefined ? null : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: route, method,
      headers: { ...(body ? { 'Content-Type':'application/json' } : {}), ...headers },
      timeout: 2500
    }, res => {
      let received = '';
      res.on('data', chunk => { received += chunk; });
      res.on('end', () => {
        try { resolve({ status:res.statusCode, headers:res.headers, data:JSON.parse(received) }); }
        catch (_err) { resolve({ status:res.statusCode, headers:res.headers, data:received }); }
      });
    });
    req.once('error', reject);
    req.once('timeout', () => req.destroy(new Error('Request timed out')));
    if (body) req.write(body);
    req.end();
  });
}
function cookie(response) {
  return String(response.headers['set-cookie'][0]).split(';')[0];
}
async function signIn(userId, password = PASSWORD) {
  return call('/api/auth/login','POST',{ user_id:userId,password });
}
before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'edu-auth-test-'));
  const repo = path.resolve(__dirname, '..');
  fs.copyFileSync(path.join(repo, 'server.js'), path.join(root,'server.js'));
  fs.cpSync(path.join(repo,'services'), path.join(root,'services'), { recursive:true });
  fs.cpSync(path.join(repo,'web-admin'), path.join(root,'web-admin'), { recursive:true });
  process.env.AUTH_CREDENTIALS_FILE = path.join(root, 'data', 'auth-credentials.json');
  const db = require(path.join(root,'services','db.js'));
  db.initDatabase(true);
  const auth = require(path.join(root,'services','authService.js'));
  assert.throws(() => auth.saveCredential('u_sa1', 'weak'), /至少12/);
  auth.saveCredential('u_sa1',PASSWORD);
  auth.saveCredential('u_adm1',PASSWORD);
  auth.saveCredential('u_par1',PASSWORD);
  assert.equal(fs.statSync(process.env.AUTH_CREDENTIALS_FILE).mode & 0o777, 0o600);
  port = await reservePort();
  child = spawn(process.execPath, ['server.js'], {
    cwd:root,
    env:{ ...process.env, PORT:String(port), HOST:'127.0.0.1',
      AUTH_CREDENTIALS_FILE:process.env.AUTH_CREDENTIALS_FILE },
    stdio:'ignore'
  });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Test server exited during startup');
    try {
      if ((await call('/api/status')).status === 200) return;
    } catch (_err) { await new Promise(resolve => setTimeout(resolve,100)); }
  }
  throw new Error('Test server did not start');
});
after(async () => {
  if (child && child.exitCode === null) {
    await new Promise(resolve => {
      child.once('exit',resolve); child.kill('SIGTERM');
    });
  }
  delete process.env.AUTH_CREDENTIALS_FILE;
  if (root) fs.rmSync(root,{ recursive:true,force:true });
});
test('health does not disclose database metrics', async () => {
  const result = await call('/api/status');
  assert.equal(result.status,200);
  assert.equal(result.data.total_records,undefined);
  assert.equal(result.data.total_tables,undefined);
});
test('headers alone cannot impersonate super admin or access SSE', async () => {
  const headers = { 'X-User-Id':'u_sa1','X-User-Role':'super_admin' };
  assert.equal((await call('/api/db/all','GET',undefined,headers)).status,401);
  assert.equal((await call('/api/events','GET',undefined,headers)).status,401);
  assert.equal((await call('/api/approvals','GET',undefined,headers)).status,401);
});
test('wrong password rejected, valid login grants secure session', async () => {
  assert.equal((await signIn('u_sa1','wrong')).status,401);
  const response = await signIn('u_sa1');
  assert.equal(response.status,200);
  assert.equal(response.data.data.user.role,'super_admin');
  assert.match(response.headers['set-cookie'][0],/HttpOnly/);
  assert.match(response.headers['set-cookie'][0],/SameSite=Strict/);
  const session = cookie(response);
  assert.equal((await call('/api/auth/me','GET',undefined,{Cookie:session})).status,200);
  assert.equal((await call('/api/db/all','GET',undefined,{Cookie:session})).status,200);
  assert.equal((await call('/api/db/all','GET',undefined,
    {Authorization:'Bearer '+response.data.data.token})).status,200);
  assert.equal((await call('/api/auth/logout','POST',{}, {Cookie:session})).status,200);
  assert.equal((await call('/api/db/all','GET',undefined,{Cookie:session})).status,401);
});
test('admin role cannot access salary reports or generic database export', async () => {
  const response = await signIn('u_adm1');
  assert.equal(response.status,200);
  const headers = { Cookie:cookie(response), 'X-User-Role':'super_admin' };
  assert.equal((await call('/api/salary/report','GET',undefined,headers)).status,403);
  assert.equal((await call('/api/db/all','GET',undefined,headers)).status,403);
  assert.equal((await call('/api/approvals','GET',undefined,headers)).status,200);
});
test('parent cannot read other students or privileged routes', async () => {
  const response = await signIn('u_par1');
  assert.equal(response.status,200);
  const headers = { Cookie:cookie(response), 'X-User-Role':'super_admin' };
  assert.equal((await call('/api/db/students','GET',undefined,headers)).status,403);
  assert.equal((await call('/api/finance/purchase','POST',{},headers)).status,403);
});
test('legacy arbitrary database mutate is blocked even for super admin', async () => {
  const response = await signIn('u_sa1');
  const headers = { Cookie:cookie(response) };
  assert.equal((await call('/api/db/mutate','POST',{
    action:'REMOVE',table:'users',id:'u_sa1'
  },headers)).status,403);
  assert.equal((await call('/api/auth/me','GET',undefined,headers)).status,200);
});
test('foreign origin rejected before authentication', async () => {
  const response = await signIn('u_sa1');
  assert.equal((await call('/api/db/all','GET',undefined,{
    Cookie:cookie(response), Origin:'https://attacker.example'
  })).status,403);
});

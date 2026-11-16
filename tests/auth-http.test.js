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
  fs.mkdirSync(path.join(root,'web-admin2'));
  fs.writeFileSync(path.join(root,'web-admin2','secret.txt'),'DO_NOT_EXPOSE');
  process.env.AUTH_CREDENTIALS_FILE = path.join(root, 'data', 'auth-credentials.json');
  const db = require(path.join(root,'services','db.js'));
  db.initDatabase(true);
  const auth = require(path.join(root,'services','authService.js'));
  assert.throws(() => auth.saveCredential('u_sa1', 'weak'), /至少12/);
  auth.saveCredential('u_sa1',PASSWORD);
  auth.saveCredential('u_adm1',PASSWORD);
  auth.saveCredential('u_par1',PASSWORD);
  auth.saveCredential('u_tch2',PASSWORD);
  auth.saveCredential('u_tch1',PASSWORD);
  const schedule=db.getById(db.TABLES.SCHEDULES_AND_ATTENDANCE,'sch_2');
  for(const [id,patch] of [
    ['teacher-substitute',{teacher_id:'u_tch2',substitute_teacher_id:'u_tch1'}],
    ['teacher-covering',{teacher_id:'u_tch1',substitute_teacher_id:'u_tch2'}],
    ['teacher-fallback',{teacher_id:null,substitute_teacher_id:null}],
    ['teacher-missing-class',{teacher_id:'u_tch2',class_id:'no-class',course_id:'no-course',status:'unknown_technical_status'}]
  ])db.insert(db.TABLES.SCHEDULES_AND_ATTENDANCE,{...schedule,...patch,id,
    internal_secret:'NEVER_SHOW_PRIVATE_DATA',snapshot_teacher_rates_json:{1:987654}},'隔离教师课表测试');
  assert.equal(fs.statSync(process.env.AUTH_CREDENTIALS_FILE).mode & 0o777, 0o600);
  db.insert(db.TABLES.APPROVAL_REQUESTS, {
    id:'atomic_bad_approval', request_type:'config_change',
    status:'pending', proposer_id:'u_adm1', proposer_name:'教务管理员',
    target_table:db.TABLES.TEACHER_TIERS, target_record_id:'missing-tied-id',
    after_data_json:{name:'不应生效'}, reason:'隔离测试'
  }, '创建测试失败审批单');
  db.insert(db.TABLES.APPROVAL_REQUESTS, {
    id:'atomic_good_approval', request_type:'config_change',
    status:'pending', proposer_id:'u_adm1', proposer_name:'教务管理员',
    target_table:db.TABLES.TEACHER_TIERS, target_record_id:'tier_junior',
    after_data_json:{name:'审批修改后的名称'}, reason:'隔离测试'
  }, '创建测试有效审批单');
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

test('missing static requests fall back without crashing subsequent page and API requests',async()=>{
 for(const route of ['/missing-client-route','/favicon.ico','/login.html','/api/status']) {
  const response=await call(route);
  assert.equal(response.status,200,route);
 }
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
  const snapshot = await call('/api/db/all','GET',undefined,headers);
  assert.equal(snapshot.status,200);
  assert.deepEqual(snapshot.data.data.audit_logs, []);
  assert.deepEqual(snapshot.data.data.teacher_lesson_fees, []);
  assert.equal((await call('/api/logs','GET',undefined,headers)).status,403);
  assert.equal((await call('/api/db/approval_requests','GET',undefined,headers)).status,403);
  assert.equal(snapshot.data.data.approval_requests.some(a => a.request_type !== 'freeze_hours' && a.proposer_id !== 'u_adm1'),false);
  const list = await call('/api/approvals','GET',undefined,headers);
  assert.equal(list.status,200);
  assert.equal(list.data.data.some(a => a.request_type !== 'freeze_hours' && a.proposer_id !== 'u_adm1'),false);
});
test('parent cannot read other students or privileged routes', async () => {
  const response = await signIn('u_par1');
  assert.equal(response.status,200);
  const headers = { Cookie:cookie(response), 'X-User-Role':'super_admin' };
  assert.equal((await call('/api/db/students','GET',undefined,headers)).status,403);
  assert.equal((await call('/api/finance/purchase','POST',{},headers)).status,403);
});
test('BUG-13-12-01: teacher mini-program login remains valid but cannot access Web management data',async()=>{
  const response=await signIn('u_tch2');
  assert.equal(response.status,200);
  const headers={Cookie:cookie(response)};
  assert.equal(response.data.data.user.role,'teacher');
  assert.equal((await call('/api/logs','GET',undefined,headers)).status,403);
  assert.equal((await call('/api/approvals','GET',undefined,headers)).status,403);
  assert.equal((await call('/api/auth/logout','POST',{},headers)).status,200);
  assert.equal((await call('/api/auth/me','GET',undefined,headers)).status,401);
});
test('teacher Web API scopes Cookie and Bearer reads to self, including substitute and class fallback',async()=>{
  const login=await signIn('u_tch2');
  for(const headers of [{Cookie:cookie(login),'X-User-Id':'u_tch1','X-User-Role':'super_admin'},
    {Authorization:'Bearer '+login.data.data.token}]) {
    const response=await call('/api/teacher/schedules?teacher_id=u_tch1&user_id=u_tch1','GET',undefined,headers);
    assert.equal(response.status,200);
    assert.equal(response.headers['cache-control'],'no-store');
    const list=response.data.data.schedules;
    assert.deepEqual(list.map(s=>s.id).sort(),['sch_2','teacher-covering','teacher-fallback','teacher-missing-class']);
    assert.equal(list.find(s=>s.id==='teacher-covering').assignmentText,'代课');
    assert.equal(list.find(s=>s.id==='teacher-missing-class').statusText,'状态待核对');
    assert.equal(list.find(s=>s.id==='teacher-missing-class').className,'班级名称待核对');
    assert.doesNotMatch(JSON.stringify(response.data),/NEVER_SHOW|987654|calculated_teacher_fee|attendees_json|student_id|package_id|snapshot_teacher_rates_json/);
  }
  const other=await signIn('u_tch1');
  const list=await call('/api/teacher/schedules','GET',undefined,{Cookie:cookie(other)});
  assert.deepEqual(list.data.data.schedules.map(s=>s.id).sort(),['sch_1','teacher-substitute']);
});
test('teacher Web API rejects missing sessions, other roles, writes and direct record probes',async()=>{
  assert.equal((await call('/api/teacher/schedules')).status,401);
  for(const id of ['u_par1','u_adm1','u_sa1']) {
    const login=await signIn(id);
    assert.equal((await call('/api/teacher/schedules','GET',undefined,{Cookie:cookie(login)})).status,403);
  }
  const login=await signIn('u_tch2');const headers={Cookie:cookie(login),Connection:'close'};
  for(const method of ['POST','PUT','DELETE'])assert.equal((await call('/api/teacher/schedules',method,{},headers)).status,403);
  assert.equal((await call('/api/teacher/schedules/sch_1','GET',undefined,headers)).status,403);
  assert.equal((await call('/api/inspector/schedules','GET',undefined,headers)).status,403);
  assert.equal((await call('/api/salary/report','GET',undefined,headers)).status,403);
  assert.equal((await call('/api/db/all','GET',undefined,headers)).status,403);
  assert.equal((await call('/api/payments/reconciliation','GET',undefined,headers)).status,403);
  assert.equal((await call('/api/academic/class/create','POST',{},headers)).status,403);
  await call('/api/auth/logout','POST',{},headers);
  assert.equal((await call('/api/teacher/schedules','GET',undefined,headers)).status,401);
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

test('failed approval business logic keeps pending status and can be retried safely', async () => {
  const login = await signIn('u_sa1');
  const headers = { Cookie:cookie(login) };
  const first = await callApproval('approval.approve',{approval_id:'atomic_bad_approval'},headers);
  assert.equal(first.status,400,JSON.stringify(first.data));
  const result = await call('/api/approvals','GET',undefined,headers);
  const item = result.data.data.find(a => a.id === 'atomic_bad_approval');
  assert.equal(item.status,'pending');
  const second = await callApproval('approval.approve',{approval_id:'atomic_bad_approval'},headers);
  assert.equal(second.status,400);
});
test('successful approval is applied once; duplicate approve/reject are rejected', async () => {
  const login = await signIn('u_sa1');
  const headers = { Cookie:cookie(login) };
  const first = await callApproval('approval.approve',{approval_id:'atomic_good_approval'},headers);
  assert.equal(first.status,200,JSON.stringify(first.data));
  const items = await call('/api/db/teacher_tiers','GET',undefined,headers);
  assert.equal(items.data.data.find(t => t.id === 'tier_junior').name,'审批修改后的名称');
  const logs=await call('/api/logs?keyword=atomic_good_approval','GET',undefined,headers);
  const log=logs.data.data.list.find(item=>item.description.includes('参数生效覆盖至'));
  assert.ok(log,'actual approval should produce the reported audit description');
  assert.match(log.description,/\[teacher_tiers\]/,'stored audit evidence remains unchanged');
  const {readableAuditDescription}=require('../web-admin/js/business-display');
  assert.match(readableAuditDescription(log.description),/参数生效覆盖至 \[教师课酬档位\]/);
  const repeated = await callApproval('approval.approve',{approval_id:'atomic_good_approval'},headers);
  assert.equal(repeated.status,409);
  const reverse = await callApproval('approval.reject',{approval_id:'atomic_good_approval'},headers);
  assert.equal(reverse.status,409);
});

test('static web file server refuses encoded traversal into prefix-matching sibling', async () => {
  const inside = await call('/login.html');
  assert.equal(inside.status,200);
  const outside = await call('/..%2Fweb-admin2/secret.txt');
  assert.equal(outside.status,403);
  assert.doesNotMatch(JSON.stringify(outside.data),/DO_NOT_EXPOSE/);
});

async function callApproval(command, params, headers) {
  if (command === 'approval.reject' && !params.reject_reason) params={...params,reject_reason:'test rejection'};
  const version=await call('/api/commands/version','GET',undefined,headers);
  return call('/api/commands/execute','POST',{command,params,idempotencyKey:'approval_test_'+require('node:crypto').randomUUID(),expectedVersion:version.data.data.version},headers);
}

async function commandSession(userId = 'u_sa1') {
  const login = await signIn(userId);
  return { Authorization: 'Bearer ' + login.data.data.token };
}
async function commandEnvelope(headers, key = 'http-command-00000001') {
  const response = await call('/api/commands/version', 'GET', undefined, headers);
  assert.equal(response.status, 200);
  return { command: 'system.writeProbe', params: { label: 'http_probe' },
    idempotencyKey: key, expectedVersion: response.data.data.version };
}

test('command endpoint authenticates both Cookie and Bearer, rejects forged roles and operation escalation', async () => {
  assert.equal((await call('/api/commands/version')).status, 401);
  assert.equal((await call('/api/commands/execute', 'POST', {},
    { 'X-User-Role': 'super_admin', 'X-User-Id': 'u_sa1' })).status, 401);
  const admin = await commandSession('u_adm1');
  const p = await commandEnvelope(admin);
  assert.equal((await call('/api/commands/execute', 'POST', p,
    { ...admin, 'X-User-Role': 'super_admin' })).status, 403);
  const parent = await commandSession('u_par1');
  assert.equal((await call('/api/commands/version', 'GET', undefined, parent)).status, 403);
  const login = await signIn('u_sa1');
  const headers = { Cookie: cookie(login) };
  const envelope = await commandEnvelope(headers, 'http-cookie-00000001');
  assert.equal((await call('/api/commands/execute', 'POST', envelope, headers)).status, 200);
  assert.equal((await call('/api/commands/execute', 'GET', undefined, headers)).status, 403);
});

test('concurrent distinct commands at one version have exactly one winner and one conflict', async () => {
  const headers = await commandSession();
  const p = await commandEnvelope(headers, 'http-race-0000000001');
  const snapshot = await call('/api/db/all', 'GET', undefined, headers);
  const results = await Promise.all([
    call('/api/commands/execute', 'POST', p, headers),
    call('/api/commands/execute', 'POST', { ...p, idempotencyKey: 'http-race-0000000002' }, headers)
  ]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal(results.find(r => r.status === 409).data.code, 'VERSION_CONFLICT');
  const latest = await commandEnvelope(headers);
  assert.equal(latest.expectedVersion, p.expectedVersion + 1);
  const after = await call('/api/db/all', 'GET', undefined, headers);
  assert.deepEqual(after.data.data, snapshot.data.data);
  assert.equal(after.data.data.__server_write_state, undefined);
});

test('concurrent duplicate HTTP submissions produce one durable receipt and stable responses', async () => {
  const headers = await commandSession();
  const p = await commandEnvelope(headers, 'http-duplicate-00001');
  const results = await Promise.all(Array.from({ length: 8 }, () =>
    call('/api/commands/execute', 'POST', p, headers)));
  assert.ok(results.every(r => r.status === 200));
  assert.equal(results.filter(r => !r.data.data.replayed).length, 1);
  assert.ok(results.every(r => r.data.data.version === p.expectedVersion + 1));
  assert.ok(results.every(r => r.data.data.result.label === 'http_probe'));
  const conflict = await call('/api/commands/execute', 'POST',
    { ...p, params: { label: 'changed' } }, headers);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.code, 'IDEMPOTENCY_CONFLICT');
});

function rawCommand(body, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port,
      path: '/api/commands/execute', method: 'POST', headers }, res => {
      let result = '';
      res.on('data', c => { result += c; });
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(result) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('command HTTP parser rejects malformed, oversized and extra-identity payloads without changing version', async () => {
  const headers = await commandSession();
  const p = await commandEnvelope(headers, 'http-invalid-0000001');
  assert.equal((await rawCommand('{broken', headers)).status, 400);
  assert.equal((await rawCommand('x'.repeat(17 * 1024), headers)).status, 413);
  assert.equal((await call('/api/commands/execute', 'POST', { ...p, role: 'super_admin' }, headers)).status, 400);
  assert.equal((await call('/api/commands/execute', 'POST', { ...p,
    params: { table: 'users', id: 'u_sa1', patch: { role: 'admin' } } }, headers)).status, 400);
  assert.equal((await commandEnvelope(headers)).expectedVersion, p.expectedVersion);
});

test('logout while command body is in flight prevents execution after earlier route authentication', async () => {
  const headers = await commandSession();
  const p = await commandEnvelope(headers, 'http-revoked-0000001');
  const body = JSON.stringify(p);
  const response = new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port,
      path: '/api/commands/execute', method: 'POST', headers: {
        ...headers, 'Content-Length': Buffer.byteLength(body), Expect: '100-continue'
      } }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.on('continue', async () => {
      try {
        req.write(body.slice(0, 1));
        assert.equal((await call('/api/auth/logout', 'POST', {}, headers)).status, 200);
        req.end(body.slice(1));
      } catch (error) { req.destroy(); reject(error); }
    });
    req.flushHeaders();
  });
  assert.equal(await response, 401);
});

test('teacher context is scoped and a concurrent real sign-in only deducts once', async () => {
  const headers = await commandSession('u_tch2');
  const context = await call('/api/commands/context','GET',undefined,headers);
  assert.equal(context.status,200);
  assert.deepEqual(context.data.data.snapshot.schedules_and_attendance.map(s=>s.id).sort(),
    ['sch_2','teacher-covering','teacher-fallback','teacher-missing-class']);
  assert.deepEqual(context.data.data.snapshot.course_packages,[]);
  assert.deepEqual(context.data.data.snapshot.audit_logs,[]);
  assert.equal(context.data.data.snapshot.schedules_and_attendance[0].snapshot_teacher_rates_json,undefined);
  const params={schedule_id:'sch_2',attendance_inputs:[{student_id:'stu_3',is_present:true},{student_id:'stu_4',is_present:false}]};
  const p={command:'attendance.submit',params,idempotencyKey:'http-real-attendance-01',expectedVersion:context.data.data.version};
  const results=await Promise.all([call('/api/commands/execute','POST',p,headers),call('/api/commands/execute','POST',{...p,idempotencyKey:'http-real-attendance-02'},headers)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  const response=results.find(r=>r.status===200);
  assert.equal(response.data.data.result.calculated_teacher_fee,undefined);
  const admin=await commandSession();
  const snapshot=await call('/api/db/all','GET',undefined,admin);
  assert.equal(snapshot.data.data.course_packages.find(p=>p.id==='pkg_3').paid_hours_left,19);
  assert.equal((await call('/api/finance/purchase','POST',{},admin)).status,428);
  assert.equal((await call('/api/approvals/approve','POST',{},admin)).status,428);
});

test('committed command notifies Web once; Web cookie and native Bearer read the same committed state',async()=>{
 const login=await signIn('u_sa1');
 const bearer={Authorization:'Bearer '+login.data.data.token};
 const web={Cookie:cookie(login)};
 const events=[];
 let stream,request;
 await new Promise((resolve,reject)=>{
  request=http.get({hostname:'127.0.0.1',port,path:'/api/events',headers:web},res=>{
   stream=res;let buffer='';res.on('data',chunk=>{
    buffer+=chunk;let end;
    while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);if(frame.startsWith('event: version')){events.push(JSON.parse(frame.split('data: ')[1]).data);resolve();}}
   });
  });request.on('error',reject);
 });
 try {
  const p=await commandEnvelope(bearer,'sync-notification-00001');
  const result=await call('/api/commands/execute','POST',p,bearer);
  assert.equal(result.status,200);
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(events.length,2);
  assert.deepEqual(events[1],{version:result.data.data.version});
  assert.equal((await call('/api/commands/execute','POST',p,bearer)).data.data.replayed,true);
  assert.equal((await call('/api/commands/execute','POST',{...p,command:'unknown'},bearer)).status,400);
  await new Promise(resolve=>setTimeout(resolve,50));assert.equal(events.length,2);
  const [native, browser]=await Promise.all([call('/api/commands/context','GET',undefined,bearer),call('/api/commands/context','GET',undefined,web)]);
  assert.deepEqual(native.data.data,browser.data.data);
  assert.equal(native.data.data.version,events[1].version);
  const ended=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('revoked SSE stayed open')),2000);stream.once('end',()=>{clearTimeout(timer);resolve()})});
  await call('/api/auth/logout','POST',{},web);
  const replacement=await commandSession();const next=await commandEnvelope(replacement,'sync-notification-00002');
  await call('/api/commands/execute','POST',next,replacement);
  await ended;
 } finally {request.destroy();if(stream)stream.destroy();}
});


test('legacy opt-in cannot mutate user records, including super-admin deletion', async () => {
  const oldPort = port;
  const testPort = await reservePort();
  const legacy = spawn(process.execPath, ['server.js'], {cwd:root, env:{...process.env,PORT:String(testPort),HOST:'127.0.0.1',AUTH_CREDENTIALS_FILE:process.env.AUTH_CREDENTIALS_FILE,ALLOW_LEGACY_MUTATION_SYNC:'1'},stdio:'ignore'});
  port=testPort;
  try {
    let login;
    for (let n=0;n<40;n++) { try { login=await signIn('u_sa1'); break; } catch (_e) { await new Promise(r=>setTimeout(r,50)); } }
    assert.equal(login.status,200);
    const headers={Cookie:cookie(login)};
    for (const payload of [
      {action:'REMOVE',table:'users',id:'u_sa2'},
      {action:'UPDATE',table:'users',id:'u_sa2',patch:{role:'admin'}},
      {action:'INSERT',table:'users',record:{id:'forged',role:'super_admin',status:'active'}}
    ]) assert.equal((await call('/api/db/mutate','POST',payload,headers)).status,403);
  } finally { port=oldPort; legacy.kill(); }
});


test('unsafe legacy rollover and salary write routes fail closed without database or version changes', async () => {
  const superAdmin = await commandSession('u_sa1');
  const administrator = await commandSession('u_adm1');
  const teacher = await commandSession('u_tch2');
  const beforeVersion = await call('/api/commands/version','GET',undefined,superAdmin);
  const beforeDatabase = await call('/api/db/all','GET',undefined,superAdmin);
  assert.equal(beforeVersion.status,200);
  assert.equal(beforeDatabase.status,200);

  const legacy = [
    {route:'/api/finance/rollover',payload:{term_id:'term_1',new_expire_date:'2027-04-01'}},
    {route:'/api/salary/settle',payload:{settlement_id:'salary_test'}},
    {route:'/api/salary/generate-settlement',payload:{teacher_id:'u_tch2',period:'2026-03'}}
  ];
  for (const item of legacy) {
    const response=await call(item.route,'POST',item.payload,superAdmin);
    assert.equal(response.status,428,item.route);
    assert.equal(response.data.code,'COMMAND_REQUIRED');
    assert.match(response.data.message,/旧财务写入接口已停用/);
    assert.equal((await call(item.route,'POST',item.payload,teacher)).status,403);
    assert.equal((await call(item.route,'POST',item.payload)).status,401);
  }
  assert.equal((await call('/api/finance/rollover','POST',legacy[0].payload,administrator)).status,428);
  assert.equal((await call('/api/salary/settle','POST',legacy[1].payload,administrator)).status,403);
  assert.equal((await call('/api/salary/generate-settlement','POST',legacy[2].payload,administrator)).status,403);

  const afterVersion=await call('/api/commands/version','GET',undefined,superAdmin);
  const afterDatabase=await call('/api/db/all','GET',undefined,superAdmin);
  assert.equal(afterVersion.status,200);
  assert.equal(afterVersion.data.data.version,beforeVersion.data.data.version);
  assert.deepEqual(afterDatabase.data.data,beforeDatabase.data.data);
  // Non-mutating salary reporting remains accessible to the authorized role.
  assert.equal((await call('/api/salary/report','GET',undefined,superAdmin)).status,200);
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');

async function freePort() {
  return new Promise((resolve,reject)=>{
    const server=net.createServer();
    server.once('error',reject);
    server.listen(0,'127.0.0.1',()=>{
      const port=server.address().port;
      server.close(error=>error?reject(error):resolve(port));
    });
  });
}
async function request(port,route,method='GET',payload,token) {
  return new Promise((resolve,reject)=>{
    const body=payload===undefined?undefined:JSON.stringify(payload);
    const r=http.request({host:'127.0.0.1',port,path:route,method,
      headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(token?{Authorization:'Bearer '+token}:{})},
      timeout:2000},response=>{
      const fragments=[];
      response.on('data',chunk=>fragments.push(chunk));
      response.on('end',()=>{
        let data;
        try {data=JSON.parse(Buffer.concat(fragments).toString('utf8'));} catch(_) {data=null;}
        resolve({status:response.statusCode,data});
      });
    });
    r.once('error',reject);
    r.once('timeout',()=>r.destroy(new Error('HTTP timeout')));
    if(body!==undefined)r.write(body);
    r.end();
  });
}
async function withServer(testFn) {
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'edu-payment-http-'));
  const root=path.resolve(__dirname,'..');
  fs.cpSync(path.join(root,'services'),path.join(folder,'services'),{recursive:true});
  fs.copyFileSync(path.join(root,'server.js'),path.join(folder,'server.js'));
  const dbfile=path.join(folder,'data','db.json');
  const creds=path.join(folder,'data','credentials.json');
  const oldDB=process.env.DB_FILE,oldAuth=process.env.AUTH_CREDENTIALS_FILE;
  process.env.DB_FILE=dbfile;
  process.env.AUTH_CREDENTIALS_FILE=creds;
  let child;
  try {
    const db=require(path.join(folder,'services','db.js'));
    const auth=require(path.join(folder,'services','authService.js'));
    db.initDatabase(true);
    for(const user of ['u_sa1','u_sa2','u_adm1','u_adm2','u_tch1'])
      auth.saveCredential(user,'Test-Private-Payment-Password-2026!');
    const port=await freePort();
    child=spawn(process.execPath,['server.js'],{cwd:folder,env:{
      ...process.env,DB_FILE:dbfile,AUTH_CREDENTIALS_FILE:creds,
      HOST:'127.0.0.1',PORT:String(port),REQUIRE_RECONCILED_PAYMENTS:'1'
    },stdio:'ignore'});
    const until=Date.now()+8000;
    let started=false;
    while(Date.now()<until) {
      if(child.exitCode!==null)throw new Error('server exited during setup');
      try { if((await request(port,'/api/status')).status===200){started=true;break;} }
      catch(_) { await new Promise(r=>setTimeout(r,60)); }
    }
    assert.equal(started,true,'test server did not start');
    const login=async id=>{
      const res=await request(port,'/api/auth/login','POST',{
        user_id:id,password:'Test-Private-Payment-Password-2026!'
      });
      assert.equal(res.status,200);
      return res.data.data.token;
    };
    const tokens={};
    for(const id of ['u_sa1','u_sa2','u_adm1','u_adm2','u_tch1'])
      tokens[id]=await login(id);
    const call=async (id,command,params)=>{
      const version=await request(port,'/api/commands/version','GET',undefined,tokens[id]);
      assert.equal(version.status,200);
      const result=await request(port,'/api/commands/execute','POST',{
        command,params,idempotencyKey:'payment-ux-'+crypto.randomUUID(),
        expectedVersion:version.data.data.version
      },tokens[id]);
      return result;
    };
    await testFn({port,tokens,call,request:(route,id)=>request(port,route,'GET',undefined,tokens[id])});
  } finally {
    if(child && child.exitCode===null)await new Promise(resolve=>{
      child.once('exit',resolve);child.kill('SIGTERM');
    });
    if(oldDB===undefined)delete process.env.DB_FILE;else process.env.DB_FILE=oldDB;
    if(oldAuth===undefined)delete process.env.AUTH_CREDENTIALS_FILE;else process.env.AUTH_CREDENTIALS_FILE=oldAuth;
    fs.rmSync(folder,{recursive:true,force:true});
  }
}

test('payment list is authenticated, role-scoped and does not leak raw reconciliation ledger',async()=>{
  await withServer(async({port,tokens,call,request:read})=>{
    assert.equal((await request(port,'/api/payments/reconciliation')).status,401);
    assert.equal((await read('/api/payments/reconciliation','u_tch1')).status,403);
    assert.equal((await read('/api/payments/reconciliation','u_sa1')).data.data.strict_mode,true);
    const base={student_id:'stu_1',course_id:'crs_1',amount:1800,account_destination:'进入公账'};
    assert.equal((await call('u_adm1','payment.submit',{...base,payment_reference:'ui-http-001'})).status,200);
    assert.equal((await call('u_adm2','payment.submit',{...base,payment_reference:'ui-http-002'})).status,200);
    const admin=await read('/api/payments/reconciliation','u_adm1');
    assert.equal(admin.status,200);
    assert.equal(admin.data.data.items.length,1);
    assert.equal(admin.data.data.items[0].payment_reference,'ui-http-001');
    assert.equal(Object.hasOwn(admin.data.data.items[0],'statement_reference'),false);
    assert.equal(Object.hasOwn(admin.data.data.items[0],'raw_snapshot'),false);
    const superView=await read('/api/payments/reconciliation','u_sa1');
    assert.equal(superView.data.data.items.length,2);
    assert.equal((await read('/api/payments/reconciliation?status=__proto__','u_sa1')).status,400);
    assert.equal((await read('/api/payments/reconciliation?status=pending','u_sa1')).data.data.items.length,2);
    const confirmed=await call('u_sa1','payment.confirm',{
      payment_reference:'ui-http-001',statement_reference:'bank-statement-ui-001'
    });
    assert.equal(confirmed.status,200);
    const adminConfirmed=await read('/api/payments/reconciliation','u_adm1');
    assert.equal(adminConfirmed.data.data.items[0].status,'confirmed');
    assert.equal(Object.hasOwn(adminConfirmed.data.data.items[0],'statement_reference'),false);
    const superConfirmed=await read('/api/payments/reconciliation?status=confirmed','u_sa2');
    assert.equal(superConfirmed.data.data.items.length,1);
    assert.equal(superConfirmed.data.data.items[0].statement_reference,'bank-statement-ui-001');
  });
});


test('general admin snapshots never bypass receipt redaction through context or full DB export',async()=>{
  await withServer(async({tokens,call,request:read})=>{
    const base={student_id:'stu_1',course_id:'crs_1',amount:1800,account_destination:'进入公账'};
    assert.equal((await call('u_adm2','payment.submit',{...base,payment_reference:'private-admin-two'})).status,200);
    assert.equal((await call('u_sa1','payment.confirm',{
      payment_reference:'private-admin-two',statement_reference:'private-bank-line-2026'
    })).status,200);

    for(const endpoint of ['/api/commands/context','/api/db/all']) {
      const admin=await read(endpoint,'u_adm1');
      assert.equal(admin.status,200,endpoint);
      const data=endpoint==='/api/commands/context'?admin.data.data.snapshot:admin.data.data;
      assert.deepEqual(data.business_write_events,[],endpoint+' leaks internal receipts');
      assert.equal(JSON.stringify(data).includes('private-bank-line-2026'),false);
      assert.equal(JSON.stringify(data).includes('private-admin-two'),false);

      const superAdmin=await read(endpoint,'u_sa1');
      assert.equal(superAdmin.status,200,endpoint);
      const full=endpoint==='/api/commands/context'?superAdmin.data.data.snapshot:superAdmin.data.data;
      assert.equal(full.business_write_events.some(row=>
        row.kind==='payment_receipt' && row.statement_reference==='private-bank-line-2026'),true,
        'Authorized super admin must still have access to detailed ledger');
    }

    const ownList=await read('/api/payments/reconciliation','u_adm2');
    assert.equal(ownList.status,200);
    assert.equal(ownList.data.data.items.length,1);
    assert.equal(ownList.data.data.items[0].payment_reference,'private-admin-two');
    assert.equal(Object.hasOwn(ownList.data.data.items[0],'statement_reference'),false);
    assert.equal((await read('/api/db/all','u_tch1')).status,403);
  });
});

'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname,'../services/commandClient.js'),'utf8');
const webSource = fs.readFileSync(path.resolve(__dirname,'../web-admin/js/api.js'),'utf8');

test('native client never optimistically writes balances; uncertain response survives restart with original key',async()=>{
  const storage=new Map([['auth_token','token1']]);
  let loseResponse=true;
  let version=10;
  const seen=new Set();
  const envelopes=[];
  const api={SERVER_API_BASE:'http://test'};
  const load=()=>{
    const module={exports:{}};
    const wx={getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,v),removeStorageSync:k=>storage.delete(k),showToast:()=>{},request(options){
      queueMicrotask(()=>{
        if(options.url.endsWith('/context')) options.success({statusCode:200,data:{code:0,data:{user_id:'u_sa1',version,snapshot:{course_packages:[{hours:seen.size ? 9:10}]}}}});
        else {
          envelopes.push(options.data);
          if(!seen.has(options.data.idempotencyKey)){seen.add(options.data.idempotencyKey);version++;}
          if(loseResponse){loseResponse=false;options.fail();}
          else options.success({statusCode:200,data:{code:0,data:{result:{accepted:true},version,replayed:true}}});
        }
      });
    }};
    vm.runInNewContext(source,{require:()=>api,module,wx,Map,Promise,Date,Math});
    return module.exports;
  };
  let client=load();
  await client.refresh();
  await assert.rejects(client.run('package.purchase',{payment_reference:'p1'}),/网络/);
  assert.equal(storage.get('course_packages')[0].hours,10);
  const saved=storage.get('pending_business_command_u_sa1');
  client=load();storage.set('auth_token','new-login-token');
  await assert.rejects(client.run('package.purchase',{payment_reference:'different'}),/未确认/);
  const result=await client.run('package.purchase',{payment_reference:'p1'});
  assert.equal(result.accepted,true);
  assert.equal(envelopes[1].idempotencyKey,saved.envelope.idempotencyKey);
  assert.equal(envelopes[1].expectedVersion,10);
  assert.equal(seen.size,1);
  assert.equal(storage.get('course_packages')[0].hours,9);
  assert.equal(storage.has('pending_business_command_u_sa1'),false);
});

test('web client preserves exact envelope after response loss and blocks another financial action',async()=>{
  const storage=new Map();
  const window={location:{origin:'http://test'}};
  const envelopes=[];
  let fail=true;
  const fetch=async(url,options={})=>{
    if(url.endsWith('/context'))return {ok:true,json:async()=>({code:0,data:{version:7,snapshot:{}}})};
    const envelope=JSON.parse(options.body);envelopes.push(envelope);
    if(fail){fail=false;throw new Error('lost response');}
    return {ok:true,json:async()=>({code:0,data:{result:{accepted:true},version:8,replayed:true}})};
  };
  const sessionStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
  vm.runInNewContext(webSource,{window,fetch,sessionStorage,crypto:{randomUUID:()=> 'web-original-request-01'},Map,Promise,URLSearchParams});
  await assert.rejects(window.api.purchasePackage({payment_reference:'p1'}),/lost response/);
  await assert.rejects(window.api.purchasePackage({payment_reference:'p2'}),/未确认/);
  await window.api.purchasePackage({payment_reference:'p1'});
  assert.deepEqual(envelopes[1],envelopes[0]);
  assert.equal(storage.size,0);
});

test('native migrated handlers contain no direct local attendance, debit, purchase or approval execution',()=>{
  for(const name of ['attendance','approval','course-packages']) {
    const code=fs.readFileSync(path.resolve(__dirname,'../pages',name,'index.js'),'utf8');
    assert.doesNotMatch(code,/(attendanceService\.(submitAttendance|updateAttendanceWithin24Hours|requestMakeupAttendance)|packageAccountService\.(purchasePackage|deductHours|rollbackHours)|\w+Service\.(apply\w+Approval|reject\w+Approval))\(/);
  }
});

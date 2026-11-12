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

test('foreground version notification does not overwrite cache or advance a draft version; stopping ignores late replies',async()=>{
 const storage=new Map([['auth_token','token']]);const timers=new Map();let sequence=0;let versionReply;
 const module={exports:{}};const notices=[];
 const wx={getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,v),request(o){
  if(o.url.endsWith('/context'))o.success({statusCode:200,data:{code:0,data:{user_id:'u_sa1',version:1,snapshot:{students:[{id:'original'}]}}}});
  else versionReply=o;
 }};
 vm.runInNewContext(source,{module,require:()=>({SERVER_API_BASE:'http://test'}),wx,Map,Promise,Date,Math,setTimeout:fn=>{timers.set(++sequence,fn);return sequence},clearTimeout:id=>timers.delete(id)});
 await module.exports.refresh();module.exports.startSync(v=>notices.push(v));
 versionReply.success({statusCode:200,data:{code:0,data:{version:2}}});
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(notices,[2]);assert.equal(storage.get('students')[0].id,'original');
 const poll=[...timers.values()][0];timers.clear();poll();module.exports.stopSync();
 versionReply.success({statusCode:200,data:{code:0,data:{version:3}}});
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(notices,[2]);assert.equal(timers.size,0);
});

test('late refresh from previous login cannot populate the next user cache',async()=>{
 const storage=new Map([['auth_token','old']]);const requests=[];const module={exports:{}};
 const wx={getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,v),request:o=>requests.push(o)};
 vm.runInNewContext(source,{module,require:()=>({SERVER_API_BASE:'http://test'}),wx,Map,Promise,Date,Math});
 const old=module.exports.refresh();const rejected=assert.rejects(old,/登录身份/);
 storage.set('auth_token','new');const current=module.exports.refresh();
 requests[1].success({statusCode:200,data:{code:0,data:{user_id:'new',version:5,snapshot:{students:[{id:'new'}]}}}});await current;
 requests[0].success({statusCode:200,data:{code:0,data:{user_id:'old',version:1,snapshot:{students:[{id:'old'}]}}}});await rejected;
 assert.equal(storage.get('students')[0].id,'new');
});

test('closing Web event subscription cancels scheduled reconnect and prevents reopening',()=>{
 const instances=[];const timers=new Map();let sequence=0;const window={location:{origin:'http://test'}};
 class Events {constructor(){instances.push(this)}addEventListener(){}close(){this.closed=true}}
 vm.runInNewContext(webSource,{window,EventSource:Events,setTimeout:fn=>{timers.set(++sequence,fn);return sequence},clearTimeout:id=>timers.delete(id),Map,Promise});
 const subscription=window.api.connectSSE(()=>{},()=>{});
 instances[0].onerror();const retry=[...timers.values()][0];
 subscription.close();assert.equal(timers.size,0);retry();assert.equal(instances.length,1);
});

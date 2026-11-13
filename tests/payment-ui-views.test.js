'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname,'..');
const MINI=path.join(ROOT,'pages/payment-reconciliation');
const MINI_JS=fs.readFileSync(path.join(MINI,'index.js'),'utf8');
const MARKUP=fs.readFileSync(path.join(MINI,'index.wxml'),'utf8');
const WEB_SCRIPT=fs.readFileSync(path.join(ROOT,'web-admin/js/payment-reconciliation.js'),'utf8');
const WEB_PAGE=fs.readFileSync(path.join(ROOT,'web-admin/payment-reconciliation.html'),'utf8');

test('payment mini-program WXML handlers resolve and no escaped comparisons break compiler',()=>{
  let page;
  vm.runInNewContext(MINI_JS,{
    require:()=>({}),Page:object=>{page=object;}
  });
  assert.ok(page);
  for(const match of MARKUP.matchAll(/(?:bindtap|bindchange|bindinput)="([^"]+)"/g)) {
    assert.equal(typeof page[match[1]],'function','Missing Page handler: '+match[1]);
  }
  for(const match of MARKUP.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    assert.doesNotMatch(match[1],/&(?:amp|lt|gt);/);
  }
  assert.match(WEB_PAGE,/payment-reconciliation\.js/);
  assert.match(WEB_PAGE,/id="submit-form"/);
  assert.match(WEB_PAGE,/id="confirm-form"/);
  assert.match(WEB_PAGE,/id="reject-form"/);
  assert.match(WEB_PAGE,/id="purchase-form"/);
  // Financial text must render as text, not unsafe HTML.
  assert.match(WEB_SCRIPT,/\.textContent\s*=/);
  assert.doesNotMatch(WEB_SCRIPT,/\.innerHTML\s*=/);
});

test('mini-program purchase refuses pending payments and uses immutable confirmed receipt fields',async()=>{
  let page;
  const calls=[];
  const dialogs=[];
  const receipts=[
    {receipt_id:'receipt1',payment_reference:'sample-001',status:'confirmed',
      student_id:'stu_1',course_id:'crs_1',amount_cents:189900,
      account_destination:'进入公账'}
  ];
  const wx={
    getStorageSync:()=> 'fake-auth-token',
    showModal:opts=>{dialogs.push(opts);if(opts.success)opts.success({confirm:true});},
    showToast:()=>{},
    request:opts=>opts.success({statusCode:200,data:{code:0,data:{items:receipts,strict_mode:true}}}),
    reLaunch:()=>{throw new Error('unexpected redirect')}
  };
  const db={SERVER_API_BASE:'http://127.0.0.1:3000',
    TABLES:{STUDENTS:'students',COURSES_AND_CLASS_TYPES:'courses',TERMS:'terms'},
    getTable:name=>name==='terms'?[{id:'term_1',name:'Term 1'}]:
      name==='students'?[{id:'stu_1',name:'Student 1'}]:
      [{id:'crs_1',course_name:'Course 1'}]
  };
  const commands={refresh:async()=>{},recoverPending:async()=>{},
    run:async(command,params)=>{calls.push({command,params});return {status:'ok'};}};
  vm.runInNewContext(MINI_JS,{
    require:name=>name.includes('commandClient')?commands:
      name.includes('paymentDisplay')?require('../services/paymentDisplay'):db,
    Page:obj=>{page=obj;},wx,
    getApp:()=>({globalData:{currentUser:{id:'u_adm1',role:'admin'}}})
  });
  page.setData=function(change){Object.assign(this.data,change);};
  await page.onShow();
  assert.equal(page.data.receipts.length,1);
  assert.equal(page.data.strictMode,true);
  page.data.selectedReceipt={...receipts[0],status:'pending'};
  page.data.paidHours='10';
  page.data.giftHours='1';
  page.data.terms=[{id:'term_1',name:'Term 1'}];
  page.purchase();
  assert.equal(calls.length,0,'Pending receipt must not create a package');
  page.data.selectedReceipt={...receipts[0]};
  page.purchase();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.length,1);
  assert.equal(calls[0].command,'package.purchase');
  assert.equal(calls[0].params.total_amount,1899);
  assert.equal(calls[0].params.payment_reference,'sample-001');
  assert.equal(calls[0].params.student_id,'stu_1');
  assert.equal(calls[0].params.course_id,'crs_1');
  assert.equal(calls[0].params.term_id,'term_1');
});

test('mini-program presents manual settlement warning, uses two-person-only UI for approval',async()=>{
  let page;
  let routed=false;
  const wx={
    getStorageSync:()=> 'fake-auth-token',
    showModal:()=>{},
    showToast:()=>{},
    request:opts=>opts.success({statusCode:200,data:{code:0,data:{items:[],strict_mode:false}}}),
    reLaunch:()=>{routed=true;}
  };
  const db={SERVER_API_BASE:'http://127.0.0.1:3000',
    TABLES:{STUDENTS:'students',COURSES_AND_CLASS_TYPES:'courses',TERMS:'terms'},
    getTable:()=>[]};
  vm.runInNewContext(MINI_JS,{
    Page:obj=>{page=obj;},wx,require:name=>name.includes('commandClient')?
      {refresh:async()=>{},recoverPending:async()=>{},run:async()=>{throw Error('should not call')}}:db,
    getApp:()=>({globalData:{currentUser:{role:'teacher'}}})
  });
  page.setData=function(change){Object.assign(this.data,change);};
  await page.onShow();
  assert.equal(routed,true);
  assert.equal(page.data.isSuperAdmin,false);
  assert.match(MARKUP,/官方银行或支付平台/);
  assert.match(MARKUP,/isSuperAdmin && selectedReceipt\.status === 'pending'/);
  assert.match(WEB_SCRIPT,/receipt\.submitted_by===state\.user\.id/);
});


test('mini-program prevents self-confirmation and self-rejection before submitting an uncertain command',async()=>{
  let page;
  const commandsMade=[];
  const warnings=[];
  const wx={
    getStorageSync:()=> 'fake-auth-token',
    showModal:opts=>{warnings.push(opts.title);if(opts.success)opts.success({confirm:true});},
    showToast:()=>{},
    request:opts=>opts.success({statusCode:200,data:{code:0,data:{items:[],strict_mode:false}}})
  };
  const commands={run:async(name,params)=>{commandsMade.push({name,params});return {status:'ok'};}};
  const db={SERVER_API_BASE:'http://127.0.0.1:3000'};
  const identity={id:'u_sa1',role:'super_admin'};
  vm.runInNewContext(MINI_JS,{
    Page:obj=>{page=obj;},wx,
    require:name=>name.includes('commandClient')?commands:
      name.includes('paymentDisplay')?require('../services/paymentDisplay'):db,
    getApp:()=>({globalData:{currentUser:identity}})
  });
  page.setData=function(change){Object.assign(this.data,change);};
  page.data.isSuperAdmin=true;
  page.data.selectedReceipt={
    receipt_id:'a',payment_reference:'bank-test-001',
    submitted_by:'u_sa1',status:'pending',amount_cents:150000
  };
  page.data.statementReference='bank-line-001';
  page.data.rejectReason='未查到账';
  page.confirmReceipt();
  page.rejectReceipt();
  assert.equal(commandsMade.length,0);
  assert.equal(warnings.length,2);
  page.data.selectedReceipt.submitted_by='u_adm1';
  page.confirmReceipt();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(commandsMade.length,1);
  assert.equal(commandsMade[0].name,'payment.confirm');
  assert.equal(commandsMade[0].params.statement_reference,'bank-line-001');
});

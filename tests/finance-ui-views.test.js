'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ROOT=path.resolve(__dirname,'..');
function source(file){return fs.readFileSync(path.join(ROOT,file),'utf8');}
const mini=source('pages/salary/index.js');
const wxml=source('pages/salary/index.wxml');
const web=source('web-admin/finance-operations.html');
const webJs=source('web-admin/js/finance-operations.js');
const api=source('web-admin/js/api.js');

function page() {
  let instance;
  const calls=[];
  const messages=[];
  const wx={
    showModal:p=>{messages.push(p.title);if(p.success)p.success({confirm:true});},
    showToast:()=>{},showLoading:()=>{},hideLoading:()=>{}
  };
  const commands={
    run:async(name,params)=>{calls.push({name,params});return {status:'ok'};},
    refresh:async()=>{}, recoverPending:async()=>{}
  };
  const salary={
    generateTeacherSalarySettlement:()=>{throw new Error('Do not write salary locally');},
    settleTeacherSalary:()=>{throw new Error('Do not settle salary locally');}
  };
  vm.runInNewContext(mini,{
    Page:p=>{instance=p;},getApp:()=>({globalData:{currentUser:{id:'u_sa1',role:'super_admin'}}}),
    require:id=>id.includes('commandClient')?commands:
      id.includes('salaryEngineService')?salary:{},wx,console
  });
  instance.setData=function(data){Object.assign(this.data,data)};
  instance.refreshAllData=()=>{};
  instance.data.currentUser={id:'u_sa1',role:'super_admin'};
  instance.data.canManageSalary=true;
  instance.data.teacherList=[{id:'u_tch2',name:'Teacher'}];
  instance.data.teacherListNoAll=instance.data.teacherList;
  instance.data.teacherIndex=0;
  instance.data.selectedMonth='2026-03';
  instance.data.settlements=[{id:'settlement-test',teacher_name:'Teacher',period:'2026-03',
    total_salary:1220,status:'draft'}];
  return {instance,calls,messages};
}

test('salary mini-program uses remote atomic commands, not direct local finance writes',async()=>{
  const f=page();
  await f.instance.onGenerateSettlement();
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].name,'salary.generate');
  assert.equal(f.calls[0].params.teacher_id,'u_tch2');
  assert.equal(f.calls[0].params.period,'2026-03');
  f.instance.onSettleConfirm({currentTarget:{dataset:{id:'settlement-test'}}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.calls.length,2);
  assert.equal(f.calls[1].name,'salary.settle');
  assert.equal(f.calls[1].params.settlement_id,'settlement-test');
});

test('non-super-admin mini-program user cannot trigger salary writes',async()=>{
  const f=page();
  f.instance.data.currentUser={id:'u_adm1',role:'admin'};
  f.instance.data.canManageSalary=false;
  await f.instance.onGenerateSettlement();
  f.instance.onSettleConfirm({currentTarget:{dataset:{id:'settlement-test'}}});
  assert.equal(f.calls.length,0);
  assert.match(wxml,/wx:if="\{\{canManageSalary\}\}"/);
  assert.match(wxml,/disabled="\{\{salaryActionBusy\}\}"/);
});

test('web interface displays business terms and uses only confirmed command client actions',()=>{
  for(const name of ['学期课时顺延','教师月度工资单','应发课酬','教师','结算月份','免补费']){
    assert.ok(web.includes(name),name+' missing');
  }
  assert.match(web,/finance-operations\.js/);
  assert.doesNotMatch(webJs,/\.innerHTML\s*=/);
  assert.match(webJs,/window\.api\.rolloverTerm/);
  assert.match(webJs,/window\.api\.generateSettlement/);
  assert.match(webJs,/window\.api\.settleSalary/);
  assert.match(api,/executeCommand\('finance\.rollover'/);
  assert.match(api,/executeCommand\('salary\.generate'/);
  assert.match(api,/executeCommand\('salary\.settle'/);
  assert.doesNotMatch(api,/\/api\/salary\/generate-settlement'/);
  assert.doesNotMatch(api,/\/api\/salary\/settle'/);
  assert.doesNotMatch(api,/\/api\/finance\/rollover'/);
});

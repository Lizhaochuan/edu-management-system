'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ROOT=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(ROOT,file),'utf8');
const payment=require('../services/paymentDisplay');
const business=require('../web-admin/js/business-display.js');

test('payment receipts translate names, status, money, account and timestamp for mini-program',()=>{
  const row={receipt_id:'receipt_a',payment_reference:'reference-ABC',
    student_id:'stu1',course_id:'course1',submitted_by:'admin1',status:'pending',
    amount_cents:180055,account_destination:'进入公账',created_at:'2026-11-13T08:00:00.000Z'};
  const entry=payment.receipt(row,{
    students:[{id:'stu1',name:'王小明'}],
    courses:[{id:'course1',course_name:'自然拼读'}],
    users:[{id:'admin1',name:'教务主管'}]});
  assert.equal(entry.studentName,'王小明');
  assert.equal(entry.courseName,'自然拼读');
  assert.equal(entry.submittedByName,'教务主管');
  assert.equal(entry.statusText,'待人工核对');
  assert.equal(entry.amountText,'¥1800.55 元');
  assert.equal(entry.accountText,'对公账户');
  assert.equal(row.status,'pending','original business state must not be altered');
  assert.equal(row.studentName,undefined);
});

test('all payment statuses use familiar Chinese words; unknown references are never displayed as names',()=>{
  for(const [state,label] of Object.entries({pending:'待人工核对',
    confirmed:'已人工确认到账',rejected:'已拒绝',consumed:'已用于购课入账'})){
    assert.equal(payment.receipt({status:state,amount_cents:100},{}).statusText,label);
    assert.equal(business.readablePaymentStatus(state),label);
  }
  const entry=payment.receipt({status:'pending',amount_cents:1,
    student_id:'stu_SECRET',course_id:'course_SECRET',submitted_by:'u_SECRET'}, {});
  assert.equal(entry.studentName,'学员姓名待核对');
  assert.equal(entry.courseName,'课程名称待核对');
  assert.equal(entry.submittedByName,'登记人员待核对');
  assert.doesNotMatch(JSON.stringify([entry.studentName,entry.courseName,entry.submittedByName]),/SECRET/);
  assert.equal(payment.money(200001),'¥2000.01 元');
});

test('mini-program payment list binds only Chinese business labels, not technical IDs',()=>{
  const markup=read('pages/payment-reconciliation/index.wxml');
  const source=read('pages/payment-reconciliation/index.js');
  for(const name of ['item.studentName','item.courseName','item.statusText',
    'item.amountText','item.accountText','item.submittedByName'])assert.ok(markup.includes(name),name);
  for(const raw of ['item.student_id','item.course_id','item.submitted_by',
    'item.status}}','item.amount_cents / 100','selectedReceipt.status}}'])
    assert.equal(markup.includes('{{'+raw),false,raw);
  assert.ok(source.includes("require('../../services/paymentDisplay')"));
  assert.ok(source.includes('paymentDisplay.receipt(row,displayContext)'));
});

test('browser translation library executes without Node require and safely describes actual changes',()=>{
  const context={window:{},Date,JSON};
  vm.runInNewContext(read('web-admin/js/business-display.js'),context);
  const lib=context.window.BusinessDisplay;
  assert.equal(typeof lib.auditChange,'function');
  const result=lib.auditChange({action:'UPDATE',target_table:'teacher_tiers',
    before_snapshot_json:{headcount_rates_json:{1:100,2:140}},
    after_snapshot_json:{headcount_rates_json:{1:110,2:150}}});
  assert.equal(result.rows.length,2);
  assert.equal(result.rows[0].label,'1 人出勤课酬');
  assert.equal(result.rows[0].afterText,'¥110 元/课时');
  assert.doesNotMatch(JSON.stringify(result),/headcount_rates_json/);
  const failed=lib.auditChange({action:'UPDATE',target_table:'users',
    before_snapshot_json:'{broken-PRIVATE',after_snapshot_json:{password_hash:'PRIVATE'}});
  assert.equal(failed.rows.length,0);
  assert.doesNotMatch(JSON.stringify(failed),/PRIVATE/);
});

test('browser inspector converts per-student deductions without printing raw payloads',()=>{
  const entry=business.readableDeduction({
    attendees_json:JSON.stringify([{student_name:'小赵',deducted_hours:1.5,
      deducted_detail_json:{secret:'not for UI'}},{student_name:'小田',deducted_hours:0}]),
    makeup_students:[{student_name:'小林',deducted_hours:2}]
  });
  assert.equal(entry.rows.length,2);
  assert.equal(entry.rows[0].name,'小赵');
  assert.equal(entry.rows[0].hours,'1.5 课时');
  assert.equal(entry.rows[1].hours,'2 课时');
  assert.doesNotMatch(JSON.stringify(entry),/not for UI|deducted_detail_json/);
  const broken=business.readableDeduction({attendees_json:'{broken',
    deducted_detail_json:'{"secret":"private"}'});
  assert.equal(broken.rows.length,0);
  assert.match(broken.note,/核对/);
  assert.doesNotMatch(JSON.stringify(broken),/private/);
});

test('Web operation log comparison and deduction modal no longer render JSON or technical table names',()=>{
  const log=read('web-admin/js/components/audit-logs.js');
  const inspector=read('web-admin/js/components/inspector.js');
  const toolbox=read('web-admin/js/components/toolbox.js');
  const dashboard=read('web-admin/index.html');
  assert.match(log,/diffModal.item.readable.rows/);
  assert.match(log,/window.BusinessDisplay.auditChange/);
  assert.match(inspector,/window.BusinessDisplay.readableDeduction/);
  assert.doesNotMatch(log,/<pre\b|formatJson\(|JSON\.stringify\(|JSON Diff|before_snapshot_json\)\s*\}\}/);
  assert.doesNotMatch(inspector,/<pre\b|formatJson\(|JSON\.stringify\(/);
  assert.doesNotMatch(toolbox,/<pre\b|JSON\.stringify\(res/);
  assert.match(dashboard,/src="\/js\/business-display.js"/);
  assert.doesNotMatch(dashboard,/Phase 6-A|PC Web 监控与调试控制台/);
});

test('Web payment list and live update notifications do not print raw role and status codes',()=>{
  const pay=read('web-admin/js/payment-reconciliation.js');
  const app=read('web-admin/js/app.js');
  assert.match(pay,/statusText\(entry.status\)/);
  assert.match(pay,/nameOf\(state.users,entry.submitted_by,'name'\)/);
  assert.match(pay,/user.role==='super_admin'\?'超级管理员':'教务管理员'/);
  assert.doesNotMatch(pay,/cell\(tr,entry.status\)|cell\(tr,entry.submitted_by\)/);
  assert.match(app,/BusinessDisplay.readableMutation/);
  assert.doesNotMatch(app,/\$\{data\.table\}.*\$\{data\.action\}/);
  assert.equal(business.readableMutation('course_packages','UPDATE'),
    '学员课时包已修改，可刷新查看最新变化。');
});

test('readable display modules are presentation only and never write the financial database',()=>{
  for(const file of ['services/paymentDisplay.js','web-admin/js/business-display.js']){
    const code=read(file);
    assert.doesNotMatch(code,/\bdb\.(?:insert|update|remove|replaceAll|transaction)\(/);
    assert.doesNotMatch(code,/run\('payment\.confirm'|run\('package\.purchase'/);
  }
});


test('all protected mini-program screens describe user roles in Chinese, not raw codes',()=>{
  for(const page of ['user-management','config-settings','audit-logs']){
    const markup=read('pages/'+page+'/index.wxml');
    const source=read('pages/'+page+'/index.js');
    assert.doesNotMatch(markup,/\{\{currentUser\.role\}\}/);
    assert.match(markup,/\{\{currentRoleText\}\}/);
    assert.match(source,/ROLE_NAMES\[user\.role\]/);
    assert.match(source,/currentRoleText:/);
  }
  assert.doesNotMatch(read('pages/config-settings/index.wxml'),/\(admin\)|\(super_admin\)/);
});

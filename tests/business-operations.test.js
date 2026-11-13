'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'edu-command-'));
  fs.cpSync(path.resolve(__dirname, '../services'), path.join(root, 'services'), { recursive: true });
  const file = path.join(root, 'data/db.json');
  process.env.AUTH_CREDENTIALS_FILE = path.join(root, 'credentials.json');
  let db, auth, commands;
  function reload() {
    for (const name of ['db', 'authService', 'businessCommandService']) {
      delete require.cache[require.resolve(path.join(root, 'services', name + '.js'))];
    }
    db = require(path.join(root, 'services/db'));
    auth = require(path.join(root, 'services/authService'));
    commands = require(path.join(root, 'services/businessCommandService'));
  }
  reload();
  db.initDatabase(true);
  for (const id of ['u_sa1', 'u_sa2', 'u_adm1', 'u_par1', 'u_tch1', 'u_tch2']) auth.saveCredential(id, 'Command-Test-Password-2026!');
  return {
    get db() { return db; }, get auth() { return auth; }, get commands() { return commands; },
    root, file, reload,
    req(id = 'u_sa1') {
      const session = auth.login(id, 'Command-Test-Password-2026!', id);
      assert.equal(session.status, 200);
      return { headers: { authorization: 'Bearer ' + session.token } };
    },
    envelope(key = 'test-key-00000001') {
      return { command: 'system.writeProbe', params: { label: 'probe' },
        idempotencyKey: key, expectedVersion: db.getWriteState().version };
    },
    close() { delete process.env.AUTH_CREDENTIALS_FILE; fs.rmSync(root, { recursive: true, force: true }); }
  };
}
function checkError(fn, status, code) {
  assert.throws(fn, e => e.status === status && e.code === code);
}
function run(fn) { const f = fixture(); try { fn(f); } finally { f.close(); } }


function execute(f, command, params, user = 'u_sa1', key) {
  return f.commands.execute(f.req(user),{...f.envelope(key || 'operation_'+require('node:crypto').randomUUID()),command,params});
}
function purchase(overrides = {}) { return {student_id:'stu_1',course_id:'crs_1',term_id:'term_spring_2026',paid_hours_total:10,gift_hours_total:2,total_amount:1800,account_destination:'进入公账',payment_reference:'payment-001',...overrides}; }
function sheet(overrides = {}) { return {schedule_id:'sch_2',attendance_inputs:[{student_id:'stu_3',is_present:true},{student_id:'stu_4',is_present:false}],...overrides}; }

test('purchase clears historical debt first, preserves snapshots and rejects duplicate payment across new keys', () => run(f => {
  f.db.update(f.db.TABLES.COURSE_PACKAGES,'pkg_1',{debt_hours:3});
  const settled=JSON.stringify(f.db.getById(f.db.TABLES.SCHEDULES_AND_ATTENDANCE,'sch_1'));
  const result=execute(f,'package.purchase',purchase(),'u_adm1').result;
  assert.equal(result.package.paid_hours_left,7);
  assert.equal(result.package.gift_hours_left,2);
  assert.equal(result.package.unit_price_snapshot,180);
  assert.equal(f.db.getById(f.db.TABLES.COURSE_PACKAGES,'pkg_1').debt_hours,0);
  checkError(()=>execute(f,'package.purchase',purchase()),409,'BUSINESS_DUPLICATE');
  assert.equal(JSON.stringify(f.db.getById(f.db.TABLES.SCHEDULES_AND_ATTENDANCE,'sch_1')),settled);
  checkError(()=>execute(f,'package.purchase',purchase({operator:{role:'super_admin'}})),400,'INVALID_PARAMS');
  checkError(()=>execute(f,'package.purchase',purchase(),'u_par1'),403,'FORBIDDEN');
  checkError(()=>execute(f,'package.purchase',purchase({paid_hours_total:Infinity})),400,'INVALID_PARAMS');
}));

test('purchase failure after debt offset restores old balance, audit, version and receipts', () => run(f => {
  f.db.update(f.db.TABLES.COURSE_PACKAGES,'pkg_1',{debt_hours:3});
  const before=fs.readFileSync(f.file,'utf8');
  const memory=JSON.stringify(f.db.dumpAll());
  const insert=f.db.insert;
  f.db.insert=(table,...args)=>{if(table===f.db.TABLES.COURSE_PACKAGES)throw new Error('INJECTED package failure');return insert(table,...args)};
  try { assert.throws(()=>execute(f,'package.purchase',purchase()),/INJECTED/); } finally {f.db.insert=insert;}
  assert.equal(JSON.stringify(f.db.dumpAll()),memory);
  assert.equal(fs.readFileSync(f.file,'utf8'),before);
  assert.equal(execute(f,'package.purchase',purchase()).result.package.paid_hours_left,7);
}));

test('only assigned teacher can sign; lesson-derived hours and fee are applied once despite new keys', () => run(f => {
  checkError(()=>execute(f,'attendance.submit',sheet(),'u_tch1'),403,'FORBIDDEN');
  const p={...f.envelope(),command:'attendance.submit',params:sheet()};
  const req=f.req('u_tch2');
  const result=f.commands.execute(req,p);
  assert.equal(f.db.getById(f.db.TABLES.COURSE_PACKAGES,'pkg_3').paid_hours_left,19);
  assert.equal(f.db.getById(f.db.TABLES.SCHEDULES_AND_ATTENDANCE,'sch_2').calculated_teacher_fee,150);
  assert.equal(result.result.fee_result,undefined);
  assert.equal(result.result.teacher_tier_snapshot,undefined);
  assert.equal(f.commands.execute(req,p).replayed,true);
  checkError(()=>execute(f,'attendance.submit',sheet(),'u_tch2'),409,'LESSON_STATE_CONFLICT');
  assert.equal(f.db.getById(f.db.TABLES.COURSE_PACKAGES,'pkg_3').paid_hours_left,19);
}));

test('attendance rejects forged debit amounts, duplicate or foreign students and missing roster entries', () => run(f => {
  checkError(()=>execute(f,'attendance.submit',sheet({hours_needed:100})),400,'INVALID_PARAMS');
  for(const inputs of [[{student_id:'stu_1',is_present:true}],[],[{student_id:'stu_3',is_present:true},{student_id:'stu_3',is_present:true}]]) {
    checkError(()=>execute(f,'attendance.submit',sheet({attendance_inputs:inputs})),400,'BUSINESS_REJECTED');
  }
  assert.equal(f.db.getById(f.db.TABLES.COURSE_PACKAGES,'pkg_3').paid_hours_left,20);
}));

test('salary calculation failure after deduction rolls back entire sign-in and can retry safely', () => run(f => {
  const salary=require(path.join(f.root,'services/salaryEngineService'));
  const calc=salary.calculateLessonFee;
  const before=fs.readFileSync(f.file,'utf8');
  salary.calculateLessonFee=()=>{throw new Error('INJECTED salary')};
  try {assert.throws(()=>execute(f,'attendance.submit',sheet()),/INJECTED salary/);}finally{salary.calculateLessonFee=calc;}
  assert.equal(fs.readFileSync(f.file,'utf8'),before);
  assert.equal(f.db.getById(f.db.TABLES.COURSE_PACKAGES,'pkg_3').paid_hours_left,20);
  execute(f,'attendance.submit',sheet());
}));

test('24-hour amendment precisely refunds hours; salary failure during amendment is no longer swallowed', () => run(f => {
  execute(f,'attendance.submit',sheet());
  const salary=require(path.join(f.root,'services/salaryEngineService'));
  const calc=salary.calculateLessonFee;
  const before=fs.readFileSync(f.file,'utf8');
  const absent=sheet({attendance_inputs:[{student_id:'stu_3',is_present:false},{student_id:'stu_4',is_present:false}]});
  salary.calculateLessonFee=()=>{throw new Error('INJECTED amendment salary')};
  try {assert.throws(()=>execute(f,'attendance.update',absent),/INJECTED/);}finally{salary.calculateLessonFee=calc;}
  assert.equal(fs.readFileSync(f.file,'utf8'),before);
  execute(f,'attendance.update',absent);
  assert.equal(f.db.getById(f.db.TABLES.COURSE_PACKAGES,'pkg_3').paid_hours_left,20);
  f.db.update(f.db.TABLES.SCHEDULES_AND_ATTENDANCE,'sch_2',{attendance_submitted_at:'2020-01-01T00:00:00.000Z'});
  assert.throws(()=>execute(f,'attendance.update',sheet()),/24小时/);
}));

test('manual debit uses durable business event, rollback only consumes stored detail once', () => run(f => {
  const params={student_id:'stu_1',course_id:'crs_1',hours_needed:2,context_desc:'补记课堂消课',event_id:'lesson-event-001'};
  const result=execute(f,'hours.deduct',params,'u_adm1').result;
  assert.equal(f.db.getById(f.db.TABLES.COURSE_PACKAGES,'pkg_1').paid_hours_left,33.5);
  checkError(()=>execute(f,'hours.deduct',params),409,'BUSINESS_DUPLICATE');
  checkError(()=>execute(f,'hours.rollback',{deduction_id:result.deduction_id,reason:'撤销'},'u_adm1'),403,'FORBIDDEN');
  execute(f,'hours.rollback',{deduction_id:result.deduction_id,reason:'撤销'});
  assert.equal(f.db.getById(f.db.TABLES.COURSE_PACKAGES,'pkg_1').paid_hours_left,35.5);
  checkError(()=>execute(f,'hours.rollback',{deduction_id:result.deduction_id,reason:'再次撤销'}),409,'DEDUCTION_STATE_CONFLICT');
}));

test('makeup approval signs and deducts once; cannot self-approve, approve twice or reject after approval', () => run(f => {
  const request=execute(f,'attendance.requestMakeup',{...sheet(),reason:'漏签'},'u_tch2').result;
  assert.equal(f.db.getById(f.db.TABLES.COURSE_PACKAGES,'pkg_3').paid_hours_left,20);
  execute(f,'approval.approve',{approval_id:request.approval_id});
  assert.equal(f.db.getById(f.db.TABLES.COURSE_PACKAGES,'pkg_3').paid_hours_left,19);
  checkError(()=>execute(f,'approval.reject',{approval_id:request.approval_id,reject_reason:'晚到请求'}),409,'APPROVAL_STATE_CONFLICT');
  const self=f.db.insert(f.db.TABLES.APPROVAL_REQUESTS,{request_type:'config_change',proposer_id:'u_sa1',status:'pending',target_table:'teacher_tiers',target_record_id:'tier_junior',after_data_json:{name:'new'}});
  checkError(()=>execute(f,'approval.approve',{approval_id:self.id}),403,'SELF_APPROVAL');
}));

test('approval rejects arbitrary user role changes, finalized lessons and rolls back partial business application', () => run(f => {
  const a=f.db.insert(f.db.TABLES.APPROVAL_REQUESTS,{request_type:'config_change',proposer_id:'u_adm1',status:'pending',target_table:'users',target_record_id:'u_adm1',after_data_json:{role:'super_admin'}});
  checkError(()=>execute(f,'approval.approve',{approval_id:a.id}),400,'BUSINESS_REJECTED');
  assert.equal(f.db.getById(f.db.TABLES.USERS,'u_adm1').role,'admin');
  const config=require(path.join(f.root,'services/systemConfigService'));
  const apply=config.applyConfigApproval;
  const b=f.db.insert(f.db.TABLES.APPROVAL_REQUESTS,{request_type:'config_change',proposer_id:'u_adm1',status:'pending',target_table:'teacher_tiers',target_record_id:'tier_junior',after_data_json:{name:'new'}});
  const before=fs.readFileSync(f.file,'utf8');
  config.applyConfigApproval=()=>{f.db.update(f.db.TABLES.TEACHER_TIERS,'tier_junior',{name:'partial'});throw new Error('INJECTED approval failure')};
  try {assert.throws(()=>execute(f,'approval.approve',{approval_id:b.id}),/INJECTED/);}finally{config.applyConfigApproval=apply;}
  assert.equal(fs.readFileSync(f.file,'utf8'),before);
  assert.equal(f.db.getById(f.db.TABLES.APPROVAL_REQUESTS,b.id).status,'pending');
  checkError(()=>execute(f,'attendance.submit',sheet({schedule_id:'sch_1'})),409,'LESSON_LOCKED');
}));

test('large debit preserves FIFO paid/gift/debt rules and invalidates pending approval before it can execute',()=>run(f=>{
 const a=f.db.insert(f.db.TABLES.APPROVAL_REQUESTS,{request_type:'refund',status:'pending',proposer_id:'u_adm1'});
 f.db.update(f.db.TABLES.COURSE_PACKAGES,'pkg_1',{lock_status:'pending_approval_locked',locked_by_approval_id:a.id});
 const result=execute(f,'hours.deduct',{student_id:'stu_1',course_id:'crs_1',hours_needed:42,context_desc:'补记实际课堂',event_id:'event-debt-01'}).result;
 assert.equal(result.paid_deducted,35.5);
 assert.equal(result.gift_deducted,4);
 assert.equal(result.debt_added,2.5);
 assert.equal(f.db.getById(f.db.TABLES.APPROVAL_REQUESTS,a.id).status,'invalidated_by_attendance');
 checkError(()=>execute(f,'approval.approve',{approval_id:a.id}),409,'APPROVAL_STATE_CONFLICT');
 execute(f,'hours.rollback',{deduction_id:result.deduction_id,reason:'重复课堂登记纠正'});
 assert.equal(f.db.getById(f.db.TABLES.COURSE_PACKAGES,'pkg_1').paid_hours_left,35.5);
 assert.equal(f.db.getById(f.db.TABLES.COURSE_PACKAGES,'pkg_1').gift_hours_left,4);
 assert.equal(f.db.getById(f.db.TABLES.COURSE_PACKAGES,'pkg_1').debt_hours,0);
}));

test('rejecting makeup request restores scheduled state without charging hours',()=>run(f=>{
 const request=execute(f,'attendance.requestMakeup',{...sheet(),reason:'漏签'},'u_tch2').result;
 execute(f,'approval.reject',{approval_id:request.approval_id,reject_reason:'资料不全'});
 assert.equal(f.db.getById(f.db.TABLES.SCHEDULES_AND_ATTENDANCE,'sch_2').status,'scheduled');
 assert.equal(f.db.getById(f.db.TABLES.COURSE_PACKAGES,'pkg_3').paid_hours_left,20);
}));

test('approval proposals use authenticated proposer and fixed schema; configuration applies only after approval',()=>run(f=>{
 const params={type:'config.term',data:{termId:'term_spring_2026',newExpireDate:'2027-06-30',reason:'新学期调整'}};
 const request=execute(f,'approval.propose',params,'u_adm1').result;
 assert.equal(request.proposer_id,'u_adm1');
 assert.equal(f.db.getById(f.db.TABLES.TERMS,'term_spring_2026').fixed_expire_date,'2026-06-30');
 execute(f,'approval.approve',{approval_id:request.id});
 assert.equal(f.db.getById(f.db.TABLES.TERMS,'term_spring_2026').fixed_expire_date,'2027-06-30');
 checkError(()=>execute(f,'approval.propose',{...params,data:{...params.data,proposer_id:'u_sa1'}}),400,'INVALID_PARAMS');
 checkError(()=>execute(f,'approval.propose',params,'u_tch2'),403,'FORBIDDEN');
 checkError(()=>execute(f,'approval.propose',{type:'db.update',data:{}}),400,'INVALID_PARAMS');
}));

test('partner rate approval preserves eight independent brackets and cannot change roles',()=>run(f=>{
 const rates={1:111,2:199,3:251,4:315,5:355,6:399,7:420,8:450};
 const a=execute(f,'approval.propose',{type:'config.partnerRates',data:{headcount_rates_json:rates,reason:'独立课酬'}},'u_adm1').result;
 execute(f,'approval.approve',{approval_id:a.id});
 assert.deepEqual(f.db.getById(f.db.TABLES.PARTNER_TEACHER_RATE_CONFIG,'partner_teacher').headcount_rates_json,rates);
 checkError(()=>execute(f,'approval.propose',{type:'config.teacherCategory',target_id:'u_tch2',data:{role:'super_admin',reason:'伪造'}}),400,'INVALID_PARAMS');
}));

test('refund proposal and lock commit together; rejection unlocks without altering balances',()=>run(f=>{
 execute(f,'approval.propose',{type:'refund',data:{package_id:'pkg_1',handling_fee:0,refund_method:'微信转账',refund_reason:'申请退费'}},'u_adm1');
 const a=f.db.getTable(f.db.TABLES.APPROVAL_REQUESTS).find(a=>a.request_type==='refund'&&a.proposer_id==='u_adm1');
 assert.ok(a);
 assert.equal(f.db.getById(f.db.TABLES.COURSE_PACKAGES,'pkg_1').lock_status,'pending_approval_locked');
 execute(f,'approval.reject',{approval_id:a.id,reject_reason:'资料待补齐'});
 assert.notEqual(f.db.getById(f.db.TABLES.COURSE_PACKAGES,'pkg_1').lock_status,'pending_approval_locked');
 assert.equal(f.db.getById(f.db.TABLES.COURSE_PACKAGES,'pkg_1').paid_hours_left,35.5);
}));

test('approval refuses configuration changed since proposal rather than overwriting newer settings',()=>run(f=>{
 const request=execute(f,'approval.propose',{type:'config.term',data:{termId:'term_spring_2026',newExpireDate:'2027-06-30',reason:'调整学期'}},'u_adm1').result;
 f.db.update(f.db.TABLES.TERMS,'term_spring_2026',{fixed_expire_date:'2027-01-01'});
 checkError(()=>execute(f,'approval.approve',{approval_id:request.id}),409,'APPROVAL_SNAPSHOT_CONFLICT');
 assert.equal(f.db.getById(f.db.TABLES.TERMS,'term_spring_2026').fixed_expire_date,'2027-01-01');
 assert.equal(f.db.getById(f.db.TABLES.APPROVAL_REQUESTS,request.id).status,'pending');
}));

test('proposal numeric and calendar inputs reject coercions and impossible dates before any writes',()=>run(f=>{
 const before=fs.readFileSync(f.file,'utf8');
 for(const freeze_days of [true,{},1.5,Infinity,'1e2']) checkError(()=>execute(f,'approval.propose',{type:'freeze',data:{package_id:'pkg_1',freeze_days,reason:'病假冻结'}}),400,'INVALID_PARAMS');
 checkError(()=>execute(f,'approval.propose',{type:'config.term',data:{termId:'term_spring_2026',newExpireDate:'2027-02-30',reason:'错误日期'}}),400,'INVALID_PARAMS');
 assert.equal(fs.readFileSync(f.file,'utf8'),before);
}));

test('teacher command response never contains wallet breakdown or debt warnings',()=>run(f=>{
 const result=execute(f,'attendance.submit',sheet(),'u_tch2').result;
 assert.equal(result.attendees[0].deducted_detail_json,undefined);
 assert.equal(result.insufficient_balance_notices,undefined);
}));

test('rollback cannot resurrect hours after package refund',()=>run(f=>{
 const deduction=execute(f,'hours.deduct',{student_id:'stu_1',course_id:'crs_1',hours_needed:2,context_desc:'课堂补记',event_id:'refund-rollback-01'}).result;
 execute(f,'approval.propose',{type:'refund',data:{package_id:'pkg_1',handling_fee:0,refund_method:'微信转账',refund_reason:'申请退费'}},'u_adm1');
 const a=f.db.getTable(f.db.TABLES.APPROVAL_REQUESTS).find(a=>a.request_type==='refund'&&a.proposer_id==='u_adm1');
 execute(f,'approval.approve',{approval_id:a.id});
 const before=fs.readFileSync(f.file,'utf8');
 assert.throws(()=>execute(f,'hours.rollback',{deduction_id:deduction.deduction_id,reason:'迟到的撤销请求'}));
 assert.equal(fs.readFileSync(f.file,'utf8'),before);
 assert.equal(f.db.getById(f.db.TABLES.COURSE_PACKAGES,'pkg_1').paid_hours_left,0);
}));

test('paid-off debt cannot be silently consumed again by an old debit rollback',()=>run(f=>{
 const deduction=execute(f,'hours.deduct',{student_id:'stu_1',course_id:'crs_1',hours_needed:42,context_desc:'课堂补记',event_id:'debt-paid-01'}).result;
 execute(f,'package.purchase',purchase());
 const before=fs.readFileSync(f.file,'utf8');
 assert.throws(()=>execute(f,'hours.rollback',{deduction_id:deduction.deduction_id,reason:'迟到的撤销'}),/欠费已经冲抵/);
 assert.equal(fs.readFileSync(f.file,'utf8'),before);
}));

test('teacher replay redacts financial fields from pre-fix persisted receipts too',()=>run(f=>{
 const p={...f.envelope(),command:'attendance.submit',params:sheet()};
 f.commands.execute(f.req('u_tch2'),p);
 const raw=JSON.parse(fs.readFileSync(f.file));
 raw.__server_write_state.receipts[0].response.result.insufficient_balance_notices=[{message:'sensitive balance'}];
 raw.__server_write_state.receipts[0].response.result.attendees[0].deducted_detail_json='sensitive';
 fs.writeFileSync(f.file,JSON.stringify(raw));f.reload();
 const result=f.commands.execute(f.req('u_tch2'),p);
 assert.equal(result.replayed,true);assert.equal(result.result.insufficient_balance_notices,undefined);
 assert.equal(result.result.attendees[0].deducted_detail_json,undefined);
}));

test('missing original package aborts rollback without marking its debit undone',()=>run(f=>{
 const d=execute(f,'hours.deduct',{student_id:'stu_1',course_id:'crs_1',hours_needed:2,context_desc:'课堂补记',event_id:'missing-package-01'}).result;
 f.db.remove(f.db.TABLES.COURSE_PACKAGES,'pkg_1');
 const before=fs.readFileSync(f.file,'utf8');
 assert.throws(()=>execute(f,'hours.rollback',{deduction_id:d.deduction_id,reason:'迟到撤销'}),/不存在/);
 assert.equal(fs.readFileSync(f.file,'utf8'),before);
 assert.equal(f.db.getById('business_write_events',d.deduction_id).rolled_back,false);
}));

test('sole super admin applies a config proposal immediately and leaves an approved audit record',()=>run(f=>{
 f.db.update(f.db.TABLES.USERS,'u_sa2',{status:'disabled'});
 const result=execute(f,'approval.propose',{type:'config.term',data:{termId:'term_spring_2026',newExpireDate:'2027-06-30',reason:'独立经营调整'}}).result;
 assert.equal(f.db.getById(f.db.TABLES.TERMS,'term_spring_2026').fixed_expire_date,'2027-06-30');
 assert.equal(f.db.getById(f.db.TABLES.APPROVAL_REQUESTS,result.id).status,'approved');
 assert.deepEqual(result.direct_approved,[result.id]);
}));

test('two super admins require a second approver and protect demotion',()=>run(f=>{
 const request=execute(f,'approval.propose',{type:'config.term',data:{termId:'term_spring_2026',newExpireDate:'2027-06-30',reason:'合伙人调整'}}).result;
 checkError(()=>execute(f,'approval.approve',{approval_id:request.id}),403,'SELF_APPROVAL');
 execute(f,'approval.approve',{approval_id:request.id},'u_sa2');
 const change=execute(f,'user.changeRole',{user_id:'u_sa2',role:'admin'}).result;
 assert.equal(change.status,'pending');
 assert.equal(f.db.getById(f.db.TABLES.USERS,'u_sa2').role,'super_admin');
 checkError(()=>execute(f,'approval.approve',{approval_id:change.approval_id}),403,'SELF_APPROVAL');
 execute(f,'approval.approve',{approval_id:change.approval_id},'u_sa2');
 assert.equal(f.db.getById(f.db.TABLES.USERS,'u_sa2').role,'admin');
 checkError(()=>execute(f,'user.changeRole',{user_id:'u_sa1',role:'admin'}),403,'LAST_SUPER_ADMIN');
}));

test('direct approval failure rolls back proposal, audit, version and business changes',()=>run(f=>{
 f.db.update(f.db.TABLES.USERS,'u_sa2',{status:'disabled'});
 const before=fs.readFileSync(f.file,'utf8');
 const old=f.db.update;
 f.db.update=(table,id,patch,...rest)=>{if(table===f.db.TABLES.TERMS)throw new Error('INJECTED approval failure');return old(table,id,patch,...rest)};
 try {assert.throws(()=>execute(f,'approval.propose',{type:'config.term',data:{termId:'term_spring_2026',newExpireDate:'2027-06-30',reason:'测试回滚'}}),/INJECTED/);} finally {f.db.update=old}
 assert.equal(fs.readFileSync(f.file,'utf8'),before);
}));

test('role changes reject forged identity and require fresh approval state',()=>run(f=>{
 checkError(()=>execute(f,'user.changeRole',{user_id:'u_sa2',role:'admin'},'u_adm1'),403,'FORBIDDEN');
 const pending=execute(f,'user.changeRole',{user_id:'u_sa2',role:'admin'}).result;
 f.db.update(f.db.TABLES.USERS,'u_sa2',{status:'disabled'});
 assert.equal(f.auth.login('u_sa2','Command-Test-Password-2026!','test').status,401);
 assert.equal(f.db.getById(f.db.TABLES.APPROVAL_REQUESTS,pending.approval_id).status,'pending');
}));

test('opposing pending demotions cannot remove the last active super admin',()=>run(f=>{
 const removeB=execute(f,'user.changeRole',{user_id:'u_sa2',role:'admin'},'u_sa1').result;
 const removeA=execute(f,'user.changeRole',{user_id:'u_sa1',role:'admin'},'u_sa2').result;
 assert.equal(removeB.status,'pending');
 assert.equal(removeA.status,'pending');

 // Each initial request was legal with two super admins; the first approval changes that.
 execute(f,'approval.approve',{approval_id:removeA.approval_id},'u_sa1');
 assert.equal(f.db.getById(f.db.TABLES.USERS,'u_sa1').role,'admin');
 assert.equal(f.db.getById(f.db.TABLES.USERS,'u_sa2').role,'super_admin');

 const before=fs.readFileSync(f.file,'utf8');
 const memory=JSON.stringify(f.db.dumpAll());
 const version=f.db.getWriteState().version;
 checkError(()=>execute(f,'approval.approve',{approval_id:removeB.approval_id},'u_sa2'),409,'LAST_SUPER_ADMIN');
 assert.equal(fs.readFileSync(f.file,'utf8'),before);
 assert.equal(JSON.stringify(f.db.dumpAll()),memory);
 assert.equal(f.db.getWriteState().version,version);
 assert.equal(f.db.getById(f.db.TABLES.APPROVAL_REQUESTS,removeB.approval_id).status,'pending');
 assert.equal(f.db.getById(f.db.TABLES.USERS,'u_sa2').role,'super_admin');

 // A later promotion can make the pending approval safe again.
 execute(f,'user.changeRole',{user_id:'u_adm1',role:'super_admin'},'u_sa2');
 execute(f,'approval.approve',{approval_id:removeB.approval_id},'u_adm1');
 assert.equal(f.db.getById(f.db.TABLES.USERS,'u_sa2').role,'admin');
 assert.equal(f.db.getById(f.db.TABLES.USERS,'u_adm1').role,'super_admin');
 assert.equal(f.db.getById(f.db.TABLES.APPROVAL_REQUESTS,removeB.approval_id).status,'approved');
}));


test('strict payment mode refuses credit until a separately confirmed matching receipt exists',()=>run(f=>{
 const old=process.env.REQUIRE_RECONCILED_PAYMENTS;
 process.env.REQUIRE_RECONCILED_PAYMENTS='1';
 try {
  const before=fs.readFileSync(f.file,'utf8');
  checkError(()=>execute(f,'package.purchase',purchase()),409,'PAYMENT_UNVERIFIED');
  assert.equal(fs.readFileSync(f.file,'utf8'),before);
  const submitted=execute(f,'payment.submit',{
   payment_reference:'payment-001',student_id:'stu_1',course_id:'crs_1',
   amount:1800,account_destination:'进入公账'
  },'u_adm1').result;
  assert.equal(submitted.status,'pending');
  checkError(()=>execute(f,'package.purchase',purchase()),409,'PAYMENT_UNVERIFIED');
  checkError(()=>execute(f,'payment.confirm',{payment_reference:'payment-001',statement_reference:'stmt-001'},'u_adm1'),403,'FORBIDDEN');
  const verified=execute(f,'payment.confirm',{payment_reference:'payment-001',statement_reference:'stmt-001'},'u_sa1').result;
  assert.equal(verified.status,'confirmed');
  const result=execute(f,'package.purchase',purchase(),'u_adm1').result;
  assert.equal(result.package.total_amount,1800);
  assert.equal(f.db.getTable('business_write_events').find(row=>row.kind==='payment_receipt').status,'consumed');
  const ledger=f.db.getTable('business_write_events').find(row=>row.kind==='purchase');
  assert.equal(ledger.verification_status,'manually_reconciled');
  assert.equal(ledger.receipt_id,submitted.receipt_id);
  checkError(()=>execute(f,'package.purchase',purchase()),409,'BUSINESS_DUPLICATE');
 } finally {
  if(old===undefined)delete process.env.REQUIRE_RECONCILED_PAYMENTS;
  else process.env.REQUIRE_RECONCILED_PAYMENTS=old;
 }
}));

test('manual receipt must match student, course, amount and destination before credit',()=>run(f=>{
 const old=process.env.REQUIRE_RECONCILED_PAYMENTS;
 process.env.REQUIRE_RECONCILED_PAYMENTS='1';
 try {
  execute(f,'payment.submit',{
   payment_reference:'match-001',student_id:'stu_1',course_id:'crs_1',
   amount:1800,account_destination:'进入公账'
  },'u_adm1');
  execute(f,'payment.confirm',{payment_reference:'match-001',statement_reference:'stmt-match-001'});
  const current=f.db.getTable('business_write_events').find(r=>r.reference==='match-001');
  const before=fs.readFileSync(f.file,'utf8');
  for(const change of [
   {total_amount:1801},{student_id:'stu_2'},{course_id:'crs_2'},
   {account_destination:'进入个人账户'}
  ]) {
   checkError(()=>execute(f,'package.purchase',purchase({payment_reference:'match-001',...change})),409,'PAYMENT_MISMATCH');
   assert.equal(fs.readFileSync(f.file,'utf8'),before);
   assert.equal(current.status,'confirmed');
  }
  execute(f,'package.purchase',purchase({payment_reference:'match-001'}));
 } finally {
  if(old===undefined)delete process.env.REQUIRE_RECONCILED_PAYMENTS;
  else process.env.REQUIRE_RECONCILED_PAYMENTS=old;
 }
}));

test('receipt registration and attestation require different authorized users and unique statements',()=>run(f=>{
 const pending={student_id:'stu_1',course_id:'crs_1',amount:1800,account_destination:'进入公账'};
 checkError(()=>execute(f,'payment.submit',{...pending,payment_reference:'forbidden-001'},'u_tch1'),403,'FORBIDDEN');
 checkError(()=>execute(f,'payment.submit',{...pending,payment_reference:'invalid amount',amount:1800},'u_adm1'),400,'INVALID_PARAMS');
 execute(f,'payment.submit',{...pending,payment_reference:'attest-001'},'u_sa1');
 checkError(()=>execute(f,'payment.confirm',{payment_reference:'attest-001',statement_reference:'bank-001'},'u_sa1'),403,'SELF_VERIFICATION');
 execute(f,'payment.confirm',{payment_reference:'attest-001',statement_reference:'bank-001'},'u_sa2');
 execute(f,'payment.submit',{...pending,payment_reference:'attest-002'},'u_adm1');
 checkError(()=>execute(f,'payment.confirm',{payment_reference:'attest-002',statement_reference:'bank-001'},'u_sa1'),409,'STATEMENT_DUPLICATE');
 checkError(()=>execute(f,'payment.submit',{...pending,payment_reference:'attest-001'},'u_adm1'),409,'PAYMENT_DUPLICATE');
 execute(f,'payment.reject',{payment_reference:'attest-002',reason:'银行对账记录缺失'},'u_sa1');
 checkError(()=>execute(f,'payment.confirm',{payment_reference:'attest-002',statement_reference:'bank-002'},'u_sa2'),409,'PAYMENT_STATE_CONFLICT');
 checkError(()=>execute(f,'package.purchase',purchase({payment_reference:'attest-002'})),409,'PAYMENT_UNVERIFIED');
}));

test('payment consumption and purchase share one atomic transaction even if ledger write fails',()=>run(f=>{
 const old=process.env.REQUIRE_RECONCILED_PAYMENTS;
 process.env.REQUIRE_RECONCILED_PAYMENTS='1';
 try {
  execute(f,'payment.submit',{
   payment_reference:'atomic-001',student_id:'stu_1',course_id:'crs_1',
   amount:1800,account_destination:'进入公账'
  },'u_adm1');
  execute(f,'payment.confirm',{payment_reference:'atomic-001',statement_reference:'bank-atomic-001'});
  const before=fs.readFileSync(f.file,'utf8');
  const insert=f.db.insert;
  f.db.insert=(table, record, ...rest)=>{
    if(table==='business_write_events' && record.kind==='purchase')throw new Error('INJECTED ledger write failure');
    return insert(table,record,...rest);
  };
  try {
   assert.throws(()=>execute(f,'package.purchase',purchase({payment_reference:'atomic-001'})),/INJECTED ledger write failure/);
  } finally {f.db.insert=insert}
  assert.equal(fs.readFileSync(f.file,'utf8'),before);
  const rows=f.db.getTable('business_write_events');
  assert.equal(rows.find(x=>x.reference==='atomic-001').status,'confirmed');
  assert.equal(rows.some(x=>x.kind==='purchase'),false);
  const accepted=execute(f,'package.purchase',purchase({payment_reference:'atomic-001'})).result;
  assert.ok(accepted.package.id);
 } finally {
  if(old===undefined)delete process.env.REQUIRE_RECONCILED_PAYMENTS;
  else process.env.REQUIRE_RECONCILED_PAYMENTS=old;
 }
}));

test('legacy purchase is labeled unverified rather than falsely claimed as bank-confirmed',()=>run(f=>{
 const old=process.env.REQUIRE_RECONCILED_PAYMENTS;
 delete process.env.REQUIRE_RECONCILED_PAYMENTS;
 try {
  execute(f,'package.purchase',purchase());
  const ledger=f.db.getTable('business_write_events').find(x=>x.kind==='purchase');
  assert.equal(ledger.verification_status,'unverified_legacy');
  assert.equal(ledger.receipt_id,null);
  checkError(()=>execute(f,'payment.submit',{payment_reference:'payment-001',
    student_id:'stu_1',course_id:'crs_1',amount:1800,account_destination:'进入公账'},'u_adm1'),409,'PAYMENT_DUPLICATE');
 } finally {
  if(old!==undefined)process.env.REQUIRE_RECONCILED_PAYMENTS=old;
 }
}));


test('zero-fee term rollover changes only the target term and is single-use across keys',()=>run(f=>{
  const params={package_id:'pkg_1',target_term_id:'term_summer_2026',top_up_fee:0,remark:'免补费顺延'};
  const before=f.db.getById(f.db.TABLES.COURSE_PACKAGES,'pkg_1');
  const priorHours=[before.paid_hours_left,before.gift_hours_left,before.debt_hours];
  const result=execute(f,'finance.rollover',params,'u_adm1').result;
  assert.equal(result.target_term_id,'term_summer_2026');
  const after=f.db.getById(f.db.TABLES.COURSE_PACKAGES,'pkg_1');
  assert.equal(after.expire_date,'2026-08-31');
  assert.equal(after.term_id,'term_summer_2026');
  assert.deepEqual([after.paid_hours_left,after.gift_hours_left,after.debt_hours],priorHours);
  const records=f.db.getTable(f.db.TABLES.TERM_ROLLOVER_RECORDS);
  assert.equal(records.filter(row=>row.package_id==='pkg_1').length,1);
  assert.equal(records.find(row=>row.package_id==='pkg_1').top_up_fee,0);
  const saved=fs.readFileSync(f.file,'utf8');
  checkError(()=>execute(f,'finance.rollover',params,'u_adm1'),409,'ROLLOVER_TARGET_CONFLICT');
  assert.equal(fs.readFileSync(f.file,'utf8'),saved);
}));

test('rollover rejects unverified topup, earlier terms, locked packages and teachers without any writes',()=>run(f=>{
  const base={package_id:'pkg_1',target_term_id:'term_summer_2026',top_up_fee:0};
  const before=fs.readFileSync(f.file,'utf8');
  checkError(()=>execute(f,'finance.rollover',{...base,top_up_fee:100},'u_adm1'),409,'ROLLOVER_TOPUP_UNVERIFIED');
  checkError(()=>execute(f,'finance.rollover',{...base,target_term_id:'term_spring_2026'},'u_adm1'),409,'ROLLOVER_TARGET_CONFLICT');
  checkError(()=>execute(f,'finance.rollover',base,'u_tch1'),403,'FORBIDDEN');
  checkError(()=>execute(f,'finance.rollover',{...base,unknown:true},'u_adm1'),400,'INVALID_PARAMS');
  assert.equal(fs.readFileSync(f.file,'utf8'),before);
  f.db.update(f.db.TABLES.COURSE_PACKAGES,'pkg_1',{lock_status:'pending_approval_locked'});
  const locked=fs.readFileSync(f.file,'utf8');
  checkError(()=>execute(f,'finance.rollover',base,'u_sa1'),409,'ROLLOVER_LOCKED');
  assert.equal(fs.readFileSync(f.file,'utf8'),locked);
}));

test('salary generation is one draft per teacher and month, requires a super admin',()=>run(f=>{
  const p={teacher_id:'u_tch2',period:'2026-03'};
  checkError(()=>execute(f,'salary.generate',p,'u_adm1'),403,'FORBIDDEN');
  checkError(()=>execute(f,'salary.generate',{...p,auto_settle:true}),400,'INVALID_PARAMS');
  checkError(()=>execute(f,'salary.generate',{...p,period:'2026-13'}),400,'INVALID_PARAMS');
  const created=execute(f,'salary.generate',p).result;
  assert.equal(created.status,'draft');
  assert.equal(created.teacher_id,'u_tch2');
  assert.equal(f.db.getTable(f.db.TABLES.SALARY_SETTLEMENTS).filter(x=>
    x.teacher_id==='u_tch2'&&x.period==='2026-03').length,1);
  const before=fs.readFileSync(f.file,'utf8');
  checkError(()=>execute(f,'salary.generate',p),409,'SALARY_PERIOD_DUPLICATE');
  assert.equal(fs.readFileSync(f.file,'utf8'),before);
  checkError(()=>execute(f,'salary.generate',{teacher_id:'u_adm1',period:'2026-03'}),409,'SALARY_TEACHER_INVALID');
  assert.equal(fs.readFileSync(f.file,'utf8'),before);
}));

test('salary settlement locks once and refuses reused fees without changing the version',()=>run(f=>{
  const created=execute(f,'salary.generate',{teacher_id:'u_tch2',period:'2026-03'}).result;
  checkError(()=>execute(f,'salary.settle',{settlement_id:created.settlement_id},'u_adm1'),403,'FORBIDDEN');
  const settled=execute(f,'salary.settle',{settlement_id:created.settlement_id}).result;
  assert.equal(settled.status,'settled');
  assert.equal(f.db.getById(f.db.TABLES.SALARY_SETTLEMENTS,created.settlement_id).status,'settled');
  const saved=fs.readFileSync(f.file,'utf8');
  checkError(()=>execute(f,'salary.settle',{settlement_id:created.settlement_id}),409,'SALARY_SETTLEMENT_LOCKED');
  assert.equal(fs.readFileSync(f.file,'utf8'),saved);
}));

test('salary settling stale draft with already-settled fee refuses atomically',()=>run(f=>{
  const fee=f.db.insert(f.db.TABLES.TEACHER_LESSON_FEES,{
    id:'fee-stale-draft-test',teacher_id:'u_tch2',lesson_date:'2026-03-10',
    calculated_teacher_fee:160,fee_type:'regular',is_substitute:false,
    effective_headcount:2,is_revoked:false,settlement_status:'pending'
  });
  const draft=execute(f,'salary.generate',{teacher_id:'u_tch2',period:'2026-03'}).result;
  f.db.update(f.db.TABLES.TEACHER_LESSON_FEES,fee.id,{settlement_status:'settled'});
  const target=f.db.getById(f.db.TABLES.SALARY_SETTLEMENTS,draft.settlement_id);
  f.db.update(f.db.TABLES.SALARY_SETTLEMENTS,target.id,{lesson_fee_ids:[fee.id]});
  const saved=fs.readFileSync(f.file,'utf8');
  checkError(()=>execute(f,'salary.settle',{settlement_id:draft.settlement_id}),409,'SALARY_DETAIL_CONFLICT');
  assert.equal(fs.readFileSync(f.file,'utf8'),saved);
}));

test('salary creation and rollover honor exact idempotency envelope replay',()=>run(f=>{
  const p={command:'salary.generate',params:{teacher_id:'u_tch2',period:'2026-03'},
    idempotencyKey:'salary-replay-stable-123456',expectedVersion:f.db.getWriteState().version};
  const req=f.req('u_sa1');
  const first=f.commands.execute(req,p);
  const saved=fs.readFileSync(f.file,'utf8');
  const second=f.commands.execute(req,p);
  assert.equal(second.replayed,true);
  assert.equal(second.result.settlement_id,first.result.settlement_id);
  assert.equal(fs.readFileSync(f.file,'utf8'),saved);
  const r={command:'finance.rollover',
    params:{package_id:'pkg_1',target_term_id:'term_summer_2026',top_up_fee:0},
    idempotencyKey:'rollover-replay-stable-123456',expectedVersion:f.db.getWriteState().version};
  const req2=f.req('u_adm1');
  const one=f.commands.execute(req2,r);
  const save2=fs.readFileSync(f.file,'utf8');
  const two=f.commands.execute(req2,r);
  assert.equal(two.replayed,true);
  assert.equal(two.result.rollover_id,one.result.rollover_id);
  assert.equal(fs.readFileSync(f.file,'utf8'),save2);
}));


test('salary locking rejects new fee added after draft and preserves draft data',()=>run(f=>{
  const draft=execute(f,'salary.generate',{teacher_id:'u_tch2',period:'2026-03'}).result;
  f.db.insert(f.db.TABLES.TEACHER_LESSON_FEES,{
    id:'fee-arrived-after-draft',teacher_id:'u_tch2',
    lesson_date:'2026-03-18',calculated_teacher_fee:180,
    fee_type:'regular',is_substitute:false,settlement_status:'pending'
  });
  const before=fs.readFileSync(f.file,'utf8');
  checkError(()=>execute(f,'salary.settle',{settlement_id:draft.settlement_id}),
    409,'SALARY_DRAFT_STALE');
  assert.equal(fs.readFileSync(f.file,'utf8'),before);
  assert.equal(f.db.getById(f.db.TABLES.SALARY_SETTLEMENTS,draft.settlement_id).status,'draft');
}));

test('salary locking rejects changes to fee amount after creating draft',()=>run(f=>{
  f.db.insert(f.db.TABLES.TEACHER_LESSON_FEES,{
    id:'fee-changed-after-draft',teacher_id:'u_tch2',
    lesson_date:'2026-03-18',calculated_teacher_fee:180,
    fee_type:'regular',is_substitute:false,settlement_status:'pending'
  });
  const draft=execute(f,'salary.generate',{teacher_id:'u_tch2',period:'2026-03'}).result;
  f.db.update(f.db.TABLES.TEACHER_LESSON_FEES,'fee-changed-after-draft',{
    calculated_teacher_fee:200
  });
  const before=fs.readFileSync(f.file,'utf8');
  checkError(()=>execute(f,'salary.settle',{settlement_id:draft.settlement_id}),
    409,'SALARY_DRAFT_STALE');
  assert.equal(fs.readFileSync(f.file,'utf8'),before);
}));

test('salary locking rejects approved adjustment created after a draft',()=>run(f=>{
  const draft=execute(f,'salary.generate',{teacher_id:'u_tch2',period:'2026-03'}).result;
  f.db.insert(f.db.TABLES.SALARY_ADJUSTMENTS,{
    id:'adj-after-draft',teacher_id:'u_tch2',
    signed_amount:50,status:'approved_pending_settlement'
  });
  const before=fs.readFileSync(f.file,'utf8');
  checkError(()=>execute(f,'salary.settle',{settlement_id:draft.settlement_id}),
    409,'SALARY_DRAFT_STALE');
  assert.equal(fs.readFileSync(f.file,'utf8'),before);
}));

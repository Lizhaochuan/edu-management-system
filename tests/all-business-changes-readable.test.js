'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {auditChange}=require('../services/auditDisplay');
const {formatApprovalChange}=require('../services/approvalDisplay');
const ROOT=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(ROOT,file),'utf8');

test('actual tier-rate audit updates become understandable Chinese comparisons',()=>{
  const result=auditChange({
    action:'UPDATE',target_table:'teacher_tiers',
    before_snapshot_json:JSON.stringify({id:'tier1',name:'初级教师',
      headcount_rates_json:{1:100,2:140,3:180},updated_at:'earlier'}),
    after_snapshot_json:JSON.stringify({id:'tier1',name:'初级教师',
      headcount_rates_json:{1:110,2:150,3:190},updated_at:'now'})
  });
  assert.equal(result.title,'修改 · 教师课酬档位');
  assert.deepEqual(result.rows.map(x=>[x.label,x.beforeText,x.afterText]),[
    ['1 人出勤课酬','¥100 元/课时','¥110 元/课时'],
    ['2 人出勤课酬','¥140 元/课时','¥150 元/课时'],
    ['3 人出勤课酬','¥180 元/课时','¥190 元/课时']
  ]);
  assert.doesNotMatch(JSON.stringify(result),/headcount_rates_json|updated_at|tier1/);
});

test('student hour, debt and salary audit records retain numeric business values',()=>{
  const lookups={students:[{id:'stu1',name:'小林'}],users:[{id:'teacher1',name:'李老师'}]};
  const hours=auditChange({
    action:'UPDATE',target_table:'course_packages',
    before_snapshot_json:{student_id:'stu1',paid_hours_left:12,gift_hours_left:3,debt_hours:0},
    after_snapshot_json:{student_id:'stu1',paid_hours_left:10.5,gift_hours_left:3,debt_hours:1}
  },lookups);
  assert.ok(hours.rows.some(r=>r.label==='剩余付费课时' &&
    r.beforeText==='12 课时'&&r.afterText==='10.5 课时'));
  assert.ok(hours.rows.some(r=>r.label==='累计欠课时' && r.afterText==='1 课时'));
  const salary=auditChange({
    action:'UPDATE',target_table:'salary_settlements',
    before_snapshot_json:{teacher_id:'teacher1',status:'draft',total_salary:1200},
    after_snapshot_json:{teacher_id:'teacher1',status:'settled',total_salary:1200}
  },lookups);
  assert.ok(salary.rows.some(x=>x.label==='记录状态'&&x.beforeText==='待核对草稿'&&x.afterText==='已结算'));
  assert.equal(salary.rows.some(x=>x.label==='本期应发工资'),false,
    'Unchanged salary amount must not pretend to be modified');
});

test('audit new and deleted records have truthful before and after labels',()=>{
  const insert=auditChange({
    action:'INSERT',target_table:'students',
    before_snapshot_json:null,after_snapshot_json:{id:'s1',name:'小芳',created_at:'now'}
  });
  assert.ok(insert.rows.some(x=>x.label==='姓名／名称' &&
    x.beforeText==='新记录，无原值'&&x.afterText==='小芳'));
  const removed=auditChange({
    action:'REMOVE',target_table:'students',
    before_snapshot_json:{id:'s1',name:'小芳'},after_snapshot_json:null
  });
  assert.ok(removed.rows.some(x=>x.beforeText==='小芳'&&x.afterText==='记录已删除'));
});

test('audit strips secrets, raw nested data, tokens and unsupported technical fields',()=>{
  const r=auditChange({
    action:'INSERT',target_table:'users',
    before_snapshot_json:null,
    after_snapshot_json:{name:'测试教师',role:'teacher',password_hash:'hash-FAKE-SECRET',
      session_token:'token-FAKE-SECRET',id:'u1',internal_json:{password:'private'},
      api_key:'fake-key',phone:'13800000000'}
  });
  const shown=JSON.stringify(r);
  assert.match(shown,/教师/);
  assert.doesNotMatch(shown,/FAKE-SECRET|13800000000|internal_json|password_hash|session_token|api_key|u1/);
  assert.match(r.note,/内部字段/);
});

test('audit corrupted historical JSON never appears in the user interface',()=>{
  const record=auditChange({
    action:'UPDATE',target_table:'course_packages',
    before_snapshot_json:'{invalid-private-raw',
    after_snapshot_json:'{"paid_hours_left":10}'
  });
  assert.equal(record.rows.length,0);
  assert.match(record.note,/历史记录无法可靠解析/);
  assert.doesNotMatch(JSON.stringify(record),/invalid-private-raw/);
});

test('audit display prioritizes real data rather than printing long code structures',()=>{
  const changes={};
  for(let i=0;i<40;i++)changes['unknown_private_field_'+i]={secret:'should-not-show'};
  changes.paid_hours_left=4;
  const record=auditChange({
    action:'UPDATE',target_table:'course_packages',
    before_snapshot_json:{paid_hours_left:6},after_snapshot_json:changes
  });
  assert.equal(record.rows.length,1);
  assert.equal(record.rows[0].afterText,'4 课时');
  assert.doesNotMatch(JSON.stringify(record),/unknown_private_field|should-not-show/);
  assert.match(record.note,/核对/);
});

test('makeup-attendance approvals explain each student and attendance without technical JSON',()=>{
  const result=formatApprovalChange({
    request_type:'makeup_attendance',status:'pending',
    before_data_json:{schedule_id:'schedule_1',previous_status:'scheduled'},
    after_data_json:{schedule_id:'schedule_1',class_name:'自然拼读一班',
      attendance_inputs:[{student_id:'stu1',is_present:true,is_late:true},
        {student_id:'stu2',is_present:false}],
      reason:'教师漏签'}
  },{
    students:[{id:'stu1',name:'小林'},{id:'stu2',name:'小赵'}],
    schedules:[{id:'schedule_1',lesson_date:'2026-03-12',lesson_index:6}]
  });
  assert.ok(result.rows.some(x=>x.label==='申请补签的课次' &&
    x.afterText==='2026-03-12 的课程（第6次课）'));
  assert.ok(result.rows.some(x=>x.label==='补签学员：小林' && x.afterText==='出勤（迟到）'));
  assert.ok(result.rows.some(x=>x.label==='补签学员：小赵' && x.afterText==='缺勤'));
  assert.doesNotMatch(JSON.stringify(result),/student_id|is_present|attendance_inputs|schedule_id/);
});

test('all three mini-program screens have no raw JSON or programming snapshot panels',()=>{
  for(const file of ['pages/approval/index.wxml','pages/audit-logs/index.wxml',
    'pages/course-packages/index.wxml']){
    const source=read(file);
    assert.doesNotMatch(source,/beforeJsonText|afterJsonText|json-code|code-view|json-preview-box|deducted_detail_json|before_snapshot_json|after_snapshot_json|结构化留痕 JSON|变更前 \(Before\)/i,file);
  }
  assert.match(read('pages/audit-logs/index.wxml'),/wx:for="\{\{item\.rows\}\}"/);
  assert.match(read('pages/course-packages/index.wxml'),/本次扣课结果/);
  assert.match(read('pages/approval/index.wxml'),/申请新标准/);
  assert.doesNotMatch(read('pages/audit-logs/index.js'),/formatSnapshot\(|JSON\.stringify\(.*null\s*,\s*2\)/);
});

test('audit page loads the right translated rows without changing existing database records',()=>{
  const script=read('pages/audit-logs/index.js');
  let page;
  const originals=[{id:'audit_1',action:'UPDATE',target_table:'course_packages',
    action_time:'2026-03-10T10:00:00Z',
    before_snapshot_json:JSON.stringify({paid_hours_left:8}),
    after_snapshot_json:JSON.stringify({paid_hours_left:6}),
    description:'课时包扣除 2 课时'}];
  const snapshot=JSON.stringify(originals);
  const tables={AUDIT_LOGS:'audit_logs',USERS:'users',
    STUDENTS:'students',COURSES_AND_CLASS_TYPES:'courses',
    TERMS:'terms',TEACHER_TIERS:'tiers',CLASSES:'classes'};
  const db={TABLES:tables,getTable:key=>key==='audit_logs'?originals:[]};
  vm.runInNewContext(script,{Page:obj=>{page=obj;},
    require:id=>id.endsWith('/db')?db:id.includes('auditDisplay')?{auditChange}:null,
    getApp:()=>({globalData:{currentUser:{id:'u_sa1',role:'super_admin'}}}),
    wx:{getStorageSync:()=> 'test-token',showToast:()=>{},showModal:()=>{}}
  });
  page.setData=function(data,cb){Object.assign(this.data,data);if(cb)cb()};
  page.checkPermissionAndLoad();
  assert.equal(page.data.logs.length,1);
  assert.equal(page.data.logs[0].rows[0].label,'剩余付费课时');
  assert.equal(page.data.logs[0].rows[0].beforeText,'8 课时');
  assert.equal(page.data.logs[0].rows[0].afterText,'6 课时');
  assert.equal(Object.hasOwn(page.data.logs[0],'beforeText'),false);
  assert.equal(JSON.stringify(originals),snapshot,'reading audit must never mutate source logs');
});

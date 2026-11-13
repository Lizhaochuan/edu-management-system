'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {formatApprovalChange}=require('../services/approvalDisplay');

test('teacher rate approvals are expressed as Chinese amounts per teaching hour',()=>{
  const result=formatApprovalChange({
    status:'pending',
    before_data_json:JSON.stringify({name:'初级教师',headcount_rates_json:{1:100,2:140,3:180}}),
    after_data_json:JSON.stringify({name:'初级教师',headcount_rates_json:{1:110,2:150,3:190}})
  });
  assert.equal(result.title,'申请调整内容（待审批，尚未生效）');
  assert.deepEqual(result.rows.map(row=>[row.label,row.beforeText,row.afterText]),[
    ['1 人出勤课酬','¥100 / 课时','¥110 / 课时'],
    ['2 人出勤课酬','¥140 / 课时','¥150 / 课时'],
    ['3 人出勤课酬','¥180 / 课时','¥190 / 课时']
  ]);
  assert.doesNotMatch(JSON.stringify(result),/headcount_rates_json|before_data_json|after_data_json/);
});

test('only fields submitted in a partial patch are displayed, with human names',()=>{
  const result=formatApprovalChange({
    status:'pending',
    before_data_json:{course_name:'自然拼读',class_type_name:'小班',
      max_capacity:6,unit_price:120,hours_per_lesson:1.5},
    after_data_json:{max_capacity:8,unit_price:150}
  });
  assert.deepEqual(result.rows.map(x=>x.label),['班级人数上限','课程单价']);
  assert.deepEqual(result.rows.map(x=>x.beforeText),['6 人','¥120 元']);
  assert.deepEqual(result.rows.map(x=>x.afterText),['8 人','¥150 元']);
  assert.match(result.note,/未列出的原有设置保持不变/);
});

test('new items do not pretend to have previous financial values',()=>{
  const result=formatApprovalChange({
    status:'pending',before_data_json:null,
    after_data_json:{name:'高级教师',headcount_rates_json:{1:180,2:220}}
  });
  assert.deepEqual(result.rows.map(x=>x.beforeText),
    ['新建项目，无原标准','新建项目，无原标准','新建项目，无原标准']);
  assert.equal(result.rows[1].afterText,'¥180 / 课时');
});

test('approval status never falsely claims rejected or pending prices took effect',()=>{
  const after={unit_price:160};
  const previous={unit_price:120};
  assert.match(formatApprovalChange({status:'rejected',before_data_json:previous,after_data_json:after}).title,/未生效/);
  assert.match(formatApprovalChange({status:'pending',before_data_json:previous,after_data_json:after}).title,/尚未生效/);
  assert.match(formatApprovalChange({status:'approved',before_data_json:previous,after_data_json:after}).title,/审批通过/);
});

test('role/category/teacher changes are shown as business words, not record IDs',()=>{
  const lookup={users:[{id:'u_tch1',name:'林老师'}],
    tiers:[{id:'tier_junior',name:'初级教师'}]};
  const result=formatApprovalChange({
    status:'pending',
    before_data_json:{teacher_category:'ordinary',role:'teacher',teacher_tier_id:null},
    after_data_json:{teacher_category:'partner',role:'super_admin',teacher_tier_id:'tier_junior'}
  },lookup);
  assert.equal(result.rows[0].beforeText,'普通教师');
  assert.equal(result.rows[0].afterText,'合伙人教师');
  assert.equal(result.rows[1].afterText,'超级管理员');
  assert.equal(result.rows[2].afterText,'初级教师');
});

test('unknown or broken historical fields never dump JSON or untrusted raw data to screen',()=>{
  const abnormal=formatApprovalChange({
    status:'pending',
    before_data_json:'{BROKEN JSON sensitive-token',
    after_data_json:{secret_key:'private-secret-value'}
  });
  assert.equal(abnormal.rows.length,0);
  assert.match(abnormal.note,/格式异常/);
  assert.doesNotMatch(JSON.stringify(abnormal),/sensitive-token|private-secret-value/);
  const unknown=formatApprovalChange({
    status:'pending',
    before_data_json:{unlisted_private_record:'private-before'},
    after_data_json:{unlisted_private_record:'private-after'}
  });
  assert.equal(unknown.rows.length,0);
  assert.match(unknown.note,/核对原始记录/);
  assert.doesNotMatch(JSON.stringify(unknown),/private-before|private-after|unlisted_private_record/);
});

test('no comparable values explicitly points users to the approval reason',()=>{
  const missing=formatApprovalChange({
    status:'pending',before_data_json:null,after_data_json:null
  });
  assert.deepEqual(missing.rows,[]);
  assert.match(missing.note,/申请理由/);
  const same=formatApprovalChange({
    status:'approved',before_data_json:{max_capacity:6},
    after_data_json:{max_capacity:6}
  });
  assert.deepEqual(same.rows,[]);
  assert.match(same.note,/暂无可显示的差异/);
});

test('both mini-program approval tabs render readable rows, not raw JSON code panels',()=>{
  const root=path.resolve(__dirname,'..');
  const wxml=fs.readFileSync(path.join(root,'pages/approval/index.wxml'),'utf8');
  const wxss=fs.readFileSync(path.join(root,'pages/approval/index.wxss'),'utf8');
  const source=fs.readFileSync(path.join(root,'pages/approval/index.js'),'utf8');
  assert.equal((wxml.match(/wx:for="\{\{item\.rows\}\}"/g)||[]).length,2);
  assert.equal((wxml.match(/\{\{change\.label\}\}/g)||[]).length,2);
  assert.doesNotMatch(wxml,/beforeJsonText|afterJsonText|json-code|Before|After/);
  assert.doesNotMatch(wxss,/font-family:\s*monospace/);
  assert.doesNotMatch(source,/formatJson\(|beforeJsonText|afterJsonText/);
});

test('approval page populates readable change rows while preserving review controls',()=>{
  const root=path.resolve(__dirname,'..');
  const script=fs.readFileSync(path.join(root,'pages/approval/index.js'),'utf8');
  let page;
  const approvals=[{
    id:'approval_test',request_type:'config_change',status:'pending',
    proposer_id:'u_adm1',reason:'教师课酬标准调整',
    before_data_json:{headcount_rates_json:{1:100,2:140,3:180}},
    after_data_json:{headcount_rates_json:{1:110,2:150,3:190}}
  }];
  const TABLES={APPROVAL_REQUESTS:'approval_requests',USERS:'users',
    TEACHER_TIERS:'teacher_tiers',STUDENTS:'students',
    COURSES_AND_CLASS_TYPES:'courses',TERMS:'terms',CLASSES:'classes'};
  const db={TABLES,getTable:table=>table==='approval_requests'?approvals:
    table==='users'?[{id:'u_sa1',role:'super_admin',status:'active'},
      {id:'u_sa2',role:'super_admin',status:'active'}]:[]};
  vm.runInNewContext(script,{
    Page:o=>{page=o;},require:p=>p.endsWith('/db')?db:
      p.includes('approvalDisplay')?{formatApprovalChange}: {refresh:async()=>{},recoverPending:async()=>{}},
    getApp:()=>({globalData:{currentUser:{id:'u_sa1',role:'super_admin'}}}),
    wx:{getStorageSync:()=> 'test-token',showModal:()=>{},showToast:()=>{}}
  });
  page.setData=function(next,cb){Object.assign(this.data,next);if(cb)cb()};
  page.data.currentUser={id:'u_sa1',role:'super_admin'};
  page.loadApprovalList();
  assert.equal(page.data.pendingList.length,1);
  assert.equal(page.data.pendingList[0].rows.length,3);
  assert.equal(page.data.pendingList[0].hasRolePermission,true);
  assert.equal(page.data.pendingList[0].rows[0].afterText,'¥110 / 课时');
  assert.equal(Object.hasOwn(page.data.pendingList[0],'beforeJsonText'),false);
});

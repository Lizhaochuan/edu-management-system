'use strict';

// Display-only translation. The underlying approval snapshots remain unchanged
// for audit, permission checks, and business transaction verification.
const FIELDS = {
  name:['名称','text'],
  course_name:['课程名称','text'],
  class_type_name:['班型名称','text'],
  term_type:['学期类型','text'],
  fixed_expire_date:['学期到期日','date'],
  expire_date:['课时包到期日','date'],
  teacher_category:['教师类别','category'],
  teacher_tier_id:['适用教师薪酬档位','tier'],
  teacher_id:['教师','teacher'],
  student_id:['学员','student'],
  course_id:['课程','course'],
  term_id:['学期','term'],
  target_term_id:['转入学期','term'],
  account_destination:['收款账户','account'],
  max_capacity:['班级人数上限','person'],
  maxCapacity:['班级人数上限','person'],
  unit_price:['课程单价','yuan'],
  hours_per_lesson:['每次上课时长','hours'],
  paid_hours_delta:['付费课时变化','hours'],
  gift_hours_delta:['赠送课时变化','hours'],
  paid_hours_left:['剩余付费课时','hours'],
  gift_hours_left:['剩余赠送课时','hours'],
  freeze_days:['冻结天数','days'],
  total_frozen_days:['累计冻结天数','days'],
  handling_fee:['退费手续费','yuan'],
  amount:['金额','yuan'],
  total_amount:['金额合计','yuan'],
  hours_to_transfer:['转出课时','hours'],
  target_student_id:['转入学员','student'],
  target_course_id:['转入课程','course'],
  target_class_id:['转入班级','class'],
  refund_method:['退费方式','text'],
  direction:['调整方向','direction'],
  reason:['调整原因','text'],
  role:['账号角色','role'],
  status:['状态','status'],
  target_role:['调整后的账号角色','role']
};
const RATE_KEYS = ['headcount_rates_json','custom_tier_rates_json'];
const MAPPED = {
  category:{ordinary:'普通教师',partner:'合伙人教师'},
  role:{super_admin:'超级管理员',admin:'教务管理员',teacher:'教师',parent:'家长'},
  status:{active:'启用',inactive:'停用',disabled:'停用',pending:'待处理',approved:'已通过',
    rejected:'已驳回',settled:'已结算',draft:'待核对草稿'},
  direction:{add:'增加',deduct:'扣减',reissue:'补发',clawback:'扣回'},
  account:{'进入公账':'对公账户','进入个人账户':'个人账户'},
  term_type:{spring:'春季',summer:'暑假',autumn:'秋季',winter:'寒假'}
};
const RECORDS = {
  tier:['tiers','name'],teacher:['users','name'],student:['students','name'],
  course:['courses','course_name'],term:['terms','name'],class:['classes','class_name']
};
const OWN = Object.prototype.hasOwnProperty;
function own(obj,key) { return !!obj && OWN.call(obj,key); }
function object(value) { return value && typeof value==='object' && !Array.isArray(value); }
function parseSnapshot(raw) {
  if (raw===undefined || raw===null || raw==='') return {missing:true,value:null,invalid:false};
  if (typeof raw==='string') {
    try { raw=JSON.parse(raw); }
    catch (_) { return {missing:false,value:null,invalid:true}; }
  }
  if (!object(raw)) return {missing:false,value:null,invalid:true};
  return {missing:false,value:raw,invalid:false};
}
function numberText(value) {
  const n=Number(value);
  return Number.isFinite(n) ? String(n) : '数值需核对';
}
function renderValue(value,type,lookup) {
  if (value===undefined) return '原记录未提供';
  if (value===null || value==='') return '未设置';
  if (type==='yuan') return '¥'+numberText(value)+' / 单位';
  if (type==='person') return numberText(value)+' 人';
  if (type==='hours') return numberText(value)+' 课时';
  if (type==='days') return numberText(value)+' 天';
  if (type==='date') return String(value).slice(0,10);
  if (MAPPED[type]) {
    const translated=MAPPED[type][String(value)];
    return translated || '其他（请核对）';
  }
  if (RECORDS[type]) {
    const [list,label]=RECORDS[type];
    const row=(lookup[list]||[]).find(r=>r.id===value);
    return row && row[label] ? String(row[label]) : '相关记录（名称待核对）';
  }
  if (typeof value==='boolean') return value?'是':'否';
  if (typeof value==='string' || typeof value==='number') return String(value);
  return '详情需要人工核对';
}
function renderRates(raw) {
  if (typeof raw==='string') {
    try { raw=JSON.parse(raw); } catch (_) { return null; }
  }
  if (!object(raw)) return null;
  return raw;
}
function compareValues(a,b) { return JSON.stringify(a)===JSON.stringify(b); }
function statusHeading(status) {
  if (status==='pending') return '申请调整内容（待审批，尚未生效）';
  if (status==='rejected') return '申请调整内容（已驳回，未生效）';
  if (status==='approved') return '审批通过的调整内容';
  return '本次申请调整内容';
}
function formatApprovalChange(item, lookup={}) {
  const oldData=parseSnapshot(item.before_data_json);
  const newData=parseSnapshot(item.after_data_json);
  const rows=[];
  const unknown=[];
  if (newData.invalid || oldData.invalid) return {
    rows:[],title:statusHeading(item.status),
    note:'历史变更记录格式异常，无法可靠显示，请向管理员核实后再审批。'
  };
  if (newData.missing) return {
    rows:[],title:statusHeading(item.status),
    note:'该申请没有提供可直接比较的调整数值，请结合上方申请理由和对应业务记录核对。'
  };
  const before=oldData.value||{};
  const after=newData.value||{};
  const add=(label,from,to,kind,knownBefore)=>{
    if (knownBefore && compareValues(from,to)) return;
    rows.push({
      label,
      beforeText:knownBefore?renderValue(from,kind,lookup):(oldData.missing?'新建项目，无原标准':'原值未提供'),
      afterText:renderValue(to,kind,lookup),
      changed:true
    });
  };
  for (const key of Object.keys(after)) {
    if (RATE_KEYS.includes(key)) {
      const newRates=renderRates(after[key]);
      const oldRates=renderRates(before[key]) || {};
      if (!newRates) { unknown.push('rate'); continue; }
      const counts=Object.keys(newRates).filter(k=>/^[1-8]$/.test(k)).sort((a,b)=>Number(a)-Number(b));
      if (counts.length!==Object.keys(newRates).length) unknown.push('rate');
      for (const count of counts) {
        add(count+' 人出勤课酬',own(oldRates,count)?oldRates[count]:undefined,newRates[count],
          'rate',own(oldRates,count));
      }
      continue;
    }
    const field=FIELDS[key];
    if (!field) { unknown.push(key); continue; }
    const [label,kind]=field;
    // A change request can contain only a patch. Missing keys are not "deleted".
    if (kind==='yuan') {
      const known=own(before,key);
      if (known && compareValues(before[key],after[key])) continue;
      rows.push({
        label,
        beforeText:known?'¥'+numberText(before[key])+' 元':(oldData.missing?'新建项目，无原标准':'原值未提供'),
        afterText:'¥'+numberText(after[key])+' 元',
        changed:true
      });
    } else if (kind==='rate') {
      add(label,before[key],after[key],kind,own(before,key));
    } else {
      add(label,before[key],after[key],kind,own(before,key));
    }
  }
  // Rates are per teaching hour, not per lesson; avoid conflating both.
  rows.forEach(row=>{
    if (row.label.endsWith('人出勤课酬')) {
      const valueFrom=row.beforeText;
      const valueTo=row.afterText;
      row.beforeText=valueFrom==='原值未提供'||valueFrom==='新建项目，无原标准'?
        valueFrom:'¥'+numberText(valueFrom)+' / 课时';
      row.afterText='¥'+numberText(valueTo)+' / 课时';
    }
  });
  let note='';
  if (unknown.length) note='另有未适配的设置内容。为避免误读，请联系管理员核对原始记录。';
  else if (!rows.length) note='申请提供的数值与原记录一致，暂无可显示的差异；请核对申请理由。';
  else if (oldData.missing) note='这是新建申请，未列出原有配置；显示的金额为申请值。';
  else note='仅列出申请拟调整的项目；未列出的原有设置保持不变。';
  return {rows,title:statusHeading(item.status),note};
}
module.exports={formatApprovalChange,parseSnapshot};

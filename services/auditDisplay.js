'use strict';

// Read-only audit presentation: original snapshots stay available in the database,
// but only a reviewed list of business fields may be rendered to a human.
const { parseSnapshot } = require('./approvalDisplay');

const TABLE_NAMES = {
  users:'员工与账号', students:'学员', terms:'学期', teacher_tiers:'教师课酬档位',
  partner_teacher_rate_config:'合伙人教师课酬', courses_and_class_types:'课程与班型',
  classes:'班级', course_packages:'学员课时包',
  schedules_and_attendance:'排课及考勤', approval_requests:'审批申请',
  audit_logs:'操作审计', substitute_complaints:'代课与客诉',
  makeup_requests:'补签申请', teacher_lesson_fees:'教师课酬明细',
  salary_settlements:'教师工资单',salary_adjustments:'薪资调账',
  manual_hour_adjustments:'课时调整记录', transfer_records:'课时转移记录',
  refund_records:'学员退费记录',term_rollover_records:'学期顺延记录',
  business_write_events:'业务收款与操作记录'
};
const ACTIONS = {INSERT:'新增',UPDATE:'修改',REMOVE:'删除',INIT:'系统初始化'};
const FIELDS = {
  name:['姓名／名称','text'],student_name:['学员姓名','text'],
  teacher_name:['教师姓名','text'],course_name:['课程名称','text'],
  class_type_name:['班型名称','text'],class_name:['班级名称','text'],
  student_name_snapshot:['学员姓名','text'],course_name_snapshot:['课程名称','text'],
  term_name_snapshot:['学期名称','text'],
  role:['账号权限','role'],teacher_category:['教师类别','category'],
  teacher_tier_id:['教师薪酬档位','tier'],is_custom_rate:['独立课酬设置','boolean'],
  status:['记录状态','status'],approval_status:['审批状态','status'],
  lock_status:['课时包锁定状态','lock'],refund_status:['退费状态','status'],
  settlement_status:['课酬结算状态','status'],
  account_destination:['收款账户','account'],
  total_amount:['购课金额','yuan'],unit_price:['课程单价','yuan'],
  unit_price_snapshot:['购课课时单价','yuan'],rate_used:['实际课酬单价','yuanPerHour'],
  calculated_teacher_fee:['本次教师课酬','yuan'],
  total_salary:['本期应发工资','yuan'],base_salary:['基础课酬','yuan'],
  adjustment_amount:['调账金额','yuan'],signed_amount:['调账金额','yuan'],
  amount:['金额','yuan'],amount_cents:['到账金额','cents'],gross_refund:['应退学费','yuan'],
  net_refund:['实际退费','yuan'],net_refund_amount:['实际退费','yuan'],
  handling_fee:['手续费','yuan'],gross_refund_amount:['应退金额','yuan'],
  refund_amount:['退费金额','yuan'],top_up_fee:['补费金额','yuan'],
  top_up_amount:['补费金额','yuan'],total_paid:['累计付款','yuan'],
  paid_hours_left:['剩余付费课时','hours'],gift_hours_left:['剩余赠送课时','hours'],
  paid_hours_total:['购买付费课时','hours'],gift_hours_total:['赠送课时总量','hours'],
  paid_hours_used:['已使用付费课时','hours'],gift_hours_used:['已使用赠送课时','hours'],
  debt_hours:['累计欠课时','hours'],hours_needed:['本次需要课时','hours'],
  hours_deducted:['本次扣减课时','hours'],paid_deducted:['扣除付费课时','hours'],
  gift_deducted:['扣除赠送课时','hours'],debt_added:['新增欠课时','hours'],
  hours_to_transfer:['转出课时','hours'],transferred_total_hours:['已转出课时','hours'],
  remaining_paid_hours:['转出后剩余付费课时','hours'],
  remaining_gift_hours:['转出后剩余赠送课时','hours'],
  paid_hours_delta:['付费课时调整量','hours'],gift_hours_delta:['赠送课时调整量','hours'],
  freeze_days:['冻结天数','days'],total_frozen_days:['累计冻结天数','days'],
  effective_headcount:['实际出勤人数','persons'],attendee_count:['出勤人数','persons'],
  max_capacity:['班级人数上限','persons'],maxCapacity:['班级人数上限','persons'],
  hours_per_lesson:['每次课时数','hours'],
  expire_date:['课时到期日','date'],fixed_expire_date:['学期到期日','date'],
  start_date:['开始日期','date'],end_date:['结束日期','date'],
  lesson_date:['上课日期','date'],schedule_date:['排课日期','date'],
  settled_at:['工资锁定日期','date'],approved_time:['审批时间','date'],
  period:['工资结算月份','text'],term_type:['学期类别','term'],
  refund_method:['退款方式','text'],refund_reason:['退款理由','text'],
  reason:['申请理由','text'],reject_reason:['拒绝原因','text'],
  transfer_type:['转移方式','transfer'],direction:['调整方向','direction'],
  teacher_id:['教师','teacher'],student_id:['学员','student'],term_id:['学期','termName'],
  course_id:['课程','course'],class_id:['班级','class'],
  target_student_id:['转入学员','student'],target_course_id:['转入课程','course'],
  target_class_id:['转入班级','class'],
  submitted_by:['收款登记人','person'],confirmed_by:['收款核对人','person'],
  rejected_by:['收款拒绝人','person'],
  payment_reference:['付款参考号','reference'],reference:['业务参考号','reference'],
  payment_status:['付款核对状态','status'],verification_status:['付款核对情况','verification'],
  max_frozen_days:['最多可冻结天数','days'],
  is_substitute:['是否代课','boolean'],is_revoked:['是否撤销','boolean'],
  is_cancelled:['是否取消','boolean'],
  total_available_hours:['可用课时合计','hours'],
  attendance_status:['考勤状态','status'],
  is_present:['是否出勤','boolean'],is_late:['是否迟到','boolean'],
  is_early_leave:['是否早退','boolean'],
  lesson_index:['第几次课','ordinal'],
  total_frozen_days_after:['累计冻结天数','days'],
  target_unit_price:['转入课程单价','yuan'],
  target_paid_hours:['转入付费课时','hours'],
  target_gift_hours:['转入赠送课时','hours'],
  transferred_paid_value:['转出课时折算金额','yuan'],
  target_hours_per_lesson:['转入课程每次课时数','hours'],
  total_frozen_days:['累计冻结天数','days'],
  headcount_rates_json:['按出勤人数计算的教师课酬','rates'],
  custom_tier_rates_json:['教师个人课酬标准','rates'],
  paid_hours_after:['调整后剩余付费课时','hours'],
  gift_hours_after:['调整后剩余赠送课时','hours']
};
const EN = {
  role:{super_admin:'超级管理员',admin:'教务管理员',teacher:'教师',parent:'家长'},
  category:{ordinary:'普通教师',partner:'合伙人教师'},
  status:{active:'启用',inactive:'停用',disabled:'停用',pending:'待处理',
    approved:'已通过',rejected:'已驳回',draft:'待核对草稿',
    settled:'已结算',confirmed:'已核对',consumed:'已用于购课',
    refunded:'已退款',cancelled:'已取消',pending_approval_locked:'等待审批',
    pending_super_admin_approval:'待超管批准',approved_pending_settlement:'已批准待结算',
    scheduled:'待上课',completed:'课程已完成',pending_makeup_sign_approval:'待补签审批',
    pending_settlement:'待结算',unverified_legacy:'尚未核对付款'},
  lock:{normal:'正常',frozen:'已冻结',refunded:'已退费',
    pending_approval_locked:'等待审批锁定',unlocked:'正常'},
  account:{'进入公账':'对公账户','进入个人账户':'个人账户'},
  term:{spring:'春季',summer:'暑假',autumn:'秋季',winter:'寒假'},
  transfer:{transfer_student:'转给另一位学员',transfer_course:'转到另一门课程',
    transfer_class:'转到另一班级'},
  direction:{increase:'增加',decrease:'扣减',add:'增加',deduct:'扣减',
    reissue:'补发',clawback:'扣回'},
  verification:{manually_reconciled:'已人工核对',unverified_legacy:'未核对'}
};
const REFS={
  teacher:['users','name'],person:['users','name'],student:['students','name'],
  course:['courses','course_name'],class:['classes','class_name'],
  tier:['tiers','name'],termName:['terms','name']
};
const SKIP = new Set(['id','created_at','updated_at','operator_id','session_token',
  'auth_token','password','password_hash','secret','private_key','api_key',
  'receipt_id','audit_log_id','reference_id','target_record_id',
  'before_data_json','after_data_json','before_snapshot_json','after_snapshot_json',
  'details_snapshot_json','snapshot_balance_at_propose','snapshot_balance',
  'audit_hash','hmac','signature','__server_write_state','reason_code',
  'attachment','source_document','last_login_at','source_id','target_id',
  'submit_request_id','created_by','updated_by','entry_id','proposer_id',
  'approver_id','settlement_id','package_id','schedule_id','receipt_id',
  'statement_reference','statement_raw','statement_blob','credentials',
  'login_credentials','course_packages','users','audit_logs',
  'lesson_fee_ids','adjustment_ids','class_student_ids','student_ids',
  'attendance_inputs','headcount_snapshot_json','rate_snapshot_json',
  'locked_by_approval_id','source_package_id','business_write_events']);
function owns(o,k) {return Object.prototype.hasOwnProperty.call(o,k);}
function equivalent(a,b) {return JSON.stringify(a)===JSON.stringify(b);}
function safeNumber(value) {
  if(value===null||value===undefined||value==='') return null;
  const n=Number(value);
  return Number.isFinite(n)?String(n):null;
}
function friendly(value,type,lookups) {
  if(value===null||value===undefined||value==='')return '未设置';
  if(type==='boolean')return value===true?'是':value===false?'否':'需核对';
  const units={yuan:' 元',yuanPerHour:' 元/课时',hours:' 课时',days:' 天',persons:' 人',ordinal:' 次课'};
  if(owns(units,type)){
    const n=safeNumber(value);
    return n===null?'金额或数量待核对':(type.startsWith('yuan')?'¥':'')+n+units[type];
  }
  if(type==='cents'){
    const n=Number(value);
    return Number.isInteger(n)&&n>=0?'¥'+(n/100).toFixed(2)+' 元':'金额待核对';
  }
  if(type==='date')return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}/.test(value)?
    value.slice(0,10):'日期待核对';
  if(owns(EN,type))return owns(EN[type],String(value))?EN[type][String(value)]:'状态或选项待核对';
  if(owns(REFS,type)) {
    const [table,field]=REFS[type];
    const match=(lookups[table]||[]).find(x=>x.id===value);
    return match&&match[field]?String(match[field]):'相关人员或业务记录（名称待核对）';
  }
  if(type==='reference')return typeof value==='string' && /^[A-Za-z0-9_-]{1,100}$/.test(value)?
    '已登记（详情见相关业务记录）':'参考信息待核对';
  if(type==='text') {
    if(typeof value!=='string' && typeof value!=='number')return '详情需核对';
    const s=String(value);
    return s.length<=200 && !/[\{\}\[\]<>]/.test(s) ? s : '详细内容需核对';
  }
  return '详情需核对';
}
function auditChange(log,lookups={}) {
  const before=parseSnapshot(log.before_snapshot_json);
  const after=parseSnapshot(log.after_snapshot_json);
  const mode=log.action;
  const title=(ACTIONS[mode]||'业务操作')+' · '+(TABLE_NAMES[log.target_table]||'其他业务记录');
  if(before.invalid||after.invalid){
    return {title,rows:[],note:'历史记录无法可靠解析。原始内容仍保存在审计系统中，请授权人员核对。'};
  }
  const prior=before.value||{},current=after.value||{};
  // Updates compare complete records; insert/remove show only the state that exists.
  const isRemoved=mode==='REMOVE', isInsert=mode==='INSERT';
  const active=isRemoved?prior:current;
  const rows=[];let skipped=0;
  for(const key of Object.keys(active)){
    if(SKIP.has(key) || /(?:password|token|secret|credential|private|hash|signature)/i.test(key))continue;
    if(key==='headcount_rates_json'||key==='custom_tier_rates_json') {
      let from=prior[key],to=current[key];
      try{if(typeof from==='string')from=JSON.parse(from);if(typeof to==='string')to=JSON.parse(to);}catch(_){skipped++;continue;}
      if((from&&!isPlain(from))||(to&&!isPlain(to))){skipped++;continue;}
      const rates=isRemoved?(from||{}):(to||{});
      for(const count of Object.keys(rates).filter(c=>/^[1-8]$/.test(c)).sort((a,b)=>Number(a)-Number(b))) {
        if(!isInsert&&!isRemoved&&equivalent(from&&from[count],to&&to[count]))continue;
        rows.push({label:count+' 人出勤课酬',beforeText:isInsert?'未设置':friendly(from?.[count],'yuanPerHour',lookups),
          afterText:isRemoved?'记录已删除':friendly(to?.[count],'yuanPerHour',lookups)});
      }
      continue;
    }
    const spec=FIELDS[key];
    if(!spec){skipped++;continue;}
    if(spec[1]==='rates'){skipped++;continue;}
    if(!isInsert&&!isRemoved&&equivalent(prior[key],current[key]))continue;
    rows.push({label:spec[0],
      beforeText:isInsert?'新记录，无原值':friendly(prior[key],spec[1],lookups),
      afterText:isRemoved?'记录已删除':friendly(current[key],spec[1],lookups)});
  }
  const display=rows.slice(0,20);
  let note='';
  if(rows.length>20)note+='本条操作还有 '+(rows.length-20)+' 项变化未展开显示。';
  if(skipped)note+='部分内部字段或无法准确解释的明细未直接展示，可由授权人员按审计原记录核对。';
  if(!rows.length)note+=isInsert?'记录已建立，未发现可安全展示的业务字段。':
    isRemoved?'记录已删除，详细内容未在界面显示。':
    '本次未发现可安全展示的业务字段变化；请参考操作说明。';
  return {title,rows:display,note};
}
function isPlain(value){return !!value&&typeof value==='object'&&!Array.isArray(value);}
module.exports={auditChange};

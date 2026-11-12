
'use strict';
const db=require('./db');
const configs=require('./systemConfigService');
const transfers=require('./transferRefundService');
const salary=require('./salaryEngineService');
// No client-selected tables or patches. Each proposal uses a fixed domain service.
const definitions={
 'config.term':[configs,'submitTermExpireDateRequest',false,['termId','newExpireDate','reason']],
 'config.courseCreate':[configs,'submitCreateCourseClassTypeRequest',false,['course_name','class_type_name','max_capacity','unit_price','hours_per_lesson','reason']],
 'config.courseUpdate':[configs,'submitUpdateCourseClassTypeRequest',true,['max_capacity','unit_price','hours_per_lesson','reason']],
 'config.partnerRates':[configs,'submitPartnerTeacherRatesRequest',false,['headcount_rates_json','reason']],
 'config.teacherCategory':[configs,'submitTeacherCategoryRequest',true,['teacher_category','teacher_tier_id','reason']],
 'config.tierCreate':[configs,'submitCreateTeacherTierRequest',false,['name','headcount_rates_json','maxCapacity','reason']],
 'config.tierUpdate':[configs,'submitUpdateTeacherTierRequest',true,['name','headcount_rates_json','maxCapacity','reason']],
 'config.teacherRates':[configs,'submitTeacherCustomRateRequest',true,['custom_tier_rates_json','maxCapacity','reason']],
 'config.teacherReset':[configs,'submitTeacherResetTierRequest',true,['reason']],
 'freeze':[transfers,'submitFreezeRequest',false,['package_id','freeze_days','start_date','reason']],
 'adjustHours':[transfers,'submitManualHourAdjust',false,['package_id','direction','paid_hours_delta','gift_hours_delta','reason']],
 'transfer':[transfers,'submitTransferRequest',false,['package_id','transfer_type','hours_to_transfer','target_student_id','target_course_id','target_class_id','remainder_option','reason']],
 'refund':[transfers,'submitRefundRequest',false,['package_id','handling_fee','refund_method','refund_reason','reason']],
 'salaryAdjustment':[salary,'createSalaryAdjustment',false,['teacher_id','direction','amount','reason','related_schedule_id','related_settlement_id']]
};
const numericKeys=new Set(['max_capacity','unit_price','hours_per_lesson','maxCapacity','freeze_days','paid_hours_delta','gift_hours_delta','hours_to_transfer','handling_fee','amount']);
function validValue(key,value){
 if(value===null || value===undefined)return true;
 if(numericKeys.has(key)){
  if(!['number','string'].includes(typeof value))return false;
  if(typeof value==='string'&&!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(value))return false;
  const n=Number(value);
  if(!Number.isFinite(n)||n<0||n>100000000||Math.abs(n*100-Math.round(n*100))>0.000001)return false;
  return !['max_capacity','maxCapacity','freeze_days'].includes(key)||Number.isInteger(n);
 }
 if(['newExpireDate','start_date'].includes(key)){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
  const parsed=new Date(value+'T00:00:00.000Z');
  return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;
 }
 if(key.endsWith('_json')){try{require('./salaryRateConfig').normalizeManualRates(value);return true}catch(_e){return false}}
 return typeof value==='string'&&value.length<=500;
}
module.exports={definitions,
 validate(p){
  if(!p||typeof p!=='object'||Array.isArray(p)||!Object.hasOwn(definitions,p.type))return false;
  const spec=definitions[p.type];
  if(Object.keys(p).some(k=>!['type','target_id','data'].includes(k)) || (!spec[2] && Object.hasOwn(p,'target_id')) || (spec[2] && (typeof p.target_id!=='string'|| !/^[A-Za-z0-9_-]{1,100}$/.test(p.target_id))))return false;
  if(!p.data||typeof p.data!=='object'||Array.isArray(p.data))return false;
  return Object.keys(p.data).every(k=>spec[3].includes(k)&&validValue(k,p.data[k]));
 },
 handle({params:p,operator}){
  if(p.type==='salaryAdjustment'&&operator.role!=='super_admin'){const error=new Error('仅超管可申请薪资调账');error.status=403;error.code='FORBIDDEN';throw error;}
  const [service,method,target]=definitions[p.type];
  const prior=db.getTable(db.TABLES.APPROVAL_REQUESTS).filter(a=>a.status==='pending');
  const result=target ? service[method](p.target_id,p.data) : service[method](p.data,operator);
  const previousIds=new Set(prior.map(a=>a.id));
  const added=db.getTable(db.TABLES.APPROVAL_REQUESTS).filter(a=>a.status==='pending'&&!previousIds.has(a.id));
  for(const a of added) {
    if(prior.some(old=>old.proposer_id===operator.id&&old.request_type===a.request_type&&old.config_subtype===a.config_subtype&&old.target_table===a.target_table&&old.target_record_id&&old.target_record_id===a.target_record_id)) throw new Error('同一业务目标已有待处理申请');
  }
  return result;
 }
};

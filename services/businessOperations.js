'use strict';
const db = require('./db');
const attendance = require('./attendanceService');
const packages = require('./packageAccountService');
const configs = require('./systemConfigService');
const transfers = require('./transferRefundService');
const salary = require('./salaryEngineService');
const T = db.TABLES;
const superAdminPolicy = require('./superAdminPolicy');
const LEDGER = 'business_write_events';
const id = x => typeof x === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(x);
const text = (x, max = 500) => typeof x === 'string' && x.trim().length > 0 && x.length <= max;
const number = (x, min = 0) => typeof x === 'number' && Number.isFinite(x) && x >= min && x <= 100000000 && Math.abs(x * 100 - Math.round(x * 100)) < 0.000001;
const object = (p, required, optional = []) => p && typeof p === 'object' && !Array.isArray(p) && required.every(k => Object.hasOwn(p, k)) && Object.keys(p).every(k => required.includes(k) || optional.includes(k));
const admin = u => ['admin', 'super_admin'].includes(u.role);
const teaching = u => admin(u) || u.role === 'teacher';
const attendanceParams = p => object(p, ['schedule_id', 'attendance_inputs'], ['reason']) && id(p.schedule_id) && Array.isArray(p.attendance_inputs) && p.attendance_inputs.length <= 200 &&
  p.attendance_inputs.every(x => object(x, ['student_id', 'is_present'], ['is_late', 'is_early_leave']) && id(x.student_id) && typeof x.is_present === 'boolean' && ['is_late', 'is_early_leave'].every(k => x[k] === undefined || typeof x[k] === 'boolean'));

module.exports = ({ fail }) => {
  const reject = (message, status = 400, code = 'BUSINESS_REJECTED') => fail(status, code, message);
  const get = (table, key) => db.getById(table, key) || reject('业务记录不存在', 404, 'NOT_FOUND');
  function sheet(p, operator, expectedStatus) {
    const s = get(T.SCHEDULES_AND_ATTENDANCE, p.schedule_id);
    const cls = get(T.CLASSES, s.class_id);
    const teacher = s.substitute_teacher_id || s.teacher_id || cls.teacher_id;
    if (!admin(operator) && teacher !== operator.id) reject('只能操作本人任教课次', 403, 'FORBIDDEN');
    if (s.is_settled || db.getTable(T.TEACHER_LESSON_FEES).some(f => f.schedule_id === s.id && (f.is_settled || f.settlement_status === 'settled'))) reject('已结算课次禁止修改', 409, 'LESSON_LOCKED');
    if (s.status !== expectedStatus) reject('课次状态已变化，禁止重复签到', 409, 'LESSON_STATE_CONFLICT');
    const ids = [...(cls.enrolled_student_ids || []), ...(cls.trial_student_ids || []), ...(s.makeup_students || []).map(x => x.student_id)];
    const submitted = p.attendance_inputs.map(x => x.student_id);
    if (new Set(submitted).size !== submitted.length || new Set(ids).size !== ids.length || submitted.length !== ids.length || submitted.some(x => !ids.includes(x))) reject('出勤名单必须覆盖且仅包含当前课次学员');
    return s;
  }
  function unique(kind, ref) {
    if (db.getTable(LEDGER).some(x => x.kind === kind && x.reference === ref)) reject('同一业务凭据已执行', 409, 'BUSINESS_DUPLICATE');
  }
  function configGuard(a) {
    const allowed = {
      [T.TERMS]: ['fixed_expire_date'],
      [T.TEACHER_TIERS]: ['name', 'headcount_rates_json', 'status'],
      [T.COURSES_AND_CLASS_TYPES]: ['course_name', 'class_type_name', 'max_capacity', 'unit_price', 'hours_per_lesson', 'status'],
      [T.PARTNER_TEACHER_RATE_CONFIG]: ['id','headcount_rates_json', 'status'],
      [T.USERS]: ['teacher_category', 'teacher_tier_id', 'is_custom_rate', 'custom_tier_rates_json']
    };
    const patch = typeof a.after_data_json === 'string' ? JSON.parse(a.after_data_json) : a.after_data_json;
    if (!allowed[a.target_table] || !object(patch, [], allowed[a.target_table]) || !Object.keys(patch).length) reject('审批配置目标或字段不在白名单');
    if (a.target_table === T.PARTNER_TEACHER_RATE_CONFIG && patch.id && patch.id !== 'partner_teacher') reject('合伙人配置ID无效');
    if (a.target_table === T.USERS && get(T.USERS, a.target_record_id).role !== 'teacher') reject('仅允许修改教师薪酬配置');
    if (a.target_record_id && a.before_data_json) {
      const before = typeof a.before_data_json === 'string' ? JSON.parse(a.before_data_json) : a.before_data_json;
      const current = get(a.target_table,a.target_record_id);
      for (const key of allowed[a.target_table]) {
        if (!Object.hasOwn(before,key)) continue;
        const actual = current[key] === undefined && key === 'teacher_category' ? 'ordinary' : current[key];
        if (JSON.stringify(actual) !== JSON.stringify(before[key])) reject('配置在申请后已变更，请重新申请',409,'APPROVAL_SNAPSHOT_CONFLICT');
      }
    }
  }
  function decision(p, operator, approved) {
    const a = get(T.APPROVAL_REQUESTS, p.approval_id);
    if (a.status !== 'pending') reject('审批单已处理或已被出勤扣费废止', 409, 'APPROVAL_STATE_CONFLICT');
    if (a.proposer_id === operator.id && !superAdminPolicy.mayApproveOwnRequest(db.getTable(T.USERS), operator)) reject('不能审批本人申请', 403, 'SELF_APPROVAL');
    const reason = p.reject_reason || '经审批人综合评估未予通过';
    const handlers = {
      config_change: [configs, 'applyConfigApproval', null],
      freeze_hours: [transfers, 'applyFreezeApproval', 'rejectFreezeApproval'],
      manual_hour_adjust: [transfers, 'applyManualHourAdjustApproval', 'rejectManualHourAdjustApproval'],
      balance_adjustment: [transfers, 'applyManualHourAdjustApproval', 'rejectManualHourAdjustApproval'],
      transfer: [transfers, 'applyTransferApproval', 'rejectTransferApproval'],
      refund: [transfers, 'applyRefundApproval', 'rejectRefundApproval'],
      makeup_attendance: [attendance, 'applyMakeupSignApproval', 'rejectMakeupSignApproval'],
      salary_adjustment: [salary, 'applySalaryAdjustmentApproval', 'rejectSalaryAdjustmentApproval']
    };
    if (a.request_type === 'super_admin_role_change') {
      const payload = JSON.parse(a.after_data_json);
      const target = get(T.USERS, a.target_record_id);
      if (target.role !== 'super_admin' || target.status !== 'active') reject('超管身份已变化，请重新申请', 409, 'ROLE_CHANGED');
      if (approved) db.update(T.USERS, target.id, {role:payload.role,status:payload.status}, '合伙人审批减少超管');
      db.update(T.APPROVAL_REQUESTS, a.id, {status: approved ? 'approved':'rejected', approver_id:operator.id, approver_name:operator.name, approved_time:new Date().toISOString(), reject_reason:approved ? null:reason}, '服务端合伙人审批');
      return {approval_id:a.id,status:approved ? 'approved':'rejected'};
    }
    const entry = handlers[a.request_type];
    if (!entry) reject('不支持的审批类型');
    if (approved && a.request_type === 'config_change') configGuard(a);
    if (a.request_type === 'makeup_attendance') {
      const details = typeof a.after_data_json === 'string' ? JSON.parse(a.after_data_json) : a.after_data_json;
      const params = { schedule_id: details.schedule_id, attendance_inputs: details.attendance_inputs };
      if (!attendanceParams(params)) reject('补签审批参数无效');
      sheet(params, operator, 'pending_makeup_sign_approval');
    }
    const method = approved ? entry[1] : entry[2];
    if (method) {
      const result = approved ? entry[0][method](a, operator) : entry[0][method](a, reason, operator);
      if (result && result.success === false) reject(result.message || '审批业务未成功');
    }
    db.update(T.APPROVAL_REQUESTS, a.id, { status: approved ? 'approved' : 'rejected', approver_id: operator.id,
      approver_name: operator.name, approved_time: new Date().toISOString(), reject_reason: approved ? null : reason }, '服务端审批处理');
    return { approval_id: a.id, status: approved ? 'approved' : 'rejected' };
  }
  const operations = {
    'user.create': { authorize:u=>u.role==='super_admin', validate:p=>object(p,['name','phone','role'],['teacher_tier_id']) && text(p.name,100) && text(p.phone,30) && ['guest','parent','teacher','admin','super_admin'].includes(p.role) && (p.teacher_tier_id===undefined || id(p.teacher_tier_id)), handle:({params:p})=>{
      if(db.getTable(T.USERS).some(u=>u.phone===p.phone)) reject('手机号已存在',409,'PHONE_EXISTS');
      const user=db.insert(T.USERS,{...p,status:'active',teacher_tier_id:p.role==='teacher' ? p.teacher_tier_id || null : null},'服务端预录入成员');
      return {user_id:user.id};
    } },
    'user.changeRole': { authorize:u=>u.role==='super_admin', validate:p=>object(p,['user_id','role'],['teacher_tier_id']) && id(p.user_id) && ['guest','parent','teacher','admin','super_admin'].includes(p.role) && (p.teacher_tier_id===undefined || id(p.teacher_tier_id)), handle:({params:p,operator})=>{
      const target=get(T.USERS,p.user_id);
      const count=superAdminPolicy.activeSuperAdmins(db.getTable(T.USERS)).length;
      if(target.role==='super_admin' && target.status==='active' && p.role!=='super_admin') {
        if(target.id===operator.id || count<=1) reject('不能降级自己或最后一位超管',403,'LAST_SUPER_ADMIN');
        const approval=db.insert(T.APPROVAL_REQUESTS,{request_type:'super_admin_role_change',status:'pending',proposer_id:operator.id,proposer_name:operator.name,target_table:T.USERS,target_record_id:target.id,after_data_json:JSON.stringify({role:p.role,status:'active'}),reason:'调整超管身份'},'申请减少超管');
        return {approval_id:approval.id,status:'pending'};
      }
      db.update(T.USERS,target.id,{role:p.role,status:'active',teacher_tier_id:p.role==='teacher' ? p.teacher_tier_id || null : null},'服务端调整成员身份');
      return {user_id:target.id,status:'updated'};
    } },
    'approval.propose': { authorize: admin, validate: require('./approvalProposals').validate, handle: args => {
      const before = new Set(db.getTable(T.APPROVAL_REQUESTS).map(a => a.id));
      const result = require('./approvalProposals').handle(args);
      if (superAdminPolicy.mayApproveOwnRequest(db.getTable(T.USERS), args.operator)) {
        const added = db.getTable(T.APPROVAL_REQUESTS).filter(a => !before.has(a.id) && a.status === 'pending' && a.proposer_id === args.operator.id);
        for (const item of added) decision({ approval_id: item.id }, args.operator, true);
        return { ...result, direct_approved: added.map(a => a.id) };
      }
      return result;
    } },
    'attendance.submit': { authorize: teaching, validate: p => attendanceParams(p) && !Object.hasOwn(p, 'reason'), handle: ({ params:p, operator }) => { sheet(p, operator, 'scheduled'); return attendance.submitAttendance(p.schedule_id, p.attendance_inputs, operator); } },
    'attendance.update': { authorize: teaching, validate: p => attendanceParams(p) && !Object.hasOwn(p, 'reason'), handle: ({ params:p, operator }) => { sheet(p, operator, 'completed'); return attendance.updateAttendanceWithin24Hours(p.schedule_id, p.attendance_inputs, operator); } },
    'attendance.requestMakeup': { authorize: teaching, validate: p => attendanceParams(p) && text(p.reason), handle: ({ params:p, operator }) => { sheet(p, operator, 'scheduled'); return attendance.requestMakeupAttendance(p.schedule_id, p.attendance_inputs, p.reason, operator); } },
    'package.purchase': { authorize: admin, validate: p => object(p, ['student_id','course_id','paid_hours_total','gift_hours_total','total_amount','account_destination','term_id','payment_reference'], ['remark']) && ['student_id','course_id','term_id','payment_reference'].every(k => id(p[k])) && number(p.paid_hours_total, 0.01) && number(p.gift_hours_total) && number(p.total_amount) && ['进入公账','进入个人账户'].includes(p.account_destination) && (p.remark === undefined || text(p.remark)),
      handle: ({ params:p, operator }) => { unique('purchase', p.payment_reference); const { student_id, payment_reference, ...data } = p; const result = packages.purchasePackage(student_id, data, operator); db.insert(LEDGER, { kind:'purchase',reference:payment_reference, package_id:result.package.id }, '购课凭据唯一性记录'); return result; } },
    'hours.deduct': { authorize: admin, validate: p => object(p, ['student_id','course_id','hours_needed','context_desc','event_id']) && id(p.student_id) && id(p.course_id) && id(p.event_id) && number(p.hours_needed,0.01) && text(p.context_desc),
      handle: ({ params:p }) => { unique('deduct',p.event_id); get(T.STUDENTS,p.student_id); get(T.COURSES_AND_CLASS_TYPES,p.course_id); const result = packages.deductHours(p); const row = db.insert(LEDGER,{kind:'deduct',reference:p.event_id,detail:result.deducted_detail_obj,rolled_back:false},'服务端扣课流水'); return {...result,deduction_id:row.id}; } },
    'hours.rollback': { authorize: u => u.role === 'super_admin', validate: p => object(p,['deduction_id','reason']) && id(p.deduction_id) && text(p.reason), handle: ({params:p}) => { const row=get(LEDGER,p.deduction_id); if(row.kind !== 'deduct' || row.rolled_back) reject('扣课流水已撤销或不可撤销',409,'DEDUCTION_STATE_CONFLICT'); const result=packages.rollbackHours(row.detail,p.reason); db.update(LEDGER,row.id,{rolled_back:true},'撤销服务端扣课流水'); return result; } },
    'approval.approve': { authorize: u => u.role === 'super_admin', validate: p => object(p,['approval_id']) && id(p.approval_id), handle: ({params,operator}) => decision(params,operator,true) },
    'approval.reject': { authorize: u => u.role === 'super_admin', validate: p => object(p,['approval_id','reject_reason']) && id(p.approval_id) && text(p.reject_reason), handle: ({params,operator}) => decision(params,operator,false) }
  };
  for (const spec of Object.values(operations)) {
    const handle = spec.handle;
    spec.handle = args => {
      try {
        const result = handle(args);
        if (args.operator.role !== 'super_admin' && result && result.schedule_id) {
          const {fee_result,teacher_tier_snapshot,calculated_teacher_fee,...publicResult} = result;
          return publicResult;
        }
        return result;
      } catch (error) {
        if (error.status) fail(error.status,error.code || 'BUSINESS_REJECTED',error.message);
        reject(error.message || '业务处理失败');
      }
    };
  }
  return operations;
};

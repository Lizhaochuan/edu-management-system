'use strict';

// Business presentation only. Never alter original payment records used for commands.
const STATUS=Object.freeze({
  pending:'待人工核对',
  confirmed:'已人工确认到账',
  rejected:'已拒绝',
  consumed:'已用于购课入账'
});
function money(cents){
  if(!Number.isSafeInteger(cents)||cents<0)return '金额待核对';
  return '¥'+(cents/100).toFixed(2)+' 元';
}
function date(value){
  if(typeof value!=='string')return '时间待核对';
  const d=new Date(value);
  if(Number.isNaN(d.getTime()))return '时间待核对';
  const pad=n=>String(n).padStart(2,'0');
  return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+
    ' '+pad(d.getHours())+':'+pad(d.getMinutes());
}
function account(value){
  return value==='进入公账'?'对公账户':value==='进入个人账户'?'个人账户':'账户待核对';
}
function nameOf(rows,id,key,fallback){
  const item=(rows||[]).find(r=>r&&r.id===id);
  return item&&typeof item[key]==='string'&&item[key].trim()?item[key].trim():fallback;
}
function receipt(row,context={}){
  return {...row,
    statusText:STATUS[row.status]||'状态待核对',
    studentName:nameOf(context.students,row.student_id,'name','学员姓名待核对'),
    courseName:nameOf(context.courses,row.course_id,'course_name','课程名称待核对'),
    submittedByName:nameOf(context.users,row.submitted_by,'name','登记人员待核对'),
    amountText:money(row.amount_cents),
    accountText:account(row.account_destination),
    submittedTimeText:date(row.created_at),
    packageText:row.package_id?'已建立课时包':'尚未建立课时包'
  };
}
module.exports={STATUS,money,receipt};

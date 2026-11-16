'use strict';
const db=require('./db');

// Read-only projection for the teacher Web portal. Never accept a teacher ID from
// the request; ownership uses the authenticated principal and attendance's rule.
function listForTeacher(user) {
  if(!user || user.role!=='teacher')throw new Error('仅教师可查看个人课表');
  const classes=new Map(db.getTable(db.TABLES.CLASSES).map(c=>[c.id,c]));
  const courses=new Map(db.getTable(db.TABLES.COURSES_AND_CLASS_TYPES).map(c=>[c.id,c]));
  const statuses={scheduled:'待上课',completed:'已完成',signed:'已签到',
    cancelled:'已取消',postponed:'已顺延',pending_makeup_sign_approval:'待补签审批'};
  return db.getTable(db.TABLES.SCHEDULES_AND_ATTENDANCE).filter(s=>{
    const cls=classes.get(s.class_id)||{};
    return (s.substitute_teacher_id||s.teacher_id||cls.teacher_id)===user.id;
  }).map(s=>{
    const cls=classes.get(s.class_id)||{};
    const course=courses.get(s.course_id||cls.course_id)||{};
    const hours=Number(s.snapshot_hours_per_lesson);
    return {id:s.id,date:s.lesson_date||'',startTime:s.start_time||'',endTime:s.end_time||'',
      className:cls.name||'班级名称待核对',courseName:course.course_name||'课程名称待核对',
      hours:s.snapshot_hours_per_lesson!=null&&Number.isFinite(hours)&&hours>0?hours:null,
      statusText:statuses[s.status]||'状态待核对',
      completed:['completed','signed'].includes(s.status),
      assignmentText:s.substitute_teacher_id?'代课':'任课'};
  }).sort((a,b)=>(a.date+' '+a.startTime).localeCompare(b.date+' '+b.startTime));
}
module.exports={listForTeacher};

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function fixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'edu-attendance-atomic-'));
  fs.cpSync(path.resolve(__dirname,'..','services'),path.join(temp,'services'),{recursive:true});
  const db = require(path.join(temp,'services','db.js'));
  db.initDatabase(true);
  const admin = db.getById(db.TABLES.USERS,'u_adm1');
  global.getApp = () => ({globalData:{currentUser:admin}});
  global.wx = {getStorageSync:() => null};
  const attendance = require(path.join(temp,'services','attendanceService.js'));
  const salary = require(path.join(temp,'services','salaryEngineService.js'));
  const packages = require(path.join(temp,'services','packageAccountService.js'));
  const notices = require(path.join(temp,'services','notificationService.js'));
  return {db,attendance,salary,packages,notices,admin,close() {
    delete global.getApp; delete global.wx;
    fs.rmSync(temp,{recursive:true,force:true});
  }};
}

test('attendance reverts all credit, debt, audit and schedule changes if salary calculation fails',()=>{
  const f=fixture();
  try {
    const before = JSON.stringify(f.db.dumpAll());
    f.salary.calculateLessonFee = () => {throw new Error('INJECTED salary failure')};
    assert.throws(()=>f.attendance.submitAttendance('sch_2',[
      {student_id:'stu_3',is_present:true},
      {student_id:'stu_4',is_present:true}
    ],f.admin),/INJECTED salary failure/);
    assert.equal(JSON.stringify(f.db.dumpAll()),before);
  } finally {f.close();}
});

test('cancel rolls back whole DB if a refund cannot be completed',()=>{
  const f=fixture();
  try {
    f.db.update(f.db.TABLES.SCHEDULES_AND_ATTENDANCE,'sch_1',{
      is_settled:false,
      attendees_json:[{student_id:'stu_1',status:'present',deducted_hours:1.5,
        deducted_detail_json:{entries:[{package_id:'pkg_1',hours:1.5}]}}]
    });
    const before=JSON.stringify(f.db.dumpAll());
    f.packages.rollbackHours=()=>{throw new Error('INJECTED refund failure')};
    assert.throws(()=>f.attendance.cancelScheduleLesson('sch_1',{
      reason:'天气原因',handle_mode:'individual_makeup'
    }),/INJECTED refund failure/);
    assert.equal(JSON.stringify(f.db.dumpAll()),before);
  } finally {f.close();}
});

test('cancel does not notify families if postponement fails and reverses status changes',()=>{
  const f=fixture();
  try {
    let notified=false;
    f.notices.sendLessonCancellationNotice=()=>{notified=true;return {}};
    f.attendance.postponeClassSchedules=()=>{throw new Error('INJECTED postpone failure')};
    const before=JSON.stringify(f.db.dumpAll());
    assert.throws(()=>f.attendance.cancelScheduleLesson('sch_2',{
      reason:'天气原因',handle_mode:'postpone_entire_class'
    }),/INJECTED postpone failure/);
    assert.equal(notified,false);
    assert.equal(JSON.stringify(f.db.dumpAll()),before);
  } finally {f.close();}
});

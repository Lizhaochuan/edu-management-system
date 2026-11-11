'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function fixture() {
  // Copy services into a temporary project to keep tests away from production data/db.json.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'edu-salary-test-'));
  fs.cpSync(path.resolve(__dirname, '..', 'services'), path.join(root, 'services'), { recursive: true });
  const db = require(path.join(root, 'services', 'db.js'));
  db.initDatabase(true);
  const salary = require(path.join(root, 'services', 'salaryEngineService.js'));
  return { db, salary, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('2 students at ¥140 per hour for 1.5 lesson hours = ¥210', () => {
  const { db, salary, close } = fixture();
  try {
    const r = salary.calculateLessonFee('sch_1');
    assert.equal(r.effective_headcount, 2);
    assert.equal(r.rate_used, 140);
    assert.equal(r.lesson_hours, 1.5);
    assert.equal(r.calculated_teacher_fee, 210);
    assert.equal(db.getById(db.TABLES.SCHEDULES_AND_ATTENDANCE, 'sch_1').calculated_teacher_fee, 210);
  } finally { close(); }
});

test('1-hour lesson does not inflate per-hour rate', () => {
  const { db, salary, close } = fixture();
  try {
    db.update(db.TABLES.SCHEDULES_AND_ATTENDANCE, 'sch_2',
      { attendees_json: [{ student_id: 'stu_3', status: 'present' }, { student_id: 'stu_4', status: 'present' }] });
    const r = salary.calculateLessonFee('sch_2');
    assert.equal(r.lesson_hours, 1);
    assert.equal(r.rate_used, 200);
    assert.equal(r.calculated_teacher_fee, 200);
  } finally { close(); }
});

test('individually configured rates: ¥180/hour for 1.5 hours = ¥270', () => {
  const { db, salary, close } = fixture();
  try {
    db.update(db.TABLES.USERS, 'u_tch1',
      { is_custom_rate: true, custom_tier_rates_json: { 1: 90, 2: 180, 3: 230 } });
    const r = salary.calculateLessonFee('sch_1');
    assert.equal(r.rate_used, 180);
    assert.equal(r.calculated_teacher_fee, 270);
  } finally { close(); }
});

test('original teacher makeup difference uses original lesson hours', () => {
  const { salary, close } = fixture();
  try {
    salary.calculateLessonFee('sch_1');
    const diff = salary.applyMakeupProgressiveDifferential({
      original_absent_schedule_id: 'sch_1', student_id: 'stu_missing', student_name: '补课学生'
    });
    assert.equal(diff.rate_used, 40);
    assert.equal(diff.lesson_hours, 1.5);
    assert.equal(diff.calculated_teacher_fee, 60);
    assert.equal(salary.realignOriginalClassCompensations('sch_1').total_differential_fee, 60);
  } finally { close(); }
});

test('missing duration is rejected instead of silently estimating salary', () => {
  const { db, salary, close } = fixture();
  try {
    db.update(db.TABLES.CLASSES, 'cls_1', { hours_per_lesson_snapshot: null });
    db.update(db.TABLES.SCHEDULES_AND_ATTENDANCE, 'sch_1', { snapshot_hours_per_lesson: null });
    assert.throws(() => salary.calculateLessonFee('sch_1'), /课时快照/);
  } finally { close(); }
});

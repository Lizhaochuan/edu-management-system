'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeManualRates } = require('../services/salaryRateConfig');
const arbitrary = { 1:'100', 2:'125.5', 3:'123', 4:'188', 5:'205.25', 6:'240', 7:'275', 8:'330' };
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edu-config-test-'));
  fs.cpSync(path.resolve(__dirname, '..', 'services'), path.join(dir, 'services'), { recursive:true });
  const db = require(path.join(dir, 'services', 'db.js'));
  db.initDatabase(true);
  db.update(db.TABLES.SCHEDULES_AND_ATTENDANCE, 'sch_1', { is_settled: false });
  global.getApp = () => ({ globalData: { currentUser: db.getById(db.TABLES.USERS, 'u_adm1') } });
  global.wx = { getStorageSync: () => null };
  const settings = require(path.join(dir, 'services', 'systemConfigService.js'));
  const salary = require(path.join(dir, 'services', 'salaryEngineService.js'));
  return { db, settings, salary, close: () => {
    delete global.getApp; delete global.wx; fs.rmSync(dir, { recursive:true, force:true });
  }};
}
test('all eight independent, nonuniform amounts are accepted', () => {
  assert.deepEqual(Object.values(normalizeManualRates(arbitrary)),
    [100, 125.5, 123, 188, 205.25, 240, 275, 330]);
});
test('missing, additional, textual, and malformed monetary values are rejected', () => {
  for (const data of [
    { ...arbitrary, 8:undefined }, { ...arbitrary, 9:400 },
    { ...arbitrary, 2:'¥150' }, { ...arbitrary, 3:'1e2' },
    { ...arbitrary, 4:'abc' }, { ...arbitrary, 5:'1.256' },
    { ...arbitrary, 6:Infinity }, { ...arbitrary, 7:null }
  ]) assert.throws(() => normalizeManualRates(data), /金额|档|数字/);
});
test('new ordinary teacher Level approval snapshots eight explicit rates', () => {
  const { settings, close } = fixture();
  try {
    const item = settings.submitCreateTeacherTierRequest({
      name:'优秀', headcount_rates_json:arbitrary, maxCapacity:3, reason:'新增等级'
    });
    assert.equal(item.status, 'pending');
    assert.equal(item.after_data_json.headcount_rates_json[5], 205.25);
    assert.equal(Object.keys(item.after_data_json.headcount_rates_json).length, 8);
  } finally { close(); }
});
test('partner teacher uses separate salary table without gaining admin authority', () => {
  const { db, settings, salary, close } = fixture();
  try {
    const admin = db.getById(db.TABLES.USERS, 'u_sa1');
    const rates = settings.submitPartnerTeacherRatesRequest({
      headcount_rates_json:arbitrary, reason:'配置合伙人教师价格'
    });
    settings.applyConfigApproval(rates, admin);
    const category = settings.submitTeacherCategoryRequest('u_tch1', {
      teacher_category:'partner_teacher', reason:'教师类别调整'
    });
    settings.applyConfigApproval(category, admin);
    assert.equal(db.getById(db.TABLES.USERS, 'u_tch1').role, 'teacher');
    assert.equal(db.getById(db.TABLES.USERS, 'u_tch1').teacher_category, 'partner_teacher');
    const amount = salary.calculateLessonFee('sch_1');
    assert.equal(amount.rate_used, 125.5);
    assert.equal(amount.calculated_teacher_fee, 188.25);
    assert.equal(amount.tier_name, '合伙人老师');
  } finally { close(); }
});
test('unconfigured partner teacher amount fails rather than being guessed', () => {
  const { db, salary, close } = fixture();
  try {
    db.update(db.TABLES.USERS, 'u_tch1', { teacher_category:'partner_teacher' });
    assert.throws(() => salary.calculateLessonFee('sch_1'), /尚未配置/);
  } finally { close(); }
});

test('settled historical lesson cannot be recomputed directly', () => {
  const { db, salary, close } = fixture();
  try {
    db.update(db.TABLES.SCHEDULES_AND_ATTENDANCE, 'sch_1', { is_settled:true });
    assert.throws(() => salary.calculateLessonFee('sch_1'), /已结算历史/);
  } finally { close(); }
});
test('saved hourly rate snapshot prevails over later price changes', () => {
  const { db, salary, close } = fixture();
  try {
    db.update(db.TABLES.SCHEDULES_AND_ATTENDANCE, 'sch_1', {
      teacher_salary_tier_snapshot_json: {
        teacher_id:'u_tch1', tier_id:'tier_junior', tier_name:'历史价格',
        headcount_rates_json:{1:100,2:300,3:400}
      }
    });
    const result = salary.calculateLessonFee('sch_1');
    assert.equal(result.rate_used, 300);
    assert.equal(result.calculated_teacher_fee, 450);
  } finally { close(); }
});


test('partner makeup: both new differential and realignment use the eight-bracket partner table', () => {
  const { db, salary, close } = fixture();
  try {
    const partnerRates = { 1:110, 2:155, 3:235, 4:305, 5:325, 6:370, 7:400, 8:440 };
    db.update(db.TABLES.USERS, 'u_tch1', { teacher_category: 'partner_teacher' });
    db.update(db.TABLES.PARTNER_TEACHER_RATE_CONFIG, 'partner_teacher', {
      status: 'active', headcount_rates_json: partnerRates
    });
    // Simulate an older record without either kind of salary snapshot.
    db.update(db.TABLES.SCHEDULES_AND_ATTENDANCE, 'sch_1', {
      teacher_salary_tier_snapshot_json: null, snapshot_teacher_rates_json: null
    });
    const diff = salary.applyMakeupProgressiveDifferential({
      original_absent_schedule_id: 'sch_1', student_id: 'stu_partner', student_name: '补课测试'
    });
    assert.equal(diff.tier_name, '合伙人老师');
    assert.equal(diff.rate_used, 80);
    assert.equal(diff.lesson_hours, 1.5);
    assert.equal(diff.calculated_teacher_fee, 120);
    assert.equal(salary.realignOriginalClassCompensations('sch_1').total_differential_fee, 120);
    // Current partner pricing may change, but existing supplement must not.
    db.update(db.TABLES.PARTNER_TEACHER_RATE_CONFIG, 'partner_teacher', {
      headcount_rates_json: { ...partnerRates, 3: 400 }
    });
    assert.equal(salary.realignOriginalClassCompensations('sch_1').total_differential_fee, 120);
  } finally { close(); }
});

test('legacy lesson rate snapshot wins over newer partner pricing', () => {
  const { db, salary, close } = fixture();
  try {
    db.update(db.TABLES.USERS, 'u_tch1', { teacher_category: 'partner_teacher' });
    db.update(db.TABLES.PARTNER_TEACHER_RATE_CONFIG, 'partner_teacher', {
      headcount_rates_json: { 1:100, 2:200, 3:500, 4:600, 5:700, 6:800, 7:900, 8:1000 },
      status: 'active'
    });
    // Seed schedule is historically locked to 2 students @ 140 and 3 @ 180.
    const diff = salary.applyMakeupProgressiveDifferential({
      original_absent_schedule_id: 'sch_1', student_id: 'stu_legacy', student_name: '历史补课'
    });
    assert.equal(diff.tier_name, '原班旧版价格快照');
    assert.equal(diff.rate_used, 40);
    assert.equal(diff.calculated_teacher_fee, 60);
    assert.equal(salary.realignOriginalClassCompensations('sch_1').total_differential_fee, 60);
  } finally { close(); }
});

test('partner makeup without rates or historical snapshot fails rather than guessing', () => {
  const { db, salary, close } = fixture();
  try {
    db.update(db.TABLES.USERS, 'u_tch1', { teacher_category: 'partner_teacher' });
    db.update(db.TABLES.SCHEDULES_AND_ATTENDANCE, 'sch_1', {
      teacher_salary_tier_snapshot_json: null, snapshot_teacher_rates_json: null
    });
    assert.throws(() => salary.applyMakeupProgressiveDifferential({
      original_absent_schedule_id: 'sch_1', student_id: 'stu_missing', student_name: '缺少价格'
    }), /合伙人老师尚未配置/);
    assert.equal(db.getTable(db.TABLES.TEACHER_LESSON_FEES)
      .filter(row => row.student_id === 'stu_missing').length, 0);
  } finally { close(); }
});

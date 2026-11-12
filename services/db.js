// services/db.js
// 核心数据库引擎 —— 基于 wx.Storage 的本地持久化层

// ─────────────────────────────────────────
// 表名常量
// ─────────────────────────────────────────
const TABLES = {
  USERS:                    'users',
  STUDENTS:                 'students',
  TERMS:                    'terms',
  TEACHER_TIERS:            'teacher_tiers',
  PARTNER_TEACHER_RATE_CONFIG: 'partner_teacher_rate_config',
  COURSES_AND_CLASS_TYPES:  'courses_and_class_types',
  CLASSES:                  'classes',
  COURSE_PACKAGES:          'course_packages',
  SCHEDULES_AND_ATTENDANCE: 'schedules_and_attendance',
  APPROVAL_REQUESTS:        'approval_requests',
  AUDIT_LOGS:               'audit_logs',
  SUBSTITUTE_COMPLAINTS:    'substitute_complaints',
  MAKEUP_REQUESTS:          'makeup_requests',
  TEACHER_LESSON_FEES:      'teacher_lesson_fees',
  SALARY_SETTLEMENTS:       'salary_settlements',
  SALARY_ADJUSTMENTS:       'salary_adjustments',
  MANUAL_HOUR_ADJUSTMENTS:  'manual_hour_adjustments',
  TRANSFER_RECORDS:         'transfer_records',
  REFUND_RECORDS:           'refund_records',
  TERM_ROLLOVER_RECORDS:    'term_rollover_records',
}

const DB_INIT_FLAG = '__DB_INITIALIZED__'

// ─────────────────────────────────────────
// 后端同步与存储适配器（支持微信小程序端与 Node.js 服务端共用同一底座）
// ─────────────────────────────────────────
const isMiniProgram = typeof wx !== 'undefined' && typeof wx.getStorageSync === 'function'
const miniConfig = isMiniProgram && typeof wx.getExtConfigSync === 'function' ? (wx.getExtConfigSync() || {}) : {}
const SERVER_API_BASE = (miniConfig.serverApiBase || 'http://127.0.0.1:3000').replace(/[/]$/, '')
function _getBearerToken() {
  if (!isMiniProgram) return null
  const token = wx.getStorageSync('auth_token')
  return typeof token === 'string' && token.length > 0 ? token : null
}

// Node.js 服务端文件数据库缓存
let _nodeMemoryDb = null
let _fs = null
let _path = null
let _dbFilePath = null
let _transaction = null
const WRITE_STATE = '__server_write_state'

function _clone(value) { return JSON.parse(JSON.stringify(value)) }

function _writeState() {
  const state = _loadNodeDb()[WRITE_STATE]
  if (state === undefined) return { version: 0, receipts: [] }
  if (!state || !Number.isSafeInteger(state.version) || state.version < 0 ||
      !Array.isArray(state.receipts)) throw new Error('Invalid server write metadata')
  return state
}

function getWriteState() {
  if (isMiniProgram) throw new Error('Server writes require Node.js')
  return _clone(_writeState())
}

function saveCommandReceipt(receipt) {
  if (!_transaction) throw new Error('Command receipts require a transaction')
  const state = getWriteState()
  state.receipts.push(_clone(receipt))
  _nodeMemoryDb[WRITE_STATE] = state
}

// Synchronous handlers run to completion without yielding the event loop. Reject
// reentry rather than allow one transaction to observe another's staged state.
// Never perform network I/O, notifications or await inside this boundary.
function transaction(handler, operator) {
  if (isMiniProgram) throw new Error('Server writes require Node.js')
  if (_transaction) throw new Error('Nested/concurrent transaction is not allowed')
  if (typeof handler !== 'function' || handler.constructor.name === 'AsyncFunction') {
    throw new Error('Transaction handler must be synchronous')
  }
  const before = _loadNodeDb()
  _nodeMemoryDb = _clone(before)
  _transaction = { operator }
  try {
    const result = handler()
    if (result && typeof result.then === 'function') throw new Error('Async transaction is not allowed')
    _transaction = null
    _persistNodeDb()
    return result
  } catch (error) {
    // Staged writes were never persisted. Rollback needs no second disk write,
    // which could itself fail when the disk is full or permissions are lost.
    _nodeMemoryDb = before
    throw error
  } finally {
    _transaction = null
  }
}

if (!isMiniProgram) {
  try {
    _fs = require('fs')
    _path = require('path')
    _dbFilePath = _path.join(__dirname, '..', 'data', 'db.json')
  } catch (e) {}
}

function _loadNodeDb() {
  if (_nodeMemoryDb) return _nodeMemoryDb
  if (_fs && _fs.existsSync(_dbFilePath)) {
    try {
      const raw = _fs.readFileSync(_dbFilePath, 'utf8')
      const loaded = JSON.parse(raw)
      if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) {
        throw new Error('Database root must be an object')
      }
      _nodeMemoryDb = loaded
      return _nodeMemoryDb
    } catch (e) {
      throw new Error('Cannot read database; refusing to overwrite historical data', { cause: e })
    }
  }
  _nodeMemoryDb = _buildSeedData()
  _persistNodeDb()
  return _nodeMemoryDb
}

function _persistNodeDb() {
  if (_transaction) return
  if (!_fs || !_dbFilePath || !_nodeMemoryDb) return
  const state = _writeState()
  if (state.version >= Number.MAX_SAFE_INTEGER) throw new Error('Database version exhausted')
  const nextState = { ...state, version: state.version + 1 }
  const candidate = { ..._nodeMemoryDb, [WRITE_STATE]: nextState }
  const dir = _path.dirname(_dbFilePath)
  if (!_fs.existsSync(dir)) _fs.mkdirSync(dir, { recursive: true })
  // Replace an entire JSON file atomically instead of truncating it in place.
  // This improves crash safety on a single host; it does NOT make OneDrive multi-writer safe.
  const temp = _path.join(dir, '.db-write-' + process.pid + '-' + Date.now() + '-' +
    Math.random().toString(16).slice(2) + '.tmp')
  try {
    _fs.writeFileSync(temp, JSON.stringify(candidate, null, 2), { encoding:'utf8', flag:'wx', mode:0o600 })
    // Flush the complete candidate before the atomic rename (single local disk).
    const fd = _fs.openSync(temp, 'r')
    try { _fs.fsyncSync(fd) } finally { _fs.closeSync(fd) }
    _fs.renameSync(temp, _dbFilePath)
    _nodeMemoryDb[WRITE_STATE] = nextState
  } catch (e) {
    console.error('[db] persist db.json failed; latest mutation was NOT durably saved:', e)
    throw e
  } finally {
    try { if (_fs.existsSync(temp)) _fs.unlinkSync(temp) } catch (_err) {}
  }
}

/** 底层读取表适配 */
function _readStorageTable(tableName) {
  if (isMiniProgram) {
    return wx.getStorageSync(tableName) || []
  }
  const dbObj = _loadNodeDb()
  return dbObj[tableName] || []
}

/** 底层写表适配 */
function _writeStorageTable(tableName, rows) {
  if (isMiniProgram) {
    wx.setStorageSync(tableName, rows)
  } else {
    const dbObj = _loadNodeDb()
    dbObj[tableName] = rows
    _persistNodeDb()
  }
}

/** 小程序端向后端服务异步同步变更（确保 PC 网页端 100% 实时同步感知） */
function _syncMutationToServer(mutation) {
  if (!isMiniProgram || !wx.request) return
  const token = _getBearerToken()
  if (!token) return
  try {
    wx.request({
      url: `${SERVER_API_BASE}/api/db/mutate`,
      method: 'POST',
      data: mutation,
      header: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      fail(err) {
        // 后端若未启动时静默降级为本地运行，避免控制台报错阻断小程序UI
      }
    })
  } catch (e) {}
}

// ─────────────────────────────────────────
// 内部工具
// ─────────────────────────────────────────

/** 生成简易唯一 ID（时间戳 + 随机后缀） */
function _genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

/** 获取当前操作人信息（从 App globalData 读取） */
function _currentUser() {
  if (!isMiniProgram && _transaction && _transaction.operator) return _transaction.operator
  try {
    if (typeof getApp === 'function') {
      const app = getApp()
      if (app && app.globalData && app.globalData.currentUser) {
        return app.globalData.currentUser
      }
    }
    return { id: 'unauthenticated', name: '未登录', role: 'guest' }
  } catch (e) {
    return { id: 'unauthenticated', name: '未登录', role: 'guest' }
  }
}

// ─────────────────────────────────────────
// 不可篡改日志写入（内部直接操作，绕过拦截器）
// ─────────────────────────────────────────
function _writeAuditLog(action, targetTable, targetRecordId, beforeSnapshot, afterSnapshot, description) {
  try {
    const user = _currentUser()
    const logs = _readStorageTable(TABLES.AUDIT_LOGS)
    const log = {
      id:                    _genId(),
      operator_id:           user.id,
      operator_name:         user.name,
      action_time:           new Date().toISOString(),
      action:                action,           // 'INSERT' | 'UPDATE' | 'REMOVE'
      target_table:          targetTable,
      target_record_id:      targetRecordId,
      before_snapshot_json:  beforeSnapshot  ? JSON.stringify(beforeSnapshot)  : null,
      after_snapshot_json:   afterSnapshot   ? JSON.stringify(afterSnapshot)   : null,
      description:           description || '',
    }
    logs.push(log)
    _writeStorageTable(TABLES.AUDIT_LOGS, logs)
    return log
  } catch (e) {
    if (_transaction) throw e
    console.warn('[db] audit log write failed:', e)
    return null
  }
}

// ─────────────────────────────────────────
// 通用表操作
// ─────────────────────────────────────────

/**
 * 读取整张表（返回数组，表不存在时返回空数组）
 * @param {string} tableName
 * @returns {Array}
 */
function getTable(tableName) {
  return _readStorageTable(tableName)
}

/**
 * 按 id 查询单条记录
 * @param {string} tableName
 * @param {string} id
 * @returns {Object|null}
 */
function getById(tableName, id) {
  const rows = getTable(tableName)
  return rows.find(r => r.id === id) || null
}

/**
 * 插入一条新记录（自动补充 id、created_at、updated_at）
 * @param {string} tableName
 * @param {Object} record    - 不需要包含 id（会自动生成）
 * @param {string} description - 写入审计日志的操作说明
 * @returns {Object} 插入后的完整记录
 */
function insert(tableName, record, description) {
  const rows = getTable(tableName)
  const now = new Date().toISOString()
  const newRecord = Object.assign({}, record, {
    id:         record.id || _genId(),
    created_at: record.created_at || now,
    updated_at: record.updated_at || now,
  })
  rows.push(newRecord)
  _writeStorageTable(tableName, rows)

  const log = _writeAuditLog('INSERT', tableName, newRecord.id, null, newRecord, description)

  // 双向实时同步给 PC Web 网页端
  _syncMutationToServer({
    action: 'INSERT',
    table: tableName,
    id: newRecord.id,
    record: newRecord,
    description: description || '',
    operator: _currentUser(),
    audit_log: log
  })

  return newRecord
}

/**
 * 按 id 更新一条记录（patch 合并，自动更新 updated_at）
 * @param {string} tableName
 * @param {string} id
 * @param {Object} patch      - 只需传入要修改的字段
 * @param {string} description
 * @returns {Object} 更新后的完整记录
 * @throws 如果目标表是 audit_logs，直接抛错（铁律）
 */
function update(tableName, id, patch, description) {
  if (tableName === TABLES.AUDIT_LOGS) {
    throw new Error('系统安全铁律：操作日志不可修改或删除')
  }
  const rows = getTable(tableName)
  const idx = rows.findIndex(r => r.id === id)
  if (idx === -1) throw new Error(`[db] update: 记录不存在 (table=${tableName}, id=${id})`)

  // 财务安全铁律：已结算锁定的薪资结算单不可修改！如需调整必须走算错调账审批流
  if (tableName === TABLES.SALARY_SETTLEMENTS) {
    const existing = rows[idx]
    if (existing && existing.status === 'settled') {
      throw new Error('财务安全铁律：已结算锁定的薪资结算单不可直接修改！如需调整请走算错调账审批流')
    }
  }

  const before = Object.assign({}, rows[idx])
  const after = Object.assign({}, rows[idx], patch, { updated_at: new Date().toISOString() })
  rows[idx] = after
  _writeStorageTable(tableName, rows)

  const log = _writeAuditLog('UPDATE', tableName, id, before, after, description)

  // 双向实时同步给 PC Web 网页端
  _syncMutationToServer({
    action: 'UPDATE',
    table: tableName,
    id: id,
    patch: patch,
    record: after,
    before: before,
    description: description || '',
    operator: _currentUser(),
    audit_log: log
  })

  return after
}

/**
 * 按 id 删除一条记录
 * @param {string} tableName
 * @param {string} id
 * @param {string} description
 * @returns {Object} 被删除的记录快照
 * @throws 如果目标表是 audit_logs，直接抛错（铁律）
 */
function remove(tableName, id, description) {
  if (tableName === TABLES.AUDIT_LOGS) {
    throw new Error('系统安全铁律：操作日志不可修改或删除')
  }
  const rows = getTable(tableName)
  const idx = rows.findIndex(r => r.id === id)
  if (idx === -1) throw new Error(`[db] remove: 记录不存在 (table=${tableName}, id=${id})`)

  // 财务安全铁律：已结算锁定的薪资结算单不可删除！
  if (tableName === TABLES.SALARY_SETTLEMENTS) {
    const existing = rows[idx]
    if (existing && existing.status === 'settled') {
      throw new Error('财务安全铁律：已结算锁定的薪资结算单不可删除！')
    }
  }

  const before = Object.assign({}, rows[idx])
  rows.splice(idx, 1)
  _writeStorageTable(tableName, rows)

  const log = _writeAuditLog('REMOVE', tableName, id, before, null, description)

  // 双向实时同步给 PC Web 网页端
  _syncMutationToServer({
    action: 'REMOVE',
    table: tableName,
    id: id,
    record: before,
    description: description || '',
    operator: _currentUser(),
    audit_log: log
  })

  return before
}

// ─────────────────────────────────────────
// 数据库初始化种子数据
// ─────────────────────────────────────────

function _buildSeedData() {
  const baseTime = '2026-03-01T08:00:00.000Z'

  // 1. 用户 (2超管, 2管理员, 3老师, 2家长)
  const users = [
    {
      id: 'u_sa1',
      name: '张校长(创始人)',
      role: 'super_admin',
      phone: '13800000001',
      status: 'active',
      created_at: baseTime,
      updated_at: baseTime,
    },
    {
      id: 'u_sa2',
      name: '李合伙人',
      role: 'super_admin',
      phone: '13800000002',
      status: 'active',
      created_at: baseTime,
      updated_at: baseTime,
    },
    {
      id: 'u_adm1',
      name: '王教务主管',
      role: 'admin',
      phone: '13800000003',
      status: 'active',
      created_at: baseTime,
      updated_at: baseTime,
    },
    {
      id: 'u_adm2',
      name: '赵财务主管',
      role: 'admin',
      phone: '13800000004',
      status: 'active',
      created_at: baseTime,
      updated_at: baseTime,
    },
    {
      id: 'u_tch1',
      name: '陈老师(初级)',
      role: 'teacher',
      phone: '13800000005',
      teacher_tier_id: 'tier_junior',
      custom_tier_rates_json: null,
      is_custom_rate: false,
      status: 'active',
      created_at: baseTime,
      updated_at: baseTime,
    },
    {
      id: 'u_tch2',
      name: '林老师(高级)',
      role: 'teacher',
      phone: '13800000006',
      teacher_tier_id: 'tier_senior',
      custom_tier_rates_json: null,
      is_custom_rate: false,
      status: 'active',
      created_at: baseTime,
      updated_at: baseTime,
    },
    {
      id: 'u_tch3',
      name: '周特聘名师',
      role: 'teacher',
      phone: '13800000007',
      teacher_tier_id: 'tier_middle',
      custom_tier_rates_json: { 1: 180, 2: 240, 3: 300 },
      is_custom_rate: true,
      status: 'active',
      created_at: baseTime,
      updated_at: baseTime,
    },
    {
      id: 'u_par1',
      name: '刘小宝家长',
      role: 'parent',
      phone: '13900000001',
      status: 'active',
      created_at: baseTime,
      updated_at: baseTime,
    },
    {
      id: 'u_par2',
      name: '孙小乐家长',
      role: 'parent',
      phone: '13900000002',
      status: 'active',
      created_at: baseTime,
      updated_at: baseTime,
    },
    {
      id: 'u_guest1',
      name: '新访客小周',
      role: 'guest',
      phone: '13800009999',
      status: 'pending',
      created_at: baseTime,
      updated_at: baseTime,
    },
  ]

  // 2. 学生 (4个学生，含 bound_parents)
  const students = [
    {
      id: 'stu_1',
      name: '刘小宝',
      gender: 'male',
      birthday: '2018-05-12',
      bound_parents: [
        { parent_id: 'u_par1', phone: '13900000001', relation: '父亲', subscribe_auth: true }
      ],
      created_at: baseTime,
      updated_at: baseTime,
    },
    {
      id: 'stu_2',
      name: '刘小贝',
      gender: 'female',
      birthday: '2020-09-01',
      bound_parents: [
        { parent_id: 'u_par1', phone: '13900000001', relation: '父亲', subscribe_auth: true }
      ],
      created_at: baseTime,
      updated_at: baseTime,
    },
    {
      id: 'stu_3',
      name: '孙小乐',
      gender: 'male',
      birthday: '2017-03-20',
      bound_parents: [
        { parent_id: 'u_par2', phone: '13900000002', relation: '母亲', subscribe_auth: false }
      ],
      created_at: baseTime,
      updated_at: baseTime,
    },
    {
      id: 'stu_4',
      name: '王星星',
      gender: 'female',
      birthday: '2019-11-15',
      bound_parents: [
        { parent_id: 'u_par2', phone: '13900000002', relation: '阿姨/监护人', subscribe_auth: true }
      ],
      created_at: baseTime,
      updated_at: baseTime,
    },
  ]

  // 3. 学期配置 (春夏秋冬)
  const terms = [
    {
      id: 'term_spring_2026',
      term_type: 'spring',
      name: '2026年春季学期',
      fixed_expire_date: '2026-06-30',
      created_at: baseTime,
      updated_at: baseTime,
    },
    {
      id: 'term_summer_2026',
      term_type: 'summer',
      name: '2026年暑假学期',
      fixed_expire_date: '2026-08-31',
      created_at: baseTime,
      updated_at: baseTime,
    },
    {
      id: 'term_autumn_2026',
      term_type: 'autumn',
      name: '2026年秋季学期',
      fixed_expire_date: '2027-01-15',
      created_at: baseTime,
      updated_at: baseTime,
    },
    {
      id: 'term_winter_2026',
      term_type: 'winter',
      name: '2026年寒假学期',
      fixed_expire_date: '2027-02-28',
      created_at: baseTime,
      updated_at: baseTime,
    },
  ]

  // 4. 老师薪资档位
  const teacher_tiers = [
    {
      id: 'tier_junior',
      name: '初级教师',
      headcount_rates_json: { 1: 100, 2: 140, 3: 180 },
      status: 'active',
      created_at: baseTime,
      updated_at: baseTime,
    },
    {
      id: 'tier_middle',
      name: '中级教师',
      headcount_rates_json: { 1: 120, 2: 160, 3: 200 },
      status: 'active',
      created_at: baseTime,
      updated_at: baseTime,
    },
    {
      id: 'tier_senior',
      name: '高级教师',
      headcount_rates_json: { 1: 150, 2: 200, 3: 260 },
      status: 'active',
      created_at: baseTime,
      updated_at: baseTime,
    },
  ]

  // 5. 课程与班型
  const courses_and_class_types = [
    {
      id: 'crs_1',
      course_name: '少儿机器人编程',
      class_type_name: '1v3小班',
      max_capacity: 3,
      unit_price: 180,
      hours_per_lesson: 1.5,
      status: 'active',
      created_at: baseTime,
      updated_at: baseTime,
    },
    {
      id: 'crs_2',
      course_name: '少儿创意美术',
      class_type_name: '1v6大班',
      max_capacity: 6,
      unit_price: 120,
      hours_per_lesson: 1.0,
      status: 'active',
      created_at: baseTime,
      updated_at: baseTime,
    },
    {
      id: 'crs_3',
      course_name: '思维数学拓展',
      class_type_name: '1v1定制',
      max_capacity: 1,
      unit_price: 300,
      hours_per_lesson: 1.0,
      status: 'active',
      created_at: baseTime,
      updated_at: baseTime,
    },
  ]

  // 6. 班级 (2个班级)
  const classes = [
    {
      id: 'cls_1',
      name: '乐高少儿编程-周六早班',
      course_id: 'crs_1',
      teacher_id: 'u_tch1',
      term_id: 'term_spring_2026',
      max_capacity_snapshot: 3,
      unit_price_snapshot: 180,
      hours_per_lesson_snapshot: 1.5,
      enrolled_student_ids: ['stu_1', 'stu_2'],
      trial_student_ids: ['stu_3'],
      status: 'active',
      created_at: baseTime,
      updated_at: baseTime,
    },
    {
      id: 'cls_2',
      name: '创意美术启蒙-周日下午班',
      course_id: 'crs_2',
      teacher_id: 'u_tch2',
      term_id: 'term_spring_2026',
      max_capacity_snapshot: 6,
      unit_price_snapshot: 120,
      hours_per_lesson_snapshot: 1.0,
      enrolled_student_ids: ['stu_3', 'stu_4'],
      trial_student_ids: [],
      status: 'active',
      created_at: baseTime,
      updated_at: baseTime,
    },
  ]

  // 7. 学生课时包
  const course_packages = [
    {
      id: 'pkg_1',
      student_id: 'stu_1',
      course_id: 'crs_1',
      class_id: 'cls_1',
      paid_hours_total: 40,
      paid_hours_left: 35.5,
      gift_hours_total: 4,
      gift_hours_left: 4,
      unit_price_snapshot: 180,
      account_destination: '招商银行对公账户',
      expire_date: '2026-06-30',
      total_frozen_days: 0,
      debt_hours: 0,
      lock_status: 'normal',
      locked_by_approval_id: null,
      created_at: baseTime,
      updated_at: baseTime,
    },
    {
      id: 'pkg_2',
      student_id: 'stu_2',
      course_id: 'crs_1',
      class_id: 'cls_1',
      paid_hours_total: 20,
      paid_hours_left: 18.5,
      gift_hours_total: 2,
      gift_hours_left: 2,
      unit_price_snapshot: 180,
      account_destination: '建设银行对私账户',
      expire_date: '2026-06-30',
      total_frozen_days: 0,
      debt_hours: 0,
      lock_status: 'normal',
      locked_by_approval_id: null,
      created_at: baseTime,
      updated_at: baseTime,
    },
    {
      id: 'pkg_3',
      student_id: 'stu_3',
      course_id: 'crs_2',
      class_id: 'cls_2',
      paid_hours_total: 30,
      paid_hours_left: 20.0,
      gift_hours_total: 0,
      gift_hours_left: 0,
      unit_price_snapshot: 120,
      account_destination: '招商银行对公账户',
      expire_date: '2026-06-30',
      total_frozen_days: 15,
      debt_hours: 0,
      lock_status: 'normal',
      locked_by_approval_id: null,
      created_at: baseTime,
      updated_at: baseTime,
    },
  ]

  // 8. 排课与考勤 (2条)
  const schedules_and_attendance = [
    {
      id: 'sch_1',
      class_id: 'cls_1',
      teacher_id: 'u_tch1',
      substitute_teacher_id: null, // Phase 3 预留字段：代课老师
      makeup_students: [], // Phase 3 预留字段：跨班补课学生挂载数组
      course_id: 'crs_1',
      lesson_date: '2026-03-07',
      start_time: '09:00',
      end_time: '10:30',
      snapshot_hours_per_lesson: 1.5,
      snapshot_max_capacity: 3,
      snapshot_teacher_rates_json: { 1: 100, 2: 140, 3: 180 },
      attendees_json: [
        { student_id: 'stu_1', status: 'present', deducted_hours: 1.5, package_id: 'pkg_1' },
        { student_id: 'stu_2', status: 'present', deducted_hours: 1.5, package_id: 'pkg_2' },
        { student_id: 'stu_3', status: 'trial', deducted_hours: 0, package_id: null }
      ],
      initial_present_headcount: 2,
      makeup_compensated_count: 0,
      calculated_teacher_fee: 140,
      is_settled: true,
      status: 'completed',
      created_at: baseTime,
      updated_at: baseTime,
    },
    {
      id: 'sch_2',
      class_id: 'cls_2',
      teacher_id: 'u_tch2',
      substitute_teacher_id: null, // Phase 3 预留字段：代课老师
      makeup_students: [], // Phase 3 预留字段：跨班补课学生挂载数组
      course_id: 'crs_2',
      lesson_date: '2026-03-08',
      start_time: '14:00',
      end_time: '15:00',
      snapshot_hours_per_lesson: 1.0,
      snapshot_max_capacity: 6,
      snapshot_teacher_rates_json: { 1: 150, 2: 200, 3: 260 },
      attendees_json: [
        { student_id: 'stu_3', status: 'pending', deducted_hours: 0, package_id: 'pkg_3' },
        { student_id: 'stu_4', status: 'pending', deducted_hours: 0, package_id: null }
      ],
      initial_present_headcount: 0,
      makeup_compensated_count: 0,
      calculated_teacher_fee: 0,
      is_settled: false,
      status: 'scheduled',
      created_at: baseTime,
      updated_at: baseTime,
    },
  ]

  // 9. 审批请求 (2条)
  const approval_requests = [
    {
      id: 'app_1',
      request_type: 'config_change',
      proposer_id: 'u_adm1',
      proposer_name: '王教务主管',
      required_approver_role: 'super_admin',
      target_table: 'teacher_tiers',
      target_record_id: 'tier_junior',
      snapshot_balance_at_propose: null,
      before_data_json: { headcount_rates_json: { 1: 100, 2: 140, 3: 180 } },
      after_data_json: { headcount_rates_json: { 1: 110, 2: 150, 3: 190 } },
      reason: '初级教师春季课酬阶梯基准上调申请',
      status: 'pending',
      approver_id: null,
      approved_time: null,
      reject_reason: null,
      created_at: baseTime,
      updated_at: baseTime,
    },
    {
      id: 'app_2',
      request_type: 'freeze_hours',
      proposer_id: 'u_adm2',
      proposer_name: '赵财务主管',
      required_approver_role: 'admin',
      target_table: 'course_packages',
      target_record_id: 'pkg_3',
      snapshot_balance_at_propose: { paid_hours_left: 20.0, gift_hours_left: 0 },
      before_data_json: { lock_status: 'normal', total_frozen_days: 15 },
      after_data_json: { lock_status: 'frozen', freeze_days: 30 },
      reason: '学员孙小乐骨折就医申请休学冻结30天课时',
      status: 'pending',
      approver_id: null,
      approved_time: null,
      reject_reason: null,
      created_at: baseTime,
      updated_at: baseTime,
    },
  ]

  // 10. 初始审计日志 (2条)
  const audit_logs = [
    {
      id: 'log_init_1',
      operator_id: 'u_sa1',
      operator_name: '张校长(创始人)',
      action_time: '2026-03-01T08:00:00.000Z',
      action: 'INIT',
      target_table: 'system',
      target_record_id: 'sys_001',
      before_snapshot_json: null,
      after_snapshot_json: JSON.stringify({ note: '系统初始建账，配置春夏秋冬四期与基础课酬标准' }),
      description: '初始化机构教学与财务基准数据',
    },
    {
      id: 'log_init_2',
      operator_id: 'u_sa1',
      operator_name: '张校长(创始人)',
      action_time: '2026-03-01T08:30:00.000Z',
      action: 'INIT',
      target_table: 'users',
      target_record_id: 'u_sa1',
      before_snapshot_json: null,
      after_snapshot_json: JSON.stringify({ role: 'super_admin', status: 'initialized' }),
      description: '初始化系统管理权限体系与角色分配',
    },
  ]

  return {
    [TABLES.USERS]: users,
    [TABLES.STUDENTS]: students,
    [TABLES.TERMS]: terms,
    [TABLES.TEACHER_TIERS]: teacher_tiers,
    [TABLES.PARTNER_TEACHER_RATE_CONFIG]: [{ id: 'partner_teacher', headcount_rates_json: null, status: 'unconfigured' }],
    [TABLES.COURSES_AND_CLASS_TYPES]: courses_and_class_types,
    [TABLES.CLASSES]: classes,
    [TABLES.COURSE_PACKAGES]: course_packages,
    [TABLES.SCHEDULES_AND_ATTENDANCE]: schedules_and_attendance,
    [TABLES.APPROVAL_REQUESTS]: approval_requests,
    [TABLES.AUDIT_LOGS]: audit_logs,
    [TABLES.TEACHER_LESSON_FEES]: [],
    [TABLES.SALARY_SETTLEMENTS]: [],
    [TABLES.SALARY_ADJUSTMENTS]: [],
    [TABLES.MANUAL_HOUR_ADJUSTMENTS]: [],
    [TABLES.TRANSFER_RECORDS]: [],
    [TABLES.REFUND_RECORDS]: [],
    [TABLES.TERM_ROLLOVER_RECORDS]: [],
  }
}

// ─────────────────────────────────────────
// 数据库初始化
// ─────────────────────────────────────────

/**
 * 初始化数据库
 * @param {boolean} forceReset - 为 true 时清空所有表并重新写入种子数据
 */
function initDatabase(forceReset = false) {
  if (!isMiniProgram) {
    if (forceReset || !_fs || !_fs.existsSync(_dbFilePath)) {
      // Even an explicitly enabled development reseed must not reuse versions
      // or forget completed command keys within the same database lineage.
      const state = (_nodeMemoryDb || (_fs && _fs.existsSync(_dbFilePath))) ? getWriteState() : null
      _nodeMemoryDb = _buildSeedData()
      if (state) _nodeMemoryDb[WRITE_STATE] = state
      _persistNodeDb()
    } else {
      _loadNodeDb()
    }
    return
  }

  // 小程序端初始化
  const isInited = wx.getStorageSync(DB_INIT_FLAG)
  if (isInited && !forceReset) {
    const users = wx.getStorageSync(TABLES.USERS) || []
    if (!users.some(u => u.id === 'u_guest1')) {
      const seed = _buildSeedData()
      const guest = seed[TABLES.USERS].find(u => u.id === 'u_guest1')
      if (guest) {
        users.push(guest)
        wx.setStorageSync(TABLES.USERS, users)
      }
    }
    // 启动时自动从后端服务拉取最新状态（与 PC Web 端同库）
    syncFromServer()
    return
  }

  const seed = _buildSeedData()
  Object.keys(seed).forEach(tableName => {
    wx.setStorageSync(tableName, seed[tableName])
  })

  wx.setStorageSync(DB_INIT_FLAG, true)

  // 尝试同步至后端服务
  syncFromServer()
}

/**
 * [Phase 6-A 核心亮点] 小程序端从后端服务端全量同步数据
 * @param {Function} callback
 */
function syncFromServer(callback) {
  if (!isMiniProgram || !wx.request || !_getBearerToken()) {
    if (callback) callback(null)
    return
  }

  wx.request({
    url: `${SERVER_API_BASE}/api/db/all`,
    method: 'GET',
    header: { Authorization: 'Bearer ' + _getBearerToken() },
    timeout: 3000,
    success(res) {
      if (res.data && res.data.code === 0 && res.data.data) {
        const remoteDb = res.data.data
        Object.keys(remoteDb).forEach(tableName => {
          if (Array.isArray(remoteDb[tableName])) {
            wx.setStorageSync(tableName, remoteDb[tableName])
          }
        })
        wx.setStorageSync(DB_INIT_FLAG, true)
        if (callback) callback(remoteDb)
      } else {
        if (callback) callback(null)
      }
    },
    fail(err) {
      // 服务未启动时忽略，维持本地运作
      if (callback) callback(null)
    }
  })
}

let _autoSyncTimer = null

/**
 * 启动小程序端静默后台自动同步轮询（默认 3 秒）
 */
function startAutoSync(intervalMs = 3000) {
  // Disabled until writes use authenticated, validated server business endpoints.
  // Periodic full snapshots could otherwise overwrite unsynced local business changes.
  if (!isMiniProgram || _autoSyncTimer || wx.getStorageSync('sync_mode') !== 'legacy_dev') return
  _autoSyncTimer = setInterval(() => {
    syncFromServer()
  }, intervalMs)
}

/** 导出全库（用于服务端 API） */
function dumpAll() {
  if (isMiniProgram) {
    const data = {}
    Object.values(TABLES).forEach(t => {
      data[t] = wx.getStorageSync(t) || []
    })
    return data
  }
  const { [WRITE_STATE]: _internal, ...business } = _loadNodeDb()
  return business
}

/** 全库覆盖写入（用于服务端恢复或测试重置） */
function replaceAll(newDb) {
  if (isMiniProgram) {
    Object.keys(newDb).forEach(t => {
      wx.setStorageSync(t, newDb[t])
    })
    return
  }
  const state = getWriteState()
  _nodeMemoryDb = Object.assign({}, newDb, { [WRITE_STATE]: state })
  _persistNodeDb()
}

// ─────────────────────────────────────────
// 导出
// ─────────────────────────────────────────
module.exports = {
  TABLES,
  getTable,
  getById,
  insert,
  update,
  remove,
  initDatabase,
  syncFromServer,
  startAutoSync,
  dumpAll,
  replaceAll,
  transaction,
  getWriteState,
  saveCommandReceipt,
  SERVER_API_BASE,
}


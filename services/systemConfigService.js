// services/systemConfigService.js
// 系统参数设置与审批生效服务（Phase 1-A）
const db = require('./db')
const { normalizeManualRates } = require('./salaryRateConfig')

/**
 * 校验当前登录人是否为管理员或超级管理员（老师与家长无权操作）
 */
function checkAdminPermission() {
  const serverUser = db.getTransactionOperator()
  const app = serverUser ? null : getApp()
  const user = serverUser || (app && app.globalData && app.globalData.currentUser) || wx.getStorageSync('current_user')
  if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) {
    throw new Error('权限拦截：仅教务管理(admin)或超级管理员(super_admin)可操作参数设置')
  }
  return user
}

/**
 * 校验出勤人数阶梯课酬 JSON 的合法性
 * 铁律：若封顶人数改大，必须强制校验并要求给每个新增加的人数档位填上价格（1 到 max_capacity 连续不可缺失）
 * @param {Object} headcountRates - 形如 { 1: 100, 2: 140, 3: 180 }
 * @param {number} maxCapacity - 封顶出勤人数
 */
function validateHeadcountRates(headcountRates, maxCapacity) {
  if (!headcountRates || typeof headcountRates !== 'object') {
    throw new Error('课酬阶梯必须为合法对象')
  }
  const max = Number(maxCapacity) || 0
  if (max <= 0) {
    throw new Error('封顶出勤人数必须大于0')
  }

  const missingCounts = []
  for (let i = 1; i <= max; i++) {
    const rate = headcountRates[i] !== undefined ? Number(headcountRates[i]) : NaN
    if (isNaN(rate) || rate <= 0) {
      missingCounts.push(i)
    }
  }

  if (missingCounts.length > 0) {
    throw new Error(`校验拦截：当前封顶人数为 ${max} 人，必须为所有出勤人数档位配置单价！缺少或未填出勤档位：${missingCounts.map(n => n + '人').join('、')}`)
  }
}

const systemConfigService = {
  // ─────────────────────────────────────────
  // 1. 四期到期日配置
  // ─────────────────────────────────────────

  /** 获取四期配置列表 */
  getTerms() {
    return db.getTable(db.TABLES.TERMS) || []
  },

  /**
   * 提交四期到期日修改申请（进入审批流）
   * @param {Object} params - { termId, newExpireDate, reason }
   */
  submitTermExpireDateRequest(params) {
    if (typeof wx !== 'undefined' && typeof wx.request === 'function' && !db.inServerTransaction()) return require('./commandClient').run('approval.propose',{type:'config.term',data:params})
    const user = checkAdminPermission()
    const { termId, newExpireDate, reason } = params

    if (!termId || !newExpireDate) {
      throw new Error('学期ID与新到期日不能为空')
    }
    if (!reason || !reason.trim()) {
      throw new Error('修改系统关键参数必须填写变更事由')
    }

    const term = db.getById(db.TABLES.TERMS, termId)
    if (!term) throw new Error(`未找到指定学期配置 (id=${termId})`)

    const beforeData = {
      name: term.name,
      term_type: term.term_type,
      fixed_expire_date: term.fixed_expire_date
    }

    const afterData = {
      fixed_expire_date: newExpireDate
    }

    // 写入审批请求表
    const newApproval = {
      request_type: 'config_change',
      config_subtype: 'term_expire_date',
      proposer_id: user.id,
      proposer_name: user.name,
      required_approver_role: 'super_admin',
      target_table: db.TABLES.TERMS,
      target_record_id: termId,
      snapshot_balance_at_propose: null,
      before_data_json: beforeData,
      after_data_json: afterData,
      reason: `【${term.name}】到期日调整为 ${newExpireDate}。理由：${reason.trim()}`,
      status: 'pending',
      approver_id: null,
      approved_time: null,
      reject_reason: null
    }

    const created = db.insert(
      db.TABLES.APPROVAL_REQUESTS,
      newApproval,
      `[${user.name}] 提交【${term.name}】到期日变更申请`
    )

    return created
  },

  // ─────────────────────────────────────────
  // 2. 班型与课程单价设置（旧班不变，新班用新的）
  // ─────────────────────────────────────────

  /** 获取所有课程班型列表 */
  getCoursesAndClassTypes() {
    return db.getTable(db.TABLES.COURSES_AND_CLASS_TYPES) || []
  },

  /**
   * 提交新增课程与班型申请
   * @param {Object} params - { course_name, class_type_name, max_capacity, unit_price, hours_per_lesson, reason }
   */
  submitCreateCourseClassTypeRequest(params) {
    if (typeof wx !== 'undefined' && typeof wx.request === 'function' && !db.inServerTransaction()) return require('./commandClient').run('approval.propose',{type:'config.courseCreate',data:params})
    const user = checkAdminPermission()
    const { course_name, class_type_name, max_capacity, unit_price, hours_per_lesson, reason } = params

    if (!course_name || !class_type_name) throw new Error('课程名称与班型名称必填')
    const maxCap = Number(max_capacity)
    const price = Number(unit_price)
    const hours = Number(hours_per_lesson)
    if (isNaN(maxCap) || maxCap <= 0) throw new Error('封顶人数必须为大于0的正整数')
    if (isNaN(price) || price <= 0) throw new Error('课时单价必须大于0')
    if (isNaN(hours) || hours <= 0) throw new Error('单次课时数必须大于0')
    if (!reason || !reason.trim()) throw new Error('新建课程班型必须填写说明理由')

    const afterData = {
      course_name: course_name.trim(),
      class_type_name: class_type_name.trim(),
      max_capacity: maxCap,
      unit_price: price,
      hours_per_lesson: hours,
      status: 'active'
    }

    const newApproval = {
      request_type: 'config_change',
      config_subtype: 'course_class_type_create',
      proposer_id: user.id,
      proposer_name: user.name,
      required_approver_role: 'super_admin',
      target_table: db.TABLES.COURSES_AND_CLASS_TYPES,
      target_record_id: null, // 新建无原ID
      snapshot_balance_at_propose: null,
      before_data_json: null,
      after_data_json: afterData,
      reason: `申请新建课程班型【${course_name} - ${class_type_name}】(单价:${price}元, 封顶:${maxCap}人)。事由：${reason.trim()}`,
      status: 'pending',
      approver_id: null,
      approved_time: null,
      reject_reason: null
    }

    return db.insert(
      db.TABLES.APPROVAL_REQUESTS,
      newApproval,
      `[${user.name}] 提交新建课程班型申请【${course_name}】`
    )
  },

  /**
   * 提交修改已有课程班型参数申请
   * 铁律：修改后只作用于之后新建的班级，已有旧班级快照不变
   * @param {string} id - 课程班型ID
   * @param {Object} params - { max_capacity, unit_price, hours_per_lesson, reason }
   */
  submitUpdateCourseClassTypeRequest(id, params) {
    if (typeof wx !== 'undefined' && typeof wx.request === 'function' && !db.inServerTransaction()) return require('./commandClient').run('approval.propose',{type:'config.courseUpdate',data:params,target_id:id})
    const user = checkAdminPermission()
    const { max_capacity, unit_price, hours_per_lesson, reason } = params

    const existing = db.getById(db.TABLES.COURSES_AND_CLASS_TYPES, id)
    if (!existing) throw new Error(`未找到课程班型记录 (id=${id})`)

    const maxCap = Number(max_capacity)
    const price = Number(unit_price)
    const hours = Number(hours_per_lesson)
    if (isNaN(maxCap) || maxCap <= 0) throw new Error('封顶人数必须为大于0的正整数')
    if (isNaN(price) || price <= 0) throw new Error('课时单价必须大于0')
    if (isNaN(hours) || hours <= 0) throw new Error('单次课时数必须大于0')
    if (!reason || !reason.trim()) throw new Error('调整班型参数必须填写变更事由')

    const beforeData = {
      course_name: existing.course_name,
      class_type_name: existing.class_type_name,
      max_capacity: existing.max_capacity,
      unit_price: existing.unit_price,
      hours_per_lesson: existing.hours_per_lesson
    }

    const afterData = {
      max_capacity: maxCap,
      unit_price: price,
      hours_per_lesson: hours
    }

    const newApproval = {
      request_type: 'config_change',
      config_subtype: 'course_class_type_update',
      proposer_id: user.id,
      proposer_name: user.name,
      required_approver_role: 'super_admin',
      target_table: db.TABLES.COURSES_AND_CLASS_TYPES,
      target_record_id: id,
      snapshot_balance_at_propose: null,
      before_data_json: beforeData,
      after_data_json: afterData,
      reason: `【${existing.course_name}-${existing.class_type_name}】参数调整(单价:${price}元, 封顶:${maxCap}人)。事由：${reason.trim()}`,
      status: 'pending',
      approver_id: null,
      approved_time: null,
      reject_reason: null
    }

    return db.insert(
      db.TABLES.APPROVAL_REQUESTS,
      newApproval,
      `[${user.name}] 提交课程班型【${existing.course_name}】参数调整申请`
    )
  },

  // ─────────────────────────────────────────
  // 3. 教师薪资档位设置
  // ─────────────────────────────────────────

  /** 获取所有教师薪资档位列表 */
  getTeacherTiers() {
    return db.getTable(db.TABLES.TEACHER_TIERS) || []
  },

  /** 获取所有教师用户列表（包含其档位或特聘自定义状态） */
  getTeachers() {
    const users = db.getTable(db.TABLES.USERS) || []
    const tiers = this.getTeacherTiers()
    const tierMap = {}
    tiers.forEach(t => { tierMap[t.id] = t })

    return users.filter(u => u.role === 'teacher').map(t => {
      const defaultTier = tierMap[t.teacher_tier_id]
      const isPartnerTeacher = t.teacher_category === 'partner_teacher'
      const partnerConfig = db.getById(db.TABLES.PARTNER_TEACHER_RATE_CONFIG, 'partner_teacher')
      return Object.assign({}, t, {
        tierName: isPartnerTeacher ? '合伙人老师' : (defaultTier ? defaultTier.name : '未绑定档位'),
        defaultTierRates: isPartnerTeacher ? (partnerConfig ? partnerConfig.headcount_rates_json : null) : (defaultTier ? defaultTier.headcount_rates_json : null),
        teacherCategory: isPartnerTeacher ? 'partner_teacher' : 'ordinary',
        isCustom: !!t.is_custom_rate
      })
    })
  },

  /** Partner-teacher pay is a separate table, not a normal Level or partnership dividend. */
  getPartnerTeacherRates() {
    return db.getById(db.TABLES.PARTNER_TEACHER_RATE_CONFIG, 'partner_teacher')
  },

  submitPartnerTeacherRatesRequest(params) {
    if (typeof wx !== 'undefined' && typeof wx.request === 'function' && !db.inServerTransaction()) return require('./commandClient').run('approval.propose',{type:'config.partnerRates',data:params})
    const user = checkAdminPermission()
    const { headcount_rates_json, reason } = params
    if (!reason || !reason.trim()) throw new Error('设置合伙人老师课时费必须说明理由')
    const validatedRates = normalizeManualRates(headcount_rates_json)
    const existing = this.getPartnerTeacherRates()
    return db.insert(db.TABLES.APPROVAL_REQUESTS, {
      request_type: 'config_change',
      config_subtype: 'partner_teacher_rates',
      proposer_id: user.id,
      proposer_name: user.name,
      required_approver_role: 'super_admin',
      target_table: db.TABLES.PARTNER_TEACHER_RATE_CONFIG,
      target_record_id: existing ? existing.id : null,
      before_data_json: existing || null,
      after_data_json: { id: 'partner_teacher', status: 'active', headcount_rates_json: validatedRates },
      reason: reason.trim(),
      status: 'pending'
    }, `[${user.name}] 提交合伙人老师八档课时费申请`)
  },

  /** Partner is a teaching category; it never grants super-admin privileges. */
  submitTeacherCategoryRequest(teacherId, params) {
    if (typeof wx !== 'undefined' && typeof wx.request === 'function' && !db.inServerTransaction()) return require('./commandClient').run('approval.propose',{type:'config.teacherCategory',data:params,target_id:teacherId})
    const user = checkAdminPermission()
    const { teacher_category, teacher_tier_id, reason } = params
    if (!reason || !reason.trim()) throw new Error('调整教师类别必须填写理由')
    const teacher = db.getById(db.TABLES.USERS, teacherId)
    if (!teacher || teacher.role !== 'teacher') throw new Error('仅能修改教师类别')
    if (teacher_category !== 'ordinary' && teacher_category !== 'partner_teacher') {
      throw new Error('教师类别只能是普通教师或合伙人老师')
    }
    if (teacher_category === 'ordinary') {
      const tier = db.getById(db.TABLES.TEACHER_TIERS, teacher_tier_id || teacher.teacher_tier_id)
      if (!tier) throw new Error('普通教师必须绑定有效的薪酬等级')
    }
    const afterData = { teacher_category }
    if (teacher_category === 'ordinary') afterData.teacher_tier_id = teacher_tier_id || teacher.teacher_tier_id
    return db.insert(db.TABLES.APPROVAL_REQUESTS, {
      request_type: 'config_change',
      config_subtype: 'teacher_category',
      proposer_id: user.id,
      proposer_name: user.name,
      required_approver_role: 'super_admin',
      target_table: db.TABLES.USERS,
      target_record_id: teacherId,
      before_data_json: { teacher_category: teacher.teacher_category || 'ordinary', teacher_tier_id: teacher.teacher_tier_id },
      after_data_json: afterData,
      reason: reason.trim(),
      status: 'pending'
    }, `[${user.name}] 申请调整老师【${teacher.name}】类别`)
  },

  /**
   * 提交新增教师薪资档位申请
   * @param {Object} params - { name, headcount_rates_json, maxCapacity, reason }
   */
  submitCreateTeacherTierRequest(params) {
    if (typeof wx !== 'undefined' && typeof wx.request === 'function' && !db.inServerTransaction()) return require('./commandClient').run('approval.propose',{type:'config.tierCreate',data:params})
    const user = checkAdminPermission()
    const { name, headcount_rates_json, maxCapacity, reason } = params

    if (!name || !name.trim()) throw new Error('档位名称不能为空')
    if (!reason || !reason.trim()) throw new Error('新增教师薪资档位必须填写申请理由')

    // 强校验阶梯出勤人数与价格
    const validatedRates = normalizeManualRates(headcount_rates_json)

    const afterData = {
      name: name.trim(),
      headcount_rates_json: validatedRates,
      status: 'active'
    }

    const newApproval = {
      request_type: 'config_change',
      config_subtype: 'teacher_tier_create',
      proposer_id: user.id,
      proposer_name: user.name,
      required_approver_role: 'super_admin',
      target_table: db.TABLES.TEACHER_TIERS,
      target_record_id: null,
      snapshot_balance_at_propose: null,
      before_data_json: null,
      after_data_json: afterData,
      reason: `申请新增教师薪资档位【${name.trim()}】。事由：${reason.trim()}`,
      status: 'pending',
      approver_id: null,
      approved_time: null,
      reject_reason: null
    }

    return db.insert(
      db.TABLES.APPROVAL_REQUESTS,
      newApproval,
      `[${user.name}] 申请新增教师薪资档位【${name}】`
    )
  },

  /**
   * 提交修改教师薪资档位申请（改名/改价）
   * 铁律：
   * 1. 改名不改历史，以前签到的记录保留签到时的快照不变；
   * 2. 若把封顶人数改大，必须强制校验并要求给新增加的人数档位填上价格。
   * @param {string} tierId
   * @param {Object} params - { name, headcount_rates_json, maxCapacity, reason }
   */
  submitUpdateTeacherTierRequest(tierId, params) {
    if (typeof wx !== 'undefined' && typeof wx.request === 'function' && !db.inServerTransaction()) return require('./commandClient').run('approval.propose',{type:'config.tierUpdate',data:params,target_id:tierId})
    const user = checkAdminPermission()
    const { name, headcount_rates_json, maxCapacity, reason } = params

    const tier = db.getById(db.TABLES.TEACHER_TIERS, tierId)
    if (!tier) throw new Error(`未找到指定教师档位 (id=${tierId})`)

    if (!name || !name.trim()) throw new Error('档位名称不能为空')
    if (!reason || !reason.trim()) throw new Error('修改薪资档位必须填写申请理由')

    // 强校验：阶梯出勤价格必须覆盖到最新封顶人数的每一个数字
    const validatedRates = normalizeManualRates(headcount_rates_json)

    const beforeData = {
      name: tier.name,
      headcount_rates_json: tier.headcount_rates_json
    }

    const afterData = {
      name: name.trim(),
      headcount_rates_json: validatedRates
    }

    const newApproval = {
      request_type: 'config_change',
      config_subtype: 'teacher_tier_update',
      proposer_id: user.id,
      proposer_name: user.name,
      required_approver_role: 'super_admin',
      target_table: db.TABLES.TEACHER_TIERS,
      target_record_id: tierId,
      snapshot_balance_at_propose: null,
      before_data_json: beforeData,
      after_data_json: afterData,
      reason: `【${tier.name}】档位参数调整（新名称:${name.trim()}）。事由：${reason.trim()}`,
      status: 'pending',
      approver_id: null,
      approved_time: null,
      reject_reason: null
    }

    return db.insert(
      db.TABLES.APPROVAL_REQUESTS,
      newApproval,
      `[${user.name}] 提交教师档位【${tier.name}】课酬调整申请`
    )
  },

  /**
   * 提交单个老师单独改数申请（脱离默认档，不跟档位变化）
   * @param {string} teacherId
   * @param {Object} params - { custom_tier_rates_json, maxCapacity, reason }
   */
  submitTeacherCustomRateRequest(teacherId, params) {
    if (typeof wx !== 'undefined' && typeof wx.request === 'function' && !db.inServerTransaction()) return require('./commandClient').run('approval.propose',{type:'config.teacherRates',data:params,target_id:teacherId})
    const user = checkAdminPermission()
    const { custom_tier_rates_json, maxCapacity, reason } = params

    const teacher = db.getById(db.TABLES.USERS, teacherId)
    if (!teacher || teacher.role !== 'teacher') throw new Error(`未找到指定教师 (id=${teacherId})`)
    if (!reason || !reason.trim()) throw new Error('为老师定制特聘课酬必须填写申请事由')

    const validatedRates = normalizeManualRates(custom_tier_rates_json)

    const beforeData = {
      teacher_name: teacher.name,
      is_custom_rate: teacher.is_custom_rate,
      custom_tier_rates_json: teacher.custom_tier_rates_json
    }

    const afterData = {
      is_custom_rate: true,
      custom_tier_rates_json: validatedRates
    }

    const newApproval = {
      request_type: 'config_change',
      config_subtype: 'teacher_custom_rate',
      proposer_id: user.id,
      proposer_name: user.name,
      required_approver_role: 'super_admin',
      target_table: db.TABLES.USERS,
      target_record_id: teacherId,
      snapshot_balance_at_propose: null,
      before_data_json: beforeData,
      after_data_json: afterData,
      reason: `【${teacher.name}】申请设置特聘独立课酬阶梯（脱离默认档）。事由：${reason.trim()}`,
      status: 'pending',
      approver_id: null,
      approved_time: null,
      reject_reason: null
    }

    return db.insert(
      db.TABLES.APPROVAL_REQUESTS,
      newApproval,
      `[${user.name}] 提交教师【${teacher.name}】特聘课酬设置申请`
    )
  },

  /**
   * 提交单个老师恢复跟档默认申请（清回档位默认）
   * @param {string} teacherId
   * @param {Object} params - { reason }
   */
  submitTeacherResetTierRequest(teacherId, params) {
    if (typeof wx !== 'undefined' && typeof wx.request === 'function' && !db.inServerTransaction()) return require('./commandClient').run('approval.propose',{type:'config.teacherReset',data:params,target_id:teacherId})
    const user = checkAdminPermission()
    const { reason } = params

    const teacher = db.getById(db.TABLES.USERS, teacherId)
    if (!teacher || teacher.role !== 'teacher') throw new Error(`未找到指定教师 (id=${teacherId})`)
    if (!reason || !reason.trim()) throw new Error('恢复默认档位跟档必须填写申请事由')

    const beforeData = {
      teacher_name: teacher.name,
      is_custom_rate: teacher.is_custom_rate,
      custom_tier_rates_json: teacher.custom_tier_rates_json
    }

    const afterData = {
      is_custom_rate: false,
      custom_tier_rates_json: null
    }

    const newApproval = {
      request_type: 'config_change',
      config_subtype: 'teacher_reset_tier',
      proposer_id: user.id,
      proposer_name: user.name,
      required_approver_role: 'super_admin',
      target_table: db.TABLES.USERS,
      target_record_id: teacherId,
      snapshot_balance_at_propose: null,
      before_data_json: beforeData,
      after_data_json: afterData,
      reason: `【${teacher.name}】恢复默认薪资档位跟档结算。事由：${reason.trim()}`,
      status: 'pending',
      approver_id: null,
      approved_time: null,
      reject_reason: null
    }

    return db.insert(
      db.TABLES.APPROVAL_REQUESTS,
      newApproval,
      `[${user.name}] 提交教师【${teacher.name}】恢复默认跟档申请`
    )
  },

  // ─────────────────────────────────────────
  // 4. 审批生效覆盖执行器（核心铁律）
  // ─────────────────────────────────────────

  /**
   * 当超级管理员审批通过 config_change 类型的单据时，正式将 after_data_json 覆盖写入目标业务表
   * @param {Object} approvalItem - 审批单记录对象
   * @param {Object} approverUser - 审批人用户对象
   */
  applyConfigApproval(approvalItem, approverUser) {
    if (!approvalItem || approvalItem.request_type !== 'config_change') {
      return { success: false, message: '非系统参数配置类审批单，跳过覆盖' }
    }
    if (!approverUser || approverUser.role !== 'super_admin') {
      throw new Error('系统安全铁律：仅超级管理员有权批准生效系统关键参数配置')
    }

    const { target_table, target_record_id, after_data_json, config_subtype } = approvalItem
    if (!target_table || !after_data_json) {
      throw new Error('审批单缺少目标数据表或覆盖数据')
    }

    let resultRecord = null
    const desc = `超管[${approverUser.name}]审批通过单据 #${approvalItem.id}，参数生效覆盖至 [${target_table}]`

    // 若无 target_record_id，说明是新建记录
    if (!target_record_id) {
      resultRecord = db.insert(target_table, after_data_json, desc)
    } else {
      // 存在 target_record_id，执行覆盖更新
      resultRecord = db.update(target_table, target_record_id, after_data_json, desc)
    }

    return {
      success: true,
      target_table,
      record: resultRecord
    }
  }
}

module.exports = systemConfigService


// services/attendanceService.js
// 点名考勤与销课流水服务（Phase 2-B & Phase 2-C & Phase 3-A 升级版）
const db = require('./db')
const packageAccountService = require('./packageAccountService')
const salaryEngineService = require('./salaryEngineService')
const notificationService = require('./notificationService')

/**
 * 校验当前登录人是否具备管理员或超级管理员权限
 */
function checkAdminPermission() {
  const app = getApp()
  const user = (app && app.globalData && app.globalData.currentUser) || wx.getStorageSync('current_user')
  if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) {
    throw new Error('权限拦截：仅管理员(admin)或超级管理员(super_admin)拥有取消课程与整班顺延的权限')
  }
  return user
}

/**
 * 日期顺延辅助函数（顺延指定天数，默认 7 天整周周期）
 */
function addDaysToDateStr(dateStr, days = 7) {
  if (!dateStr) return dateStr
  const parts = dateStr.split('-').map(Number)
  const d = new Date(parts[0], parts[1] - 1, parts[2])
  d.setDate(d.getDate() + days)
  const pad = n => (n < 10 ? '0' + n : n)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * 获取当前登录人
 */
function getCurrentUser() {
  const app = getApp()
  return (app && app.globalData && app.globalData.currentUser) || wx.getStorageSync('current_user') || { id: 'unknown', role: 'guest', name: '访客' }
}

/**
 * 读取老师当前的薪资档位快照（含阶梯人头价格表）
 * 铁律：特聘名师独立改数使用独立价，普通老师跟档
 */
function getTeacherTierSnapshot(teacherId) {
  if (!teacherId) return null
  const teacher = db.getById(db.TABLES.USERS, teacherId)
  if (!teacher) return null

  // 1. 若为独立改数的特聘名师
  if (teacher.is_custom_rate && teacher.custom_tier_rates_json) {
    return {
      teacher_id: teacher.id,
      teacher_name: teacher.name,
      is_custom_rate: true,
      tier_id: 'custom_tier',
      tier_name: '特聘名师独立课酬阶梯',
      headcount_rates_json: teacher.custom_tier_rates_json
    }
  }

  // 2. 默认跟档读取薪资档位表
  const tierId = teacher.teacher_tier_id || 'tier_junior'
  const tier = db.getById(db.TABLES.TEACHER_TIERS, tierId)
  return {
    teacher_id: teacher.id,
    teacher_name: teacher.name,
    is_custom_rate: false,
    tier_id: tier ? tier.id : tierId,
    tier_name: tier ? tier.name : '标准教师档',
    headcount_rates_json: tier ? tier.headcount_rates_json : { 1: 100, 2: 140, 3: 180 }
  }
}

/**
 * 老师端隐私隔离过滤（铁律）：
 * 绝对禁止在返回给老师端的数据中暴露学生具体还剩几课时（过滤 paid_hours_left, gift_hours_left, total_hours 等）
 */
function maskStudentPrivacyForTeacher(studentObj) {
  if (!studentObj) return null
  const copy = Object.assign({}, studentObj)

  // 物理删除所有学员财务隐私与课时余额相关敏感字段
  delete copy.paid_hours_left
  delete copy.gift_hours_left
  delete copy.total_available_hours
  delete copy.total_hours
  delete copy.debt_hours
  delete copy.paid_hours_total
  delete copy.gift_hours_total
  delete copy.total_amount
  delete copy.unit_price_snapshot
  delete copy.unit_price
  delete copy.account_destination
  delete copy.packages
  delete copy.refund_records
  delete copy.admin_debug_balance
  delete copy.deducted_detail_json
  delete copy.balance_snapshot
  delete copy.remaining_hours
  delete copy.paid_hours
  delete copy.gift_hours

  // 标记脱敏保护已启用
  copy.privacy_masked = true
  return copy
}

/**
 * 检查排课日程是否处于提交签到后的 24 小时自主修改期内
 * @param {Object} schedule
 * @returns {Object} { is_within_24h, hours_elapsed, remaining_hours_str }
 */
function check24HourWindow(schedule) {
  if (!schedule || !schedule.attendance_submitted_at) {
    return { is_within_24h: false, hours_elapsed: 0, remaining_hours_str: '未签到' }
  }

  const submittedTime = new Date(schedule.attendance_submitted_at).getTime()
  const now = Date.now()
  const elapsedMs = now - submittedTime
  const elapsedHours = Number((elapsedMs / (3600 * 1000)).toFixed(1))

  const isWithin24h = elapsedMs <= 24 * 3600 * 1000
  const remainingHours = Math.max(0, Number((24 - elapsedHours).toFixed(1)))

  return {
    is_within_24h: isWithin24h,
    hours_elapsed: elapsedHours,
    remaining_hours_str: isWithin24h ? `剩余 ${remainingHours} 小时可自主修改` : '已超过24小时(锁死)'
  }
}

const attendanceService = {
  // ─────────────────────────────────────────
  // 1. 获取签到表（带24小时修改窗口、隐私脱敏与Phase 3补课插槽）
  // ─────────────────────────────────────────

  /**
   * 获取指定排课日程的签到点名表
   * @param {string} scheduleId - 排课ID
   * @param {Object} viewerUser - 当前查看人（用于判断是否对老师端脱敏）
   */
  getAttendanceSheet(scheduleId, viewerUser) {
    const user = viewerUser || getCurrentUser()
    const isTeacher = user && user.role === 'teacher'

    const schedule = db.getById(db.TABLES.SCHEDULES_AND_ATTENDANCE, scheduleId)
    if (!schedule) throw new Error(`未找到指定排课记录 (id=${scheduleId})`)

    const cls = db.getById(db.TABLES.CLASSES, schedule.class_id)
    if (!cls) throw new Error(`未找到该排课所属班级 (id=${schedule.class_id})`)

    const course = db.getById(db.TABLES.COURSES_AND_CLASS_TYPES, schedule.course_id || cls.course_id)
    const teacher = db.getById(db.TABLES.USERS, schedule.teacher_id)

    // 读取班级在读学生与试听学生
    const allStudents = db.getTable(db.TABLES.STUDENTS) || []
    const studentMap = {}
    allStudents.forEach(s => { studentMap[s.id] = s })

    const enrolledIds = cls.enrolled_student_ids || []
    const trialIds = cls.trial_student_ids || []

    // 历史或预设的签到记录映射
    const existingAttendees = schedule.attendees_json || []
    const attendeeMap = {}
    existingAttendees.forEach(a => { attendeeMap[a.student_id] = a })

    // 24 小时自主改签窗口校验
    const windowInfo = check24HourWindow(schedule)

    // 组装正式学生列表
    const enrolledStudents = enrolledIds.map(stuId => {
      const stu = studentMap[stuId] || { id: stuId, name: `学员#${stuId}` }
      const record = attendeeMap[stuId]
      const isPresent = record ? record.status === 'present' : false

      // 检查该缺勤学生是否有已创建的补课预约工单 (Phase 3-C 激活)
      const makeupReq = (db.getTable(db.TABLES.MAKEUP_REQUESTS) || []).find(r =>
        r.original_schedule_id === schedule.id && r.student_id === stu.id
      )
      const makeupStatus = makeupReq ? makeupReq.status : (record ? record.makeup_status || 'none' : 'none')

      let stuData = {
        student_id: stu.id,
        name: stu.name,
        gender: stu.gender,
        is_trial: false,
        is_makeup: false,
        type_tag: '正式学员',
        status: isPresent ? 'present' : 'absent',
        is_late: record ? !!record.is_late : false,
        is_early_leave: record ? !!record.is_early_leave : false,
        deducted_hours: record ? record.deducted_hours : 0,
        deducted_detail_json: record ? record.deducted_detail_json : null,
        // ── 【Phase 3-C 缺勤补课预约核心字段】 ──
        can_book_makeup: !isPresent,
        makeup_status: makeupStatus,
        makeup_request_id: makeupReq ? makeupReq.id : (record ? record.makeup_request_id : null),
        makeup_slot_desc: !isPresent ? (
          makeupStatus === 'waived' ? '家长放弃补课(课时保留)' :
          makeupStatus === 'pending_admin_assignment' ? '待管理员协调跨师补课' :
          makeupStatus === 'scheduled' ? '已排定补课日程' :
          makeupStatus === 'completed' ? '补课已完成消课' :
          '未到可发起补课预约'
        ) : null
      }

      if (!isTeacher) {
        const balance = packageAccountService.getStudentCourseBalance(stu.id, cls.course_id)
        stuData.admin_debug_balance = balance
      } else {
        stuData = maskStudentPrivacyForTeacher(stuData)
      }

      return stuData
    })

    // 组装试听学生列表（铁律：试听生不扣课时、不算老师人头）
    const trialStudents = trialIds.map(stuId => {
      const stu = studentMap[stuId] || { id: stuId, name: `试听生#${stuId}` }
      const record = attendeeMap[stuId]
      const isPresent = record ? record.status === 'present' : false

      let stuData = {
        student_id: stu.id,
        name: stu.name,
        gender: stu.gender,
        is_trial: true,
        is_makeup: false,
        type_tag: '试听学员 (不扣课时/不算人头)',
        status: isPresent ? 'present' : 'absent',
        is_late: record ? !!record.is_late : false,
        is_early_leave: record ? !!record.is_early_leave : false,
        deducted_hours: 0,
        can_book_makeup: false
      }

      if (isTeacher) {
        stuData = maskStudentPrivacyForTeacher(stuData)
      }

      return stuData
    })

    // ─────────────────────────────────────────
    // Phase 3-C：组装挂载的跨班/单独补课学生列表 (makeup_students)
    // 铁律：代课老师与跨班补课老师同样严格隔离学员课时余额
    // ─────────────────────────────────────────
    const rawMakeupStudents = schedule.makeup_students || []
    const makeupStudents = rawMakeupStudents.map(mk => {
      const stu = studentMap[mk.student_id] || { id: mk.student_id, name: mk.student_name }
      const isPresent = mk.status === 'present'

      let stuData = {
        student_id: mk.student_id,
        name: mk.student_name || stu.name,
        gender: stu.gender || '未知',
        is_trial: false,
        is_makeup: true,
        type_tag: `补课学员 (${mk.original_teacher_name ? mk.original_teacher_name + '原班' : '跨班补课'})`,
        status: isPresent ? 'present' : 'absent',
        is_late: !!mk.is_late,
        is_early_leave: !!mk.is_early_leave,
        deducted_hours: mk.deducted_hours || 0,
        deducted_detail_json: mk.deducted_detail_json || null,
        original_teacher_id: mk.original_teacher_id,
        original_teacher_name: mk.original_teacher_name,
        original_absent_schedule_id: mk.original_absent_schedule_id,
        original_course_id: mk.original_course_id,
        original_hours_per_lesson: mk.original_hours_per_lesson,
        locked_hours_desc: `锁死原课时: ${mk.original_hours_per_lesson} 课时`,
        can_book_makeup: false
      }

      if (!isTeacher) {
        const balance = packageAccountService.getStudentCourseBalance(mk.student_id, mk.original_course_id || cls.course_id)
        stuData.admin_debug_balance = balance
      } else {
        stuData = maskStudentPrivacyForTeacher(stuData)
      }

      return stuData
    })

    return {
      schedule: {
        id: schedule.id,
        lesson_date: schedule.lesson_date,
        start_time: schedule.start_time,
        end_time: schedule.end_time,
        lesson_index: schedule.lesson_index || 1,
        hours_per_lesson: schedule.snapshot_hours_per_lesson || cls.hours_per_lesson_snapshot,
        max_capacity: schedule.snapshot_max_capacity || cls.max_capacity_snapshot,
        status: schedule.status, // 'scheduled' | 'completed' | 'pending_makeup_sign_approval'
        initial_present_headcount: schedule.initial_present_headcount || 0,
        calculated_teacher_fee: schedule.calculated_teacher_fee || 0,
        is_settled: !!schedule.is_settled,
        attendance_submitted_at: schedule.attendance_submitted_at || null,
        attendance_submitted_by: schedule.attendance_submitted_by || '',
        teacher_salary_tier_snapshot: schedule.teacher_salary_tier_snapshot_json || null,
        // 24小时修改窗口判定
        is_within_24_hours: windowInfo.is_within_24h,
        hours_since_submitted: windowInfo.hours_elapsed,
        remaining_hours_str: windowInfo.remaining_hours_str,
        is_locked_after_24h: schedule.status === 'completed' && !windowInfo.is_within_24h,
        is_solo_makeup: !!schedule.is_solo_makeup
      },
      class_info: {
        id: cls.id,
        name: cls.name,
        weekly_schedule: cls.weekly_schedule,
        course_name: course ? course.course_name : cls.course_name_snapshot,
        teacher_name: teacher ? teacher.name : cls.teacher_name_snapshot
      },
      students: [...enrolledStudents, ...trialStudents, ...makeupStudents],
      makeup_students: makeupStudents,
      enrolled_count: enrolledStudents.length,
      trial_count: trialStudents.length,
      makeup_count: makeupStudents.length,
      privacy_isolated_for_teacher: isTeacher
    }
  },

  // ─────────────────────────────────────────
  // 2. 正向点名签到提交事务（带Phase 4课酬钩子）
  // ─────────────────────────────────────────

  /**
   * 提交排课考勤签到
   */
  submitAttendance(scheduleId, attendanceInputs = [], operatorUser) {
    const operator = operatorUser || getCurrentUser()
    if (!scheduleId) throw new Error('排课记录ID不能为空')

    const schedule = db.getById(db.TABLES.SCHEDULES_AND_ATTENDANCE, scheduleId)
    if (!schedule) throw new Error(`未找到指定排课记录 (id=${scheduleId})`)

    const cls = db.getById(db.TABLES.CLASSES, schedule.class_id)
    if (!cls) throw new Error(`未找到该排课所属班级 (id=${schedule.class_id})`)

    const hoursPerLesson = Number(schedule.snapshot_hours_per_lesson || cls.hours_per_lesson_snapshot)
    if (isNaN(hoursPerLesson) || hoursPerLesson <= 0) {
      throw new Error(`排课班级单节课时异常 (hours_per_lesson=${hoursPerLesson})`)
    }

    const maxCapacity = Number(schedule.snapshot_max_capacity || cls.max_capacity_snapshot || 3)
    const effectiveTeacherId = schedule.substitute_teacher_id || schedule.teacher_id || cls.teacher_id
    const teacherSalaryTierSnapshot = getTeacherTierSnapshot(effectiveTeacherId)

    const enrolledIds = cls.enrolled_student_ids || []
    const trialIds = cls.trial_student_ids || []
    const allStudents = db.getTable(db.TABLES.STUDENTS) || []
    const studentMap = {}
    allStudents.forEach(s => { studentMap[s.id] = s })

    const inputMap = {}
    attendanceInputs.forEach(item => {
      inputMap[item.student_id] = item
    })

    const allClassStudentIds = [...enrolledIds, ...trialIds]
    const finalizedAttendees = []
    let presentFormalHeadcount = 0
    let presentTrialCount = 0
    let absentCount = 0
    const insufficientBalanceNotices = []

    allClassStudentIds.forEach(stuId => {
      const isTrial = trialIds.includes(stuId)
      const input = inputMap[stuId]
      const stuObj = studentMap[stuId]
      const stuName = stuObj ? stuObj.name : `学员#${stuId}`

      const isPresent = input ? !!input.is_present : false
      const isLate = isPresent && input ? !!input.is_late : false
      const isEarlyLeave = isPresent && input ? !!input.is_early_leave : false
      const status = isPresent ? 'present' : 'absent'

      let deductedHours = 0
      let deductedDetailJson = null

      if (isPresent) {
        if (!isTrial) {
          presentFormalHeadcount++
          const deductRes = packageAccountService.deductHours({
            student_id: stuId,
            course_id: cls.course_id,
            hours_needed: hoursPerLesson,
            context_desc: `班级【${cls.name}】第${schedule.lesson_index || 1}次课出勤消课`
          })

          deductedHours = hoursPerLesson
          deductedDetailJson = deductRes.deducted_detail_json

          if (deductRes.insufficient_balance_flagged) {
            insufficientBalanceNotices.push({
              student_id: stuId,
              student_name: stuName,
              message: `学生【${stuName}】可用课时不足一节课（已透支欠费 ${deductRes.debt_added} 课时），系统已记入欠费账本，请提醒续费。`
            })
          }
        } else {
          presentTrialCount++
          deductedHours = 0
          deductedDetailJson = null
        }
      } else {
        absentCount++
        deductedHours = 0
        deductedDetailJson = null
      }

      finalizedAttendees.push({
        student_id: stuId,
        student_name: stuName,
        is_trial: isTrial,
        status: status,
        is_late: isLate,
        is_early_leave: isEarlyLeave,
        deducted_hours: deductedHours,
        deducted_detail_json: deductedDetailJson
      })
    })

    // ─────────────────────────────────────────
    // Phase 3-C 铁律：处理挂载的跨班/单独补课学生 (makeup_students)
    // 补课扣费锁死：扣减学生的课时数强制等于原缺勤那节课的应扣课时数 (original_hours_per_lesson)
    // ─────────────────────────────────────────
    const updatedMakeupStudents = []
    const rawMakeupStudents = schedule.makeup_students || []

    rawMakeupStudents.forEach(mk => {
      const input = inputMap[mk.student_id]
      const isPresent = input ? !!input.is_present : false
      const isLate = isPresent && input ? !!input.is_late : false
      const isEarlyLeave = isPresent && input ? !!input.is_early_leave : false
      const status = isPresent ? 'present' : 'absent'

      let deductedHours = 0
      let deductedDetailJson = null

      if (isPresent) {
        presentFormalHeadcount++
        const lockedHours = Number(mk.original_hours_per_lesson)

        const deductRes = packageAccountService.deductHours({
          student_id: mk.student_id,
          course_id: mk.original_course_id || cls.course_id,
          hours_needed: lockedHours,
          context_desc: `[补课签到消课] 班级【${cls.name}】第${schedule.lesson_index || 1}次课，补课生【${mk.student_name}】出勤消课(锁定扣除原缺勤课时${lockedHours}课时)`
        })

        deductedHours = lockedHours
        deductedDetailJson = deductRes.deducted_detail_json

        if (deductRes.insufficient_balance_flagged) {
          insufficientBalanceNotices.push({
            student_id: mk.student_id,
            student_name: mk.student_name,
            message: `[补课欠费预警] 补课学生【${mk.student_name}】签到扣费后余额不足一节课（透支欠费 ${deductRes.debt_added} 课时）`
          })
        }

        if (mk.makeup_request_id) {
          try {
            db.update(
              db.TABLES.MAKEUP_REQUESTS,
              mk.makeup_request_id,
              {
                status: 'completed',
                completed_at: new Date().toISOString(),
                completed_schedule_id: schedule.id
              },
              `[补课消课完成] 学员【${mk.student_name}】在排课 #${schedule.id} 完成补课出勤消课`
            )
          } catch (e) {
            console.warn('[submitAttendance] update makeup_request failed:', e)
          }
        }

        // ── Phase 4-B：若为原老师补课 (makeup_teacher == original_teacher)，触发原班累进补差 ──
        if (effectiveTeacherId === mk.original_teacher_id && mk.original_absent_schedule_id) {
          try {
            salaryEngineService.applyMakeupProgressiveDifferential({
              original_absent_schedule_id: mk.original_absent_schedule_id,
              student_id: mk.student_id,
              student_name: mk.student_name,
              makeup_schedule_id: schedule.id,
              operatorUser: operator
            })
          } catch (e) {
            console.warn('[submitAttendance] applyMakeupProgressiveDifferential failed:', e)
          }
        }
      } else {
        absentCount++
        deductedHours = 0
        deductedDetailJson = null
      }

      updatedMakeupStudents.push(Object.assign({}, mk, {
        status,
        is_late: isLate,
        is_early_leave: isEarlyLeave,
        deducted_hours: deductedHours,
        deducted_detail_json: deductedDetailJson
      }))
    })

    const nowIso = new Date().toISOString()
    const updatePayload = {
      snapshot_hours_per_lesson: hoursPerLesson,
      snapshot_max_capacity: maxCapacity,
      teacher_id_snapshot: effectiveTeacherId,
      teacher_salary_tier_snapshot_json: teacherSalaryTierSnapshot,
      initial_present_headcount: presentFormalHeadcount,
      attendees_json: finalizedAttendees,
      makeup_students: updatedMakeupStudents,
      status: 'completed',
      attendance_submitted_at: nowIso,
      attendance_submitted_by: operator.name || '授课老师'
    }

    const logDesc = `[点名签到] 操作人【${operator.name}】完成班级【${cls.name}】第${schedule.lesson_index || 1}次课签到。正式出勤:${presentFormalHeadcount}人(试听出勤:${presentTrialCount}人, 未出勤:${absentCount}人)。单节课时快照:${hoursPerLesson}课时/人`

    db.update(db.TABLES.SCHEDULES_AND_ATTENDANCE, schedule.id, updatePayload, logDesc)

    // ─────────────────────────────────────────
    // 【Phase 4 课时费实时核算钩子 1：正向签到完成触发】
    // ─────────────────────────────────────────
    let feeResult = null
    try {
      feeResult = salaryEngineService.calculateLessonFee(schedule.id)
    } catch (e) {
      console.warn('[submitAttendance] calculateLessonFee hook failed:', e)
    }

    return {
      success: true,
      schedule_id: schedule.id,
      class_id: cls.id,
      class_name: cls.name,
      lesson_date: schedule.lesson_date,
      hours_per_lesson: hoursPerLesson,
      initial_present_headcount: presentFormalHeadcount,
      present_formal_headcount: feeResult ? feeResult.effective_headcount : presentFormalHeadcount,
      present_trial_count: presentTrialCount,
      absent_count: absentCount,
      calculated_teacher_fee: feeResult ? feeResult.calculated_teacher_fee : 0,
      fee_result: feeResult,
      teacher_tier_snapshot: teacherSalaryTierSnapshot,
      attendees: finalizedAttendees,
      insufficient_balance_notices: insufficientBalanceNotices,
      submitted_at: nowIso
    }
  },

  // ─────────────────────────────────────────
  // 3. 24小时自主改签与精准逆向重算（Phase 2-C 核心）
  // ─────────────────────────────────────────

  /**
   * 老师在提交签到 24 小时以内自主改签
   *
   * 核心铁律：
   * 1. 时间窗口校验：超过 24 小时彻底锁死，拦截抛错！
   * 2. 未出勤 -> 出勤：对新增出勤正式生调用 deductHours 正常扣课时，生成留痕；
   * 3. 出勤 -> 未出勤：调用 rollbackHours 严格原路逆向退还（冲欠费+退赠送+退付费），清空留痕；
   * 4. 重新统计当节正式出勤人头并更新快照；
   * 5. 触发 Phase 4 课时费重算钩子。
   *
   * @param {string} scheduleId
   * @param {Array<Object>} updatedInputs - 最新考勤状态 [{ student_id, is_present, is_late, is_early_leave }]
   * @param {Object} operatorUser
   */
  updateAttendanceWithin24Hours(scheduleId, updatedInputs = [], operatorUser) {
    const operator = operatorUser || getCurrentUser()
    if (!scheduleId) throw new Error('排课记录ID不能为空')

    const schedule = db.getById(db.TABLES.SCHEDULES_AND_ATTENDANCE, scheduleId)
    if (!schedule) throw new Error(`未找到指定排课记录 (id=${scheduleId})`)

    if (schedule.status !== 'completed') {
      throw new Error('该节课尚未完成初次签到，不可执行改签')
    }

    // ─────────────────────────────────────────
    // 铁律 1：24 小时修改窗口校验（超过彻底硬性锁死）
    // ─────────────────────────────────────────
    const windowInfo = check24HourWindow(schedule)
    if (!windowInfo.is_within_24h) {
      throw new Error(`已超过24小时修改期（已耗时 ${windowInfo.hours_elapsed} 小时），系统已彻底锁死该节课考勤！如需改签请联系管理员走手工调课时审批流程。`)
    }

    const cls = db.getById(db.TABLES.CLASSES, schedule.class_id)
    if (!cls) throw new Error(`未找到该排课所属班级 (id=${schedule.class_id})`)

    const hoursPerLesson = Number(schedule.snapshot_hours_per_lesson || cls.hours_per_lesson_snapshot || 1.5)
    const oldAttendees = schedule.attendees_json || []
    const oldAttendeeMap = {}
    oldAttendees.forEach(a => { oldAttendeeMap[a.student_id] = a })

    const inputMap = {}
    updatedInputs.forEach(item => {
      inputMap[item.student_id] = item
    })

    const trialIds = cls.trial_student_ids || []
    const enrolledIds = cls.enrolled_student_ids || []
    const allStudentIds = [...enrolledIds, ...trialIds]
    const allStudents = db.getTable(db.TABLES.STUDENTS) || []
    const studentMap = {}
    allStudents.forEach(s => { studentMap[s.id] = s })

    const updatedAttendees = []
    let newFormalHeadcount = 0
    let newTrialHeadcount = 0
    let newAbsentCount = 0
    const changedDetails = []
    const insufficientBalanceNotices = []

    // ─────────────────────────────────────────
    // 铁律 2：比对变动并执行 精准扣费 / 原路逆向回滚
    // ─────────────────────────────────────────
    allStudentIds.forEach(stuId => {
      const isTrial = trialIds.includes(stuId)
      const stuObj = studentMap[stuId]
      const stuName = stuObj ? stuObj.name : `学员#${stuId}`

      const oldRec = oldAttendeeMap[stuId] || { status: 'absent', deducted_hours: 0, deducted_detail_json: null }
      const oldIsPresent = oldRec.status === 'present'

      const input = inputMap[stuId]
      const newIsPresent = input ? !!input.is_present : false
      const newIsLate = newIsPresent && input ? !!input.is_late : false
      const newIsEarlyLeave = newIsPresent && input ? !!input.is_early_leave : false
      const newStatus = newIsPresent ? 'present' : 'absent'

      let newDeductedHours = oldRec.deducted_hours || 0
      let newDeductedDetail = oldRec.deducted_detail_json || null

      if (!oldIsPresent && newIsPresent) {
        // ── 变更1：从“未出勤”改为“出勤” ──
        if (!isTrial) {
          // 对新增出勤的正式学生执行正常扣课时
          const deductRes = packageAccountService.deductHours({
            student_id: stuId,
            course_id: cls.course_id,
            hours_needed: hoursPerLesson,
            context_desc: `[24小时改签] 班级【${cls.name}】第${schedule.lesson_index}次课改签出勤补扣`
          })

          newDeductedHours = hoursPerLesson
          newDeductedDetail = deductRes.deducted_detail_json

          if (deductRes.insufficient_balance_flagged) {
            insufficientBalanceNotices.push({
              student_id: stuId,
              student_name: stuName,
              message: `[改签欠费] 学生【${stuName}】改签出勤后余额不足一节课（透支欠费 ${deductRes.debt_added} 课时）`
            })
          }

          changedDetails.push(`【${stuName}】从[未出勤]改为[出勤]，扣除${hoursPerLesson}课时`)
        } else {
          newDeductedHours = 0
          newDeductedDetail = null
          changedDetails.push(`试听生【${stuName}】从[未出勤]改为[出勤](不扣课时/不算人头)`)
        }
      } else if (oldIsPresent && !newIsPresent) {
        // ── 变更2：从“出勤”改回“未出勤”（原路精准逆向退回！） ──
        if (!isTrial && oldRec.deducted_detail_json) {
          packageAccountService.rollbackHours(
            oldRec.deducted_detail_json,
            `[24小时内老师自主改签] 班级【${cls.name}】第${schedule.lesson_index}次课，学生【${stuName}】由出勤改回未出勤原路回滚`
          )
          changedDetails.push(`【${stuName}】从[出勤]改回[未出勤]，已原路逆向退还课时与冲减欠费`)
        }
        newDeductedHours = 0
        newDeductedDetail = null
      } else if (oldIsPresent && newIsPresent) {
        // ── 变更3：维持出勤不变，仅更新迟到/早退 ──
        if (oldRec.is_late !== newIsLate || oldRec.is_early_leave !== newIsEarlyLeave) {
          changedDetails.push(`【${stuName}】调整标记: 迟到=${newIsLate}, 早退=${newIsEarlyLeave}`)
        }
      }

      if (newIsPresent) {
        if (!isTrial) {
          newFormalHeadcount++
        } else {
          newTrialHeadcount++
        }
      } else {
        newAbsentCount++
      }

      updatedAttendees.push({
        student_id: stuId,
        student_name: stuName,
        is_trial: isTrial,
        status: newStatus,
        is_late: newIsLate,
        is_early_leave: newIsEarlyLeave,
        deducted_hours: newDeductedHours,
        deducted_detail_json: newDeductedDetail
      })
    })

    // ─────────────────────────────────────────
    // Phase 3-C 铁律：24小时内改签补课学生 (makeup_students)
    // 逆向回滚与原路补扣
    // ─────────────────────────────────────────
    const updatedMakeupStudents = []
    const rawMakeupStudents = schedule.makeup_students || []

    rawMakeupStudents.forEach(mk => {
      const oldIsPresent = mk.status === 'present'
      const input = inputMap[mk.student_id]
      const newIsPresent = input ? !!input.is_present : false
      const newIsLate = newIsPresent && input ? !!input.is_late : false
      const newIsEarlyLeave = newIsPresent && input ? !!input.is_early_leave : false
      const newStatus = newIsPresent ? 'present' : 'absent'

      let newDeductedHours = mk.deducted_hours || 0
      let newDeductedDetail = mk.deducted_detail_json || null

      if (!oldIsPresent && newIsPresent) {
        // 从“未出勤”改为“出勤”：锁死原课时扣费
        newFormalHeadcount++
        const lockedHours = Number(mk.original_hours_per_lesson)
        const deductRes = packageAccountService.deductHours({
          student_id: mk.student_id,
          course_id: mk.original_course_id || cls.course_id,
          hours_needed: lockedHours,
          context_desc: `[24小时改签] 班级【${cls.name}】第${schedule.lesson_index}次课，补课生【${mk.student_name}】改签出勤补扣(锁死原课时${lockedHours}课时)`
        })

        newDeductedHours = lockedHours
        newDeductedDetail = deductRes.deducted_detail_json

        if (deductRes.insufficient_balance_flagged) {
          insufficientBalanceNotices.push({
            student_id: mk.student_id,
            student_name: mk.student_name,
            message: `[补课改签欠费] 补课学生【${mk.student_name}】改签出勤后余额不足一节课（透支欠费 ${deductRes.debt_added} 课时）`
          })
        }

        if (mk.makeup_request_id) {
          try {
            db.update(
              db.TABLES.MAKEUP_REQUESTS,
              mk.makeup_request_id,
              { status: 'completed', completed_at: new Date().toISOString(), completed_schedule_id: schedule.id },
              `[补课改签完成] 学员【${mk.student_name}】在排课 #${schedule.id} 改签出勤`
            )
          } catch (e) {}
        }

        // ── Phase 4-B：改签为出勤，若为原师补课，计算累进补差 ──
        if (effectiveTeacherId === mk.original_teacher_id && mk.original_absent_schedule_id) {
          try {
            salaryEngineService.applyMakeupProgressiveDifferential({
              original_absent_schedule_id: mk.original_absent_schedule_id,
              student_id: mk.student_id,
              student_name: mk.student_name,
              makeup_schedule_id: schedule.id,
              operatorUser: operator
            })
          } catch (e) {
            console.warn('[modifyAttendanceWithin24Hours] applyMakeupProgressiveDifferential failed:', e)
          }
        }

        changedDetails.push(`补课生【${mk.student_name}】从[未出勤]改为[出勤]，锁定扣除${lockedHours}课时`)
      } else if (oldIsPresent && !newIsPresent) {
        // 从“出勤”改为“未出勤”：原路逆向退还课时！
        if (mk.deducted_detail_json) {
          packageAccountService.rollbackHours(
            mk.deducted_detail_json,
            `[24小时改签回滚] 班级【${cls.name}】第${schedule.lesson_index}次课，补课生【${mk.student_name}】由出勤改回未出勤原路回滚`
          )
        }
        newDeductedHours = 0
        newDeductedDetail = null

        if (mk.makeup_request_id) {
          try {
            db.update(
              db.TABLES.MAKEUP_REQUESTS,
              mk.makeup_request_id,
              { status: 'scheduled', completed_at: null, completed_schedule_id: null },
              `[补课改签回滚] 学员【${mk.student_name}】由出勤改回未出勤，恢复为排定状态`
            )
          } catch (e) {}
        }

        // ── Phase 4-B：改签改回未出勤，若为原师补课，撤销累进补差并重新对齐 ──
        if (effectiveTeacherId === mk.original_teacher_id && mk.original_absent_schedule_id) {
          try {
            salaryEngineService.revokeMakeupProgressiveDifferential({
              original_absent_schedule_id: mk.original_absent_schedule_id,
              student_id: mk.student_id,
              makeup_schedule_id: schedule.id,
              operatorUser: operator
            })
          } catch (e) {
            console.warn('[modifyAttendanceWithin24Hours] revokeMakeupProgressiveDifferential failed:', e)
          }
        }

        changedDetails.push(`补课生【${mk.student_name}】从[出勤]改回[未出勤]，已原路退还课时与冲减欠费`)
      } else if (oldIsPresent && newIsPresent) {
        newFormalHeadcount++
        if (mk.is_late !== newIsLate || mk.is_early_leave !== newIsEarlyLeave) {
          changedDetails.push(`补课生【${mk.student_name}】调整标记: 迟到=${newIsLate}, 早退=${newIsEarlyLeave}`)
        }
      } else {
        newAbsentCount++
      }

      updatedMakeupStudents.push(Object.assign({}, mk, {
        status: newStatus,
        is_late: newIsLate,
        is_early_leave: newIsEarlyLeave,
        deducted_hours: newDeductedHours,
        deducted_detail_json: newDeductedDetail
      }))
    })

    // 更新排课记录
    const nowIso = new Date().toISOString()
    const updatePayload = {
      initial_present_headcount: newFormalHeadcount,
      attendees_json: updatedAttendees,
      makeup_students: updatedMakeupStudents,
      attendance_last_modified_at: nowIso,
      attendance_last_modified_by: operator.name || '授课老师'
    }

    const logDesc = `[24小时改签] 操作人【${operator.name}】修改班级【${cls.name}】第${schedule.lesson_index}次课签到。调整后正式出勤:${newFormalHeadcount}人(试听:${newTrialHeadcount}人, 未到:${newAbsentCount}人)。明细: ${changedDetails.join('; ') || '状态未变'}`

    db.update(db.TABLES.SCHEDULES_AND_ATTENDANCE, schedule.id, updatePayload, logDesc)

    // ─────────────────────────────────────────
    // 【Phase 4 课时费实时核算钩子 2：24小时内修改签到完成触发】
    // ─────────────────────────────────────────
    let feeResult = null
    try {
      feeResult = salaryEngineService.calculateLessonFee(schedule.id)
    } catch (e) {
      console.warn('[updateAttendanceWithin24Hours] calculateLessonFee hook failed:', e)
    }

    return {
      success: true,
      schedule_id: schedule.id,
      present_formal_headcount: feeResult ? feeResult.effective_headcount : newFormalHeadcount,
      present_trial_count: newTrialHeadcount,
      absent_count: newAbsentCount,
      calculated_teacher_fee: feeResult ? feeResult.calculated_teacher_fee : 0,
      fee_result: feeResult,
      changed_details: changedDetails,
      insufficient_balance_notices: insufficientBalanceNotices,
      modified_at: nowIso
    }
  },

  // ─────────────────────────────────────────
  // 4. 忘记提交签到（漏签补签审批流）
  // ─────────────────────────────────────────

  /**
   * 老师发起漏签补签申请（提交超级管理员审批）
   * 铁律：系统绝不替老师自动签到，暂不扣学生课时，排课置为 pending_makeup_sign_approval
   *
   * @param {string} scheduleId
   * @param {Array<Object>} attendanceInputs - 补签提交的出勤名单
   * @param {string} reason - 漏签理由 (必填)
   * @param {Object} operatorUser
   */
  requestMakeupAttendance(scheduleId, attendanceInputs = [], reason = '', operatorUser) {
    const operator = operatorUser || getCurrentUser()
    if (!scheduleId) throw new Error('排课记录ID不能为空')
    if (!reason || !reason.trim()) throw new Error('必须填写漏签补签的说明理由')

    const schedule = db.getById(db.TABLES.SCHEDULES_AND_ATTENDANCE, scheduleId)
    if (!schedule) throw new Error(`未找到指定排课记录 (id=${scheduleId})`)

    const cls = db.getById(db.TABLES.CLASSES, schedule.class_id)
    if (!cls) throw new Error(`未找到该排课所属班级 (id=${schedule.class_id})`)

    // 排课状态置为 pending_makeup_sign_approval
    db.update(
      db.TABLES.SCHEDULES_AND_ATTENDANCE,
      schedule.id,
      {
        status: 'pending_makeup_sign_approval',
        makeup_sign_requested_at: new Date().toISOString(),
        makeup_sign_reason: reason.trim()
      },
      `[漏签补签申请] 老师【${operator.name}】提交班级【${cls.name}】第${schedule.lesson_index}次课补签申请，等待超级管理员审批`
    )

    // 生成一条待超管审批的审批单
    const approvalRecord = {
      request_type: 'makeup_attendance',
      proposer_id: operator.id,
      proposer_name: operator.name,
      required_approver_role: 'super_admin', // 强制超级管理员审批
      target_table: db.TABLES.SCHEDULES_AND_ATTENDANCE,
      target_record_id: schedule.id,
      snapshot_balance_at_propose: null,
      before_data_json: { schedule_id: schedule.id, previous_status: schedule.status },
      after_data_json: {
        schedule_id: schedule.id,
        class_id: cls.id,
        class_name: cls.name,
        attendance_inputs: attendanceInputs,
        reason: reason.trim()
      },
      reason: `老师[${operator.name}]申请补签班级【${cls.name}】第${schedule.lesson_index}次课(${schedule.lesson_date})考勤。事由: ${reason.trim()}`,
      status: 'pending',
      approver_id: null,
      approved_time: null,
      reject_reason: null
    }

    const createdApproval = db.insert(
      db.TABLES.APPROVAL_REQUESTS,
      approvalRecord,
      `[漏签补签] 为排课 #${schedule.id} 生成补签审批单`
    )

    return {
      success: true,
      schedule_id: schedule.id,
      approval_id: createdApproval.id,
      status: 'pending_makeup_sign_approval',
      message: '补签申请已提交，等待超级管理员审批。超管批准后将自动扣课时并锁死快照！'
    }
  },

  /**
   * 超管批准漏签补签审批回调（考勤正式落地扣费并锁死快照）
   * @param {Object} approvalItem - 审批单记录
   * @param {Object} approverUser - 审批人
   */
  applyMakeupSignApproval(approvalItem, approverUser) {
    const afterData = typeof approvalItem.after_data_json === 'string'
      ? JSON.parse(approvalItem.after_data_json)
      : (approvalItem.after_data_json || {})

    const scheduleId = afterData.schedule_id
    const attendanceInputs = afterData.attendance_inputs || []

    if (!scheduleId) throw new Error('补签审批数据中缺失 schedule_id')

    // 真正执行正向点名签到落地扣费与快照锁死
    const submitResult = this.submitAttendance(scheduleId, attendanceInputs, {
      id: approvalItem.proposer_id,
      name: approvalItem.proposer_name || '执教老师'
    })

    // 记录超管批准日志
    db.update(
      db.TABLES.SCHEDULES_AND_ATTENDANCE,
      scheduleId,
      {
        approved_by_super_admin_id: approverUser.id,
        approved_by_super_admin_name: approverUser.name
      },
      `[补签审批通过落地] 超级管理员【${approverUser.name}】批准了排课 #${scheduleId} 的漏签补签申请单 #${approvalItem.id}`
    )

    return submitResult
  },

  /**
   * 超管驳回漏签补签审批回调
   * @param {Object} approvalItem
   * @param {string} rejectReason
   * @param {Object} approverUser
   */
  rejectMakeupSignApproval(approvalItem, rejectReason, approverUser) {
    const afterData = typeof approvalItem.after_data_json === 'string'
      ? JSON.parse(approvalItem.after_data_json)
      : (approvalItem.after_data_json || {})

    const scheduleId = afterData.schedule_id
    if (!scheduleId) return

    // 将排课恢复为 scheduled 状态，维持未签状态，绝不扣课时
    db.update(
      db.TABLES.SCHEDULES_AND_ATTENDANCE,
      scheduleId,
      {
        status: 'scheduled',
        makeup_sign_rejected_reason: rejectReason || '超级管理员驳回补签申请'
      },
      `[补签驳回] 超管【${approverUser.name}】驳回排课 #${scheduleId} 漏签补签申请: ${rejectReason || '未说明'}`
    )
  },

  // ─────────────────────────────────────────
  // 5. 排课日程创建与查询辅助
  // ─────────────────────────────────────────

  /** 创建一节排课日程 */
  createSchedule(scheduleData) {
    const { class_id, lesson_date, start_time, end_time, lesson_index = 1 } = scheduleData
    if (!class_id) throw new Error('必须指定所属班级')
    if (!lesson_date) throw new Error('必须指定上课日期')
    if (!start_time || !end_time) throw new Error('必须指定上课起止时间')

    const cls = db.getById(db.TABLES.CLASSES, class_id)
    if (!cls) throw new Error(`未找到指定班级 (id=${class_id})`)

    const newRecord = {
      class_id: cls.id,
      course_id: cls.course_id,
      teacher_id: cls.teacher_id,
      substitute_teacher_id: null,
      makeup_students: [],
      lesson_date,
      start_time,
      end_time,
      lesson_index: Number(lesson_index) || 1,
      snapshot_hours_per_lesson: cls.hours_per_lesson_snapshot,
      snapshot_max_capacity: cls.max_capacity_snapshot,
      snapshot_teacher_rates_json: null,
      attendees_json: [],
      initial_present_headcount: 0,
      makeup_compensated_count: 0,
      calculated_teacher_fee: 0,
      is_settled: false,
      status: 'scheduled'
    }

    const desc = `创建班级【${cls.name}】第${newRecord.lesson_index}次课日程 (${lesson_date} ${start_time}-${end_time})`
    return db.insert(db.TABLES.SCHEDULES_AND_ATTENDANCE, newRecord, desc)
  },

  /** 查询排课日程列表 */
  getSchedulesList(filter = {}, viewerUser) {
    const user = viewerUser || getCurrentUser()
    const isTeacher = user && user.role === 'teacher'

    const schedules = db.getTable(db.TABLES.SCHEDULES_AND_ATTENDANCE) || []
    const classes = db.getTable(db.TABLES.CLASSES) || []
    const classMap = {}
    classes.forEach(c => { classMap[c.id] = c })

    return schedules.filter(s => {
      if (isTeacher && !filter.all_teachers) {
        const myId = user.id
        if (s.teacher_id !== myId && s.substitute_teacher_id !== myId) {
          return false
        }
      } else if (filter.teacher_id) {
        if (s.teacher_id !== filter.teacher_id && s.substitute_teacher_id !== filter.teacher_id) {
          return false
        }
      }

      if (filter.class_id && s.class_id !== filter.class_id) return false
      if (filter.status && s.status !== filter.status) return false
      if (filter.lesson_date && s.lesson_date !== filter.lesson_date) return false

      return true
    }).map(s => {
      const cls = classMap[s.class_id]
      const windowInfo = check24HourWindow(s)
      return Object.assign({}, s, {
        class_name: cls ? cls.name : `班级#${s.class_id}`,
        weekly_schedule: cls ? cls.weekly_schedule : '',
        course_name: cls ? cls.course_name_snapshot : '',
        hours_per_lesson: s.snapshot_hours_per_lesson || (cls ? cls.hours_per_lesson_snapshot : 1.5),
        max_capacity: s.snapshot_max_capacity || (cls ? cls.max_capacity_snapshot : 3),
        is_within_24_hours: windowInfo.is_within_24h,
        hours_since_submitted: windowInfo.hours_elapsed,
        remaining_hours_str: windowInfo.remaining_hours_str
      })
    }).sort((a, b) => new Date(`${b.lesson_date} ${b.start_time || '00:00'}`) - new Date(`${a.lesson_date} ${a.start_time || '00:00'}`))
  },

  // ─────────────────────────────────────────
  // 6. Phase 3-A：单节课程取消与整班顺延一节
  // ─────────────────────────────────────────

  /**
   * 管理员取消单节排课（最高操作权限与三步联动同一事务完成）
   *
   * 核心业务铁律：
   * 1. 无条件最高权限：管理员/超管可随时取消任何一节课，系统绝不写死拦截条件！
   * 2. 事务第1步（不扣课时/原路退回）：若该节课此前已被误签消课，自动调用 rollbackHours 原路逆向全额退还已扣课时与冲减欠费；
   * 3. 事务第2步（老师课酬清零）：授课老师当节课酬强制记为 0 元；
   * 4. 事务第3步（触发取消通知）：向本班所有绑定家长（微信订阅消息/人工兜底）和授课老师推送取消课程通知；
   * 5. 后续处理二选一（管理员手动决定，绝不替管理员选）：
   *    - 选项 A (individual_makeup): 单独补课模式，课表后续时间不动，学生可后续单独安排补课；
   *    - 选项 B (postpone_entire_class): 整班顺延一节，该班本次及后面所有未上课表整体往后顺延一节，并推送新课表通知。
   *
   * @param {string} scheduleId - 排课ID
   * @param {Object} options
   *   - reason: 取消原因说明 (必填，如 "恶劣天气暴雨停课")
   *   - handle_mode: 'individual_makeup' | 'postpone_entire_class' (必填)
   * @returns {Object} 取消执行明细
   */
  cancelScheduleLesson(scheduleId, options = {}) {
    const operator = checkAdminPermission() // 管理员最高权限
    if (!scheduleId) throw new Error('必须指定需要取消的排课ID')

    const { reason, handle_mode } = options
    if (!reason || !reason.trim()) {
      throw new Error('取消课程必须填写合规的事由说明 (reason)')
    }

    if (handle_mode !== 'individual_makeup' && handle_mode !== 'postpone_entire_class') {
      throw new Error('取消课程后必须明确二选一后续处理模式：【选项A：单独补课模式】或【选项B：整班往后挪一节】')
    }

    const schedule = db.getById(db.TABLES.SCHEDULES_AND_ATTENDANCE, scheduleId)
    if (!schedule) throw new Error(`未找到指定排课记录 (id=${scheduleId})`)

    if (schedule.status === 'cancelled') {
      throw new Error('该排课记录此前已被取消，无需重复取消')
    }

    const cls = db.getById(db.TABLES.CLASSES, schedule.class_id)
    if (!cls) throw new Error(`未找到该排课所属班级 (id=${schedule.class_id})`)

    // ─────────────────────────────────────────
    // 三步联动第 1 步：不扣课时 / 误签原路精准退还
    // ─────────────────────────────────────────
    const refundedStudents = []
    const rawAttendees = schedule.attendees_json || []
    const updatedAttendees = rawAttendees.map(item => {
      const copy = Object.assign({}, item)
      // 若该生此前已出勤并扣了课时，调用 Phase 2-A rollbackHours 严格原路退回！
      if (item.deducted_hours > 0 && item.deducted_detail_json) {
        try {
          const rollbackRes = packageAccountService.rollbackHours(
            item.deducted_detail_json,
            `[课程取消原路退还] 管理员【${operator.name}】取消班级【${cls.name}】第${schedule.lesson_index}次课，全额退回课时。事由: ${reason.trim()}`
          )
          refundedStudents.push({
            student_id: item.student_id,
            student_name: item.student_name,
            refunded_hours: item.deducted_hours,
            paid_refunded: rollbackRes.total_paid_refunded,
            gift_refunded: rollbackRes.total_gift_refunded,
            debt_cleared: rollbackRes.debt_cleared
          })
        } catch (e) {
          console.warn(`[cancelScheduleLesson] rollbackHours failed for stu ${item.student_id}:`, e)
        }
      }

      // 清空扣费记录并标记状态
      copy.status = 'cancelled'
      copy.deducted_hours = 0
      copy.deducted_detail_json = null

      // 若为选项 A，打上单独补课候选标记 (Phase 3-C 衔接)
      if (handle_mode === 'individual_makeup') {
        copy.can_book_makeup = true
        copy.makeup_status = 'pending_individual_makeup'
      }

      return copy
    })

    // ─────────────────────────────────────────
    // 三步联动第 2 步：授课老师当节课时费清零 (强制记为 0 元)
    // ─────────────────────────────────────────
    const nowIso = new Date().toISOString()
    const cancelPayload = {
      status: 'cancelled',
      cancel_reason: reason.trim(),
      cancel_handle_mode: handle_mode,
      cancelled_at: nowIso,
      cancelled_by: operator.name || '教务管理员',
      calculated_teacher_fee: 0, // 老师课时费强制记为 0 元
      attendees_json: updatedAttendees
    }

    const logDesc = `[取消排课] 管理员【${operator.name}】取消班级【${cls.name}】第${schedule.lesson_index}次课(${schedule.lesson_date})。事由: ${reason.trim()}。处理模式: ${handle_mode === 'individual_makeup' ? '选项A(单独补课模式)' : '选项B(整班顺延一节)'}。已原路退回 ${refundedStudents.length} 位学员课时，老师当节课酬清零。`

    db.update(db.TABLES.SCHEDULES_AND_ATTENDANCE, schedule.id, cancelPayload, logDesc)

    // Phase 4-A：同步触发课酬引擎将台账记录清零置 0
    try {
      salaryEngineService.calculateLessonFee(schedule.id)
    } catch (e) {
      console.warn('[cancelScheduleLesson] salaryEngine calculateLessonFee failed:', e)
    }

    // ─────────────────────────────────────────
    // 三步联动第 3 步：触发取消通知分发
    // ─────────────────────────────────────────
    let cancelNoticeResult = null
    try {
      cancelNoticeResult = notificationService.sendLessonCancellationNotice(
        cls.id,
        {
          lesson_date: schedule.lesson_date,
          start_time: schedule.start_time,
          end_time: schedule.end_time,
          lesson_index: schedule.lesson_index
        },
        reason.trim(),
        refundedStudents
      )
    } catch (e) {
      console.warn('[cancelScheduleLesson] sendLessonCancellationNotice failed:', e)
    }

    // ─────────────────────────────────────────
    // 后续处理执行：选项 B (整班往后挪一节)
    // ─────────────────────────────────────────
    let postponeResult = null
    if (handle_mode === 'postpone_entire_class') {
      postponeResult = this.postponeClassSchedules(cls.id, schedule.id, reason.trim(), operator)
    }

    return {
      success: true,
      schedule_id: schedule.id,
      class_id: cls.id,
      class_name: cls.name,
      lesson_date: schedule.lesson_date,
      reason: reason.trim(),
      handle_mode: handle_mode,
      teacher_fee_cleared: true,
      refunded_students_count: refundedStudents.length,
      refunded_students: refundedStudents,
      cancel_notice_result: cancelNoticeResult,
      postpone_result: postponeResult,
      cancelled_at: nowIso
    }
  },

  /**
   * 整班往后挪一节（整班顺延算法）
   * 将该班自本次课之后的全部未上日程整体顺延 7 天（1 个整周周期），学期结束时间自动推迟一节
   *
   * @param {string} classId - 班级ID
   * @param {string} fromScheduleId - 触发顺延的排课ID
   * @param {string} reason - 顺延原因
   * @param {Object} operatorUser
   */
  postponeClassSchedules(classId, fromScheduleId, reason = '课程整班往后顺延一节', operatorUser) {
    const operator = operatorUser || checkAdminPermission()
    if (!classId) throw new Error('班级ID不能为空')

    const cls = db.getById(db.TABLES.CLASSES, classId)
    if (!cls) throw new Error(`未找到指定班级 (id=${classId})`)

    const allSchedules = db.getTable(db.TABLES.SCHEDULES_AND_ATTENDANCE) || []
    // 查找该班所有排课
    const classSchedules = allSchedules
      .filter(s => s.class_id === classId)
      .sort((a, b) => new Date(`${a.lesson_date} ${a.start_time || '00:00'}`) - new Date(`${b.lesson_date} ${b.start_time || '00:00'}`))

    const fromSchedule = classSchedules.find(s => s.id === fromScheduleId)
    const fromIndex = fromSchedule ? Number(fromSchedule.lesson_index || 1) : 1
    const fromDate = fromSchedule ? fromSchedule.lesson_date : '1970-01-01'

    // 筛选出在该课次之后的所有“未签到”的课次进行顺延
    // 包括 lesson_date > fromDate 且 status === 'scheduled' 的记录
    const schedulesToPostpone = classSchedules.filter(s =>
      s.id !== fromScheduleId &&
      s.status === 'scheduled' &&
      new Date(s.lesson_date) >= new Date(fromDate)
    )

    const postponedRecords = []

    schedulesToPostpone.forEach(s => {
      const oldDate = s.lesson_date
      const newDate = addDaysToDateStr(oldDate, 7) // 顺延 7 天

      db.update(
        db.TABLES.SCHEDULES_AND_ATTENDANCE,
        s.id,
        {
          lesson_date: newDate,
          postponed_from_date: oldDate,
          postponed_at: new Date().toISOString()
        },
        `[整班顺延] 班级【${cls.name}】第${s.lesson_index}次课原定于 ${oldDate}，整体往后顺延一节至 ${newDate}。事由: ${reason}`
      )

      postponedRecords.push({
        schedule_id: s.id,
        lesson_index: s.lesson_index,
        old_date: oldDate,
        new_date: newDate,
        start_time: s.start_time,
        end_time: s.end_time
      })
    })

    // 自动向全班所有绑定家长和授课老师推送新课表通知
    let postponeNoticeResult = null
    try {
      postponeNoticeResult = notificationService.sendSchedulePostponedNotice(
        classId,
        postponedRecords,
        reason
      )
    } catch (e) {
      console.warn('[postponeClassSchedules] sendSchedulePostponedNotice failed:', e)
    }

    return {
      class_id: classId,
      class_name: cls.name,
      postponed_count: postponedRecords.length,
      postponed_records: postponedRecords,
      notice_result: postponeNoticeResult
    }
  },

  // ─────────────────────────────────────────
  // 7. Phase 3-B：老师代课流转与代课客诉个案处理
  // ─────────────────────────────────────────

  /**
   * 管理员指派代课老师
   *
   * 铁律：
   * 1. 权限校验：仅管理员/超管可安排代课；
   * 2. 更新排课记录中的 substitute_teacher_id；
   * 3. 设定代课成功后，立即向该班全员家长推送代课通知（微信订阅消息/人工兜底），明确哪一节课、改由哪位代课老师上；
   * 4. 写入操作日志留痕。
   *
   * @param {string} scheduleId - 排课ID
   * @param {string} substituteTeacherId - 代课老师用户ID
   * @param {string} reason - 代课原因说明
   */
  assignSubstituteTeacher(scheduleId, substituteTeacherId, reason = '教师临时事务代课') {
    const operator = checkAdminPermission()
    if (!scheduleId) throw new Error('排课ID不能为空')
    if (!substituteTeacherId) throw new Error('必须指定代课老师')

    const schedule = db.getById(db.TABLES.SCHEDULES_AND_ATTENDANCE, scheduleId)
    if (!schedule) throw new Error(`未找到指定排课记录 (id=${scheduleId})`)

    if (schedule.status === 'cancelled') {
      throw new Error('该课程已被取消，无法安排代课')
    }

    const cls = db.getById(db.TABLES.CLASSES, schedule.class_id)
    if (!cls) throw new Error(`未找到该排课所属班级 (id=${schedule.class_id})`)

    const originalTeacherId = schedule.teacher_id || cls.teacher_id
    if (substituteTeacherId === originalTeacherId) {
      throw new Error('代课老师不能与原执教老师是同一人！如需取消代课请使用恢复原老师功能。')
    }

    const subTeacher = db.getById(db.TABLES.USERS, substituteTeacherId)
    if (!subTeacher || subTeacher.role !== 'teacher') {
      throw new Error(`未找到有效的代课教师账号 (id=${substituteTeacherId})`)
    }

    const originalTeacher = db.getById(db.TABLES.USERS, originalTeacherId)
    const origTeacherName = originalTeacher ? originalTeacher.name : '原任课老师'

    const nowIso = new Date().toISOString()
    const updatePayload = {
      substitute_teacher_id: subTeacher.id,
      substitute_teacher_name_snapshot: subTeacher.name,
      substitute_assigned_at: nowIso,
      substitute_assigned_by: operator.name || '教务管理员',
      substitute_assign_reason: reason.trim() || '教师临时事务调休'
    }

    const logDesc = `[安排代课] 管理员【${operator.name}】将班级【${cls.name}】第${schedule.lesson_index}次课(${schedule.lesson_date})指定由【${subTeacher.name}老师】代课(原老师: ${origTeacherName})。事由: ${reason}`

    const updatedSchedule = db.update(db.TABLES.SCHEDULES_AND_ATTENDANCE, schedule.id, updatePayload, logDesc)

    // 触发向全班家长推送代课通知（必须明确哪节课、改由哪位老师上）
    let noticeResult = null
    try {
      noticeResult = notificationService.sendSubstituteTeacherNotice(
        cls.id,
        {
          lesson_date: schedule.lesson_date,
          start_time: schedule.start_time,
          end_time: schedule.end_time,
          lesson_index: schedule.lesson_index
        },
        subTeacher,
        reason.trim()
      )
    } catch (e) {
      console.warn('[assignSubstituteTeacher] sendSubstituteTeacherNotice failed:', e)
    }

    return {
      success: true,
      schedule_id: schedule.id,
      class_id: cls.id,
      class_name: cls.name,
      original_teacher_name: origTeacherName,
      substitute_teacher_id: subTeacher.id,
      substitute_teacher_name: subTeacher.name,
      lesson_date: schedule.lesson_date,
      notice_result: noticeResult
    }
  },

  /**
   * 恢复为原老师执教（取消代课）
   * @param {string} scheduleId
   */
  cancelSubstituteTeacher(scheduleId) {
    const operator = checkAdminPermission()
    const schedule = db.getById(db.TABLES.SCHEDULES_AND_ATTENDANCE, scheduleId)
    if (!schedule) throw new Error('排课记录不存在')

    const cls = db.getById(db.TABLES.CLASSES, schedule.class_id)
    const origTeacher = db.getById(db.TABLES.USERS, schedule.teacher_id || (cls ? cls.teacher_id : ''))
    const prevSubName = schedule.substitute_teacher_name_snapshot || '代课老师'

    const patch = {
      substitute_teacher_id: null,
      substitute_teacher_name_snapshot: null,
      substitute_assigned_at: null,
      substitute_assigned_by: null,
      substitute_assign_reason: null
    }

    const logDesc = `[取消代课] 管理员【${operator.name}】取消排课 #${schedule.id} 的代课安排，恢复由【${origTeacher ? origTeacher.name : '原任课老师'}】执教(原代课: ${prevSubName})`
    return db.update(db.TABLES.SCHEDULES_AND_ATTENDANCE, schedule.id, patch, logDesc)
  },

  /**
   * 代课后家长不满意（代课客诉登记与个案处理）
   *
   * 核心业务铁律：
   * 1. 录入：关联代课排课ID、涉及学生/家长、家长不满意的原因；
   * 2. 处理决定三选一枚举：
   *    - '安排重上一节'：标记该生获得一次重上/补课机会 (can_relesson = true)；
   *    - '退还当节课时'：若该生当节已扣费，立即调用 rollbackHours 原路退回该生当节所扣课时；
   *    - '不予处理'：记录管理员理由，留档备查；
   * 3. 录入：管理员决定的原因；
   * 4. 完整留档至 substitute_complaints 表并写入操作日志。
   *
   * @param {Object} complaintData
   *   - schedule_id: 关联代课排课ID (必填)
   *   - student_id: 涉及学生ID (必填)
   *   - complaint_reason: 家长不满意的原因 (必填)
   *   - decision: '安排重上一节' | '退还当节课时' | '不予处理' (必选)
   *   - decision_reason: 管理员决定的原因 (必填)
   */
  handleSubstituteComplaint(complaintData) {
    const operator = checkAdminPermission()
    const {
      schedule_id,
      student_id,
      complaint_reason,
      decision,
      decision_reason
    } = complaintData

    if (!schedule_id) throw new Error('必须指定关联的代课排课记录 (schedule_id)')
    if (!student_id) throw new Error('必须指定涉及的学员 (student_id)')
    if (!complaint_reason || !complaint_reason.trim()) throw new Error('必须录入家长不满意的原因说明')
    if (!decision || (decision !== '安排重上一节' && decision !== '退还当节课时' && decision !== '不予处理')) {
      throw new Error('处理决定必须为以下三选一枚举：【安排重上一节】、【退还当节课时】或【不予处理】')
    }
    if (!decision_reason || !decision_reason.trim()) throw new Error('必须录入管理员决定的原因')

    const schedule = db.getById(db.TABLES.SCHEDULES_AND_ATTENDANCE, schedule_id)
    if (!schedule) throw new Error(`未找到指定排课记录 (id=${schedule_id})`)

    const cls = db.getById(db.TABLES.CLASSES, schedule.class_id)
    const student = db.getById(db.TABLES.STUDENTS, student_id)
    if (!student) throw new Error(`未找到指定学员 (id=${student_id})`)

    // 获取涉及家长的联系方式
    const firstParent = (student.bound_parents && student.bound_parents[0]) || {}
    const parentName = firstParent.relation ? `${firstParent.relation}` : '家长'

    const attendees = schedule.attendees_json || []
    const stuAttendee = attendees.find(a => a.student_id === student_id)

    let refundResult = null
    let canRelesson = false
    let isRefunded = false
    let refundedHours = 0

    // ─────────────────────────────────────────
    // 三选一处理逻辑
    // ─────────────────────────────────────────
    if (decision === '退还当节课时') {
      // 检查该生是否已签到扣费
      if (stuAttendee && stuAttendee.deducted_hours > 0 && stuAttendee.deducted_detail_json) {
        refundResult = packageAccountService.rollbackHours(
          stuAttendee.deducted_detail_json,
          `[代课客诉退课时] 管理员【${operator.name}】处理学员【${student.name}】代课客诉退还当节课时。客诉事由: ${complaint_reason.trim()}; 处理决定原因: ${decision_reason.trim()}`
        )
        isRefunded = true
        refundedHours = stuAttendee.deducted_hours

        // 更新考勤明细
        const updatedAttendees = attendees.map(a => {
          if (a.student_id === student_id) {
            return Object.assign({}, a, {
              deducted_hours: 0,
              deducted_detail_json: null,
              complaint_refunded: true,
              complaint_refund_reason: decision_reason.trim()
            })
          }
          return a
        })

        db.update(
          db.TABLES.SCHEDULES_AND_ATTENDANCE,
          schedule.id,
          { attendees_json: updatedAttendees },
          `[代课客诉退课时] 排课 #${schedule.id} 学员【${student.name}】当节扣费已全额原路退还`
        )
      } else {
        // 该生尚未扣费或未出勤
        isRefunded = false
        refundedHours = 0
      }
    } else if (decision === '安排重上一节') {
      canRelesson = true
      // 在排课考勤中标记该生获得一次重上/补课机会
      const updatedAttendees = attendees.map(a => {
        if (a.student_id === student_id) {
          return Object.assign({}, a, {
            can_relesson: true,
            relesson_reason: decision_reason.trim(),
            makeup_status: 'complaint_relesson'
          })
        }
        return a
      })

      db.update(
        db.TABLES.SCHEDULES_AND_ATTENDANCE,
        schedule.id,
        { attendees_json: updatedAttendees },
        `[代课客诉安排重上] 排课 #${schedule.id} 学员【${student.name}】标记获得一次免费重上补课机会`
      )
    }

    // ─────────────────────────────────────────
    // 组装并留档客诉记录
    // ─────────────────────────────────────────
    const complaintRecord = {
      schedule_id: schedule.id,
      class_id: cls ? cls.id : schedule.class_id,
      class_name_snapshot: cls ? cls.name : '未知班级',
      lesson_date: schedule.lesson_date,
      teacher_id: schedule.teacher_id,
      substitute_teacher_id: schedule.substitute_teacher_id || null,
      substitute_teacher_name_snapshot: schedule.substitute_teacher_name_snapshot || '未知代课老师',
      student_id: student.id,
      student_name_snapshot: student.name,
      parent_phone_snapshot: firstParent.phone || '',
      parent_relation_snapshot: parentName,
      complaint_reason: complaint_reason.trim(),
      decision: decision,
      decision_reason: decision_reason.trim(),
      is_refunded: isRefunded,
      refunded_hours: refundedHours,
      refund_detail: refundResult,
      can_relesson: canRelesson,
      operator_id: operator.id,
      operator_name: operator.name,
      handled_at: new Date().toISOString()
    }

    const createdComplaint = db.insert(
      db.TABLES.SUBSTITUTE_COMPLAINTS,
      complaintRecord,
      `[代课客诉处理] 管理员【${operator.name}】处理学员【${student.name}】代课客诉。决定: 【${decision}】。理由: ${decision_reason}`
    )

    return {
      success: true,
      complaint_id: createdComplaint.id,
      decision: decision,
      decision_reason: decision_reason.trim(),
      is_refunded: isRefunded,
      refunded_hours: refundedHours,
      can_relesson: canRelesson,
      refund_result: refundResult,
      student_name: student.name
    }
  },

  /**
   * 查询代课客诉留档列表
   */
  getSubstituteComplaints(filter = {}) {
    const list = db.getTable(db.TABLES.SUBSTITUTE_COMPLAINTS) || []
    return list.filter(item => {
      if (filter.schedule_id && item.schedule_id !== filter.schedule_id) return false
      if (filter.student_id && item.student_id !== filter.student_id) return false
      if (filter.decision && item.decision !== filter.decision) return false
      return true
    }).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
  },

  /**
   * 获取所有可供指派代课的在职教师列表
   */
  getAvailableTeachersList() {
    const users = db.getTable(db.TABLES.USERS) || []
    return users.filter(u => u.role === 'teacher' && u.status === 'active')
  },

  // ─────────────────────────────────────────
  // 8. Phase 3-C：缺勤补课预约全流程、跨班防呆与薪资钩子
  // ─────────────────────────────────────────

  /**
   * 查询符合跨班/单独补课的可挂载目标排课列表
   *
   * 铁律防呆过滤：
   * 1. 状态必须为未上的课次 (status === 'scheduled')；
   * 2. 课程一致：必须与原缺勤班级同课程 (course_id 相同)；
   * 3. 课时一致：单节耗课数必须相同 (hours_per_lesson 相同)；
   * 4. 跨师封顶硬性过滤：已有正式生人数 + 已挂载补课生人数 必须严格小于该班封顶人数 (max_capacity)；
   * 5. 若指定 teacher_id（如原老师补），仅展示该老师执教的课次。
   *
   * @param {Object} params - { course_id, hours_per_lesson, exclude_schedule_id, teacher_id }
   */
  getEligibleMakeupSchedules(params = {}) {
    const {
      course_id,
      hours_per_lesson,
      exclude_schedule_id,
      teacher_id
    } = params

    const allSchedules = db.getTable(db.TABLES.SCHEDULES_AND_ATTENDANCE) || []
    const allClasses = db.getTable(db.TABLES.CLASSES) || []
    const classMap = {}
    allClasses.forEach(c => { classMap[c.id] = c })
    const allUsers = db.getTable(db.TABLES.USERS) || []
    const userMap = {}
    allUsers.forEach(u => { userMap[u.id] = u })

    const eligible = []

    allSchedules.forEach(s => {
      if (s.status !== 'scheduled') return
      if (exclude_schedule_id && s.id === exclude_schedule_id) return

      const cls = classMap[s.class_id]
      if (!cls) return

      // 1. 同课程校验 (course_id 相同)
      const scheduleCourseId = s.course_id || cls.course_id
      if (course_id && scheduleCourseId !== course_id) return

      // 2. 耗课数一致校验 (hours_per_lesson 相同)
      const schedHours = Number(s.snapshot_hours_per_lesson || cls.hours_per_lesson_snapshot)
      if (hours_per_lesson !== undefined && Number(schedHours) !== Number(hours_per_lesson)) return

      // 3. 原老师补课时的老师匹配
      const schedTeacherId = s.teacher_id || cls.teacher_id
      if (teacher_id && schedTeacherId !== teacher_id) return

      // 4. 封顶人数校验：已有正式生 + 已挂载补课生 < 封顶人数 (max_capacity)
      const maxCap = Number(s.snapshot_max_capacity || cls.max_capacity_snapshot || 3)
      const enrolledCount = (cls.enrolled_student_ids || []).length
      const makeupCount = (s.makeup_students || []).length
      const currentTotal = enrolledCount + makeupCount

      if (currentTotal >= maxCap) {
        // 满员课次硬性过滤，绝不展示
        return
      }

      const teacherObj = userMap[schedTeacherId]
      const teacherName = teacherObj ? teacherObj.name : (cls.teacher_name_snapshot || '老师')

      eligible.push({
        schedule_id: s.id,
        class_id: cls.id,
        class_name: cls.name,
        course_id: scheduleCourseId,
        lesson_date: s.lesson_date,
        start_time: s.start_time,
        end_time: s.end_time,
        hours_per_lesson: schedHours,
        teacher_id: schedTeacherId,
        teacher_name: teacherName,
        max_capacity: maxCap,
        current_headcount: currentTotal,
        remaining_seats: maxCap - currentTotal,
        display_label: `【${cls.name}】${s.lesson_date} ${s.start_time}-${s.end_time} (${teacherName}老师, 余${maxCap - currentTotal}位)`
      })
    })

    return eligible.sort((a, b) => new Date(`${a.lesson_date} ${a.start_time}`) - new Date(`${b.lesson_date} ${b.start_time}`))
  },

  /**
   * 将补课学生挂载到目标排课中 (makeup_students)
   *
   * 铁律防呆与锁死：
   * 1. 跨师封顶硬性拦截：已有人头 >= 封顶人数硬性报错拦截；
   * 2. 课时与课程严格匹配校验；
   * 3. 补课期限铁律：不设单独期限，完全跟随课时包有效期，只要有未到期课时包绝不拦截；
   * 4. 必须强制绑定 original_teacher_id 和 original_absent_schedule_id 以供 Phase 4 薪资引擎计算补差！
   *
   * @param {string} targetScheduleId - 目标排课ID
   * @param {Object} makeupData - 补课元数据
   * @param {Object} operatorUser
   */
  mountMakeupStudent(targetScheduleId, makeupData, operatorUser) {
    const operator = operatorUser || getCurrentUser()
    if (!targetScheduleId) throw new Error('必须指定目标排课课次')

    const targetSchedule = db.getById(db.TABLES.SCHEDULES_AND_ATTENDANCE, targetScheduleId)
    if (!targetSchedule) throw new Error(`未找到目标排课课次 #${targetScheduleId}`)
    if (targetSchedule.status !== 'scheduled') {
      throw new Error('只能挂载到待开课（scheduled）的课次中')
    }

    const targetCls = db.getById(db.TABLES.CLASSES, targetSchedule.class_id)
    if (!targetCls) throw new Error(`未找到目标排课所属班级 (id=${targetSchedule.class_id})`)

    // ─────────────────────────────────────────
    // 防呆 1：同课程与耗课数硬性比对校验
    // ─────────────────────────────────────────
    const targetCourseId = targetSchedule.course_id || targetCls.course_id
    if (targetCourseId !== makeupData.original_course_id) {
      throw new Error(`跨班补课硬性拦截：目标排课课程(${targetCourseId})与原缺勤课程(${makeupData.original_course_id})不一致！`)
    }

    const targetHours = Number(targetSchedule.snapshot_hours_per_lesson || targetCls.hours_per_lesson_snapshot)
    if (targetHours !== Number(makeupData.original_hours_per_lesson)) {
      throw new Error(`跨班补课硬性拦截：目标课次耗课(${targetHours}课时)与原缺勤耗课(${makeupData.original_hours_per_lesson}课时)不匹配！`)
    }

    // ─────────────────────────────────────────
    // 防呆 2：跨师封顶硬性拦截
    // ─────────────────────────────────────────
    const maxCap = Number(targetSchedule.snapshot_max_capacity || targetCls.max_capacity_snapshot || 3)
    const enrolledCount = (targetCls.enrolled_student_ids || []).length
    const currentMakeup = targetSchedule.makeup_students || []
    const totalHeadcount = enrolledCount + currentMakeup.length

    if (totalHeadcount >= maxCap) {
      throw new Error(`跨班补课硬性拦截：目标排课已达封顶人数(${totalHeadcount}/${maxCap}人)，禁止超额挂载！`)
    }

    if (currentMakeup.some(m => m.student_id === makeupData.student_id)) {
      throw new Error(`学员【${makeupData.student_name}】已挂载在当前课次，请勿重复挂载！`)
    }

    // ─────────────────────────────────────────
    // 防呆 3：补课期限铁律（完全跟随课时包有效期）
    // ─────────────────────────────────────────
    const balance = packageAccountService.getStudentCourseBalance(makeupData.student_id, makeupData.original_course_id)
    if (balance.total_available_hours <= 0) {
      throw new Error(`学员【${makeupData.student_name}】当前课程可用课时不足(当前余额: ${balance.total_available_hours}课时)，无法预约补课`)
    }

    const packages = (db.getTable(db.TABLES.COURSE_PACKAGES) || []).filter(p =>
      p.student_id === makeupData.student_id &&
      p.course_id === makeupData.original_course_id &&
      (Number(p.paid_hours_left || 0) + Number(p.gift_hours_left || 0) > 0)
    )
    const hasValidPackageForDate = packages.some(p => !p.expire_date || p.expire_date >= targetSchedule.lesson_date)
    if (!hasValidPackageForDate && packages.length > 0) {
      throw new Error(`学员所有课时包在目标补课日期(${targetSchedule.lesson_date})前均已到期，无法安排该日期的补课（补课期限完全跟随课时包有效期）`)
    }

    // ─────────────────────────────────────────
    // 组装补课数据结构：强制携带 original_teacher_id 和 original_absent_schedule_id
    // ─────────────────────────────────────────
    const newEntry = {
      makeup_request_id: makeupData.makeup_request_id || null,
      student_id: makeupData.student_id,
      student_name: makeupData.student_name,
      original_teacher_id: makeupData.original_teacher_id, // 强制绑定原任课老师ID
      original_teacher_name: makeupData.original_teacher_name,
      original_absent_schedule_id: makeupData.original_absent_schedule_id, // 强制绑定原缺勤排课ID
      original_course_id: makeupData.original_course_id,
      original_hours_per_lesson: Number(makeupData.original_hours_per_lesson), // 锁死扣费课时！
      status: 'absent',
      is_late: false,
      is_early_leave: false,
      deducted_hours: 0,
      deducted_detail_json: null,
      mounted_at: new Date().toISOString()
    }

    const updatedMakeupList = [...currentMakeup, newEntry]

    const logDesc = `[挂载补课生] 操作人【${operator.name}】将缺勤学员【${makeupData.student_name}】挂载至班级【${targetCls.name}】课次 #${targetSchedule.id}(${targetSchedule.lesson_date})。原授课老师: ${makeupData.original_teacher_name}，锁定扣费: ${makeupData.original_hours_per_lesson}课时`

    const updatedSchedule = db.update(
      db.TABLES.SCHEDULES_AND_ATTENDANCE,
      targetSchedule.id,
      { makeup_students: updatedMakeupList },
      logDesc
    )

    return updatedSchedule
  },

  /**
   * 新建单独补课排课课次
   * @param {Object} params
   * @param {Object} operatorUser
   */
  createSoloMakeupSchedule(params, operatorUser) {
    const operator = operatorUser || getCurrentUser()
    const {
      makeup_request_id,
      class_id,
      teacher_id,
      teacher_name,
      course_id,
      lesson_date,
      start_time,
      end_time,
      original_hours_per_lesson,
      student,
      original_schedule_id
    } = params

    if (!lesson_date) throw new Error('请选择补课日期')
    if (!start_time || !end_time) throw new Error('请选择补课时间范围')
    if (!teacher_id) throw new Error('必须指定补课授课老师')

    // 补课期限铁律校验
    const balance = packageAccountService.getStudentCourseBalance(student.id, course_id)
    if (balance.total_available_hours <= 0) {
      throw new Error(`学员【${student.name}】可用课时不足(当前余额: ${balance.total_available_hours}课时)，无法新建单独补课`)
    }

    const packages = (db.getTable(db.TABLES.COURSE_PACKAGES) || []).filter(p =>
      p.student_id === student.id &&
      p.course_id === course_id &&
      (Number(p.paid_hours_left || 0) + Number(p.gift_hours_left || 0) > 0)
    )
    const hasValid = packages.some(p => !p.expire_date || p.expire_date >= lesson_date)
    if (!hasValid && packages.length > 0) {
      throw new Error(`学员所有课时包在目标补课日期(${lesson_date})前均已到期，无法创建补课课次`)
    }

    const newSoloSchedule = {
      class_id: class_id,
      teacher_id: teacher_id,
      course_id: course_id,
      lesson_date: lesson_date,
      start_time: start_time,
      end_time: end_time,
      snapshot_hours_per_lesson: Number(original_hours_per_lesson),
      snapshot_max_capacity: 1, // 单独补课封顶 1 人
      initial_present_headcount: 0,
      calculated_teacher_fee: 0,
      status: 'scheduled',
      is_solo_makeup: true,
      makeup_students: [
        {
          makeup_request_id: makeup_request_id || null,
          student_id: student.id,
          student_name: student.name,
          original_teacher_id: teacher_id,
          original_teacher_name: teacher_name,
          original_absent_schedule_id: original_schedule_id,
          original_course_id: course_id,
          original_hours_per_lesson: Number(original_hours_per_lesson),
          status: 'absent',
          is_late: false,
          is_early_leave: false,
          deducted_hours: 0,
          deducted_detail_json: null
        }
      ],
      attendees_json: []
    }

    const logDesc = `[新建单独补课] 操作人【${operator.name}】为学员【${student.name}】新建单独补课课次：${lesson_date} ${start_time}-${end_time}(授课老师: ${teacher_name}，耗课: ${original_hours_per_lesson}课时)`

    return db.insert(db.TABLES.SCHEDULES_AND_ATTENDANCE, newSoloSchedule, logDesc)
  },

  /**
   * 发起缺勤补课预约全流程（支持三种补课路径）
   *
   * 路径 1：自己补（原老师补） —— 挂入原老师其他课次 或 新建单独补课
   * 路径 2：非本人补（别的老师补） —— 生成跨师补课工单流转至管理员待办工作台
   * 路径 3：不补（家长放弃补课） —— 标记为 waived，课时安全保留原余额不作扣减
   *
   * @param {Object} params
   * @param {Object} operatorUser
   */
  bookMakeupLesson(params, operatorUser) {
    const operator = operatorUser || getCurrentUser()
    const {
      original_schedule_id,
      student_id,
      makeup_type,        // 'same_teacher' | 'cross_teacher' | 'waived'
      sub_mode,           // 'mount_existing' | 'new_solo' (for same_teacher)
      target_schedule_id, // for mount_existing
      solo_date,          // for new_solo
      solo_start_time,    // for new_solo
      solo_end_time,      // for new_solo
      remarks             // 沟通事由说明
    } = params

    if (!original_schedule_id) throw new Error('原缺勤排课ID不能为空')
    if (!student_id) throw new Error('缺勤学员ID不能为空')
    if (!makeup_type || !['same_teacher', 'cross_teacher', 'waived'].includes(makeup_type)) {
      throw new Error('补课路径必须为：【same_teacher (自己补/原老师补)】、【cross_teacher (非本人/跨师补)】或【waived (不补/家长放弃)】')
    }

    const origSchedule = db.getById(db.TABLES.SCHEDULES_AND_ATTENDANCE, original_schedule_id)
    if (!origSchedule) throw new Error(`未找到原排课记录 #${original_schedule_id}`)

    const origCls = db.getById(db.TABLES.CLASSES, origSchedule.class_id)
    const origCourseId = origSchedule.course_id || (origCls ? origCls.course_id : '')
    const origHours = Number(origSchedule.snapshot_hours_per_lesson || (origCls ? origCls.hours_per_lesson_snapshot : 1.5))
    const origTeacherId = origSchedule.teacher_id || (origCls ? origCls.teacher_id : '')
    const origTeacher = db.getById(db.TABLES.USERS, origTeacherId)
    const origTeacherName = origTeacher ? origTeacher.name : '原任课老师'

    const student = db.getById(db.TABLES.STUDENTS, student_id)
    if (!student) throw new Error(`未找到学员 #${student_id}`)

    // ─────────────────────────────────────────
    // 铁律：补课期限完全跟随课时包有效期 (不设单独截止日，只要有未到期课时包就能约)
    // ─────────────────────────────────────────
    if (makeup_type !== 'waived') {
      const balance = packageAccountService.getStudentCourseBalance(student.id, origCourseId)
      if (balance.total_available_hours <= 0) {
        throw new Error(`学员【${student.name}】在当前课程下可用课时不足(当前余额: ${balance.total_available_hours}课时)，无法预约补课`)
      }
    }

    const nowIso = new Date().toISOString()
    const requestId = 'mk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

    // ── 路径 3：家长表示不补课 (waived) ──
    if (makeup_type === 'waived') {
      const updatedAttendees = (origSchedule.attendees_json || []).map(a => {
        if (a.student_id === student_id) {
          return Object.assign({}, a, {
            makeup_status: 'waived',
            makeup_request_id: requestId,
            makeup_waived_reason: remarks || '家长表示不补课'
          })
        }
        return a
      })

      db.update(
        db.TABLES.SCHEDULES_AND_ATTENDANCE,
        origSchedule.id,
        { attendees_json: updatedAttendees },
        `[放弃补课] 学员【${student.name}】在排课 #${origSchedule.id} 缺勤，家长表示不补课，课时安全保留原余额`
      )

      const waivedRecord = {
        id: requestId,
        original_schedule_id: origSchedule.id,
        student_id: student.id,
        student_name_snapshot: student.name,
        course_id: origCourseId,
        class_id: origCls ? origCls.id : origSchedule.class_id,
        class_name_snapshot: origCls ? origCls.name : '未知班级',
        original_teacher_id: origTeacherId,
        original_teacher_name_snapshot: origTeacherName,
        original_hours_per_lesson: origHours,
        absent_date: origSchedule.lesson_date,
        makeup_type: 'waived',
        status: 'waived',
        remarks: remarks || '家长表示不补课',
        operator_id: operator.id,
        operator_name: operator.name,
        created_at: nowIso,
        updated_at: nowIso
      }

      db.insert(
        db.TABLES.MAKEUP_REQUESTS,
        waivedRecord,
        `[登记放弃补课] 学员【${student.name}】缺勤不补课留档。事由: ${remarks || '家长自愿放弃'}`
      )

      return {
        success: true,
        makeup_type: 'waived',
        request_id: requestId,
        student_name: student.name,
        message: '已标记为家长放弃补课，课时安全保留在原课时包中'
      }
    }

    // ── 路径 2：非本人补（别的老师补 / cross_teacher） ──
    if (makeup_type === 'cross_teacher') {
      const reqRecord = {
        id: requestId,
        original_schedule_id: origSchedule.id,
        student_id: student.id,
        student_name_snapshot: student.name,
        course_id: origCourseId,
        class_id: origCls ? origCls.id : origSchedule.class_id,
        class_name_snapshot: origCls ? origCls.name : '未知班级',
        original_teacher_id: origTeacherId,
        original_teacher_name_snapshot: origTeacherName,
        original_hours_per_lesson: origHours,
        absent_date: origSchedule.lesson_date,
        makeup_type: 'cross_teacher',
        status: 'pending_admin_assignment',
        remarks: remarks || '',
        operator_id: operator.id,
        operator_name: operator.name,
        created_at: nowIso,
        updated_at: nowIso
      }

      db.insert(
        db.TABLES.MAKEUP_REQUESTS,
        reqRecord,
        `[发起跨师补课] 老师【${operator.name}】为缺勤学员【${student.name}】发起跨师补课申请，流转管理员待办工作台`
      )

      const updatedAttendees = (origSchedule.attendees_json || []).map(a => {
        if (a.student_id === student_id) {
          return Object.assign({}, a, {
            makeup_status: 'pending_admin_assignment',
            makeup_request_id: requestId
          })
        }
        return a
      })

      db.update(
        db.TABLES.SCHEDULES_AND_ATTENDANCE,
        origSchedule.id,
        { attendees_json: updatedAttendees },
        `[排课考勤更新] 学员【${student.name}】已发起跨师补课申请 #${requestId}`
      )

      return {
        success: true,
        makeup_type: 'cross_teacher',
        request_id: requestId,
        student_name: student.name,
        status: 'pending_admin_assignment',
        message: '跨师补课工单已生成，已流转至管理员待办工作台协调安排'
      }
    }

    // ── 路径 1：自己补（原老师补 / same_teacher） ──
    if (makeup_type === 'same_teacher') {
      let targetSchedule = null

      if (sub_mode === 'mount_existing') {
        if (!target_schedule_id) throw new Error('请选择要挂入的原老师其他课次')
        targetSchedule = this.mountMakeupStudent(target_schedule_id, {
          makeup_request_id: requestId,
          student_id: student.id,
          student_name: student.name,
          original_teacher_id: origTeacherId,
          original_teacher_name: origTeacherName,
          original_absent_schedule_id: origSchedule.id,
          original_course_id: origCourseId,
          original_hours_per_lesson: origHours
        }, operator)
      } else if (sub_mode === 'new_solo') {
        if (!solo_date) throw new Error('请选择新建补课日期')
        if (!solo_start_time || !solo_end_time) throw new Error('请设置补课时间范围')

        targetSchedule = this.createSoloMakeupSchedule({
          makeup_request_id: requestId,
          class_id: origCls ? origCls.id : origSchedule.class_id,
          teacher_id: origTeacherId,
          teacher_name: origTeacherName,
          course_id: origCourseId,
          lesson_date: solo_date,
          start_time: solo_start_time,
          end_time: solo_end_time,
          original_hours_per_lesson: origHours,
          student: student,
          original_schedule_id: origSchedule.id
        }, operator)
      } else {
        throw new Error('原老师补课必须选择【mount_existing (挂入其他课次)】或【new_solo (新建单独补课)】')
      }

      const scheduledReq = {
        id: requestId,
        original_schedule_id: origSchedule.id,
        student_id: student.id,
        student_name_snapshot: student.name,
        course_id: origCourseId,
        class_id: origCls ? origCls.id : origSchedule.class_id,
        class_name_snapshot: origCls ? origCls.name : '未知班级',
        original_teacher_id: origTeacherId,
        original_teacher_name_snapshot: origTeacherName,
        original_hours_per_lesson: origHours,
        absent_date: origSchedule.lesson_date,
        makeup_type: 'same_teacher',
        status: 'scheduled',
        target_schedule_id: targetSchedule.id,
        target_teacher_id: origTeacherId,
        target_teacher_name_snapshot: origTeacherName,
        makeup_date: targetSchedule.lesson_date,
        makeup_time: `${targetSchedule.start_time}-${targetSchedule.end_time}`,
        remarks: remarks || '原老师自主补课安排',
        operator_id: operator.id,
        operator_name: operator.name,
        created_at: nowIso,
        updated_at: nowIso
      }

      db.insert(
        db.TABLES.MAKEUP_REQUESTS,
        scheduledReq,
        `[原老师补课已排定] 老师【${origTeacherName}】为学员【${student.name}】排定补课：${targetSchedule.lesson_date} ${targetSchedule.start_time}-${targetSchedule.end_time}`
      )

      const updatedAttendees = (origSchedule.attendees_json || []).map(a => {
        if (a.student_id === student_id) {
          return Object.assign({}, a, {
            makeup_status: 'scheduled',
            makeup_request_id: requestId,
            makeup_target_schedule_id: targetSchedule.id
          })
        }
        return a
      })

      db.update(
        db.TABLES.SCHEDULES_AND_ATTENDANCE,
        origSchedule.id,
        { attendees_json: updatedAttendees },
        `[排课考勤更新] 学员【${student.name}】已排定原老师补课课次 #${targetSchedule.id}`
      )

      return {
        success: true,
        makeup_type: 'same_teacher',
        request_id: requestId,
        target_schedule_id: targetSchedule.id,
        lesson_date: targetSchedule.lesson_date,
        start_time: targetSchedule.start_time,
        end_time: targetSchedule.end_time,
        student_name: student.name,
        message: `原老师补课已排定成功(${targetSchedule.lesson_date} ${targetSchedule.start_time}-${targetSchedule.end_time})`
      }
    }
  },

  /**
   * 管理员协调安排跨师补课工单
   *
   * @param {string} requestId - 补课工单ID
   * @param {Object} targetData - { mode: 'mount_existing'|'new_solo', target_schedule_id, teacher_id, solo_date, solo_start_time, solo_end_time }
   * @param {Object} operatorUser
   */
  assignCrossTeacherMakeup(requestId, targetData, operatorUser) {
    const operator = operatorUser || checkAdminPermission()
    if (!requestId) throw new Error('补课工单ID不能为空')

    const request = db.getById(db.TABLES.MAKEUP_REQUESTS, requestId)
    if (!request) throw new Error(`未找到补课工单 #${requestId}`)
    if (request.status !== 'pending_admin_assignment') {
      throw new Error(`当前工单状态为【${request.status}】，无法执行安排操作`)
    }

    const { mode, target_schedule_id, teacher_id, solo_date, solo_start_time, solo_end_time } = targetData
    let targetSchedule = null
    let targetTeacherName = ''

    if (mode === 'mount_existing') {
      if (!target_schedule_id) throw new Error('请选择要插班挂载的目标课次')
      targetSchedule = this.mountMakeupStudent(target_schedule_id, {
        makeup_request_id: request.id,
        student_id: request.student_id,
        student_name: request.student_name_snapshot,
        original_teacher_id: request.original_teacher_id,
        original_teacher_name: request.original_teacher_name_snapshot,
        original_absent_schedule_id: request.original_schedule_id,
        original_course_id: request.course_id,
        original_hours_per_lesson: request.original_hours_per_lesson
      }, operator)

      const targetCls = db.getById(db.TABLES.CLASSES, targetSchedule.class_id)
      const tch = db.getById(db.TABLES.USERS, targetSchedule.teacher_id || (targetCls ? targetCls.teacher_id : ''))
      targetTeacherName = tch ? tch.name : '补课老师'
    } else if (mode === 'new_solo') {
      if (!teacher_id) throw new Error('请选择跨师补课授课老师')
      const tch = db.getById(db.TABLES.USERS, teacher_id)
      if (!tch || tch.role !== 'teacher') throw new Error('指定的教师账号无效')
      targetTeacherName = tch.name

      const student = db.getById(db.TABLES.STUDENTS, request.student_id)
      targetSchedule = this.createSoloMakeupSchedule({
        makeup_request_id: request.id,
        class_id: request.class_id,
        teacher_id: teacher_id,
        teacher_name: targetTeacherName,
        course_id: request.course_id,
        lesson_date: solo_date,
        start_time: solo_start_time,
        end_time: solo_end_time,
        original_hours_per_lesson: request.original_hours_per_lesson,
        student: student,
        original_schedule_id: request.original_schedule_id
      }, operator)
    } else {
      throw new Error('跨师补课安排模式必须为【mount_existing (插班挂载)】或【new_solo (新建单独补课)】')
    }

    // 更新工单状态为 scheduled
    const nowIso = new Date().toISOString()
    const updateReqPayload = {
      status: 'scheduled',
      target_schedule_id: targetSchedule.id,
      target_teacher_id: targetSchedule.teacher_id,
      target_teacher_name_snapshot: targetTeacherName,
      makeup_date: targetSchedule.lesson_date,
      makeup_time: `${targetSchedule.start_time}-${targetSchedule.end_time}`,
      assigned_by: operator.name || '教务管理员',
      assigned_at: nowIso,
      updated_at: nowIso
    }

    db.update(
      db.TABLES.MAKEUP_REQUESTS,
      request.id,
      updateReqPayload,
      `[跨师补课安排] 管理员【${operator.name}】安排学员【${request.student_name_snapshot}】由【${targetTeacherName}老师】补课(${targetSchedule.lesson_date} ${targetSchedule.start_time}-${targetSchedule.end_time})`
    )

    // 更新原排课考勤中该学员的状态为 scheduled
    const origSchedule = db.getById(db.TABLES.SCHEDULES_AND_ATTENDANCE, request.original_schedule_id)
    if (origSchedule) {
      const updatedAttendees = (origSchedule.attendees_json || []).map(a => {
        if (a.student_id === request.student_id) {
          return Object.assign({}, a, {
            makeup_status: 'scheduled',
            makeup_target_schedule_id: targetSchedule.id
          })
        }
        return a
      })
      db.update(
        db.TABLES.SCHEDULES_AND_ATTENDANCE,
        origSchedule.id,
        { attendees_json: updatedAttendees },
        `[排课考勤更新] 学员【${request.student_name_snapshot}】跨师补课已排定课次 #${targetSchedule.id}`
      )
    }

    return {
      success: true,
      request_id: request.id,
      student_name: request.student_name_snapshot,
      target_teacher_name: targetTeacherName,
      lesson_date: targetSchedule.lesson_date,
      start_time: targetSchedule.start_time,
      end_time: targetSchedule.end_time,
      target_schedule_id: targetSchedule.id
    }
  },

  /**
   * 查询所有待管理员安排的跨师补课工单列表
   */
  getPendingMakeupRequests() {
    const list = db.getTable(db.TABLES.MAKEUP_REQUESTS) || []
    return list.filter(r => r.status === 'pending_admin_assignment')
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
  }
}

module.exports = attendanceService

// services/classService.js
// 班级管理服务（Phase 1-C：建班五要素、换师切割、开班门槛、插班算费与试听规则）
const db = require('./db')
const packageAccountService = require('./packageAccountService')

/**
 * 校验当前登录人是否具备教务管理或超级管理员权限
 */
function checkAdminPermission() {
  const app = getApp()
  const user = (app && app.globalData && app.globalData.currentUser) || wx.getStorageSync('current_user')
  if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) {
    throw new Error('权限拦截：仅教务管理(admin)或超级管理员(super_admin)可操作班级排课与管理')
  }
  return user
}

/**
 * 核心开班门槛计算（铁律）：
 * 1. 一对一班 (封顶 = 1人)：满 1 个正式学生直接开班 ('open')；
 * 2. 多人班 (封顶 >= 2人)：满 2 个人起开班 ('open')；只有 1 个或 0 个正式生时不开发，状态为 'waiting_for_min_students'。
 * 注：试听生绝不计入正式开班门槛！
 */
function computeClassStatus(enrolledCount, maxCapacity) {
  const maxCap = Number(maxCapacity) || 1
  const count = Number(enrolledCount) || 0

  if (maxCap === 1) {
    return count >= 1 ? 'open' : 'waiting_for_min_students'
  } else {
    return count >= 2 ? 'open' : 'waiting_for_min_students'
  }
}

const classService = {
  // ─────────────────────────────────────────
  // 1. 建班定五样（新建班级）
  // ─────────────────────────────────────────

  /**
   * 创建班级（建班定五样）：
   * 必须确定：老师、封顶人数、一课时单价、每次课几课时、每周上课时间
   * @param {Object} data
   *   - name: 班级名称
   *   - course_id: 所属课程ID
   *   - teacher_id: 授课老师ID
   *   - term_id: 学期期数ID
   *   - max_capacity: 封顶人数 (默认从班型带出；若自定义需走审批或超管批准)
   *   - unit_price: 一课时单价快照
   *   - hours_per_lesson: 每次课几课时快照
   *   - weekly_schedule: 每周上课时间 (如 "每周六 09:00-10:30")
   *   - total_lessons: 总课次数 (默认 16 次)
   *   - custom_capacity_approved: 是否为超管审批通过的自定义封顶 (boolean)
   */
  createClass(data) {
    const operator = checkAdminPermission()
    const {
      name,
      course_id,
      teacher_id,
      term_id,
      max_capacity,
      unit_price,
      hours_per_lesson,
      weekly_schedule,
      total_lessons = 16,
      custom_capacity_approved = false
    } = data

    if (!name || !name.trim()) throw new Error('班级名称不能为空')
    if (!course_id) throw new Error('必须选择所属课程')
    if (!teacher_id) throw new Error('必须指定授课老师（建班定五样之一）')
    if (!term_id) throw new Error('必须指定所属学期期数')
    if (!weekly_schedule || !weekly_schedule.trim()) throw new Error('必须指定每周上课时间（建班定五样之一）')

    const course = db.getById(db.TABLES.COURSES_AND_CLASS_TYPES, course_id)
    if (!course) throw new Error(`未找到指定课程 (id=${course_id})`)

    const teacher = db.getById(db.TABLES.USERS, teacher_id)
    if (!teacher || teacher.role !== 'teacher') throw new Error(`未找到指定授课老师 (id=${teacher_id})`)

    const term = db.getById(db.TABLES.TERMS, term_id)
    if (!term) throw new Error(`未找到指定学期 (id=${term_id})`)

    const maxCap = Number(max_capacity !== undefined ? max_capacity : course.max_capacity)
    const unitPrice = Number(unit_price !== undefined ? unit_price : course.unit_price)
    const hoursPerLesson = Number(hours_per_lesson !== undefined ? hours_per_lesson : course.hours_per_lesson)
    const totalLessons = Number(total_lessons) || 16

    if (isNaN(maxCap) || maxCap <= 0) throw new Error('封顶人数必须大于0')
    if (isNaN(unitPrice) || unitPrice <= 0) throw new Error('课时单价快照必须大于0')
    if (isNaN(hoursPerLesson) || hoursPerLesson <= 0) throw new Error('单次课时数快照必须大于0')

    // 规则校验：若自定义新班封顶（与课程班型默认封顶不同）且操作人是普通管理员，需走审批流
    if (maxCap !== course.max_capacity && operator.role !== 'super_admin' && !custom_capacity_approved) {
      const newApproval = {
        request_type: 'config_change',
        config_subtype: 'custom_class_capacity',
        proposer_id: operator.id,
        proposer_name: operator.name,
        required_approver_role: 'super_admin',
        target_table: db.TABLES.CLASSES,
        target_record_id: null,
        snapshot_balance_at_propose: null,
        before_data_json: { default_course_capacity: course.max_capacity },
        after_data_json: Object.assign({}, data, { max_capacity: maxCap }),
        reason: `教务[${operator.name}]申请新建班级【${name}】并自定义特殊封顶人数为 ${maxCap} 人（原班型默认 ${course.max_capacity} 人）`,
        status: 'pending',
        approver_id: null,
        approved_time: null,
        reject_reason: null
      }

      db.insert(
        db.TABLES.APPROVAL_REQUESTS,
        newApproval,
        `[${operator.name}] 提交自定义封顶人数新建班级申请【${name}】`
      )

      throw new Error(`提示：您设定的班级封顶(${maxCap}人)与班型默认(${course.max_capacity}人)不一致，已自动生成审批单提交超级管理员审批，审批通过后即可建班！`)
    }

    // 初始开班状态判定
    const initialStatus = computeClassStatus(0, maxCap)

    const newClassRecord = {
      name: name.trim(),
      course_id: course_id,
      course_name_snapshot: course.course_name,
      teacher_id: teacher_id,
      teacher_name_snapshot: teacher.name,
      term_id: term_id,
      term_name_snapshot: term.name,
      max_capacity_snapshot: maxCap, // 建班定五样：封顶人数快照（建好后绝对锁死！）
      unit_price_snapshot: unitPrice, // 建班定五样：一课时单价快照
      hours_per_lesson_snapshot: hoursPerLesson, // 建班定五样：每次课几课时快照
      weekly_schedule: weekly_schedule.trim(), // 建班定五样：每周上课时间
      total_lessons: totalLessons, // 计划总讲次
      current_lesson_index: 0, // 当前已上课次
      enrolled_student_ids: [], // 正式学生列表 (占满班名额)
      enrolled_student_details: [], // 正式学生插班明细
      trial_student_ids: [], // 试听学生列表 (不占正式名额、不计开班门槛、不扣课时、不算老师出勤人头)
      status: initialStatus, // 'waiting_for_min_students' | 'open' | 'closed'
      is_capacity_locked: true // 物理封顶锁死标记
    }

    const desc = `[${operator.name}] 新建班级【${name}】(定五样: 老师=${teacher.name}, 封顶=${maxCap}人, 单价=${unitPrice}元, 课时=${hoursPerLesson}, 时间=${weekly_schedule})`
    const createdClass = db.insert(db.TABLES.CLASSES, newClassRecord, desc)

    return createdClass
  },

  // ─────────────────────────────────────────
  // 2. 封顶锁死铁律与班级更新
  // ─────────────────────────────────────────

  /**
   * 更新班级信息
   * 铁律：班的封顶在新建班时定，班建好以后，这个班的封顶绝不可更改！
   * @param {string} classId
   * @param {Object} patch - 待修改的字段
   */
  updateClass(classId, patch) {
    const operator = checkAdminPermission()
    const target = db.getById(db.TABLES.CLASSES, classId)
    if (!target) throw new Error(`未找到班级记录 (id=${classId})`)

    // ── 【铁律：封顶锁死拦截】 ──
    if (patch.max_capacity_snapshot !== undefined && Number(patch.max_capacity_snapshot) !== Number(target.max_capacity_snapshot)) {
      throw new Error(`系统安全铁律：班级的封顶人数在建班时已永久锁死(${target.max_capacity_snapshot}人)，绝不可直接更改！若学生情况特殊或课时不同，必须新建班级并将学生转班，旧班记录完整保留。`)
    }

    // 允许修改名称、上课时间、总课次等
    const safePatch = {}
    if (patch.name) safePatch.name = patch.name.trim()
    if (patch.weekly_schedule) safePatch.weekly_schedule = patch.weekly_schedule.trim()
    if (patch.total_lessons) safePatch.total_lessons = Number(patch.total_lessons)

    const updated = db.update(
      db.TABLES.CLASSES,
      classId,
      safePatch,
      `[${operator.name}] 更新班级【${target.name}】基础排班信息`
    )

    return updated
  },

  // ─────────────────────────────────────────
  // 3. 换老师与历史切割
  // ─────────────────────────────────────────

  /**
   * 班级换老师（历史切割）：
   * 1. 班不解散，班的进度不变；
   * 2. 原老师以前的签到和结算记录完整保留并归属原老师；
   * 3. 新老师从换的那节课起记录，课时费按实际接手新老师的档位计算；
   * 4. 不自动发换老师通知（学校线下通知家长）。
   * @param {string} classId
   * @param {string} newTeacherId
   * @param {string} reason - 换师原因
   */
  changeTeacher(classId, newTeacherId, reason = '教务调配更换授课教师') {
    const operator = checkAdminPermission()
    const target = db.getById(db.TABLES.CLASSES, classId)
    if (!target) throw new Error(`未找到班级记录 (id=${classId})`)

    const newTeacher = db.getById(db.TABLES.USERS, newTeacherId)
    if (!newTeacher || newTeacher.role !== 'teacher') {
      throw new Error(`未找到指定新授课教师 (id=${newTeacherId})`)
    }

    if (target.teacher_id === newTeacherId) {
      throw new Error(`该班当前授课老师已经是【${newTeacher.name}】，无需重复更换`)
    }

    const oldTeacherName = target.teacher_name_snapshot || '原教师'

    const patch = {
      teacher_id: newTeacherId,
      teacher_name_snapshot: newTeacher.name
    }

    const desc = `[${operator.name}] 班级【${target.name}】更换授课教师: 由【${oldTeacherName}】更换为【${newTeacher.name}】。事由：${reason} (历史签到记录归属原老师，后续课程由新老师承接)`

    const updated = db.update(db.TABLES.CLASSES, classId, patch, desc)
    return updated
  },

  // ─────────────────────────────────────────
  // 4. 正式排班与插班算费（满班硬性拦截）
  // ─────────────────────────────────────────

  /**
   * 将正式学生排入班级或中途插班：
   * 1. 满班硬性拦截：达到封顶人数硬性拦截，不设候补；
   * 2. 插班算费：从第几节课插进来，只收学生从那节起班级剩余节数对应的课时数；
   * 3. 开班门槛联动：2人起开班（1v1则1人开班），学生先排入，满足人数自动变为 'open'。
   *
   * @param {string} classId - 班级ID
   * @param {string} studentId - 学生ID
   * @param {Object} options
   *   - start_lesson_index: 从第几节课插班 (默认当前进度+1，即下一节)
   *   - remark: 选填备注
   */
  enrollStudent(classId, studentId, options = {}) {
    const operator = checkAdminPermission()
    const cls = db.getById(db.TABLES.CLASSES, classId)
    if (!cls) throw new Error(`未找到指定班级 (id=${classId})`)

    const student = db.getById(db.TABLES.STUDENTS, studentId)
    if (!student) throw new Error(`未找到指定学员 (id=${studentId})`)

    const enrolledIds = [...(cls.enrolled_student_ids || [])]
    const trialIds = [...(cls.trial_student_ids || [])]
    const enrolledDetails = [...(cls.enrolled_student_details || [])]

    // 检查是否已经是正式生
    if (enrolledIds.includes(studentId)) {
      throw new Error(`学员【${student.name}】已经在该班级中担任正式在读生，无需重复排班！`)
    }

    // ── 【铁律：满班硬性拦截，不设候补】 ──
    if (enrolledIds.length >= cls.max_capacity_snapshot) {
      throw new Error(`满班硬性拦截：班级【${cls.name}】当前正式在读学员已达封顶(${cls.max_capacity_snapshot}人)！本机构不设候补名单，请为学员排入其他未满班级或新建班级！`)
    }

    // 若原先在试听生列表中，自动移除升级为正式生
    const trialIdx = trialIds.indexOf(studentId)
    if (trialIdx !== -1) {
      trialIds.splice(trialIdx, 1)
    }

    // ── 【核心算费：插班算费】 ──
    const totalLessons = Number(cls.total_lessons || 16)
    const currentLesson = Number(cls.current_lesson_index || 0)
    // 默认从当前进度的下一节开始算插班节次
    const startLesson = Number(options.start_lesson_index || (currentLesson + 1))

    if (startLesson > totalLessons) {
      throw new Error(`插班节次(${startLesson})超出班级总课次数(${totalLessons})，无法插班`)
    }

    // 剩余节数与应收课时数（不收已经上过的节数！）
    const chargedLessons = Math.max(0, totalLessons - startLesson + 1)
    const chargedHours = Number((chargedLessons * cls.hours_per_lesson_snapshot).toFixed(2))

    // 记录插班明细
    const detail = {
      student_id: studentId,
      student_name: student.name,
      enrolled_at: new Date().toISOString(),
      start_lesson_index: startLesson,
      charged_lessons: chargedLessons,
      charged_hours: chargedHours,
      remark: options.remark || (startLesson > 1 ? `中途第${startLesson}节插班，核算剩余${chargedLessons}次课` : '期初正常入班')
    }

    enrolledIds.push(studentId)
    enrolledDetails.push(detail)

    // 重新计算开班门槛
    const newStatus = computeClassStatus(enrolledIds.length, cls.max_capacity_snapshot)

    const patch = {
      enrolled_student_ids: enrolledIds,
      trial_student_ids: trialIds,
      enrolled_student_details: enrolledDetails,
      status: newStatus
    }

    const desc = `[${operator.name}] 学员【${student.name}】排入班级【${cls.name}】(第${startLesson}节插班, 核算${chargedLessons}次课/共${chargedHours}课时)。当前正式生${enrolledIds.length}/${cls.max_capacity_snapshot}人, 状态更新为[${newStatus}]`

    const updated = db.update(db.TABLES.CLASSES, classId, patch, desc)

    return {
      class: updated,
      enrolledDetail: detail,
      statusChangedTo: newStatus
    }
  },

  // ─────────────────────────────────────────
  // 5. 登记试听生（试听规则与多班并存）
  // ─────────────────────────────────────────

  /**
   * 登记试听生（trial）：
   * 核心铁律：
   * 1. 试听生不占正式满班名额（不计入 enrolled_student_ids）；
   * 2. 试听生不触发开班门槛；
   * 3. 试听不扣学生课时（课时余额不变）；
   * 4. 试听学生不算入老师的出勤人头（老师费不变）；
   * 5. 多班并存：允许学生同时挂在多个班，正式班扣课，试听班不扣课不计人头。
   *
   * @param {string} classId
   * @param {string} studentId
   * @param {Object} options
   */
  addTrialStudent(classId, studentId, options = {}) {
    const operator = checkAdminPermission()
    const cls = db.getById(db.TABLES.CLASSES, classId)
    if (!cls) throw new Error(`未找到指定班级 (id=${classId})`)

    const student = db.getById(db.TABLES.STUDENTS, studentId)
    if (!student) throw new Error(`未找到指定学员 (id=${studentId})`)

    const enrolledIds = cls.enrolled_student_ids || []
    if (enrolledIds.includes(studentId)) {
      throw new Error(`学员【${student.name}】已经是该班级的正式在读生，不可降级为试听生`)
    }

    const trialIds = [...(cls.trial_student_ids || [])]
    if (trialIds.includes(studentId)) {
      throw new Error(`学员【${student.name}】已登记为该班试听生，无需重复添加`)
    }

    trialIds.push(studentId)

    // 注意：enrolled_student_ids 不变，开班状态 status 不变，满班名额不受影响！
    const patch = {
      trial_student_ids: trialIds
    }

    const desc = `[${operator.name}] 登记学员【${student.name}】为班级【${cls.name}】试听生 (不占正式名额/不触发开班/不扣课时/不计老师课酬人头)`

    const updated = db.update(db.TABLES.CLASSES, classId, patch, desc)

    return {
      class: updated,
      student_id: studentId,
      isTrial: true
    }
  },

  // ─────────────────────────────────────────
  // 6. 移出班级 / 退班
  // ─────────────────────────────────────────

  /**
   * 将学生从班级移出（正式退班或取消试听）
   * @param {string} classId
   * @param {string} studentId
   * @param {boolean} isTrial - 是否移出试听
   * @param {string} reason
   */
  removeStudentFromClass(classId, studentId, isTrial = false, reason = '教务调班移出') {
    const operator = checkAdminPermission()
    const cls = db.getById(db.TABLES.CLASSES, classId)
    if (!cls) throw new Error(`未找到指定班级 (id=${classId})`)

    const student = db.getById(db.TABLES.STUDENTS, studentId)
    const stuName = student ? student.name : studentId

    let enrolledIds = [...(cls.enrolled_student_ids || [])]
    let trialIds = [...(cls.trial_student_ids || [])]
    let enrolledDetails = [...(cls.enrolled_student_details || [])]

    if (isTrial) {
      trialIds = trialIds.filter(id => id !== studentId)
    } else {
      enrolledIds = enrolledIds.filter(id => id !== studentId)
      enrolledDetails = enrolledDetails.filter(d => d.student_id !== studentId)
    }

    // 重新计算开班状态（若正式人数低于 2 人，回退为 waiting_for_min_students）
    const newStatus = computeClassStatus(enrolledIds.length, cls.max_capacity_snapshot)

    const patch = {
      enrolled_student_ids: enrolledIds,
      trial_student_ids: trialIds,
      enrolled_student_details: enrolledDetails,
      status: newStatus
    }

    const desc = `[${operator.name}] 从班级【${cls.name}】移出${isTrial ? '试听生' : '正式生'}【${stuName}】。事由：${reason}。当前正式生${enrolledIds.length}/${cls.max_capacity_snapshot}人, 状态更新为[${newStatus}]`

    const updated = db.update(db.TABLES.CLASSES, classId, patch, desc)
    return updated
  },

  // ─────────────────────────────────────────
  // 7. 预埋排课日程结构（Phase 3 预留字段）
  // ─────────────────────────────────────────

  /**
   * 生成班级排课日程结构骨架（预埋 substitute_teacher_id 和 makeup_students）
   * @param {string} classId
   * @param {Object} lessonInfo
   *   - lesson_date: 上课日期
   *   - start_time: 开始时间
   *   - end_time: 结束时间
   *   - lesson_index: 第几节课
   */
  buildScheduleLessonSkeleton(classId, lessonInfo) {
    const cls = db.getById(db.TABLES.CLASSES, classId)
    if (!cls) throw new Error(`未找到班级记录 (id=${classId})`)

    return {
      class_id: classId,
      course_id: cls.course_id,
      teacher_id: cls.teacher_id, // 默认当前执教老师
      // ── 【Phase 3 预留字段：代课老师】 ──
      substitute_teacher_id: null,
      lesson_date: lessonInfo.lesson_date,
      start_time: lessonInfo.start_time,
      end_time: lessonInfo.end_time,
      lesson_index: lessonInfo.lesson_index || 1,
      snapshot_hours_per_lesson: cls.hours_per_lesson_snapshot,
      snapshot_max_capacity: cls.max_capacity_snapshot,
      // ── 【Phase 3 预留字段：跨班补课学生挂载数组】 ──
      makeup_students: [],
      attendees_json: [],
      initial_present_headcount: 0,
      makeup_compensated_count: 0,
      calculated_teacher_fee: 0,
      is_settled: false,
      status: 'scheduled'
    }
  },

  // ─────────────────────────────────────────
  // 8. 班级查询列表
  // ─────────────────────────────────────────

  /**
   * 获取班级列表及在读学员概况
   * @param {Object} query - { course_id, term_id, status }
   */
  getClassList(query = {}) {
    const classes = db.getTable(db.TABLES.CLASSES) || []
    const students = db.getTable(db.TABLES.STUDENTS) || []
    const studentMap = {}
    students.forEach(s => { studentMap[s.id] = s })

    return classes.filter(c => {
      if (query.course_id && c.course_id !== query.course_id) return false
      if (query.term_id && c.term_id !== query.term_id) return false
      if (query.status && c.status !== query.status) return false
      return true
    }).map(c => {
      const enrolledNames = (c.enrolled_student_ids || []).map(id => (studentMap[id] ? studentMap[id].name : id))
      const trialNames = (c.trial_student_ids || []).map(id => (studentMap[id] ? studentMap[id].name : id))
      const enrolledCount = (c.enrolled_student_ids || []).length
      const isFull = enrolledCount >= c.max_capacity_snapshot

      return Object.assign({}, c, {
        enrolledNames,
        trialNames,
        enrolledCount,
        isFull
      })
    })
  }
}

module.exports = classService

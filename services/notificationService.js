// services/notificationService.js
// 家校订阅消息授权、微信服务通知与家长学员绑定服务（Phase 1-D）
const db = require('./db')

const notificationService = {
  // ─────────────────────────────────────────
  // 1. 家长与学员绑定（多家长多对多/多对一支持）
  // ─────────────────────────────────────────

  /**
   * 家长绑定已有学员（支持多个家长绑定同一个孩子）
   * @param {Object} params
   *   - student_id: 学员ID
   *   - parent_id: 家长用户ID
   *   - parent_phone: 家长手机号
   *   - relation: 亲属关系 ('父亲' | '母亲' | '其他')
   *   - subscribe_auth: 是否同意接收微信订阅通知 (boolean)
   */
  bindStudentParent(params) {
    const { student_id, parent_id, parent_phone, relation = '家长', subscribe_auth = false } = params

    if (!student_id) throw new Error('必须指定要绑定的学员')
    if (!parent_id) throw new Error('必须指定当前家长账号')

    const student = db.getById(db.TABLES.STUDENTS, student_id)
    if (!student) throw new Error(`未找到学员档案 (id=${student_id})`)

    const boundParents = [...(student.bound_parents || [])]
    const existingIndex = boundParents.findIndex(p => p.parent_id === parent_id || (parent_phone && p.phone === parent_phone))

    const isAgree = !!subscribe_auth

    if (existingIndex !== -1) {
      // 已经绑定过，更新关系与授权状态
      boundParents[existingIndex] = Object.assign({}, boundParents[existingIndex], {
        parent_id,
        phone: parent_phone || boundParents[existingIndex].phone,
        relation,
        subscribe_auth: isAgree
      })
    } else {
      // 多家长支持：爸爸、妈妈等多个家长账号绑定同一个孩子（数组追加）
      boundParents.push({
        parent_id,
        phone: parent_phone || '',
        relation,
        subscribe_auth: isAgree
      })
    }

    const desc = `家长[${parent_phone || parent_id}]绑定学员【${student.name}】(${relation})，订阅消息授权状态: [${isAgree ? '已同意微信推送' : '未同意(转人工微信兜底)'}]`

    const updated = db.update(
      db.TABLES.STUDENTS,
      student_id,
      { bound_parents: boundParents },
      desc
    )

    return {
      student: updated,
      subscribe_auth: isAgree,
      isMultipleParents: boundParents.length > 1
    }
  },

  /**
   * 家长登记新学员并直接建立第一监护人绑定
   * @param {Object} params - { name, gender, birthday, parent_id, parent_phone, relation, subscribe_auth }
   */
  registerNewStudent(params) {
    const { name, gender = 'male', birthday = '', parent_id, parent_phone, relation = '家长', subscribe_auth = false } = params

    if (!name || !name.trim()) throw new Error('孩子姓名不能为空')
    if (!parent_id) throw new Error('必须关联当前家长账号')

    const isAgree = !!subscribe_auth

    const newStudentRecord = {
      name: name.trim(),
      gender,
      birthday,
      bound_parents: [
        {
          parent_id,
          phone: parent_phone || '',
          relation,
          subscribe_auth: isAgree
        }
      ],
      status: 'active'
    }

    const desc = `家长[${parent_phone || parent_id}]登记新建学员【${name}】档案，并绑定为(${relation})，订阅消息授权状态: [${isAgree ? '已同意微信推送' : '未同意(转人工微信兜底)'}]`

    const created = db.insert(db.TABLES.STUDENTS, newStudentRecord, desc)

    return {
      student: created,
      subscribe_auth: isAgree
    }
  },

  /**
   * 单独更新某个家长对某个孩子的订阅消息授权状态
   * @param {string} studentId
   * @param {string} parentId
   * @param {boolean} granted - 是否同意
   */
  updateSubscribeAuth(studentId, parentId, granted) {
    const student = db.getById(db.TABLES.STUDENTS, studentId)
    if (!student) throw new Error(`未找到指定学员 (id=${studentId})`)

    const boundParents = [...(student.bound_parents || [])]
    const idx = boundParents.findIndex(p => p.parent_id === parentId)
    if (idx === -1) throw new Error('该家长未绑定此学员')

    const isAgree = !!granted
    boundParents[idx].subscribe_auth = isAgree

    const desc = `家长[${parentId}]更新对学员【${student.name}】的微信订阅消息授权为: [${isAgree ? '已同意' : '已拒绝(转人工兜底)'}]`

    const updated = db.update(
      db.TABLES.STUDENTS,
      studentId,
      { bound_parents: boundParents },
      desc
    )

    return {
      student: updated,
      subscribe_auth: isAgree
    }
  },

  // ─────────────────────────────────────────
  // 2. 微信订阅消息授权与人工微信兜底清单
  // ─────────────────────────────────────────

  /**
   * 调起微信订阅消息授权弹窗（支持真机与开发者工具调用）
   * 模拟或调起 wx.requestSubscribeMessage
   * @param {Array<string>} tmplIds - 模版ID列表
   * @returns {Promise<boolean>} 是否全部或部分授权成功
   */
  requestSubscribeMessage(tmplIds = ['tmpl_attendance_01', 'tmpl_balance_02']) {
    return new Promise((resolve) => {
      if (typeof wx !== 'undefined' && wx.requestSubscribeMessage) {
        wx.requestSubscribeMessage({
          tmplIds,
          success: (res) => {
            // 只要有一个模板被 accept 即视为家长同意接收通知
            const isAccepted = tmplIds.some(id => res[id] === 'accept')
            resolve(isAccepted)
          },
          fail: (err) => {
            console.warn('[notification] requestSubscribeMessage failed or canceled:', err)
            // 用户取消或环境不支持时返回 false，转人工兜底
            resolve(false)
          }
        })
      } else {
        // 无微信原生 API 环境默认返回 false
        resolve(false)
      }
    })
  },

  /**
   * 获取管理员“人工发微信兜底列表”：
   * 筛选所有 subscribe_auth === false 的家长与学员关联清单
   */
  getManualNotifyFallbackList() {
    const students = db.getTable(db.TABLES.STUDENTS) || []
    const users = db.getTable(db.TABLES.USERS) || []
    const userMap = {}
    users.forEach(u => { userMap[u.id] = u })

    const fallbackList = []

    students.forEach(stu => {
      (stu.bound_parents || []).forEach(p => {
        if (!p.subscribe_auth) {
          const parentUser = userMap[p.parent_id]
          fallbackList.push({
            student_id: stu.id,
            student_name: stu.name,
            parent_id: p.parent_id,
            parent_name: parentUser ? parentUser.name : '家长',
            phone: p.phone || (parentUser ? parentUser.phone : ''),
            relation: p.relation || '监护人',
            subscribe_auth: false,
            notify_channel: '人工发微信兜底'
          })
        }
      })
    })

    return fallbackList
  },

  /**
   * 查询某个家长绑定的全部孩子（带课程余量及班级概况）
   * @param {string} parentId
   * @param {string} parentPhone
   */
  getStudentsByParent(parentId, parentPhone) {
    const students = db.getTable(db.TABLES.STUDENTS) || []
    const packages = db.getTable(db.TABLES.COURSE_PACKAGES) || []
    const classes = db.getTable(db.TABLES.CLASSES) || []

    return students.filter(s => {
      const parents = s.bound_parents || []
      return parents.some(p => p.parent_id === parentId || (parentPhone && p.phone === parentPhone))
    }).map(s => {
      const myRelation = (s.bound_parents || []).find(p => p.parent_id === parentId || (parentPhone && p.phone === parentPhone))
      // 课时余额
      const myPkgs = packages.filter(p => p.student_id === s.id)
      let totalPaidLeft = 0
      let totalGiftLeft = 0
      myPkgs.forEach(p => {
        totalPaidLeft = Number((totalPaidLeft + Number(p.paid_hours_left || 0)).toFixed(2))
        totalGiftLeft = Number((totalGiftLeft + Number(p.gift_hours_left || 0)).toFixed(2))
      })

      // 参加班级
      const myClasses = classes.filter(c => (c.enrolled_student_ids || []).includes(s.id))
      const trialClasses = classes.filter(c => (c.trial_student_ids || []).includes(s.id))

      return Object.assign({}, s, {
        currentRelation: myRelation ? myRelation.relation : '家长',
        subscribe_auth: myRelation ? !!myRelation.subscribe_auth : false,
        allParents: s.bound_parents || [],
        totalAvailableHours: Number((totalPaidLeft + totalGiftLeft).toFixed(2)),
        totalPaidLeft,
        totalGiftLeft,
        enrolledClasses: myClasses.map(c => c.name),
        trialClasses: trialClasses.map(c => c.name)
      })
    })
  },

  // ─────────────────────────────────────────
  // 3. 课时预警与家校通知接口（Phase 2-A 核心联动）
  // ─────────────────────────────────────────

  /**
   * 4课时预警触发通知
   * @param {string} studentId - 学员ID
   * @param {string} courseId - 课程ID
   * @param {number} totalAvailableHours - 当前剩余可用总课时
   * @returns {Object} 通知执行结果
   */
  sendLowBalanceWarning(studentId, courseId, totalAvailableHours) {
    const student = db.getById(db.TABLES.STUDENTS, studentId)
    const course = db.getById(db.TABLES.COURSES_AND_CLASS_TYPES, courseId)
    const studentName = student ? student.name : '学员'
    const courseName = course ? course.course_name : '课程'

    const parents = (student && student.bound_parents) || []
    const notifiedParents = []
    const fallbackParents = []

    parents.forEach(p => {
      if (p.subscribe_auth) {
        // 家长已同意微信订阅通知：模拟触发微信订阅消息推送
        notifiedParents.push({
          parent_id: p.parent_id,
          phone: p.phone,
          relation: p.relation,
          channel: 'wechat_subscribe_message',
          title: '课时不足预警提醒',
          content: `尊敬的${p.relation || '家长'}，您的孩子【${studentName}】在【${courseName}】的剩余可用课时仅剩 ${totalAvailableHours} 课时（已低于4课时预警线），为保证孩子正常上课，请及时联系班主任或教务老师进行续费。`
        })
      } else {
        // 家长未授权微信通知：转入管理员人工发微信兜底清单
        fallbackParents.push({
          student_id: studentId,
          student_name: studentName,
          parent_id: p.parent_id,
          phone: p.phone,
          relation: p.relation,
          channel: 'manual_wechat_fallback',
          reason: '课时不足4课时催缴续费提醒',
          warning_hours: totalAvailableHours
        })
      }
    })

    // 写入一条系统通知审计留痕
    const desc = `[4课时预警] 学员【${studentName}】在【${courseName}】可用课时仅剩 ${totalAvailableHours} 课时。已推送微信订阅消息 ${notifiedParents.length} 位家长，转入人工兜底 ${fallbackParents.length} 位家长。`
    if (student) {
      db.update(
        db.TABLES.STUDENTS,
        student.id,
        { last_low_balance_warning_at: new Date().toISOString() },
        desc
      )
    }

    return {
      triggered: true,
      student_id: studentId,
      student_name: studentName,
      course_id: courseId,
      course_name: courseName,
      remaining_hours: totalAvailableHours,
      notified_parents: notifiedParents,
      fallback_parents: fallbackParents
    }
  },

  // ─────────────────────────────────────────
  // 4. Phase 3-A：课程取消通知与整班顺延新课表通知
  // ─────────────────────────────────────────

  /**
   * 发送单节课程取消通知（向全班绑定家长与授课老师）
   * @param {string} classId - 班级ID
   * @param {Object} lessonInfo - { lesson_date, start_time, end_time, lesson_index }
   * @param {string} reason - 取消事由
   * @param {Array} refundedStudents - 已退还课时的学员清单
   */
  sendLessonCancellationNotice(classId, lessonInfo, reason = '学校教务调整', refundedStudents = []) {
    const cls = db.getById(db.TABLES.CLASSES, classId)
    const className = cls ? cls.name : `班级#${classId}`
    const teacher = cls ? db.getById(db.TABLES.USERS, cls.teacher_id) : null

    const allStudentIds = [...(cls.enrolled_student_ids || []), ...(cls.trial_student_ids || [])]
    const allStudents = db.getTable(db.TABLES.STUDENTS) || []
    const studentMap = {}
    allStudents.forEach(s => { studentMap[s.id] = s })

    const notifiedParents = []
    const fallbackParents = []

    allStudentIds.forEach(stuId => {
      const stu = studentMap[stuId]
      if (!stu) return
      const stuName = stu.name
      const isRefunded = refundedStudents.some(r => r.student_id === stuId)

      const parents = stu.bound_parents || []
      parents.forEach(p => {
        const msgContent = `尊敬的${p.relation || '家长'}：您的孩子【${stuName}】所在的【${className}】原定于 ${lessonInfo.lesson_date} ${lessonInfo.start_time}-${lessonInfo.end_time} 的第${lessonInfo.lesson_index || 1}次课程因【${reason}】已取消。${isRefunded ? '已扣课时已全额原路退回课时包，' : '本次课程不扣除任何课时，'}请知悉并合理安排接送时间。`

        if (p.subscribe_auth) {
          notifiedParents.push({
            student_id: stuId,
            student_name: stuName,
            parent_id: p.parent_id,
            phone: p.phone,
            channel: 'wechat_subscribe_message',
            title: '课程取消通知',
            content: msgContent
          })
        } else {
          fallbackParents.push({
            student_id: stuId,
            student_name: stuName,
            parent_id: p.parent_id,
            phone: p.phone,
            channel: 'manual_wechat_fallback',
            reason: `课程取消通知(${reason})`,
            content: msgContent
          })
        }
      })
    })

    // 老师通知
    const teacherNotice = teacher ? {
      teacher_id: teacher.id,
      teacher_name: teacher.name,
      channel: 'wechat_subscribe_message',
      title: '课程取消提醒',
      content: `【${teacher.name}老师】您执教的【${className}】原定于 ${lessonInfo.lesson_date} ${lessonInfo.start_time}-${lessonInfo.end_time} 的课程因【${reason}】已取消，当节课酬不计入结算。`
    } : null

    return {
      success: true,
      class_id: classId,
      class_name: className,
      lesson_date: lessonInfo.lesson_date,
      reason,
      notified_parents_count: notifiedParents.length,
      fallback_parents_count: fallbackParents.length,
      teacher_notified: !!teacherNotice,
      notified_parents: notifiedParents,
      fallback_parents: fallbackParents,
      teacher_notice: teacherNotice
    }
  },

  /**
   * 发送整班顺延新课表通知（向全班绑定家长与授课老师）
   * @param {string} classId
   * @param {Array} newSchedules - 顺延后的新排课日程
   * @param {string} reason
   */
  sendSchedulePostponedNotice(classId, newSchedules = [], reason = '课程整班往后顺延一节') {
    const cls = db.getById(db.TABLES.CLASSES, classId)
    const className = cls ? cls.name : `班级#${classId}`

    const allStudentIds = [...(cls.enrolled_student_ids || []), ...(cls.trial_student_ids || [])]
    const allStudents = db.getTable(db.TABLES.STUDENTS) || []
    const studentMap = {}
    allStudents.forEach(s => { studentMap[s.id] = s })

    const notifiedList = []
    const fallbackList = []

    const scheduleSummary = newSchedules.slice(0, 3).map(s => `第${s.lesson_index}次: ${s.lesson_date} ${s.start_time}`).join('；')

    allStudentIds.forEach(stuId => {
      const stu = studentMap[stuId]
      if (!stu) return
      (stu.bound_parents || []).forEach(p => {
        const content = `尊敬的${p.relation || '家长'}：【${className}】课表因【${reason}】已整体往后顺延一节。最新开课安排：${scheduleSummary}...请登录小程序查看完整新课表。`
        if (p.subscribe_auth) {
          notifiedList.push({ parent_id: p.parent_id, phone: p.phone, content })
        } else {
          fallbackList.push({ parent_id: p.parent_id, phone: p.phone, content, reason: '整班顺延新课表通知' })
        }
      })
    })

    return {
      success: true,
      class_name: className,
      notified_count: notifiedList.length,
      fallback_count: fallbackList.length,
      new_schedules_count: newSchedules.length
    }
  },

  /**
   * 发送代课安排通知（向全班绑定家长、原执教老师与代课老师）
   * @param {string} classId
   * @param {Object} lessonInfo - { lesson_date, start_time, end_time, lesson_index }
   * @param {Object} subTeacher - 代课老师对象 { id, name }
   * @param {string} reason - 代课原因
   */
  sendSubstituteTeacherNotice(classId, lessonInfo, subTeacher, reason = '教师临时事务调休') {
    const cls = db.getById(db.TABLES.CLASSES, classId)
    const className = cls ? cls.name : `班级#${classId}`
    const originalTeacher = cls ? db.getById(db.TABLES.USERS, cls.teacher_id) : null
    const origTeacherName = originalTeacher ? originalTeacher.name : '原任课老师'

    const allStudentIds = [...(cls.enrolled_student_ids || []), ...(cls.trial_student_ids || [])]
    const allStudents = db.getTable(db.TABLES.STUDENTS) || []
    const studentMap = {}
    allStudents.forEach(s => { studentMap[s.id] = s })

    const notifiedParents = []
    const fallbackParents = []

    allStudentIds.forEach(stuId => {
      const stu = studentMap[stuId]
      if (!stu) return
      const stuName = stu.name
      const parents = stu.bound_parents || []

      parents.forEach(p => {
        const msgContent = `尊敬的${p.relation || '家长'}：您的孩子【${stuName}】所在的【${className}】原定于 ${lessonInfo.lesson_date} ${lessonInfo.start_time}-${lessonInfo.end_time} 的第${lessonInfo.lesson_index || 1}次课程，因【${reason}】，本次特指派【${subTeacher.name}老师】代课授课，请知悉并准时到校上课。`

        if (p.subscribe_auth) {
          notifiedParents.push({
            student_id: stuId,
            student_name: stuName,
            parent_id: p.parent_id,
            phone: p.phone,
            channel: 'wechat_subscribe_message',
            title: '教师代课服务通知',
            content: msgContent
          })
        } else {
          fallbackParents.push({
            student_id: stuId,
            student_name: stuName,
            parent_id: p.parent_id,
            phone: p.phone,
            channel: 'manual_wechat_fallback',
            reason: `代课通知(${subTeacher.name}老师代课)`,
            content: msgContent
          })
        }
      })
    })

    return {
      success: true,
      class_name: className,
      lesson_date: lessonInfo.lesson_date,
      original_teacher: origTeacherName,
      substitute_teacher: subTeacher.name,
      reason,
      notified_parents_count: notifiedParents.length,
      fallback_parents_count: fallbackParents.length,
      notified_parents: notifiedParents,
      fallback_parents: fallbackParents
    }
  },

  sendAttendanceNotice(studentId, lessonInfo) {
    // 供后续考勤发送订阅通知
  },

  sendApprovalNotice(approverId, approvalInfo) {
    // 供审批待办发送服务通知
  }
}

module.exports = notificationService

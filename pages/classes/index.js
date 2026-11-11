// pages/classes/index.js
const classService = require('../../services/classService')
const db = require('../../services/db')

Page({
  data: {
    currentUser: null,
    isAdmin: false,
    classes: [],
    teachers: [],
    courses: [],
    students: [],
    terms: [],

    stats: {
      totalClasses: 0,
      openClasses: 0,
      waitingClasses: 0,
      fullClasses: 0
    },

    // 弹窗1：新建班级（定五样）
    showCreateModal: false,
    createForm: {
      name: '',
      course_id: '',
      course_index: 0,
      teacher_id: '',
      teacher_index: 0,
      term_id: '',
      term_index: 0,
      max_capacity: 3,
      unit_price: 180,
      hours_per_lesson: 1.5,
      weekly_schedule: '每周六 09:00-10:30',
      total_lessons: 16
    },

    // 弹窗2：正式排班 / 插班算费
    showEnrollModal: false,
    enrollTargetClass: null,
    enrollForm: {
      student_id: '',
      student_index: 0,
      start_lesson_index: 1,
      total_lessons: 16,
      remaining_lessons: 16,
      needed_hours: 24,
      remark: ''
    },

    // 弹窗3：登记试听生
    showTrialModal: false,
    trialTargetClass: null,
    trialForm: {
      student_id: '',
      student_index: 0
    },

    // 弹窗4：更换授课教师
    showChangeTeacherModal: false,
    changeTeacherTargetClass: null,
    changeTeacherForm: {
      new_teacher_id: '',
      teacher_index: 0,
      reason: '教务课程师资优化调整'
    }
  },

  onLoad() {
    this.initData()
  },

  onShow() {
    this.initData()
  },

  onRoleChange() {
    wx.showToast({ title:'请退出后使用另一个账号登录', icon:'none' })
  }

  initData() {
    const app = getApp()
    const user = app && app.globalData && app.globalData.currentUser
    if (!user || !wx.getStorageSync('auth_token')) {
      wx.reLaunch({ url: '/pages/login/index' })
      return
    }

    const isAdmin = user && (user.role === 'admin' || user.role === 'super_admin')

    const users = db.getTable(db.TABLES.USERS) || []
    const teachers = users.filter(u => u.role === 'teacher')
    const courses = db.getTable(db.TABLES.COURSES_AND_CLASS_TYPES) || []
    const students = db.getTable(db.TABLES.STUDENTS) || []
    const terms = db.getTable(db.TABLES.TERMS) || []

    this.setData({
      currentUser: user,
      isAdmin,
      teachers,
      courses,
      students,
      terms
    }, () => {
      this.loadClasses()
    })
  },

  /** 加载班级列表与统计 */
  loadClasses() {
    const list = classService.getClassList()

    let openClasses = 0
    let waitingClasses = 0
    let fullClasses = 0

    list.forEach(c => {
      if (c.status === 'open') openClasses++
      if (c.status === 'waiting_for_min_students') waitingClasses++
      if (c.isFull) fullClasses++
    })

    this.setData({
      classes: list,
      stats: {
        totalClasses: list.length,
        openClasses,
        waitingClasses,
        fullClasses
      }
    })
  },

  // ─────────────────────────────────────────
  // 1. 新建班级（定五样）
  // ─────────────────────────────────────────
  onOpenCreateModal() {
    if (!this.data.isAdmin) {
      wx.showToast({ title: '仅教务/超管可新建班级', icon: 'none' })
      return
    }

    const courses = this.data.courses || []
    const teachers = this.data.teachers || []
    const terms = this.data.terms || []

    const defaultCourse = courses[0]
    const defaultTeacher = teachers[0]
    const defaultTerm = terms[0]

    this.setData({
      showCreateModal: true,
      createForm: {
        name: defaultCourse ? `${defaultCourse.course_name}周六早班` : '新班级',
        course_id: defaultCourse ? defaultCourse.id : '',
        course_index: 0,
        teacher_id: defaultTeacher ? defaultTeacher.id : '',
        teacher_index: 0,
        term_id: defaultTerm ? defaultTerm.id : '',
        term_index: 0,
        max_capacity: defaultCourse ? defaultCourse.max_capacity : 3,
        unit_price: defaultCourse ? defaultCourse.unit_price : 180,
        hours_per_lesson: defaultCourse ? defaultCourse.hours_per_lesson : 1.5,
        weekly_schedule: '每周六 09:00-10:30',
        total_lessons: 16
      }
    })
  },

  onCloseCreateModal() {
    this.setData({ showCreateModal: false })
  },

  onCreateCourseChange(e) {
    const idx = Number(e.detail.value)
    const crs = this.data.courses[idx]
    if (!crs) return

    this.setData({
      'createForm.course_index': idx,
      'createForm.course_id': crs.id,
      'createForm.name': `${crs.course_name}周六班`,
      'createForm.max_capacity': crs.max_capacity,
      'createForm.unit_price': crs.unit_price,
      'createForm.hours_per_lesson': crs.hours_per_lesson
    })
  },

  onCreateTeacherChange(e) {
    const idx = Number(e.detail.value)
    const tch = this.data.teachers[idx]
    if (!tch) return
    this.setData({
      'createForm.teacher_index': idx,
      'createForm.teacher_id': tch.id
    })
  },

  onCreateTermChange(e) {
    const idx = Number(e.detail.value)
    const trm = this.data.terms[idx]
    if (!trm) return
    this.setData({
      'createForm.term_index': idx,
      'createForm.term_id': trm.id
    })
  },

  onCreateInput(e) {
    const field = e.currentTarget.dataset.field
    this.setData({
      [`createForm.${field}`]: e.detail.value
    })
  },

  onSubmitCreateClass() {
    const form = this.data.createForm
    try {
      const created = classService.createClass({
        name: form.name,
        course_id: form.course_id,
        teacher_id: form.teacher_id,
        term_id: form.term_id,
        max_capacity: form.max_capacity,
        unit_price: form.unit_price,
        hours_per_lesson: form.hours_per_lesson,
        weekly_schedule: form.weekly_schedule,
        total_lessons: form.total_lessons
      })

      this.setData({ showCreateModal: false })
      this.loadClasses()

      wx.showModal({
        title: '班级建立成功！',
        content: `【${created.name}】已成功建班！\n定五样已锁定：\n• 老师: ${created.teacher_name_snapshot}\n• 封顶: ${created.max_capacity_snapshot} 人 (建后锁死不可改)\n• 单价: ¥${created.unit_price_snapshot}/课时\n• 课时: ${created.hours_per_lesson_snapshot} 课时/次\n• 时间: ${created.weekly_schedule}\n\n当前状态: ${created.status === 'open' ? '已正式开班' : '待满2人正式开班 (学生先报名先等)'}`,
        showCancel: false,
        confirmText: '确定'
      })
    } catch (err) {
      wx.showModal({
        title: '建班提示',
        content: err.message,
        showCancel: false
      })
    }
  },

  // ─────────────────────────────────────────
  // 2. 正式排班与插班算费（满班硬性拦截）
  // ─────────────────────────────────────────
  onOpenEnrollModal(e) {
    if (!this.data.isAdmin) {
      wx.showToast({ title: '仅教务/超管可进行排班', icon: 'none' })
      return
    }

    const id = e.currentTarget.dataset.id
    const target = this.data.classes.find(c => c.id === id)
    if (!target) return

    // 满班硬性前置判断
    if (target.isFull) {
      wx.showModal({
        title: '满班硬性拦截',
        content: `班级【${target.name}】当前正式学员已达封顶(${target.max_capacity_snapshot}人)！\n本机构不设候补名单，无法继续添加正式学员，请为学员排入其他班级或新建班级！`,
        showCancel: false,
        confirmColor: '#dc2626'
      })
      return
    }

    const students = this.data.students || []
    const defaultStudent = students[0]
    const currentLesson = Number(target.current_lesson_index || 0)
    const nextLesson = currentLesson + 1
    const totalLessons = Number(target.total_lessons || 16)
    const remainingLessons = Math.max(0, totalLessons - nextLesson + 1)
    const neededHours = Number((remainingLessons * target.hours_per_lesson_snapshot).toFixed(2))

    this.setData({
      showEnrollModal: true,
      enrollTargetClass: target,
      enrollForm: {
        student_id: defaultStudent ? defaultStudent.id : '',
        student_index: 0,
        start_lesson_index: nextLesson,
        total_lessons: totalLessons,
        remaining_lessons: remainingLessons,
        needed_hours: neededHours,
        remark: nextLesson > 1 ? `中途第${nextLesson}节插班` : '期初正常入班'
      }
    })
  },

  onCloseEnrollModal() {
    this.setData({ showEnrollModal: false, enrollTargetClass: null })
  },

  onEnrollStudentChange(e) {
    const idx = Number(e.detail.value)
    const stu = this.data.students[idx]
    if (!stu) return
    this.setData({
      'enrollForm.student_index': idx,
      'enrollForm.student_id': stu.id
    })
  },

  onEnrollStartLessonInput(e) {
    const startLesson = Number(e.detail.value) || 1
    const totalLessons = this.data.enrollForm.total_lessons
    const cls = this.data.enrollTargetClass
    const remaining = Math.max(0, totalLessons - startLesson + 1)
    const hours = Number((remaining * (cls ? cls.hours_per_lesson_snapshot : 1.5)).toFixed(2))

    this.setData({
      'enrollForm.start_lesson_index': startLesson,
      'enrollForm.remaining_lessons': remaining,
      'enrollForm.needed_hours': hours
    })
  },

  onSubmitEnroll() {
    const { enrollTargetClass, enrollForm, students } = this.data
    if (!enrollTargetClass) return

    const student = students.find(s => s.id === enrollForm.student_id) || students[enrollForm.student_index]
    if (!student) {
      wx.showToast({ title: '请选择学员', icon: 'none' })
      return
    }

    try {
      const res = classService.enrollStudent(enrollTargetClass.id, student.id, {
        start_lesson_index: enrollForm.start_lesson_index,
        remark: enrollForm.remark
      })

      this.setData({ showEnrollModal: false, enrollTargetClass: null })
      this.loadClasses()

      const detail = res.enrolledDetail
      wx.showModal({
        title: '学员排班成功！',
        content: `学员【${student.name}】已成功排入【${enrollTargetClass.name}】！\n\n【插班计费核算】\n• 插班起始节次: 第 ${detail.start_lesson_index} 节课\n• 核算收取节数: 剩余 ${detail.charged_lessons} 节 (不收已过节数)\n• 需备课时总数: ${detail.charged_hours} 课时\n\n【开班状态】\n当前正式学员: ${res.class.enrolled_student_ids.length}/${res.class.max_capacity_snapshot} 人\n班级状态: ${res.class.status === 'open' ? '🎉 已达开班人数，正式开班！' : '⏳ 待满2人正式开班 (继续等待)'}`,
        showCancel: false,
        confirmText: '确定'
      })
    } catch (err) {
      wx.showModal({
        title: '排班拦截',
        content: err.message,
        showCancel: false,
        confirmColor: '#dc2626'
      })
    }
  },

  // ─────────────────────────────────────────
  // 3. 登记试听生（不占名额不扣课）
  // ─────────────────────────────────────────
  onOpenTrialModal(e) {
    if (!this.data.isAdmin) {
      wx.showToast({ title: '仅教务/超管可登记试听', icon: 'none' })
      return
    }

    const id = e.currentTarget.dataset.id
    const target = this.data.classes.find(c => c.id === id)
    if (!target) return

    const students = this.data.students || []
    this.setData({
      showTrialModal: true,
      trialTargetClass: target,
      trialForm: {
        student_id: students[0] ? students[0].id : '',
        student_index: 0
      }
    })
  },

  onCloseTrialModal() {
    this.setData({ showTrialModal: false, trialTargetClass: null })
  },

  onTrialStudentChange(e) {
    const idx = Number(e.detail.value)
    const stu = this.data.students[idx]
    if (!stu) return
    this.setData({
      'trialForm.student_index': idx,
      'trialForm.student_id': stu.id
    })
  },

  onSubmitTrial() {
    const { trialTargetClass, trialForm, students } = this.data
    if (!trialTargetClass) return

    const student = students.find(s => s.id === trialForm.student_id) || students[trialForm.student_index]
    if (!student) return

    try {
      classService.addTrialStudent(trialTargetClass.id, student.id)

      this.setData({ showTrialModal: false, trialTargetClass: null })
      this.loadClasses()

      wx.showModal({
        title: '试听登记成功！',
        content: `学员【${student.name}】已成功登记为【${trialTargetClass.name}】的试听生！\n\n【试听铁律保障】\n✓ 不占正式满班名额（满班计算不受影响）\n✓ 不触发开班门槛（仍按正式学员统计）\n✓ 试听不扣减学生课时余额\n✓ 不计入老师出勤人头（老师课酬不变）\n✓ 支持多班并存（在别的班正常上课不受阻）`,
        showCancel: false,
        confirmText: '好的'
      })
    } catch (err) {
      wx.showModal({
        title: '试听登记失败',
        content: err.message,
        showCancel: false
      })
    }
  },

  // ─────────────────────────────────────────
  // 4. 更换授课老师（换师历史切割）
  // ─────────────────────────────────────────
  onOpenChangeTeacherModal(e) {
    if (!this.data.isAdmin) {
      wx.showToast({ title: '仅教务/超管可更换老师', icon: 'none' })
      return
    }

    const id = e.currentTarget.dataset.id
    const target = this.data.classes.find(c => c.id === id)
    if (!target) return

    const teachers = this.data.teachers || []
    this.setData({
      showChangeTeacherModal: true,
      changeTeacherTargetClass: target,
      changeTeacherForm: {
        new_teacher_id: teachers[0] ? teachers[0].id : '',
        teacher_index: 0,
        reason: '教务课程师资调配与班级接力'
      }
    })
  },

  onCloseChangeTeacherModal() {
    this.setData({ showChangeTeacherModal: false, changeTeacherTargetClass: null })
  },

  onChangeTeacherChange(e) {
    const idx = Number(e.detail.value)
    const tch = this.data.teachers[idx]
    if (!tch) return
    this.setData({
      'changeTeacherForm.teacher_index': idx,
      'changeTeacherForm.new_teacher_id': tch.id
    })
  },

  onChangeTeacherReasonInput(e) {
    this.setData({
      'changeTeacherForm.reason': e.detail.value
    })
  },

  onSubmitChangeTeacher() {
    const { changeTeacherTargetClass, changeTeacherForm, teachers } = this.data
    if (!changeTeacherTargetClass) return

    const newTeacher = teachers.find(t => t.id === changeTeacherForm.new_teacher_id) || teachers[changeTeacherForm.teacher_index]
    if (!newTeacher) return

    try {
      classService.changeTeacher(
        changeTeacherTargetClass.id,
        newTeacher.id,
        changeTeacherForm.reason
      )

      this.setData({ showChangeTeacherModal: false, changeTeacherTargetClass: null })
      this.loadClasses()

      wx.showModal({
        title: '更换授课教师成功！',
        content: `班级【${changeTeacherTargetClass.name}】已成功更换授课老师为【${newTeacher.name}】！\n\n【历史切割规则】\n• 班级不解散，教学进度完整延续；\n• 原老师历史签到和结算记录完整保留归属原老师；\n• 新老师从接手那节课起记录，按新老师档位计费；\n• 不自动发微信通知（学校线下通知家长）。`,
        showCancel: false,
        confirmText: '好的'
      })
    } catch (err) {
      wx.showModal({
        title: '换师失败',
        content: err.message,
        showCancel: false
      })
    }
  },

  // ─────────────────────────────────────────
  // 5. 封顶锁死破坏性验证测试（直观验证铁律）
  // ─────────────────────────────────────────
  onTestLockCapacity(e) {
    const id = e.currentTarget.dataset.id
    const target = this.data.classes.find(c => c.id === id)
    if (!target) return

    wx.showModal({
      title: '⚠️ 封顶锁死破坏性测试',
      content: `当前班级【${target.name}】建班时锁死封顶为 ${target.max_capacity_snapshot} 人。\n\n点击确认将故意发起代码级指令尝试将封顶改大为 99 人，测试底层安全铁律是否有效拦截！`,
      confirmText: '测试强改封顶',
      confirmColor: '#dc2626',
      success: (res) => {
        if (res.confirm) {
          try {
            // 故意尝试修改封顶人数快照
            classService.updateClass(target.id, {
              max_capacity_snapshot: 99
            })
            wx.showModal({
              title: '🚨 致命漏洞',
              content: '封顶锁死防线失效，请立即检查 classService.js！',
              showCancel: false
            })
          } catch (err) {
            wx.showModal({
              title: '🛡️ 封顶锁死铁律拦截成功！',
              content: `底层防御引擎立即拦截：\n\n【${err.message}】\n\n已成功验证：建班之后封顶人数绝对不可更改，旧班不动，必须新建班级转班！`,
              showCancel: false,
              confirmText: '验证通过',
              confirmColor: '#16a34a'
            })
          }
        }
      }
    })
  }
})

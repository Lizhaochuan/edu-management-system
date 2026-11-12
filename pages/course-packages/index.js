const commands = require('../../services/commandClient')
// pages/course-packages/index.js
// 课时包账本与 Phase 2-A 扣费/回滚控制台
const packageAccountService = require('../../services/packageAccountService')
const transferRefundService = require('../../services/transferRefundService')
const db = require('../../services/db')

Page({
  noOp() {},
  data: {
    currentUser: null,
    isAdmin: false, // super_admin 或 admin 可操作
    packages: [],
    students: [],
    courses: [],
    terms: [],

    // 统计指标
    stats: {
      totalPackages: 0,
      totalPaidLeft: 0,
      totalGiftLeft: 0,
      publicAccountAmount: 0,
      personalAccountAmount: 0,
      totalDebtHours: 0
    },

    // 弹窗1：买课登记
    showPurchaseModal: false,
    purchaseForm: {
      student_id: '',
      student_index: 0,
      course_id: '',
      course_index: 0,
      paid_hours_total: '16',
      gift_hours_total: '0',
      total_amount: '2880',
      account_destination: '进入公账',
      term_id: '',
      term_index: 0,
      selectedExpireDate: '',
      debtHoursWarning: 0,
      remark: ''
    },

    // 弹窗2：消课扣费（Phase 2-A 多包FIFO、破锁、预警、记欠）
    showDeductModal: false,
    deductTarget: null,
    deductForm: {
      student_id: '',
      student_index: 0,
      course_id: '',
      course_index: 0,
      hours_needed: '1.5',
      context_desc: '测试课堂消课'
    },

    // 最近一次消课扣费明细（用于展示结构化留痕与逆向回滚）
    lastDeductionResult: null,

    // 弹窗3：原路逆向回滚弹窗
    showRollbackModal: false,
    rollbackReason: '老师点名手滑撤回签到',

    // 弹窗4：课时冻结申请 (Phase 5-A 90天双封顶)
    showFreezeModal: false,
    freezeTarget: null,
    maxFreezeDaysAllowed: 90,
    freezeForm: {
      freeze_days: '14',
      reason: ''
    },

    // 弹窗5：管理员手工调课时 (Phase 5-A 超管独批·防负数·并发锁)
    showAdjustModal: false,
    adjustTarget: null,
    adjustForm: {
      direction: 'increase', // 'increase' | 'decrease'
      paid_delta: '2',
      gift_delta: '0',
      reason: ''
    },
    previewAdjustHours: {
      paid: 0,
      gift: 0,
      total: 0,
      isNegative: false
    },

    // 弹窗6：核心教务三转 (Phase 5-B 转人 / 转课 / 转班)
    showTransferModal: false,
    transferTarget: null,
    transferTargetStudents: [],
    transferTargetCourses: [],
    transferTargetClasses: [],
    transferForm: {
      transfer_type: 'transfer_student', // 'transfer_student' | 'transfer_course' | 'transfer_class'
      hours_to_transfer: '10',
      target_student_index: 0,
      target_course_index: 0,
      target_class_index: 0,
      remainder_option: 'top_up',
      reason: ''
    },
    transferPreview: null,
    transferErrorMsg: '',

    // 弹窗7：退费清算 (Phase 5-C 赠送不退·原价快照·公私账手续费双轨·超管独批)
    showRefundModal: false,
    refundTarget: null,
    refundPreview: null,
    refundMethods: ['微信转账', '银行卡转账', '现金', '支付宝', '其他'],
    refundMethodIndex: 0,
    refundForm: {
      handling_fee: '0',
      refund_method: '微信转账',
      reason: ''
    },

    // 弹窗8：四期到期扫描与顺延 (Phase 5-C)
    showExpiringModal: false,
    selectedTermIndex: 0,
    expiringPackages: [],

    // 弹窗9：期末顺延确认与补费
    showRolloverModal: false,
    rolloverTarget: null,
    rolloverTermIndex: 0,
    rolloverForm: {
      top_up_fee: '0',
      remark: ''
    },

    // 选中的快捷测试用例
    activeTestTab: 'all'
  },

  onLoad() {
    this.initData()
  },

  async onShow() {
    try { await commands.refresh(); await commands.recoverPending() } catch (err) { wx.showModal({title:"读取服务端失败",content:err.message,showCancel:false}); return }
    this.initData()
  },

  onRoleChange() {
    wx.showToast({ title:'请退出后使用另一个账号登录', icon:'none' })
  },

  initData() {
    const app = getApp()
    const user = app && app.globalData && app.globalData.currentUser
    if (!user || !wx.getStorageSync('auth_token')) {
      wx.reLaunch({ url: '/pages/login/index' })
      return
    }

    const isAdmin = user && (user.role === 'admin' || user.role === 'super_admin')

    const students = db.getTable(db.TABLES.STUDENTS) || []
    const courses = db.getTable(db.TABLES.COURSES_AND_CLASS_TYPES) || []
    const terms = db.getTable(db.TABLES.TERMS) || []

    this.setData({
      currentUser: user,
      isAdmin,
      students,
      courses,
      terms
    }, () => {
      this.loadPackages()
    })
  },

  /** 读取课时包列表与统计 */
  loadPackages() {
    const user = this.data.currentUser
    let allPkgs = packageAccountService.getAllPackages()

    // 若当前为家长，则只看其绑定学员的课时包
    if (user && user.role === 'parent') {
      const myStudents = (this.data.students || []).filter(s =>
        (s.bound_parents || []).some(p => p.parent_id === user.id || p.phone === user.phone)
      )
      const myStuIds = myStudents.map(s => s.id)
      allPkgs = allPkgs.filter(p => myStuIds.includes(p.student_id))
    }

    let totalPaidLeft = 0
    let totalGiftLeft = 0
    let publicAmount = 0
    let personalAmount = 0
    let totalDebt = 0

    allPkgs.forEach(p => {
      totalPaidLeft = Number((totalPaidLeft + Number(p.paid_hours_left || 0)).toFixed(2))
      totalGiftLeft = Number((totalGiftLeft + Number(p.gift_hours_left || 0)).toFixed(2))
      totalDebt = Number((totalDebt + Number(p.debt_hours || 0)).toFixed(2))
      if (p.account_destination === '进入公账') {
        publicAmount += Number(p.total_amount || 0)
      } else {
        personalAmount += Number(p.total_amount || 0)
      }
    })

    this.setData({
      packages: allPkgs,
      stats: {
        totalPackages: allPkgs.length,
        totalPaidLeft,
        totalGiftLeft,
        publicAccountAmount: publicAmount,
        personalAccountAmount: personalAmount,
        totalDebtHours: totalDebt
      }
    })
  },

  // ─────────────────────────────────────────
  // 1. 买课登记相关交互（Phase 1-B）
  // ─────────────────────────────────────────
  onOpenPurchaseModal() {
    if (!this.data.isAdmin) {
      wx.showToast({ title: '仅教务/管理员可登记买课', icon: 'none' })
      return
    }

    const students = this.data.students || []
    const courses = this.data.courses || []
    const terms = this.data.terms || []

    const defaultStudent = students[0]
    const defaultCourse = courses[0]
    const defaultTerm = terms[0]

    // 联动检查欠课
    const debtWarning = this.checkDebtHours(
      defaultStudent ? defaultStudent.id : '',
      defaultCourse ? defaultCourse.id : ''
    )

    this.setData({
      showPurchaseModal: true,
      purchaseForm: {
        student_id: defaultStudent ? defaultStudent.id : '',
        student_index: 0,
        course_id: defaultCourse ? defaultCourse.id : '',
        course_index: 0,
        paid_hours_total: '16',
        gift_hours_total: '0',
        total_amount: defaultCourse ? String(defaultCourse.unit_price * 16) : '2880',
        account_destination: '进入公账',
        term_id: defaultTerm ? defaultTerm.id : '',
        term_index: 0,
        selectedExpireDate: defaultTerm ? defaultTerm.fixed_expire_date : '',
        debtHoursWarning: debtWarning,
        remark: ''
      }
    })
  },

  onClosePurchaseModal() {
    this.setData({ showPurchaseModal: false })
  },

  /** 检查学生某课程历史欠费课时数 */
  checkDebtHours(studentId, courseId) {
    if (!studentId || !courseId) return 0
    const balance = packageAccountService.getStudentCourseBalance(studentId, courseId)
    return balance.debt_hours || 0
  },

  onStudentPickerChange(e) {
    const idx = Number(e.detail.value)
    const stu = this.data.students[idx]
    if (!stu) return

    const debt = this.checkDebtHours(stu.id, this.data.purchaseForm.course_id)
    this.setData({
      'purchaseForm.student_index': idx,
      'purchaseForm.student_id': stu.id,
      'purchaseForm.debtHoursWarning': debt
    })
  },

  onCoursePickerChange(e) {
    const idx = Number(e.detail.value)
    const crs = this.data.courses[idx]
    if (!crs) return

    const debt = this.checkDebtHours(this.data.purchaseForm.student_id, crs.id)
    const paidHours = Number(this.data.purchaseForm.paid_hours_total) || 16
    const calculatedAmount = String(crs.unit_price * paidHours)

    this.setData({
      'purchaseForm.course_index': idx,
      'purchaseForm.course_id': crs.id,
      'purchaseForm.total_amount': calculatedAmount,
      'purchaseForm.debtHoursWarning': debt
    })
  },

  onTermPickerChange(e) {
    const idx = Number(e.detail.value)
    const term = this.data.terms[idx]
    if (!term) return

    this.setData({
      'purchaseForm.term_index': idx,
      'purchaseForm.term_id': term.id,
      'purchaseForm.selectedExpireDate': term.fixed_expire_date
    })
  },

  onPurchaseInput(e) {
    const field = e.currentTarget.dataset.field
    this.setData({
      [`purchaseForm.${field}`]: e.detail.value
    })
  },

  onSelectAccountDestination(e) {
    const dest = e.currentTarget.dataset.dest
    this.setData({
      'purchaseForm.account_destination': dest
    })
  },

  async onSubmitPurchase() {
    const form = this.data.purchaseForm
    const student = this.data.students.find(s => s.id === form.student_id)
    const course = this.data.courses.find(c => c.id === form.course_id)

    if (!student || !course) {
      wx.showToast({ title: '学员或课程无效', icon: 'none' })
      return
    }

    try {
      const res = await commands.run('package.purchase', {
        student_id:student.id, payment_reference:form.payment_reference,
        course_id: course.id,
        paid_hours_total: Number(form.paid_hours_total),
        gift_hours_total: Number(form.gift_hours_total),
        total_amount: Number(form.total_amount),
        account_destination: form.account_destination,
        term_id: form.term_id,
        ...(form.remark ? {remark:form.remark} : {})
      })

      this.setData({ showPurchaseModal: false })
      this.loadPackages()

      // 欠费冲抵结果展示
      const debtOffset = res.debtOffset
      if (debtOffset && debtOffset.totalOffset > 0) {
        wx.showModal({
          title: '买课成功（已自动冲抵欠课）！',
          content: `新购成功！因该生在【${course.course_name}】曾有欠课时 ${debtOffset.totalDebtBefore} 课时，系统已自动优先用新买课时冲抵欠费 ${debtOffset.totalOffset} 课时。\n\n抵扣后可用付费余量：${res.package.paid_hours_left} 课时\n可用赠送余量：${res.package.gift_hours_left} 课时\n剩余仍欠课时：${debtOffset.remainingDebt} 课时`,
          showCancel: false,
          confirmText: '好的'
        })
      } else {
        wx.showModal({
          title: '购课登记成功！',
          content: `已成功为【${student.name}】建立【${course.course_name}】课时包批次！\n付费课时：${res.package.paid_hours_total} 课时\n赠送课时：${res.package.gift_hours_total} 课时\n资金去向：${res.package.account_destination}\n统一到期日：${res.package.expire_date} (旧班不绑，新班入班时抵扣)`,
          showCancel: false,
          confirmText: '确定'
        })
      }
    } catch (err) {
      wx.showModal({
        title: '买课登记失败',
        content: err.message,
        showCancel: false
      })
    }
  },

  // ─────────────────────────────────────────
  // 2. 消课扣费与 Phase 2-A 验证（FIFO、破锁、预警、记欠）
  // ─────────────────────────────────────────
  onOpenDeductModal(e) {
    if (!this.data.isAdmin) {
      wx.showToast({ title: '仅教务/管理员可模拟测试消课', icon: 'none' })
      return
    }

    const pkgId = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.id
    let target = null
    if (pkgId) {
      target = this.data.packages.find(p => p.id === pkgId)
    }

    const students = this.data.students || []
    const courses = this.data.courses || []

    let studentId = target ? target.student_id : (students[0] ? students[0].id : '')
    let courseId = target ? target.course_id : (courses[0] ? courses[0].id : '')

    let studentIndex = students.findIndex(s => s.id === studentId)
    if (studentIndex < 0) studentIndex = 0

    let courseIndex = courses.findIndex(c => c.id === courseId)
    if (courseIndex < 0) courseIndex = 0

    this.setData({
      showDeductModal: true,
      deductTarget: target,
      deductForm: {
        student_id: studentId,
        student_index: studentIndex,
        course_id: courseId,
        course_index: courseIndex,
        hours_needed: '1.5',
        context_desc: target ? `针对课时包 #${target.id} 测试消课` : '课堂正常出勤消课'
      }
    })
  },

  onCloseDeductModal() {
    this.setData({ showDeductModal: false, deductTarget: null })
  },

  onDeductStudentChange(e) {
    const idx = Number(e.detail.value)
    const stu = this.data.students[idx]
    if (!stu) return
    this.setData({
      'deductForm.student_index': idx,
      'deductForm.student_id': stu.id
    })
  },

  onDeductCourseChange(e) {
    const idx = Number(e.detail.value)
    const crs = this.data.courses[idx]
    if (!crs) return
    this.setData({
      'deductForm.course_index': idx,
      'deductForm.course_id': crs.id
    })
  },

  onDeductInput(e) {
    const field = e.currentTarget.dataset.field
    this.setData({
      [`deductForm.${field}`]: e.detail.value
    })
  },

  /** 快速填充预设测试用例 */
  onApplyQuickCase(e) {
    const caseType = e.currentTarget.dataset.case
    const students = this.data.students || []
    const courses = this.data.courses || []

    if (caseType === 'fifo') {
      // 案例1：多包 FIFO 扣费（先到期先扣 + 先付费后赠送）
      this.setData({
        'deductForm.hours_needed': '2.0',
        'deductForm.context_desc': '【测试1: FIFO多包顺序】到期日近的先扣，且先付费后赠送'
      })
      wx.showToast({ title: '已载入FIFO多包扣费案例', icon: 'none' })
    } else if (caseType === 'debt') {
      // 案例2：余额不足记欠（透支至0，可用不为负数，累加欠课时）
      this.setData({
        'deductForm.hours_needed': '50.0', // 大额超量扣费
        'deductForm.context_desc': '【测试2: 余额透支记欠】可用课时扣至0，差额累加进debt_hours'
      })
      wx.showToast({ title: '已载入欠费透支案例', icon: 'none' })
    } else if (caseType === 'warning') {
      // 案例3：可用课时 < 4 课时预警联动
      this.setData({
        'deductForm.hours_needed': '35.0',
        'deductForm.context_desc': '【测试3: 4课时预警线】扣完后可用<4课时触发家校微信通知'
      })
      wx.showToast({ title: '已载入4课时预警案例', icon: 'none' })
    } else if (caseType === 'unlock') {
      wx.showToast({title:'请通过服务端审批创建锁定，不再提供本地模拟写入',icon:'none'})
    }
  },

  /** 提交消课扣费 */
  async onSubmitDeduct() {
    const form = this.data.deductForm
    if (!form.student_id || !form.course_id) {
      wx.showToast({ title: '学员或课程不能为空', icon: 'none' })
      return
    }

    try {
      const res = await commands.run('hours.deduct', {
        event_id: this._deductEvent || (this._deductEvent = commands.key()),
        student_id: form.student_id,
        course_id: form.course_id,
        hours_needed: Number(form.hours_needed),
        context_desc: form.context_desc
      })

      this._deductEvent = null
      this.setData({
        showDeductModal: false,
        deductTarget: null,
        lastDeductionResult: res
      })
      this.loadPackages()

      // 组织提示消息
      let content = `【扣费执行成功】\n` +
        `• 需扣总数: ${res.hours_needed} 课时\n` +
        `• 付费课时扣除: ${res.paid_deducted} 课时\n` +
        `• 赠送课时扣除: ${res.gift_deducted} 课时\n` +
        `• 涉及课时包批次数: ${res.packages_breakdown.length} 个\n`

      if (res.insufficient_balance_flagged) {
        content += `\n⚠️ 【可用余额不足兜底】\n可用课时已扣至 0（绝不记负数），超额透支 ${res.debt_added} 课时已记入欠费账本！`
      }

      if (res.low_balance_warning) {
        content += `\n\n🚨 【4课时预警触发】\n当前剩余可用课时仅 ${res.current_balance.total_available_hours} 课时！已联动家校通知（微信订阅消息/人工微信兜底清单）`
      }

      if (res.invalidated_approvals && res.invalidated_approvals.length > 0) {
        content += `\n\n⚡ 【并发破锁生效】\n上课消课优先物理执行，已自动破除审批锁，并将 ${res.invalidated_approvals.length} 笔未决审批单自动置为【invalidated_by_attendance】失效！`
      }

      wx.showModal({
        title: res.insufficient_balance_flagged ? '消课完成（产生欠课）' : '消课扣费成功！',
        content,
        showCancel: false,
        confirmText: '查看明细'
      })
    } catch (err) {
      wx.showModal({
        title: '扣费失败',
        content: err.message,
        showCancel: false
      })
    }
  },

  // ─────────────────────────────────────────
  // 3. 原路逆向回滚相关交互（Phase 2-A 核心亮点）
  // ─────────────────────────────────────────
  onOpenRollbackModal() {
    if (!this.data.lastDeductionResult) {
      wx.showToast({ title: '暂无最近消课记录可回滚', icon: 'none' })
      return
    }

    this.setData({
      showRollbackModal: true,
      rollbackReason: '老师点名手滑撤回签到'
    })
  },

  onCloseRollbackModal() {
    this.setData({ showRollbackModal: false })
  },

  onRollbackReasonInput(e) {
    this.setData({
      rollbackReason: e.detail.value
    })
  },

  async onSubmitRollback() {
    const { lastDeductionResult, rollbackReason } = this.data
    if (!lastDeductionResult) return

    try {
      const rollbackRes = await commands.run('hours.rollback', {deduction_id:lastDeductionResult.deduction_id,reason:rollbackReason})

      this.setData({
        showRollbackModal: false,
        lastDeductionResult: null // 已回滚，清空留痕
      })
      this.loadPackages()

      const content = `【原路逆向回滚完成】\n` +
        `• 回滚原因: ${rollbackRes.reason}\n` +
        `• 优先冲减欠课时: ${rollbackRes.debt_cleared} 课时\n` +
        `• 先退回赠送课时: ${rollbackRes.total_gift_refunded} 课时\n` +
        `• 再退回付费课时: ${rollbackRes.total_paid_refunded} 课时\n\n` +
        `最新可用总课时: ${rollbackRes.current_balance.total_available_hours} 课时\n最新累计欠课时: ${rollbackRes.current_balance.debt_hours} 课时`

      wx.showModal({
        title: '原路精准回滚成功！',
        content,
        showCancel: false,
        confirmText: '验证完毕'
      })
    } catch (err) {
      wx.showModal({
        title: '回滚失败',
        content: err.message,
        showCancel: false
      })
    }
  },

  // ─────────────────────────────────────────
  // Phase 5-A 弹窗 4：课时冻结操作
  // ─────────────────────────────────────────
  onOpenFreezeModal(e) {
    const pkgId = e.currentTarget.dataset.id
    const target = this.data.packages.find(p => p.id === pkgId)
    if (!target) return

    const totalFrozen = Number(target.total_frozen_days || 0)
    if (totalFrozen >= 90) {
      wx.showModal({
        title: '90天封顶拦截',
        content: `该课时包累计已冻结 ${totalFrozen} 天，已达系统 90 天封顶上限，不能继续申请冻结。`,
        showCancel: false,
        confirmColor: '#dc2626'
      })
      return
    }

    const maxAllowed = Math.min(90, 90 - totalFrozen)
    this.setData({
      showFreezeModal: true,
      freezeTarget: target,
      maxFreezeDaysAllowed: maxAllowed,
      freezeForm: {
        freeze_days: String(Math.min(14, maxAllowed)),
        reason: '学生生病请假就医'
      }
    })
  },

  onCloseFreezeModal() {
    this.setData({
      showFreezeModal: false,
      freezeTarget: null
    })
  },

  onFreezeDaysInput(e) {
    this.setData({
      'freezeForm.freeze_days': e.detail.value
    })
  },

  onFreezeReasonInput(e) {
    this.setData({
      'freezeForm.reason': e.detail.value
    })
  },

  async onSubmitFreeze() {
    const { freezeTarget, freezeForm, currentUser } = this.data
    if (!freezeTarget) return

    const days = parseInt(freezeForm.freeze_days, 10)
    if (isNaN(days) || days <= 0) {
      wx.showToast({ title: '请输入有效的冻结天数', icon: 'none' })
      return
    }

    if (!freezeForm.reason || !freezeForm.reason.trim()) {
      wx.showToast({ title: '必须填写冻结详细原因', icon: 'none' })
      return
    }

    try {
      const res = await transferRefundService.submitFreezeRequest({
        package_id: freezeTarget.id,
        freeze_days: days,
        reason: freezeForm.reason.trim()
      }, currentUser)

      this.onCloseFreezeModal()
      this.loadPackages()

      wx.showModal({
        title: '冻结申请已提交',
        content: `已成功为学员【${freezeTarget.student_name_snapshot}】提交课时冻结申请！\n• 申请冻结: ${res.effective_freeze_days} 天\n• 待管理员在【审批中心】审核，审批通过后到期日将自动顺延。`,
        showCancel: false,
        confirmText: '确定'
      })
    } catch (err) {
      wx.showModal({
        title: '提交失败',
        content: err.message,
        showCancel: false
      })
    }
  },

  // ─────────────────────────────────────────
  // Phase 5-B 弹窗 6：核心教务三转操作 (转人 / 转课 / 转班)
  // ─────────────────────────────────────────
  onOpenTransferModal(e) {
    const pkgId = e.currentTarget.dataset.id
    const target = this.data.packages.find(p => p.id === pkgId)
    if (!target) return

    if (target.lock_status === 'pending_approval_locked') {
      wx.showModal({
        title: '审批并发锁定中',
        content: '该课时包当前有一笔待超级管理员审批的变更单，请等待审批完成或撤回后再操作',
        showCancel: false,
        confirmColor: '#ea580c'
      })
      return
    }

    const allStudents = db.getTable(db.TABLES.STUDENTS) || []
    const allCourses = db.getTable(db.TABLES.COURSES_AND_CLASS_TYPES) || []
    const allClasses = db.getTable(db.TABLES.CLASSES) || []

    const targetStudents = allStudents.filter(s => s.id !== target.student_id)
    const targetCourses = allCourses.filter(c => c.id !== target.course_id && c.status === 'active')
    const targetClasses = allClasses.filter(cls => cls.id !== target.class_id && cls.status === 'active')

    const curTotal = Number(target.paid_hours_left || 0) + Number(target.gift_hours_left || 0)
    const defaultHours = curTotal > 0 ? String(Math.min(10, curTotal)) : '1'

    this.setData({
      showTransferModal: true,
      transferTarget: target,
      transferTargetStudents: targetStudents,
      transferTargetCourses: targetCourses,
      transferTargetClasses: targetClasses,
      transferForm: {
        transfer_type: 'transfer_student',
        hours_to_transfer: defaultHours,
        target_student_index: 0,
        target_course_index: 0,
        target_class_index: 0,
        remainder_option: 'top_up',
        reason: '家长时间冲突协商转出'
      },
      transferPreview: null,
      transferErrorMsg: ''
    }, () => {
      this._calcTransferPreview()
    })
  },

  onCloseTransferModal() {
    this.setData({
      showTransferModal: false,
      transferTarget: null,
      transferPreview: null,
      transferErrorMsg: ''
    })
  },

  onSelectTransferType(e) {
    const type = e.currentTarget.dataset.type
    this.setData({
      'transferForm.transfer_type': type
    }, () => {
      this._calcTransferPreview()
    })
  },

  onTransferHoursInput(e) {
    this.setData({
      'transferForm.hours_to_transfer': e.detail.value
    }, () => {
      this._calcTransferPreview()
    })
  },

  onTransferStudentChange(e) {
    this.setData({
      'transferForm.target_student_index': Number(e.detail.value)
    }, () => {
      this._calcTransferPreview()
    })
  },

  onTransferCourseChange(e) {
    this.setData({
      'transferForm.target_course_index': Number(e.detail.value)
    }, () => {
      this._calcTransferPreview()
    })
  },

  onTransferClassChange(e) {
    this.setData({
      'transferForm.target_class_index': Number(e.detail.value)
    }, () => {
      this._calcTransferPreview()
    })
  },

  onRemainderOptionChange(e) {
    this.setData({
      'transferForm.remainder_option': e.detail.value
    }, () => {
      this._calcTransferPreview()
    })
  },

  onTransferReasonInput(e) {
    this.setData({
      'transferForm.reason': e.detail.value
    })
  },

  _calcTransferPreview() {
    const { transferTarget, transferForm, transferTargetStudents, transferTargetCourses, transferTargetClasses } = this.data
    if (!transferTarget) return

    const hours = parseFloat(transferForm.hours_to_transfer)
    if (isNaN(hours) || hours <= 0) {
      this.setData({ transferPreview: null, transferErrorMsg: '请输入大于0的转出课时数' })
      return
    }

    let targetStudentId = null
    let targetCourseId = null
    let targetClassId = null

    if (transferForm.transfer_type === 'transfer_student') {
      const stu = transferTargetStudents[transferForm.target_student_index]
      targetStudentId = stu ? stu.id : null
      targetCourseId = transferTarget.course_id
    } else if (transferForm.transfer_type === 'transfer_course') {
      const crs = transferTargetCourses[transferForm.target_course_index]
      targetCourseId = crs ? crs.id : null
      targetStudentId = transferTarget.student_id
    } else if (transferForm.transfer_type === 'transfer_class') {
      const cls = transferTargetClasses[transferForm.target_class_index]
      targetClassId = cls ? cls.id : null
      targetCourseId = cls ? cls.course_id : null
      targetStudentId = transferTarget.student_id
    }

    try {
      const preview = transferRefundService.previewTransfer({
        package_id: transferTarget.id,
        transfer_type: transferForm.transfer_type,
        hours_to_transfer: hours,
        target_student_id: targetStudentId,
        target_course_id: targetCourseId,
        target_class_id: targetClassId,
        remainder_option: transferForm.remainder_option
      })

      this.setData({
        transferPreview: preview,
        transferErrorMsg: ''
      })
    } catch (err) {
      this.setData({
        transferPreview: null,
        transferErrorMsg: err.message || '换算试算异常'
      })
    }
  },

  async onSubmitTransfer() {
    const { transferTarget, transferForm, transferTargetStudents, transferTargetCourses, transferTargetClasses, transferPreview, transferErrorMsg, currentUser } = this.data
    if (!transferTarget) return

    if (transferErrorMsg) {
      wx.showModal({ title: '无法提交', content: transferErrorMsg, showCancel: false })
      return
    }

    if (!transferPreview) {
      wx.showToast({ title: '请先核对试算结果', icon: 'none' })
      return
    }

    if (!transferForm.reason || !transferForm.reason.trim()) {
      wx.showToast({ title: '必须填写转移原因', icon: 'none' })
      return
    }

    let targetStudentId = null
    let targetCourseId = null
    let targetClassId = null

    if (transferForm.transfer_type === 'transfer_student') {
      const stu = transferTargetStudents[transferForm.target_student_index]
      targetStudentId = stu ? stu.id : null
    } else if (transferForm.transfer_type === 'transfer_course') {
      const crs = transferTargetCourses[transferForm.target_course_index]
      targetCourseId = crs ? crs.id : null
    } else if (transferForm.transfer_type === 'transfer_class') {
      const cls = transferTargetClasses[transferForm.target_class_index]
      targetClassId = cls ? cls.id : null
    }

    try {
      const res = await transferRefundService.submitTransferRequest({
        package_id: transferTarget.id,
        transfer_type: transferForm.transfer_type,
        hours_to_transfer: parseFloat(transferForm.hours_to_transfer),
        target_student_id: targetStudentId,
        target_course_id: targetCourseId,
        target_class_id: targetClassId,
        remainder_option: transferForm.remainder_option,
        reason: transferForm.reason.trim()
      }, currentUser)

      this.onCloseTransferModal()
      this.loadPackages()

      const topUpTip = transferPreview.top_up_amount > 0 ? `\n• 家长需补差价: +¥${transferPreview.top_up_amount}` : ''
      const refundTip = transferPreview.refund_amount > 0 ? `\n• 需退还零头: -¥${transferPreview.refund_amount}` : ''

      wx.showModal({
        title: '三转申请已提交超管审批',
        content: `【${transferPreview.transfer_type_name}】申请已成功提交！\n• 转出课时: ${transferPreview.transferred_total_hours} 课时 (先扣付费:${transferPreview.transferred_paid_hours}, 后扣赠送:${transferPreview.transferred_gift_hours})\n• 目标所得: ${transferPreview.target_total_hours} 课时${topUpTip}${refundTip}\n• 【审批并发锁已生效】该课时包已被锁定，待超级管理员在【审批中心】审核批准后正式生效。`,
        showCancel: false,
        confirmText: '确定'
      })
    } catch (err) {
      wx.showModal({
        title: '提交失败',
        content: err.message,
        showCancel: false
      })
    }
  },

  // ─────────────────────────────────────────
  // Phase 5-A 弹窗 5：管理员手工调课时操作
  // ─────────────────────────────────────────
  onOpenAdjustModal(e) {
    const pkgId = e.currentTarget.dataset.id
    const target = this.data.packages.find(p => p.id === pkgId)
    if (!target) return

    if (target.lock_status === 'pending_approval_locked') {
      wx.showModal({
        title: '审批并发锁定中',
        content: '该课时包当前有一笔待超级管理员审批的变更单，请等待审批完成或撤回后再操作',
        showCancel: false,
        confirmColor: '#ea580c'
      })
      return
    }

    const adjustForm = {
      direction: 'increase',
      paid_delta: '2',
      gift_delta: '0',
      reason: '补赠推荐新学员活动课时'
    }

    this.setData({
      showAdjustModal: true,
      adjustTarget: target,
      adjustForm
    }, () => {
      this._updateAdjustPreview()
    })
  },

  onCloseAdjustModal() {
    this.setData({
      showAdjustModal: false,
      adjustTarget: null
    })
  },

  onSelectAdjustDirection(e) {
    const dir = e.currentTarget.dataset.dir
    this.setData({
      'adjustForm.direction': dir
    }, () => {
      this._updateAdjustPreview()
    })
  },

  onAdjustPaidInput(e) {
    this.setData({
      'adjustForm.paid_delta': e.detail.value
    }, () => {
      this._updateAdjustPreview()
    })
  },

  onAdjustGiftInput(e) {
    this.setData({
      'adjustForm.gift_delta': e.detail.value
    }, () => {
      this._updateAdjustPreview()
    })
  },

  onAdjustReasonInput(e) {
    this.setData({
      'adjustForm.reason': e.detail.value
    })
  },

  _updateAdjustPreview() {
    const { adjustTarget, adjustForm } = this.data
    if (!adjustTarget) return

    const curPaid = Number(adjustTarget.paid_hours_left || 0)
    const curGift = Number(adjustTarget.gift_hours_left || 0)

    const paidDelta = Math.abs(Number(adjustForm.paid_delta || 0))
    const giftDelta = Math.abs(Number(adjustForm.gift_delta || 0))

    let previewPaid = curPaid
    let previewGift = curGift
    let isNegative = false

    if (adjustForm.direction === 'increase') {
      previewPaid = Number((curPaid + paidDelta).toFixed(2))
      previewGift = Number((curGift + giftDelta).toFixed(2))
    } else {
      previewPaid = Number((curPaid - paidDelta).toFixed(2))
      previewGift = Number((curGift - giftDelta).toFixed(2))
      if (previewPaid < 0 || previewGift < 0 || (previewPaid + previewGift) < 0) {
        isNegative = true
      }
    }

    this.setData({
      previewAdjustHours: {
        paid: previewPaid,
        gift: previewGift,
        total: Number((previewPaid + previewGift).toFixed(2)),
        isNegative
      }
    })
  },

  async onSubmitAdjust() {
    const { adjustTarget, adjustForm, previewAdjustHours, currentUser } = this.data
    if (!adjustTarget) return

    if (previewAdjustHours.isNegative) {
      wx.showToast({ title: '扣减后余额不能为负数', icon: 'none' })
      return
    }

    const paidDelta = Number(adjustForm.paid_delta || 0)
    const giftDelta = Number(adjustForm.gift_delta || 0)
    if (paidDelta <= 0 && giftDelta <= 0) {
      wx.showToast({ title: '调整课时量必须大于0', icon: 'none' })
      return
    }

    if (!adjustForm.reason || !adjustForm.reason.trim()) {
      wx.showToast({ title: '必须填写调账详细原因', icon: 'none' })
      return
    }

    try {
      const res = await transferRefundService.submitManualHourAdjust({
        package_id: adjustTarget.id,
        direction: adjustForm.direction,
        paid_hours_delta: paidDelta,
        gift_hours_delta: giftDelta,
        reason: adjustForm.reason.trim()
      }, currentUser)

      this.onCloseAdjustModal()
      this.loadPackages()

      const tipLocked = res.is_locked ? '\n• 【审批并发锁已生效】扣减期间该课时包已被锁定，禁止重复提交！' : ''
      wx.showModal({
        title: '调账申请已提交超管审批',
        content: `已成功为学员【${adjustTarget.student_name_snapshot}】提交手工调课时申请！\n• 事项: ${adjustForm.direction === 'increase' ? '增加(+)' : '扣减(-)'}${paidDelta + giftDelta}课时${tipLocked}\n• 待超级管理员在【审批中心】审核批准后正式生效。`,
        showCancel: false,
        confirmText: '确定'
      })
    } catch (err) {
      wx.showModal({
        title: '提交失败',
        content: err.message,
        showCancel: false
      })
    }
  },

  // ─────────────────────────────────────────
  // Phase 5-B 弹窗 6：核心教务三转操作 (转人 / 转课 / 转班)
  // ─────────────────────────────────────────
  onOpenTransferModal(e) {
    const pkgId = e.currentTarget.dataset.id
    const target = this.data.packages.find(p => p.id === pkgId)
    if (!target) return

    if (target.lock_status === 'pending_approval_locked') {
      wx.showModal({
        title: '审批并发锁定中',
        content: '该课时包当前有一笔待超级管理员审批的变更单，请等待审批完成或撤回后再操作',
        showCancel: false,
        confirmColor: '#ea580c'
      })
      return
    }

    const allStudents = db.getTable(db.TABLES.STUDENTS) || []
    const allCourses = db.getTable(db.TABLES.COURSES_AND_CLASS_TYPES) || []
    const allClasses = db.getTable(db.TABLES.CLASSES) || []

    const targetStudents = allStudents.filter(s => s.id !== target.student_id)
    const targetCourses = allCourses.filter(c => c.id !== target.course_id && c.status === 'active')
    const targetClasses = allClasses.filter(cls => cls.id !== target.class_id && cls.status === 'active')

    const curTotal = Number(target.paid_hours_left || 0) + Number(target.gift_hours_left || 0)
    const defaultHours = curTotal > 0 ? String(Math.min(10, curTotal)) : '1'

    this.setData({
      showTransferModal: true,
      transferTarget: target,
      transferTargetStudents: targetStudents,
      transferTargetCourses: targetCourses,
      transferTargetClasses: targetClasses,
      transferForm: {
        transfer_type: 'transfer_student',
        hours_to_transfer: defaultHours,
        target_student_index: 0,
        target_course_index: 0,
        target_class_index: 0,
        remainder_option: 'top_up',
        reason: '家长时间冲突协商转出'
      },
      transferPreview: null,
      transferErrorMsg: ''
    }, () => {
      this._calcTransferPreview()
    })
  },

  onCloseTransferModal() {
    this.setData({
      showTransferModal: false,
      transferTarget: null,
      transferPreview: null,
      transferErrorMsg: ''
    })
  },

  onSelectTransferType(e) {
    const type = e.currentTarget.dataset.type
    this.setData({
      'transferForm.transfer_type': type
    }, () => {
      this._calcTransferPreview()
    })
  },

  onTransferHoursInput(e) {
    this.setData({
      'transferForm.hours_to_transfer': e.detail.value
    }, () => {
      this._calcTransferPreview()
    })
  },

  onTransferStudentChange(e) {
    this.setData({
      'transferForm.target_student_index': Number(e.detail.value)
    }, () => {
      this._calcTransferPreview()
    })
  },

  onTransferCourseChange(e) {
    this.setData({
      'transferForm.target_course_index': Number(e.detail.value)
    }, () => {
      this._calcTransferPreview()
    })
  },

  onTransferClassChange(e) {
    this.setData({
      'transferForm.target_class_index': Number(e.detail.value)
    }, () => {
      this._calcTransferPreview()
    })
  },

  onRemainderOptionChange(e) {
    this.setData({
      'transferForm.remainder_option': e.detail.value
    }, () => {
      this._calcTransferPreview()
    })
  },

  onTransferReasonInput(e) {
    this.setData({
      'transferForm.reason': e.detail.value
    })
  },

  _calcTransferPreview() {
    const { transferTarget, transferForm, transferTargetStudents, transferTargetCourses, transferTargetClasses } = this.data
    if (!transferTarget) return

    const hours = parseFloat(transferForm.hours_to_transfer)
    if (isNaN(hours) || hours <= 0) {
      this.setData({ transferPreview: null, transferErrorMsg: '请输入大于0的转出课时数' })
      return
    }

    let targetStudentId = null
    let targetCourseId = null
    let targetClassId = null

    if (transferForm.transfer_type === 'transfer_student') {
      const stu = transferTargetStudents[transferForm.target_student_index]
      targetStudentId = stu ? stu.id : null
      targetCourseId = transferTarget.course_id
    } else if (transferForm.transfer_type === 'transfer_course') {
      const crs = transferTargetCourses[transferForm.target_course_index]
      targetCourseId = crs ? crs.id : null
      targetStudentId = transferTarget.student_id
    } else if (transferForm.transfer_type === 'transfer_class') {
      const cls = transferTargetClasses[transferForm.target_class_index]
      targetClassId = cls ? cls.id : null
      targetCourseId = cls ? cls.course_id : null
      targetStudentId = transferTarget.student_id
    }

    try {
      const preview = transferRefundService.previewTransfer({
        package_id: transferTarget.id,
        transfer_type: transferForm.transfer_type,
        hours_to_transfer: hours,
        target_student_id: targetStudentId,
        target_course_id: targetCourseId,
        target_class_id: targetClassId,
        remainder_option: transferForm.remainder_option
      })

      this.setData({
        transferPreview: preview,
        transferErrorMsg: ''
      })
    } catch (err) {
      this.setData({
        transferPreview: null,
        transferErrorMsg: err.message || '换算试算异常'
      })
    }
  },

  async onSubmitTransfer() {
    const { transferTarget, transferForm, transferTargetStudents, transferTargetCourses, transferTargetClasses, transferPreview, transferErrorMsg, currentUser } = this.data
    if (!transferTarget) return

    if (transferErrorMsg) {
      wx.showModal({ title: '无法提交', content: transferErrorMsg, showCancel: false })
      return
    }

    if (!transferPreview) {
      wx.showToast({ title: '请先核对试算结果', icon: 'none' })
      return
    }

    if (!transferForm.reason || !transferForm.reason.trim()) {
      wx.showToast({ title: '必须填写转移原因', icon: 'none' })
      return
    }

    let targetStudentId = null
    let targetCourseId = null
    let targetClassId = null

    if (transferForm.transfer_type === 'transfer_student') {
      const stu = transferTargetStudents[transferForm.target_student_index]
      targetStudentId = stu ? stu.id : null
    } else if (transferForm.transfer_type === 'transfer_course') {
      const crs = transferTargetCourses[transferForm.target_course_index]
      targetCourseId = crs ? crs.id : null
    } else if (transferForm.transfer_type === 'transfer_class') {
      const cls = transferTargetClasses[transferForm.target_class_index]
      targetClassId = cls ? cls.id : null
    }

    try {
      const res = await transferRefundService.submitTransferRequest({
        package_id: transferTarget.id,
        transfer_type: transferForm.transfer_type,
        hours_to_transfer: parseFloat(transferForm.hours_to_transfer),
        target_student_id: targetStudentId,
        target_course_id: targetCourseId,
        target_class_id: targetClassId,
        remainder_option: transferForm.remainder_option,
        reason: transferForm.reason.trim()
      }, currentUser)

      this.onCloseTransferModal()
      this.loadPackages()

      const topUpTip = transferPreview.top_up_amount > 0 ? `\n• 家长需补差价: +¥${transferPreview.top_up_amount}` : ''
      const refundTip = transferPreview.refund_amount > 0 ? `\n• 需退还零头: -¥${transferPreview.refund_amount}` : ''

      wx.showModal({
        title: '三转申请已提交超管审批',
        content: `【${transferPreview.transfer_type_name}】申请已成功提交！\n• 转出课时: ${transferPreview.transferred_total_hours} 课时 (先扣付费:${transferPreview.transferred_paid_hours}, 后扣赠送:${transferPreview.transferred_gift_hours})\n• 目标所得: ${transferPreview.target_total_hours} 课时${topUpTip}${refundTip}\n• 【审批并发锁已生效】该课时包已被锁定，待超级管理员在【审批中心】审核批准后正式生效。`,
        showCancel: false,
        confirmText: '确定'
      })
    } catch (err) {
      wx.showModal({
        title: '提交失败',
        content: err.message,
        showCancel: false
      })
    }
  },

  // ─────────────────────────────────────────
  // Phase 5-C：退费核算引擎与四期到期顺延事件处理
  // ─────────────────────────────────────────

  /** 打开退费清算申请 Modal */
  onOpenRefundModal(e) {
    const id = e.currentTarget.dataset.id
    const pkg = this.data.packages.find(p => p.id === id) || db.getById(db.TABLES.COURSE_PACKAGES, id)
    if (!pkg) return

    if (pkg.lock_status === 'pending_approval_locked') {
      wx.showModal({
        title: '审批并发锁保护',
        content: `该课时包当前处于待审批锁定中（单据 #${pkg.locked_by_approval_id}），不可重复发起退费。`,
        showCancel: false
      })
      return
    }

    if (pkg.lock_status === 'refunded' || pkg.refund_status === 'refunded') {
      wx.showToast({ title: '该课时包已退费核销', icon: 'none' })
      return
    }

    const curPaid = Number(pkg.paid_hours_left || 0)
    const curGift = Number(pkg.gift_hours_left || 0)
    if (curPaid + curGift <= 0) {
      wx.showToast({ title: '已无剩余课时，无需退费', icon: 'none' })
      return
    }

    try {
      const preview = transferRefundService.previewRefund(pkg.id, {
        handling_fee: 0,
        refund_method: this.data.refundMethods[0],
        refund_reason: ''
      })

      this.setData({
        showRefundModal: true,
        refundTarget: pkg,
        refundPreview: preview,
        refundMethodIndex: 0,
        refundForm: {
          handling_fee: '0',
          refund_method: this.data.refundMethods[0],
          reason: ''
        }
      })
    } catch (err) {
      wx.showModal({
        title: '试算失败',
        content: err.message,
        showCancel: false
      })
    }
  },

  /** 关闭退费 Modal */
  onCloseRefundModal() {
    this.setData({
      showRefundModal: false,
      refundTarget: null,
      refundPreview: null
    })
  },

  /** 输入退费手续费（公账生效） */
  onRefundHandlingFeeInput(e) {
    const val = e.detail.value
    const refundTarget = this.data.refundTarget
    if (!refundTarget) return

    this.setData({
      'refundForm.handling_fee': val
    }, () => {
      try {
        const preview = transferRefundService.previewRefund(refundTarget.id, {
          handling_fee: val,
          refund_method: this.data.refundForm.refund_method,
          refund_reason: this.data.refundForm.reason
        })
        this.setData({ refundPreview: preview })
      } catch (err) {
        // 输入过程中临时不合法忽略
      }
    })
  },

  /** 选择退费方式 */
  onRefundMethodChange(e) {
    const idx = parseInt(e.detail.value, 10)
    const method = this.data.refundMethods[idx] || '微信转账'
    this.setData({
      refundMethodIndex: idx,
      'refundForm.refund_method': method
    })
  },

  /** 输入退费原因 */
  onRefundReasonInput(e) {
    this.setData({
      'refundForm.reason': e.detail.value
    })
  },

  /** 提交退费清算审批（超管独批） */
  async onSubmitRefund() {
    const { refundTarget, refundForm, refundPreview, currentUser } = this.data
    if (!refundTarget || !refundPreview) return

    if (!refundForm.reason || !refundForm.reason.trim()) {
      wx.showToast({ title: '必须填写详细退费原因', icon: 'none' })
      return
    }

    try {
      const res = await transferRefundService.submitRefundRequest({
        package_id: refundTarget.id,
        handling_fee: parseFloat(refundForm.handling_fee || 0),
        refund_method: refundForm.refund_method,
        refund_reason: refundForm.reason.trim()
      }, currentUser)

      this.onCloseRefundModal()
      this.loadPackages()

      wx.showModal({
        title: '退费清算已提交超管审批',
        content: `【退费清算申请】已成功提交！\n• 应退学费: ¥${refundPreview.gross_refund} (退还付费课时 ${refundPreview.paid_hours_left} 课时)\n• 作废赠送: ${refundPreview.gift_hours_forfeited} 课时 (一分钱不退)\n• 扣除手续费: ¥${refundPreview.handling_fee}\n• 实际退款: ¥${refundPreview.net_refund} (${refundForm.refund_method})\n• 【审批并发锁已生效】该课时包已被锁定，待超级管理员在【审批中心】审核批准后清零核销！`,
        showCancel: false,
        confirmText: '确定'
      })
    } catch (err) {
      wx.showModal({
        title: '提交退费失败',
        content: err.message,
        showCancel: false
      })
    }
  },

  /** 打开四期到期扫描 Modal */
  onOpenExpiringModal() {
    const allTerms = db.getTable(db.TABLES.TERMS) || []
    const firstTerm = allTerms[0] || null

    const scanResult = transferRefundService.scanExpiringPackages({
      term_id: firstTerm ? firstTerm.id : null
    })

    this.setData({
      showExpiringModal: true,
      selectedTermIndex: 0,
      expiringPackages: scanResult.packages
    })
  },

  /** 关闭四期到期扫描 Modal */
  onCloseExpiringModal() {
    this.setData({
      showExpiringModal: false,
      expiringPackages: []
    })
  },

  /** 切换扫描学期 */
  onTermFilterChange(e) {
    const idx = parseInt(e.detail.value, 10)
    const allTerms = this.data.allTerms || []
    const targetTerm = allTerms[idx]

    const scanResult = transferRefundService.scanExpiringPackages({
      term_id: targetTerm ? targetTerm.id : null
    })

    this.setData({
      selectedTermIndex: idx,
      expiringPackages: scanResult.packages
    })
  },

  /** 从到期扫描列表直接触发退费清算 */
  onDirectRefundFromExpiring(e) {
    const id = e.currentTarget.dataset.id
    this.onCloseExpiringModal()
    this.onOpenRefundModal({ currentTarget: { dataset: { id } } })
  },

  /** 打开期末顺延确认 Modal */
  onOpenRolloverModal(e) {
    const id = e.currentTarget.dataset.id
    const pkg = this.data.packages.find(p => p.id === id) || db.getById(db.TABLES.COURSE_PACKAGES, id)
    if (!pkg) return

    const allTerms = this.data.allTerms || []
    // 匹配下一个学期
    let nextIdx = 0
    const curIdx = allTerms.findIndex(t => t.id === pkg.term_id)
    if (curIdx !== -1 && curIdx + 1 < allTerms.length) {
      nextIdx = curIdx + 1
    }

    const stu = db.getById(db.TABLES.STUDENTS, pkg.student_id) || { name: pkg.student_name_snapshot }
    const enrichedTarget = Object.assign({}, pkg, {
      student_name: stu.name,
      term_name: pkg.term_name_snapshot || '当前学期'
    })

    this.setData({
      showRolloverModal: true,
      rolloverTarget: enrichedTarget,
      rolloverTermIndex: nextIdx,
      rolloverForm: {
        top_up_fee: '0',
        remark: ''
      }
    })
  },

  /** 关闭期末顺延 Modal */
  onCloseRolloverModal() {
    this.setData({
      showRolloverModal: false,
      rolloverTarget: null
    })
  },

  /** 顺延目标学期切换 */
  onRolloverTermChange(e) {
    this.setData({
      rolloverTermIndex: parseInt(e.detail.value, 10)
    })
  },

  /** 输入顺延补齐金额 */
  onRolloverTopUpInput(e) {
    this.setData({
      'rolloverForm.top_up_fee': e.detail.value
    })
  },

  /** 输入顺延备注 */
  onRolloverRemarkInput(e) {
    this.setData({
      'rolloverForm.remark': e.detail.value
    })
  },

  /** 提交期末顺延 */
  onSubmitRollover() {
    const { rolloverTarget, allTerms, rolloverTermIndex, rolloverForm, currentUser } = this.data
    if (!rolloverTarget) return

    const targetTerm = allTerms[rolloverTermIndex]
    if (!targetTerm) {
      wx.showToast({ title: '请选择顺延目标学期', icon: 'none' })
      return
    }

    try {
      const res = transferRefundService.executeTermRollover({
        package_id: rolloverTarget.id,
        target_term_id: targetTerm.id,
        top_up_fee: parseFloat(rolloverForm.top_up_fee || 0),
        remark: rolloverForm.remark.trim()
      }, currentUser)

      this.onCloseRolloverModal()
      this.loadPackages()

      // 如果到期扫描窗口打开，刷新到期列表
      if (this.data.showExpiringModal) {
        const curTerm = allTerms[this.data.selectedTermIndex]
        const scanRes = transferRefundService.scanExpiringPackages({
          term_id: curTerm ? curTerm.id : null
        })
        this.setData({ expiringPackages: scanRes.packages })
      }

      wx.showModal({
        title: '期末顺延成功',
        content: `学员【${rolloverTarget.student_name}】课时包 #${rolloverTarget.id} 已成功顺延至【${targetTerm.name}】！\n• 新统一到期日: ${targetTerm.fixed_expire_date}\n• 顺延总课时: ${rolloverTarget.paid_hours_left + rolloverTarget.gift_hours_left} 课时\n• 家长补齐费用: ¥${res.rollover_record.top_up_fee}\n• 顺延流水已安全归档留痕。`,
        showCancel: false,
        confirmText: '确定'
      })
    } catch (err) {
      wx.showModal({
        title: '顺延失败',
        content: err.message,
        showCancel: false
      })
    }
  }
})


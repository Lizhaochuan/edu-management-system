const commands = require('../../services/commandClient')
// pages/config-settings/index.js
const systemConfigService = require('../../services/systemConfigService')
const db = require('../../services/db')
const { normalizeManualRates } = require('../../services/salaryRateConfig')

Page({
  // Consume modal taps without invoking a missing "true" event handler.
  noOp() {},
  data: {
    currentUser: null,
    hasPermission: false, // 仅 admin 与 super_admin 为 true
    activeTab: 'terms', // 'terms' | 'courses' | 'tiers'
    tierSubTab: 'tiers', // 'tiers' | 'teachers'

    // 1. 四期数据
    terms: [],
    showTermModal: false,
    editingTerm: null,
    termForm: {
      expire_date: '',
      reason: ''
    },

    // 2. 班型课程数据
    courses: [],
    showCourseModal: false,
    isEditCourse: false,
    editingCourse: null,
    courseForm: {
      course_name: '',
      class_type_name: '',
      max_capacity: '3',
      unit_price: '180',
      hours_per_lesson: '1.5',
      reason: ''
    },

    // 3. 教师档位与特聘
    tiers: [],
    teachers: [],
    partnerConfig: null,
    showPartnerModal: false,
    partnerForm: { ratesList: [1,2,3,4,5,6,7,8].map(headcount => ({ headcount, rate: '' })), reason: '' },
    showTierModal: false,
    isEditTier: false,
    editingTier: null,
    tierForm: {
      name: '',
      max_capacity: 8,
      ratesList: [1,2,3,4,5,6,7,8].map(headcount => ({ headcount, rate: '' })),
      reason: ''
    },

    // 4. 特聘教师独立改数弹窗
    showTeacherCustomModal: false,
    editingTeacher: null,
    teacherCustomForm: {
      max_capacity: 8,
      ratesList: [1,2,3,4,5,6,7,8].map(headcount => ({ headcount, rate: '' })),
      reason: ''
    }
  },

  onLoad() {
    this.checkPermissionAndLoad()
  },

  async onShow() {
    try { await commands.refresh(); await commands.recoverPending() } catch (err) { wx.showModal({title:"读取失败",content:err.message,showCancel:false}); return }
    this.checkPermissionAndLoad()
  },

  onRoleChange() {
    wx.showToast({ title:'请退出后使用另一个账号登录', icon:'none' })
  },

  /** 权限拦截与数据刷新 */
  checkPermissionAndLoad() {
    const app = getApp()
    const user = app && app.globalData && app.globalData.currentUser
    if (!user || !wx.getStorageSync('auth_token')) {
      wx.reLaunch({ url: '/pages/login/index' })
      return
    }

    const hasPermission = user && (user.role === 'admin' || user.role === 'super_admin')

    if (!hasPermission) {
      this.setData({
        currentUser: user,
        hasPermission: false
      })
      return
    }

    this.setData({
      currentUser: user,
      hasPermission: true
    }, () => {
      this.loadAllData()
    })
  },

  loadAllData() {
    const terms = systemConfigService.getTerms()
    const courses = systemConfigService.getCoursesAndClassTypes()
    const tiers = systemConfigService.getTeacherTiers()
    const teachers = systemConfigService.getTeachers()

    this.setData({
      terms,
      courses,
      tiers,
      teachers,
      partnerConfig: systemConfigService.getPartnerTeacherRates()
    })
  },

  onSwitchTab(e) {
    const tab = e.currentTarget.dataset.tab
    this.setData({ activeTab: tab })
  },

  onSwitchTierSubTab(e) {
    const sub = e.currentTarget.dataset.sub
    this.setData({ tierSubTab: sub })
  },

  // ─────────────────────────────────────────
  // 1. 四期到期日操作
  // ─────────────────────────────────────────
  onOpenEditTerm(e) {
    const id = e.currentTarget.dataset.id
    const term = this.data.terms.find(t => t.id === id)
    if (!term) return

    this.setData({
      showTermModal: true,
      editingTerm: term,
      termForm: {
        expire_date: term.fixed_expire_date,
        reason: ''
      }
    })
  },

  onCloseTermModal() {
    this.setData({ showTermModal: false, editingTerm: null })
  },

  onTermDateChange(e) {
    this.setData({ 'termForm.expire_date': e.detail.value })
  },

  onTermInputReason(e) {
    this.setData({ 'termForm.reason': e.detail.value })
  },

  async onSubmitTermChange() {
    const { editingTerm, termForm } = this.data
    if (!editingTerm) return
    if (!termForm.expire_date) {
      wx.showToast({ title: '请选择新到期日', icon: 'none' })
      return
    }
    if (!termForm.reason.trim()) {
      wx.showToast({ title: '请填写调整事由', icon: 'none' })
      return
    }

    try {
      const created = await systemConfigService.submitTermExpireDateRequest({
        termId: editingTerm.id,
        newExpireDate: termForm.expire_date,
        reason: termForm.reason
      })

      this.setData({ showTermModal: false, editingTerm: null })

      wx.showModal({
        title: created.direct_approved?.length ? '设置已生效' : '申请已提交！',
        content: `${created.direct_approved?.length ? '已直接生效并记录操作。' : `已生成审批单 #${created.id}。\n需另一位超管审批后生效。`}`,
        showCancel: false,
        confirmText: '好的'
      })
    } catch (err) {
      wx.showModal({ title: '提交失败', content: err.message, showCancel: false })
    }
  },

  // ─────────────────────────────────────────
  // 2. 班型与课程单价操作
  // ─────────────────────────────────────────
  onOpenAddCourse() {
    this.setData({
      showCourseModal: true,
      isEditCourse: false,
      editingCourse: null,
      courseForm: {
        course_name: '',
        class_type_name: '',
        max_capacity: '3',
        unit_price: '180',
        hours_per_lesson: '1.5',
        reason: ''
      }
    })
  },

  onOpenEditCourse(e) {
    const id = e.currentTarget.dataset.id
    const course = this.data.courses.find(c => c.id === id)
    if (!course) return

    this.setData({
      showCourseModal: true,
      isEditCourse: true,
      editingCourse: course,
      courseForm: {
        course_name: course.course_name,
        class_type_name: course.class_type_name,
        max_capacity: String(course.max_capacity),
        unit_price: String(course.unit_price),
        hours_per_lesson: String(course.hours_per_lesson),
        reason: ''
      }
    })
  },

  onCloseCourseModal() {
    this.setData({ showCourseModal: false, editingCourse: null })
  },

  onCourseInput(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [`courseForm.${field}`]: e.detail.value })
  },

  async onSubmitCourse() {
    const { isEditCourse, editingCourse, courseForm } = this.data

    try {
      let created = null
      if (isEditCourse) {
        created = await systemConfigService.submitUpdateCourseClassTypeRequest(editingCourse.id, {
          max_capacity: courseForm.max_capacity,
          unit_price: courseForm.unit_price,
          hours_per_lesson: courseForm.hours_per_lesson,
          reason: courseForm.reason
        })
      } else {
        created = await systemConfigService.submitCreateCourseClassTypeRequest({
          course_name: courseForm.course_name,
          class_type_name: courseForm.class_type_name,
          max_capacity: courseForm.max_capacity,
          unit_price: courseForm.unit_price,
          hours_per_lesson: courseForm.hours_per_lesson,
          reason: courseForm.reason
        })
      }

      this.setData({ showCourseModal: false, editingCourse: null })

      wx.showModal({
        title: created.direct_approved?.length ? '设置已生效' : '申请已提交！',
        content: `已生成审批单 #${created.id}。\n重要规则：审批生效后，已有的历史旧班级保留原定额与单价快照不变，新建班级将采用新标准！`,
        showCancel: false,
        confirmText: '我知道了'
      })
    } catch (err) {
      wx.showModal({ title: '提交拦截', content: err.message, showCancel: false })
    }
  },

  // ─────────────────────────────────────────
  // 3. 教师档位操作（强校验人数改大阶梯填价）
  // ─────────────────────────────────────────
  onOpenAddTier() {
    this.setData({
      showTierModal: true,
      isEditTier: false,
      editingTier: null,
      tierForm: {
        name: '',
        max_capacity: 8,
        ratesList: [1,2,3,4,5,6,7,8].map(headcount => ({ headcount, rate: '' })),
        reason: ''
      }
    })
  },

  onOpenEditTier(e) {
    const id = e.currentTarget.dataset.id
    const tier = this.data.tiers.find(t => t.id === id)
    if (!tier) return

    const ratesJson = tier.headcount_rates_json || {}
    const ratesList = [1,2,3,4,5,6,7,8].map(headcount => ({
      headcount,
      rate: ratesJson[headcount] !== undefined ? String(ratesJson[headcount]) : ''
    }))

    this.setData({
      showTierModal: true,
      isEditTier: true,
      editingTier: tier,
      tierForm: {
        name: tier.name,
        max_capacity: 8,
        ratesList,
        reason: ''
      }
    })
  },

  onCloseTierModal() {
    this.setData({ showTierModal: false, editingTier: null })
  },

  onTierNameInput(e) {
    this.setData({ 'tierForm.name': e.detail.value })
  },

  onTierReasonInput(e) {
    this.setData({ 'tierForm.reason': e.detail.value })
  },

  onTierRateItemInput(e) {
    const idx = e.currentTarget.dataset.index
    const val = e.detail.value
    this.setData({
      [`tierForm.ratesList[${idx}].rate`]: val
    })
  },

  async onSubmitTier() {
    const { isEditTier, editingTier, tierForm } = this.data

    // 组装 headcount_rates_json
    const headcountRates = {}
    tierForm.ratesList.forEach(item => {
      headcountRates[item.headcount] = item.rate
    })

    try {
      const validatedRates = normalizeManualRates(headcountRates)
      let created = null
      if (isEditTier) {
        created = await systemConfigService.submitUpdateTeacherTierRequest(editingTier.id, {
          name: tierForm.name,
          headcount_rates_json: validatedRates,
          maxCapacity: tierForm.max_capacity,
          reason: tierForm.reason
        })
      } else {
        created = await systemConfigService.submitCreateTeacherTierRequest({
          name: tierForm.name,
          headcount_rates_json: validatedRates,
          maxCapacity: tierForm.max_capacity,
          reason: tierForm.reason
        })
      }

      this.setData({ showTierModal: false, editingTier: null })

      wx.showModal({
        title: created.direct_approved?.length ? '设置已生效' : '申请已提交！',
        content: `已生成审批单 #${created.id}。\n核心保障：改名改价不影响历史排课签到快照，审批通过后对后续排课生效！`,
        showCancel: false,
        confirmText: '好的'
      })
    } catch (err) {
      wx.showModal({
        title: '校验拦截提示',
        content: err.message,
        showCancel: false,
        confirmColor: '#dc2626'
      })
    }
  },

  // ─────────────────────────────────────────
  // 4. 特聘教师独立改数 / 恢复跟档
  // ─────────────────────────────────────────
  onOpenTeacherCustomModal(e) {
    const id = e.currentTarget.dataset.id
    const teacher = this.data.teachers.find(t => t.id === id)
    if (!teacher) return

    const rates = teacher.custom_tier_rates_json || teacher.defaultTierRates || {}
    const ratesList = [1,2,3,4,5,6,7,8].map(headcount => ({
      headcount,
      rate: rates[headcount] !== undefined ? String(rates[headcount]) : ''
    }))

    this.setData({
      showTeacherCustomModal: true,
      editingTeacher: teacher,
      teacherCustomForm: {
        max_capacity: 8,
        ratesList,
        reason: ''
      }
    })
  },

  onCloseTeacherCustomModal() {
    this.setData({ showTeacherCustomModal: false, editingTeacher: null })
  },

  onCustomRateItemInput(e) {
    const idx = e.currentTarget.dataset.index
    const val = e.detail.value
    this.setData({
      [`teacherCustomForm.ratesList[${idx}].rate`]: val
    })
  },

  onCustomReasonInput(e) {
    this.setData({ 'teacherCustomForm.reason': e.detail.value })
  },

  async onSubmitTeacherCustom() {
    const { editingTeacher, teacherCustomForm } = this.data
    if (!editingTeacher) return

    const headcountRates = {}
    teacherCustomForm.ratesList.forEach(item => {
      headcountRates[item.headcount] = item.rate
    })

    try {
      const validatedRates = normalizeManualRates(headcountRates)
      const created = await systemConfigService.submitTeacherCustomRateRequest(editingTeacher.id, {
        custom_tier_rates_json: validatedRates,
        maxCapacity: teacherCustomForm.max_capacity,
        reason: teacherCustomForm.reason
      })

      this.setData({ showTeacherCustomModal: false, editingTeacher: null })

      wx.showModal({
        title: '特聘改数申请已提交！',
        content: `已成功发起教师【${editingTeacher.name}】特聘独立课酬审批单 #${created.id}。\n通过后将脱离默认档位独立计费！`,
        showCancel: false,
        confirmText: '好的'
      })
    } catch (err) {
      wx.showModal({ title: '校验拦截', content: err.message, showCancel: false })
    }
  },

  async onResetTeacherTier(e) {
    const id = e.currentTarget.dataset.id
    const teacher = this.data.teachers.find(t => t.id === id)
    if (!teacher) return

    wx.showModal({
      title: '确认恢复跟档？',
      content: `是否申请将教师【${teacher.name}】恢复为默认档位【${teacher.tierName}】自动跟档结算？`,
      confirmText: '申请恢复',
      success: async (res) => {
        if (res.confirm) {
          try {
            const created = await systemConfigService.submitTeacherResetTierRequest(teacher.id, {
              reason: `管理员申请将${teacher.name}特聘独立改数清除，恢复默认档位跟档`
            })
            wx.showModal({
              title: '恢复申请已提交',
              content: `已生成审批单 #${created.id}，等待超管审批生效。`,
              showCancel: false
            })
          } catch (err) {
            wx.showModal({ title: '操作失败', content: err.message, showCancel: false })
          }
        }
      }
    })
  },

  onOpenPartnerModal() {
    const rates = (this.data.partnerConfig && this.data.partnerConfig.headcount_rates_json) || {}
    this.setData({
      showPartnerModal: true,
      partnerForm: {
        ratesList: [1,2,3,4,5,6,7,8].map(headcount => ({
          headcount, rate: rates[headcount] !== undefined ? String(rates[headcount]) : ''
        })),
        reason: ''
      }
    })
  },
  onClosePartnerModal() { this.setData({ showPartnerModal: false }) },
  onPartnerRateInput(e) {
    this.setData({ [`partnerForm.ratesList[${e.currentTarget.dataset.index}].rate`]: e.detail.value })
  },
  onPartnerReasonInput(e) { this.setData({ 'partnerForm.reason': e.detail.value }) },
  async onSubmitPartnerRates() {
    try {
      const rates = {}
      this.data.partnerForm.ratesList.forEach(row => { rates[row.headcount] = row.rate })
      const created = await systemConfigService.submitPartnerTeacherRatesRequest({
        headcount_rates_json: normalizeManualRates(rates),
        reason: this.data.partnerForm.reason
      })
      this.setData({ showPartnerModal: false })
      wx.showModal({ title: '已提交审批', content: `合伙人老师档位设置申请 #${created.id}，等待超管审批。`, showCancel: false })
    } catch (err) {
      wx.showModal({ title: '金额校验失败', content: err.message, showCancel: false })
    }
  },
  async onSubmitTeacherCategory(e) {
    const teacher = this.data.teachers.find(t => t.id === e.currentTarget.dataset.id)
    if (!teacher) return
    const category = teacher.teacherCategory === 'partner_teacher' ? 'ordinary' : 'partner_teacher'
    wx.showModal({
      title: '确认申请调整教师类别',
      content: `将【${teacher.name}】调整为${category === 'partner_teacher' ? '合伙人老师' : '普通教师'}？仍然需要超级管理员审批。`,
      success: async (res) => {
        if (!res.confirm) return
        try {
          const created = await systemConfigService.submitTeacherCategoryRequest(teacher.id, {
            teacher_category: category,
            teacher_tier_id: teacher.teacher_tier_id,
            reason: '管理员申请调整教师薪酬类别'
          })
          wx.showModal({ title: '已提交审批', content: `审批单 #${created.id}`, showCancel: false })
        } catch (err) { wx.showModal({ title: '申请失败', content: err.message, showCancel: false }) }
      }
    })
  },

  onBackHome() {
    wx.navigateBack({
      fail: () => {
        wx.reLaunch({ url: '/pages/index/index' })
      }
    })
  }
})


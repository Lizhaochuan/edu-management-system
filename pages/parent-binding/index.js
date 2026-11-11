// pages/parent-binding/index.js
const notificationService = require('../../services/notificationService')
const db = require('../../services/db')

const RELATIONS = ['母亲', '父亲', '爷爷', '奶奶', '姥姥', '姥爷', '其他监护人']

Page({
  data: {
    currentUser: null,
    isParent: false,
    isAdmin: false,
    myChildren: [],
    allStudents: [],
    fallbackList: [],
    relations: RELATIONS,

    // 弹窗1：绑定已有孩子（多家长绑定同一个孩子）
    showBindExistingModal: false,
    bindForm: {
      student_id: '',
      student_index: 0,
      relation: '母亲',
      relation_index: 0
    },

    // 弹窗2：登记新孩子
    showRegisterModal: false,
    registerForm: {
      name: '',
      gender: 'male',
      birthday: '2019-01-01',
      relation: '母亲',
      relation_index: 0
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
  },

  initData() {
    const app = getApp()
    const user = app && app.globalData && app.globalData.currentUser
    if (!user || !wx.getStorageSync('auth_token')) {
      wx.reLaunch({ url: '/pages/login/index' })
      return
    }

    const isParent = user && user.role === 'parent'
    const isAdmin = user && (user.role === 'admin' || user.role === 'super_admin')

    const allStudents = db.getTable(db.TABLES.STUDENTS) || []

    this.setData({
      currentUser: user,
      isParent,
      isAdmin,
      allStudents
    }, () => {
      this.refreshLists()
    })
  },

  refreshLists() {
    const user = this.data.currentUser
    if (!user) return

    // 1. 家长绑定的孩子
    const myChildren = notificationService.getStudentsByParent(user.id, user.phone)

    // 2. 管理员查看的人工微信兜底列表 (subscribe_auth === false)
    const fallbackList = notificationService.getManualNotifyFallbackList()

    this.setData({
      myChildren,
      fallbackList
    })
  },

  // ─────────────────────────────────────────
  // 核心授权询问拦截器（铁律）
  // ─────────────────────────────────────────
  promptSubscribeAuth(studentId, parentId, childName) {
    wx.showModal({
      title: '微信订阅消息授权询问',
      content: `是否同意接收学校通知（微信订阅消息）？\n\n• 点击【同意接收】：后续孩子【${childName}】的考勤签到、消课扣费及上课提醒将优先由微信服务通知自动推送！\n• 点击【暂不同意】：系统将自动为您标记为人工兜底，由教务老师通过人工微信列表为您发送通知。`,
      cancelText: '暂不同意',
      confirmText: '同意接收',
      confirmColor: '#16a34a',
      success: (res) => {
        const isAgree = res.confirm
        try {
          notificationService.updateSubscribeAuth(studentId, parentId, isAgree)
          this.refreshLists()

          if (isAgree) {
            // 尝试触发微信原生订阅弹窗
            notificationService.requestSubscribeMessage()
            wx.showModal({
              title: '微信订阅授权已开启！',
              content: `已为【${childName}】开启微信服务通知，上课消课透明推送。`,
              showCancel: false,
              confirmText: '好的'
            })
          } else {
            wx.showModal({
              title: '已转入人工微信兜底',
              content: `您暂未开启微信订阅消息，系统已自动将您的手机号转入管理员【人工发微信兜底列表】，教务老师将通过人工方式通知您。`,
              showCancel: false,
              confirmText: '知道了'
            })
          }
        } catch (err) {
          wx.showToast({ title: err.message, icon: 'none' })
        }
      }
    })
  },

  // ─────────────────────────────────────────
  // 1. 绑定已有学员（支持爸爸、妈妈等多个家长绑定同一个孩子）
  // ─────────────────────────────────────────
  onOpenBindExistingModal() {
    const students = this.data.allStudents || []
    this.setData({
      showBindExistingModal: true,
      bindForm: {
        student_id: students[0] ? students[0].id : '',
        student_index: 0,
        relation: '母亲',
        relation_index: 0
      }
    })
  },

  onCloseBindExistingModal() {
    this.setData({ showBindExistingModal: false })
  },

  onBindStudentChange(e) {
    const idx = Number(e.detail.value)
    const stu = this.data.allStudents[idx]
    if (!stu) return
    this.setData({
      'bindForm.student_index': idx,
      'bindForm.student_id': stu.id
    })
  },

  onBindRelationChange(e) {
    const idx = Number(e.detail.value)
    this.setData({
      'bindForm.relation_index': idx,
      'bindForm.relation': RELATIONS[idx]
    })
  },

  onSubmitBindExisting() {
    const { bindForm, allStudents, currentUser } = this.data
    const student = allStudents.find(s => s.id === bindForm.student_id) || allStudents[bindForm.student_index]
    if (!student) {
      wx.showToast({ title: '请选择学员', icon: 'none' })
      return
    }

    try {
      const res = notificationService.bindStudentParent({
        student_id: student.id,
        parent_id: currentUser.id,
        parent_phone: currentUser.phone,
        relation: bindForm.relation,
        subscribe_auth: false // 初始先进入询问
      })

      this.setData({ showBindExistingModal: false })
      this.refreshLists()

      // 绑定完成后立即弹出授权询问
      this.promptSubscribeAuth(student.id, currentUser.id, student.name)
    } catch (err) {
      wx.showModal({
        title: '绑定失败',
        content: err.message,
        showCancel: false
      })
    }
  },

  // ─────────────────────────────────────────
  // 2. 登记新学员并直接建立第一监护人绑定
  // ─────────────────────────────────────────
  onOpenRegisterModal() {
    this.setData({
      showRegisterModal: true,
      registerForm: {
        name: '',
        gender: 'male',
        birthday: '2019-01-01',
        relation: '母亲',
        relation_index: 0
      }
    })
  },

  onCloseRegisterModal() {
    this.setData({ showRegisterModal: false })
  },

  onRegisterInputName(e) {
    this.setData({ 'registerForm.name': e.detail.value.trim() })
  },

  onRegisterGenderChange(e) {
    this.setData({ 'registerForm.gender': e.currentTarget.dataset.gender })
  },

  onRegisterBirthdayChange(e) {
    this.setData({ 'registerForm.birthday': e.detail.value })
  },

  onRegisterRelationChange(e) {
    const idx = Number(e.detail.value)
    this.setData({
      'registerForm.relation_index': idx,
      'registerForm.relation': RELATIONS[idx]
    })
  },

  onSubmitRegister() {
    const { registerForm, currentUser } = this.data
    if (!registerForm.name) {
      wx.showToast({ title: '请输入孩子姓名', icon: 'none' })
      return
    }

    try {
      const res = notificationService.registerNewStudent({
        name: registerForm.name,
        gender: registerForm.gender,
        birthday: registerForm.birthday,
        parent_id: currentUser.id,
        parent_phone: currentUser.phone,
        relation: registerForm.relation,
        subscribe_auth: false
      })

      this.setData({ showRegisterModal: false })
      this.initData()

      // 登记完成后立即弹出授权询问
      this.promptSubscribeAuth(res.student.id, currentUser.id, res.student.name)
    } catch (err) {
      wx.showModal({
        title: '登记失败',
        content: err.message,
        showCancel: false
      })
    }
  },

  // ─────────────────────────────────────────
  // 3. 切换/重新触发微信订阅授权
  // ─────────────────────────────────────────
  onToggleSubscribeAuth(e) {
    const studentId = e.currentTarget.dataset.id
    const child = this.data.myChildren.find(c => c.id === studentId)
    if (!child) return

    this.promptSubscribeAuth(studentId, this.data.currentUser.id, child.name)
  },

  // 复制手机号
  onCopyPhone(e) {
    const phone = e.currentTarget.dataset.phone
    if (phone) {
      wx.setClipboardData({
        data: phone,
        success: () => {
          wx.showToast({ title: '手机号已复制', icon: 'success' })
        }
      })
    }
  }
})

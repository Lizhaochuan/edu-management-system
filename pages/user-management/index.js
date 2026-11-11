// pages/user-management/index.js
const db = require('../../services/db')

const ROLE_OPTIONS = [
  { value: 'guest',       label: '未分配身份 / 游客', badgeClass: 'role-guest', desc: '无任何教务财务权限，仅能等待超管分配' },
  { value: 'parent',      label: '学员家长',         badgeClass: 'role-parent', desc: '可查看孩子课时余额、消课记录与接收微信通知' },
  { value: 'teacher',     label: '授课教师',         badgeClass: 'role-teacher', desc: '可查看授课课表、课堂点名考勤与查看个人课酬' },
  { value: 'admin',       label: '教务 / 财务管理',   badgeClass: 'role-admin', desc: '可建班排课、管理学员课时包账本与初级审批' },
  { value: 'super_admin', label: '超级管理员 / 合伙人', badgeClass: 'role-super_admin', desc: '最高权限：人员赋权、底座配置审批、审计底册' }
]

const TIER_OPTIONS = [
  { id: 'tier_junior', name: '初级教师 (100~180/课时)' },
  { id: 'tier_middle', name: '中级教师 (120~200/课时)' },
  { id: 'tier_senior', name: '高级教师 (150~260/课时)' }
]

Page({
  data: {
    currentUser: null,
    isSuperAdmin: false,
    activeTab: 'all', // 'all' | 'guest' | 'parent' | 'teacher' | 'admin' | 'super_admin'
    allUsers: [],
    filteredUsers: [],
    counts: {
      all: 0,
      guest: 0,
      parent: 0,
      teacher: 0,
      admin: 0,
      super_admin: 0
    },

    // 弹窗1：预录入账号
    showAddModal: false,
    addForm: {
      name: '',
      phone: '',
      role: 'parent',
      teacher_tier_id: 'tier_junior'
    },

    // 弹窗2：编辑授权/身份调整
    showEditModal: false,
    editingUser: null,
    editForm: {
      role: '',
      teacher_tier_id: 'tier_junior'
    },

    roleOptions: ROLE_OPTIONS,
    tierOptions: TIER_OPTIONS
  },

  onLoad() {
    this.checkPermissionAndLoad()
  },

  onShow() {
    this.checkPermissionAndLoad()
  },

  /** 角色切换回调 */
  onRoleChange(e) {
    const user = e.detail.user
    const app = getApp()
    if (app && app.globalData) {
      app.globalData.currentUser = user
    }
    wx.setStorageSync('current_user', user)

    this.checkPermissionAndLoad()
  },

  /** 权限死锁校验与列表加载 */
  checkPermissionAndLoad() {
    const app = getApp()
    let user = (app && app.globalData && app.globalData.currentUser) || wx.getStorageSync('current_user')
    if (!user) {
      const users = db.getTable(db.TABLES.USERS) || []
      user = users.find(u => u.role === 'super_admin') || users[0]
      if (app && app.globalData) {
        app.globalData.currentUser = user
      }
      wx.setStorageSync('current_user', user)
    }

    const isSuperAdmin = user && user.role === 'super_admin'

    if (!isSuperAdmin) {
      this.setData({
        currentUser: user,
        isSuperAdmin: false,
        allUsers: [],
        filteredUsers: []
      })
      return
    }

    this.setData({
      currentUser: user,
      isSuperAdmin: true
    }, () => {
      this.loadUsers()
    })
  },

  /** 加载用户列表 */
  loadUsers() {
    const rawUsers = db.getTable(db.TABLES.USERS) || []

    const counts = {
      all: rawUsers.length,
      guest: 0,
      parent: 0,
      teacher: 0,
      admin: 0,
      super_admin: 0
    }

    const allUsers = rawUsers.map(u => {
      const role = u.role || 'guest'
      if (counts[role] !== undefined) {
        counts[role]++
      }

      const roleOpt = ROLE_OPTIONS.find(r => r.value === role) || ROLE_OPTIONS[0]
      let tierName = ''
      if (role === 'teacher') {
        const tier = TIER_OPTIONS.find(t => t.id === u.teacher_tier_id)
        tierName = u.is_custom_rate ? '特聘自定义阶梯' : (tier ? tier.name : '标准档位')
      }

      return Object.assign({}, u, {
        roleLabel: roleOpt.label,
        badgeClass: roleOpt.badgeClass,
        roleDesc: roleOpt.desc,
        tierName,
        isSelf: this.data.currentUser && this.data.currentUser.id === u.id
      })
    })

    // 按创建时间倒序
    allUsers.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))

    this.setData({
      allUsers,
      counts
    }, () => {
      this.filterByTab(this.data.activeTab)
    })
  },

  /** 切换筛选 Tab */
  onSwitchTab(e) {
    const tab = e.currentTarget.dataset.tab
    this.setData({ activeTab: tab })
    this.filterByTab(tab)
  },

  filterByTab(tab) {
    if (tab === 'all') {
      this.setData({ filteredUsers: this.data.allUsers })
    } else {
      this.setData({
        filteredUsers: this.data.allUsers.filter(u => u.role === tab)
      })
    }
  },

  // ─────────────────────────────────────────
  // 功能 1：预录入账号
  // ─────────────────────────────────────────
  onOpenAddModal() {
    this.setData({
      showAddModal: true,
      addForm: {
        name: '',
        phone: '',
        role: 'parent',
        teacher_tier_id: 'tier_junior'
      }
    })
  },

  onCloseAddModal() {
    this.setData({ showAddModal: false })
  },

  onAddInputName(e) {
    this.setData({ 'addForm.name': e.detail.value.trim() })
  },

  onAddInputPhone(e) {
    this.setData({ 'addForm.phone': e.detail.value.trim() })
  },

  onAddSelectRole(e) {
    this.setData({ 'addForm.role': e.currentTarget.dataset.role })
  },

  onAddSelectTier(e) {
    this.setData({ 'addForm.teacher_tier_id': e.currentTarget.dataset.tier })
  },

  onSubmitAdd() {
    const { name, phone, role, teacher_tier_id } = this.data.addForm
    if (!name) {
      wx.showToast({ title: '请输入姓名', icon: 'none' })
      return
    }
    if (!phone || phone.length < 8) {
      wx.showToast({ title: '请输入正确手机号', icon: 'none' })
      return
    }

    // 检查手机号冲突
    const existing = this.data.allUsers.find(u => u.phone === phone)
    if (existing) {
      wx.showModal({
        title: '手机号已存在',
        content: `手机号 ${phone} 已由【${existing.name} (${existing.roleLabel})】建档，请直接在列表中点击编辑身份。`,
        showCancel: false
      })
      return
    }

    try {
      const user = this.data.currentUser
      const newRecord = {
        name,
        phone,
        role,
        teacher_tier_id: role === 'teacher' ? teacher_tier_id : null,
        custom_tier_rates_json: null,
        is_custom_rate: false,
        status: 'active'
      }

      // 底层 insert 会自动写不可篡改 audit_logs
      db.insert(
        db.TABLES.USERS,
        newRecord,
        `超管[${user.name}]预录入手机号[${phone}]新成员[${name}]，指定身份为[${role}]`
      )

      this.setData({ showAddModal: false })
      this.loadUsers()

      wx.showToast({
        title: '成员预录入成功',
        icon: 'success'
      })
    } catch (err) {
      wx.showModal({
        title: '预录入失败',
        content: err.message,
        showCancel: false
      })
    }
  },

  // ─────────────────────────────────────────
  // 功能 2：赋权与角色调整
  // ─────────────────────────────────────────
  onOpenEditModal(e) {
    const id = e.currentTarget.dataset.id
    const target = this.data.allUsers.find(u => u.id === id)
    if (!target) return

    this.setData({
      showEditModal: true,
      editingUser: target,
      editForm: {
        role: target.role || 'guest',
        teacher_tier_id: target.teacher_tier_id || 'tier_junior'
      }
    })
  },

  onCloseEditModal() {
    this.setData({
      showEditModal: false,
      editingUser: null
    })
  },

  onEditSelectRole(e) {
    const role = e.currentTarget.dataset.role
    this.setData({ 'editForm.role': role })
  },

  onEditSelectTier(e) {
    const tier = e.currentTarget.dataset.tier
    this.setData({ 'editForm.teacher_tier_id': tier })
  },

  onSubmitEdit() {
    const { editingUser, editForm, currentUser } = this.data
    if (!editingUser) return

    // 安全防线：防止当前超管将自己降权为游客，导致系统无人可用
    if (editingUser.id === currentUser.id && editForm.role !== 'super_admin') {
      wx.showModal({
        title: '操作受限',
        content: '安全铁律保护：不可将当前正在操作的超管账号降级，防止系统无最高管理员！请使用另一位合伙人账号进行调整。',
        showCancel: false,
        confirmColor: '#dc2626'
      })
      return
    }

    try {
      const patch = {
        role: editForm.role,
        teacher_tier_id: editForm.role === 'teacher' ? editForm.teacher_tier_id : null,
        status: 'active'
      }

      // 底层 update 会自动写不可篡改 audit_logs
      db.update(
        db.TABLES.USERS,
        editingUser.id,
        patch,
        `超管[${currentUser.name}]将用户[${editingUser.name}(${editingUser.phone})]的身份由[${editingUser.role}]重新赋权为[${editForm.role}]`
      )

      this.setData({
        showEditModal: false,
        editingUser: null
      })

      this.loadUsers()

      wx.showModal({
        title: '赋权成功！',
        content: `已成功将【${editingUser.name}】的身份调整为【${editForm.role}】。\n该操作已自动写入底层不可篡改操作日志！`,
        showCancel: false,
        confirmText: '好的'
      })
    } catch (err) {
      wx.showModal({
        title: '赋权失败',
        content: err.message,
        showCancel: false
      })
    }
  },

  // ─────────────────────────────────────────
  // 功能 3：删除账号（测试/离职）
  // ─────────────────────────────────────────
  onDeleteUser(e) {
    const id = e.currentTarget.dataset.id
    const target = this.data.allUsers.find(u => u.id === id)
    if (!target) return

    if (target.id === this.data.currentUser.id) {
      wx.showToast({ title: '不能删除自己', icon: 'none' })
      return
    }

    wx.showModal({
      title: '确认删除此账号？',
      content: `是否确认删除成员【${target.name} (${target.phone})】？删除记录同样会被不可篡改日志全量存证。`,
      confirmColor: '#dc2626',
      confirmText: '确认删除',
      success: (res) => {
        if (res.confirm) {
          try {
            db.remove(
              db.TABLES.USERS,
              target.id,
              `超管[${this.data.currentUser.name}]删除了用户[${target.name}(${target.phone})]`
            )
            this.loadUsers()
            wx.showToast({ title: '已删除账号', icon: 'none' })
          } catch (err) {
            wx.showModal({ title: '删除失败', content: err.message, showCancel: false })
          }
        }
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

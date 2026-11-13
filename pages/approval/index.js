const commands = require('../../services/commandClient')
// pages/approval/index.js
const db = require('../../services/db')
const approvalDisplay = require('../../services/approvalDisplay')

const TYPE_CONFIG = {
  super_admin_role_change: {label:'超管身份变更',badgeClass:'type-config',requireRoleText:'需另一位超级管理员审批'},
  config_change: {
    label: '底座配置变更',
    badgeClass: 'type-config',
    requireRoleText: '仅超级管理员可审批'
  },
  freeze_hours: {
    label: '课时冻结申请',
    badgeClass: 'type-freeze',
    requireRoleText: '教务主管/超管可审批'
  },
  balance_adjustment: {
    label: '手工调账/赠课',
    badgeClass: 'type-adjust',
    requireRoleText: '仅超级管理员可审批'
  },
  manual_hour_adjust: {
    label: '课时异常调整',
    badgeClass: 'type-adjust',
    requireRoleText: '仅超级管理员可审批'
  },
  refund: {
    label: '退费清算申请',
    badgeClass: 'type-refund',
    requireRoleText: '仅超级管理员可审批'
  },
  transfer: {
    label: '转人/转课/转班申请',
    badgeClass: 'type-transfer',
    requireRoleText: '仅超级管理员可审批'
  },
  makeup_attendance: {
    label: '漏签补签申请',
    badgeClass: 'type-attendance',
    requireRoleText: '仅超级管理员可审批'
  },
  salary_adjustment: {
    label: '薪资算错调账申请',
    badgeClass: 'type-salary',
    requireRoleText: '仅超级管理员可审批'
  }
}

Page({
  data: {
    currentUser: null,
    activeTab: 'pending', // 'pending' | 'processed'
    pendingList: [],
    processedList: [],
    counts: {
      pending: 0,
      processed: 0
    }
  },

  onLoad() {
    this.initCurrentUser()
  },

  async onShow() {
    try { await commands.refresh(); await commands.recoverPending() } catch (err) { wx.showModal({title:"读取服务端失败",content:err.message,showCancel:false}); return }
    this.initCurrentUser()
  },

  /** 初始化当前用户并加载审批单列表 */
  initCurrentUser() {
    const app = getApp()
    const user = app && app.globalData && app.globalData.currentUser
    if (!user || !wx.getStorageSync('auth_token')) {
      wx.reLaunch({ url: '/pages/login/index' })
      return
    }

    this.setData({ currentUser: user }, () => {
      this.loadApprovalList()
    })
  },

  /** 角色切换回调 */
  onRoleChange() {
    wx.showToast({ title:'请退出后使用另一个账号登录', icon:'none' })
  },

  /** 切换 Tab */
  onSwitchTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (tab !== this.data.activeTab) {
      this.setData({ activeTab: tab })
    }
  },

  /** 格式化日期时间 */
  formatDate(isoStr) {
    if (!isoStr) return '--'
    try {
      const d = new Date(isoStr)
      if (isNaN(d.getTime())) return isoStr
      const pad = (n) => (n < 10 ? '0' + n : n)
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    } catch (e) {
      return isoStr
    }
  },

  /** 加载并解析审批列表 */
  loadApprovalList() {
    const rawList = db.getTable(db.TABLES.APPROVAL_REQUESTS) || []
    const user = this.data.currentUser || {}

    const pendingList = []
    const processedList = []
    const lookup = {
      tiers: db.getTable(db.TABLES.TEACHER_TIERS) || [],
      users: db.getTable(db.TABLES.USERS) || [],
      students: db.getTable(db.TABLES.STUDENTS) || [],
      courses: db.getTable(db.TABLES.COURSES_AND_CLASS_TYPES) || [],
      terms: db.getTable(db.TABLES.TERMS) || [],
      classes: db.getTable(db.TABLES.CLASSES) || [],
      schedules: db.getTable(db.TABLES.SCHEDULES_AND_ATTENDANCE) || []
    }

    rawList.forEach(item => {
      const typeConf = TYPE_CONFIG[item.request_type] || {
        label: '其他审批事项（需核对类型）',
        badgeClass: 'type-default',
        requireRoleText: '需对应权限审批'
      }

      // 核心审批权限校验：
      // 1. freeze_hours: admin 或 super_admin 可审批
      // 2. 其他全部类型: 必须强制 super_admin 才能审批
      let hasRolePermission = false
      if (user.role === 'super_admin') {
        hasRolePermission = true
      } else if (user.role === 'admin' && item.request_type === 'freeze_hours') {
        hasRolePermission = true
      }

      // 判断是否自审 (发起人等于当前登录人)
      const activeSupers = (db.getTable(db.TABLES.USERS) || []).filter(u => u.role === 'super_admin' && u.status === 'active')
      const isSelf = user.id && user.id === item.proposer_id && activeSupers.length !== 1

      const enrichedItem = Object.assign({}, item, {
        typeLabel: typeConf.label,
        typeBadgeClass: typeConf.badgeClass,
        requireRoleText: typeConf.requireRoleText,
        hasRolePermission,
        isSelf,
        createdTimeText: this.formatDate(item.created_at || item.action_time),
        approvedTimeText: this.formatDate(item.approved_time),
        ...approvalDisplay.formatApprovalChange(item, lookup)
      })

      if (item.status === 'pending') {
        pendingList.push(enrichedItem)
      } else {
        processedList.push(enrichedItem)
      }
    })

    // 按创建时间倒序排列
    pendingList.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
    processedList.sort((a, b) => new Date(b.approved_time || b.updated_at || 0) - new Date(a.approved_time || a.updated_at || 0))

    this.setData({
      pendingList,
      processedList,
      counts: {
        pending: pendingList.length,
        processed: processedList.length
      }
    })
  },

  /** 点击“通过”审批 */
  onApprove(e) {
    const id = e.currentTarget.dataset.id
    const item = this.data.pendingList.find(r => r.id === id)
    if (!item) return

    const user = this.data.currentUser

    // ── 【铁律1：自审拦截】 ──
    if (user.id === item.proposer_id && (db.getTable(db.TABLES.USERS) || []).filter(u => u.role === 'super_admin' && u.status === 'active').length !== 1) {
      wx.showModal({
        title: '内控安全拦截',
        content: '违反内控铁律：不能审批自己发起的申请！请切换其他管理员/超管账号审批。',
        showCancel: false,
        confirmColor: '#dc2626',
        confirmText: '确定'
      })
      return
    }

    // ── 【铁律2：角色权限二次防线】 ──
    if (!item.hasRolePermission) {
      wx.showToast({
        title: `无权审批：${item.requireRoleText}`,
        icon: 'none'
      })
      return
    }

    wx.showModal({
      title: '确认审批通过？',
      content: `单号 #${item.id}\n事项：${item.typeLabel}\n理由：${item.reason}`,
      confirmColor: '#16a34a',
      confirmText: '确认通过',
      success: async (res) => {
        if (res.confirm) {
          try {
            await commands.run('approval.approve', {approval_id:item.id})

            wx.showToast({
              title: '审批通过成功',
              icon: 'success',
              duration: 1500
            })

            this.loadApprovalList()
          } catch (err) {
            wx.showModal({
              title: '审批操作失败',
              content: err.message || '未知错误',
              showCancel: false
            })
          }
        }
      }
    })
  },

  /** 点击“驳回”审批 */
  onReject(e) {
    const id = e.currentTarget.dataset.id
    const item = this.data.pendingList.find(r => r.id === id)
    if (!item) return

    const user = this.data.currentUser

    // ── 【铁律1：自审拦截】 ──
    if (user.id === item.proposer_id && (db.getTable(db.TABLES.USERS) || []).filter(u => u.role === 'super_admin' && u.status === 'active').length !== 1) {
      wx.showModal({
        title: '内控安全拦截',
        content: '违反内控铁律：不能审批自己发起的申请！请切换其他管理员/超管账号审批。',
        showCancel: false,
        confirmColor: '#dc2626',
        confirmText: '确定'
      })
      return
    }

    // ── 【铁律2：角色权限二次防线】 ──
    if (!item.hasRolePermission) {
      wx.showToast({
        title: `无权审批：${item.requireRoleText}`,
        icon: 'none'
      })
      return
    }

    // 支持输入驳回理由
    wx.showModal({
      title: '驳回审批申请',
      content: '请输入驳回理由：',
      editable: true,
      placeholderText: '请详细说明驳回原因（如：资料不全、数额有误）',
      confirmColor: '#dc2626',
      confirmText: '确认驳回',
      success: async (res) => {
        if (res.confirm) {
          const reason = (res.content && res.content.trim()) || '经审批人综合评估未予通过'
          try {
            await commands.run('approval.reject', {approval_id:item.id,reject_reason:reason})

            wx.showToast({
              title: '已驳回申请',
              icon: 'none',
              duration: 1500
            })

            this.loadApprovalList()
          } catch (err) {
            wx.showModal({
              title: '驳回操作失败',
              content: err.message || '未知错误',
              showCancel: false
            })
          }
        }
      }
    })
  }
})


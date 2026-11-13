// pages/index/index.js
const db = require('../../services/db')

const ALL_CARDS = [
  // ── 已实现可点击跳转入口 ──
  {
    id: 'approval',
    name: '通用审批中心',
    icon: '📝',
    desc: '单据审批、流转与会签跟踪',
    tag: '已就绪',
    tagType: 'success',
    path: '/pages/approval/index',
    roles: ['super_admin', 'admin', 'teacher', 'parent'],
    isReady: true,
  },
  {
    id: 'audit_logs',
    name: '不可篡改操作日志',
    icon: '🛡️',
    desc: '系统核心数据修改不可变存证底册',
    tag: '仅超管',
    tagType: 'danger',
    path: '/pages/audit-logs/index',
    roles: ['super_admin'], // 严格仅超管可见
    isReady: true,
  },
  {
    id: 'user_management',
    name: '人员与权限授权中心',
    icon: '👑',
    desc: '按手机号预录入账号、赋权家长/老师/管理员',
    tag: '仅超管',
    tagType: 'danger',
    path: '/pages/user-management/index',
    roles: ['super_admin'], // 严格仅超管可见
    isReady: true,
  },
  {
    id: 'config_settings',
    name: '系统参数与课酬设置',
    icon: '⚙️',
    desc: '四期到期日、课程单价班型、教师薪资档位',
    tag: 'Phase 1-A',
    tagType: 'success',
    path: '/pages/config-settings/index',
    roles: ['super_admin', 'admin'], // 老师和家长无权访问
    isReady: true,
  },

  // ── 待开发阶段模块卡片 ──
  {
    id: 'class_schedule',
    name: '建班排课与开班管理',
    icon: '📅',
    desc: '建班定五样、封顶锁死、换师切割、开班门槛',
    tag: 'Phase 1-C',
    tagType: 'success',
    path: '/pages/classes/index',
    roles: ['super_admin', 'admin', 'teacher'],
    isReady: true,
  },
  {
    id: 'course_packages',
    name: '买课登记与课时账本',
    icon: '💰',
    desc: '多包FIFO扣费、4课时预警、透支记欠与原路回滚',
    tag: 'Phase 2-A',
    tagType: 'success',
    path: '/pages/course-packages/index',
    roles: ['super_admin', 'admin', 'parent'],
    isReady: true,
  },
  {
    id: 'attendance',
    name: '考勤签到与排课异动',
    icon: '📋',
    desc: '点名签到、24H改签、课程取消与整班顺延',
    tag: 'Phase 3-A',
    tagType: 'success',
    path: '/pages/attendance/index',
    roles: ['super_admin', 'admin', 'teacher'],
    isReady: true,
  },
  {
    id: 'salary_engine',
    name: '老师课酬与薪资结算',
    icon: '⚡',
    desc: '阶梯课酬、代课补差、结算锁死与调账审批',
    tag: 'Phase 4-C',
    tagType: 'success',
    path: '/pages/salary/index',
    roles: ['super_admin', 'admin', 'teacher'],
    isReady: true,
  },
  {
    id: 'transfer_refund',
    name: '退费与三转清算',
    icon: '🔄',
    desc: '转班、转人、转机构与审批退费',
    tag: 'Phase 5',
    tagType: 'pending',
    phase: 'Phase 5: 退费与三转审批',
    roles: ['super_admin', 'admin'],
    isReady: false,
  },

  // ── 家长端专属视图卡片 ──
  {
    id: 'parent_packages',
    name: '孩子课时余额账本',
    icon: '👛',
    desc: '剩余课时核对、多家长共同绑定与孩子档案',
    tag: 'Phase 1-D',
    tagType: 'success',
    path: '/pages/parent-binding/index',
    roles: ['parent'],
    isReady: true,
  },
  {
    id: 'parent_attendance',
    name: '课堂考勤消课记录',
    icon: '📖',
    desc: '学员上课签到与课时扣减透明流水',
    tag: 'Phase 3 & 6',
    tagType: 'pending',
    phase: 'Phase 3 & 6: 考勤销课流水',
    roles: ['parent'],
    isReady: false,
  },
  {
    id: 'parent_notice',
    name: '家校通知与订阅授权',
    icon: '🔔',
    desc: '微信订阅消息授权与人工微信兜底清单',
    tag: 'Phase 1-D',
    tagType: 'success',
    path: '/pages/parent-binding/index',
    roles: ['parent', 'super_admin', 'admin'],
    isReady: true,
  },
]

const ROLE_DESC_MAP = {
  super_admin: {
    roleTitle: '超级管理员 / 机构合伙人',
    badgeClass: 'badge-super_admin',
    desc: '拥有系统全局终极管理权限：审批底座配置、跨权限越权调账审批、查看不可篡改系统操作审计底册。'
  },
  admin: {
    roleTitle: '教务管理 / 财务主管',
    badgeClass: 'badge-admin',
    desc: '负责班级建立、排课指派、课时包购课管理与基础业务审批。受安全铁律限制，不可查看不可篡改审计底册。'
  },
  teacher: {
    roleTitle: '授课教师',
    badgeClass: 'badge-teacher',
    desc: '负责授课日程安排、课堂学员考勤点名（支持多状态签到）、课时自动消耗核销及个人阶梯课酬查看。'
  },
  parent: {
    roleTitle: '学员家长',
    badgeClass: 'badge-parent',
    desc: '家校协同端：透明查看绑定学员的课程资产余额、扣课记录、请假休学申请及接收微信服务通知。'
  },
  guest: {
    roleTitle: '未分配身份 / 游客',
    badgeClass: 'badge-guest',
    desc: '新访客尚未获得教务或财务授权，请联系机构超级管理员（张校长）分配角色，或输入手机号验证认领已建档账号。'
  }
}

Page({
  data: {
    currentUser: null,
    debugEnabled: false,
    roleInfo: {},
    visibleCards: [],
    stats: {
      studentCount: 0,
      classCount: 0,
      pendingApprovalCount: 0,
      auditLogCount: 0
    }
  },

  onLoad() {
    this.refreshCurrentView()
  },

  onShow() {
    this.refreshCurrentView()
  },

  /** Role is established only by server login; never default to local super-admin. */
  refreshCurrentView() {
    const app = getApp()
    const user = app && app.globalData && app.globalData.currentUser
    if (!user || !['admin', 'super_admin'].includes(user.role)) {
      wx.reLaunch({ url: '/pages/login/index' })
      return
    }
    this.setData({
      debugEnabled: user.role === 'super_admin' &&
        wx.getStorageSync('enable_debug_tools') === true
    })
    this.applyUser(user)
  },

  onLogout() {
    const token = wx.getStorageSync('auth_token')
    if (token) {
      wx.request({
        url: db.SERVER_API_BASE + '/api/auth/logout',
        method: 'POST',
        header: { Authorization: 'Bearer ' + token },
        timeout: 2000
      })
    }
    wx.removeStorageSync('auth_token')
    wx.removeStorageSync('current_user')
    getApp().globalData.currentUser = null
    wx.reLaunch({ url: '/pages/login/index' })
  },

  /** 应用用户并进行视图隔离 */
  applyUser(user) {
    if (!user) return
    const role = user.role || 'parent'
    const roleInfo = ROLE_DESC_MAP[role] || {
      roleTitle: '普通人员',
      badgeClass: 'badge-parent',
      desc: '暂无特殊权限说明。'
    }

    // 过滤出当前角色可见的功能卡片
    const visibleCards = ALL_CARDS.filter(card => card.roles.includes(role))

    // 统计底座数据活跃状态
    const students = db.getTable(db.TABLES.STUDENTS) || []
    const classes = db.getTable(db.TABLES.CLASSES) || []
    const approvals = db.getTable(db.TABLES.APPROVAL_REQUESTS) || []
    const pendingApprovals = approvals.filter(a => a.status === 'pending')
    const auditLogs = db.getTable(db.TABLES.AUDIT_LOGS) || []

    this.setData({
      currentUser: user,
      roleInfo,
      visibleCards,
      stats: {
        studentCount: students.length,
        classCount: classes.length,
        pendingApprovalCount: pendingApprovals.length,
        auditLogCount: auditLogs.length
      }
    })
  },

  /** 点击卡片跳转或提示 */
  onCardTap(e) {
    const cardId = e.currentTarget.dataset.id
    const card = this.data.visibleCards.find(c => c.id === cardId)
    if (!card) return

    if (card.isReady) {
      wx.navigateTo({
        url: card.path,
        fail: (err) => {
          wx.showToast({
            title: '进入模块失败，请稍后重试',
            icon: 'none'
          })
          console.error('[navigation error]:', err)
        }
      })
    } else {
      wx.showToast({
        title: `【${card.phase}】阶段待开发`,
        icon: 'none',
        duration: 2000
      })
    }
  },

  /** 模拟发起一条调账审批并写入日志 */
  onSimulateApproval() {
    if (!this.data.debugEnabled) return
    const user = this.data.currentUser
    if (!user) {
      wx.showToast({ title: '当前未登录用户', icon: 'none' })
      return
    }

    try {
      const pkg = db.getById(db.TABLES.COURSE_PACKAGES, 'pkg_1')
      const beforeBalance = pkg ? { paid_hours_left: pkg.paid_hours_left, gift_hours_left: pkg.gift_hours_left } : { paid_hours_left: 35.5, gift_hours_left: 4 }
      const newPaidLeft = pkg ? Number((pkg.paid_hours_left + 2).toFixed(1)) : 37.5

      const newApproval = {
        request_type: 'balance_adjustment',
        proposer_id: user.id,
        proposer_name: user.name,
        required_approver_role: 'super_admin',
        target_table: db.TABLES.COURSE_PACKAGES,
        target_record_id: 'pkg_1',
        snapshot_balance_at_propose: beforeBalance,
        before_data_json: { paid_hours_left: beforeBalance.paid_hours_left },
        after_data_json: { paid_hours_left: newPaidLeft },
        reason: `${user.name} 申请课时异常补偿赠送 2.0 课时（测试单）`,
        status: 'pending',
        approver_id: null,
        approved_time: null,
        reject_reason: null
      }

      // 底层 insert 会自动触发 _writeAuditLog 写入不可篡改 audit_logs
      const created = db.insert(
        db.TABLES.APPROVAL_REQUESTS,
        newApproval,
        `由 [${user.name}] 模拟发起课时包 pkg_1 调账审批申请单`
      )

      this.refreshCurrentView()

      wx.showModal({
        title: '模拟申请发起成功！',
        content: `已成功创建审批单 #${created.id}，且系统已触发安全拦截器自动写入 1 条不可篡改审计日志！`,
        showCancel: false,
        confirmText: '我知道了'
      })
    } catch (err) {
      wx.showModal({
        title: '操作异常',
        content: err.message || '发起失败',
        showCancel: false
      })
    }
  },

  /** 一键重置演示数据库 */
  onResetDatabase() {
    if (!this.data.debugEnabled) return
    wx.showModal({
      title: '确认重置演示数据库？',
      content: '该操作将清空当前所有修改并重新载入 10 张表的初始演示种子数据。',
      confirmColor: '#dc2626',
      success: (res) => {
        if (res.confirm) {
          try {
            db.initDatabase(true)
            this.refreshCurrentView()
            wx.showToast({
              title: '数据库已重置还原',
              icon: 'success',
              duration: 2000
            })
          } catch (e) {
            wx.showToast({
              title: '重置失败: ' + e.message,
              icon: 'none'
            })
          }
        }
      }
    })
  },

  /** Account claiming by phone without server proof has been removed. */
  onClaimPhone() {
    wx.showToast({ title:'请联系管理员设置登录凭证', icon:'none' })
  }
})

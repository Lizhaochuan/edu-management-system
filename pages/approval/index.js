// pages/approval/index.js
const db = require('../../services/db')
const systemConfigService = require('../../services/systemConfigService')
const attendanceService = require('../../services/attendanceService')
const salaryEngineService = require('../../services/salaryEngineService')
const transferRefundService = require('../../services/transferRefundService')

const TYPE_CONFIG = {
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

  onShow() {
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
  }

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

  /** 格式化 JSON 数据展示 */
  formatJson(data) {
    if (!data) return '无快照数据'
    if (typeof data === 'string') {
      try {
        const obj = JSON.parse(data)
        return JSON.stringify(obj, null, 2)
      } catch (e) {
        return data
      }
    }
    return JSON.stringify(data, null, 2)
  },

  /** 加载并解析审批列表 */
  loadApprovalList() {
    const rawList = db.getTable(db.TABLES.APPROVAL_REQUESTS) || []
    const user = this.data.currentUser || {}

    const pendingList = []
    const processedList = []

    rawList.forEach(item => {
      const typeConf = TYPE_CONFIG[item.request_type] || {
        label: item.request_type || '通用单据',
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
      const isSelf = user.id && user.id === item.proposer_id

      const enrichedItem = Object.assign({}, item, {
        typeLabel: typeConf.label,
        typeBadgeClass: typeConf.badgeClass,
        requireRoleText: typeConf.requireRoleText,
        hasRolePermission,
        isSelf,
        createdTimeText: this.formatDate(item.created_at || item.action_time),
        approvedTimeText: this.formatDate(item.approved_time),
        beforeJsonText: this.formatJson(item.before_data_json),
        afterJsonText: this.formatJson(item.after_data_json)
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
    if (user.id === item.proposer_id) {
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
      success: (res) => {
        if (res.confirm) {
          try {
            const now = new Date().toISOString()
            db.update(
              db.TABLES.APPROVAL_REQUESTS,
              item.id,
              {
                status: 'approved',
                approver_id: user.id,
                approver_name: user.name,
                approved_time: now
              },
              `审批通过：[${user.name}] 批准了申请单 #${item.id} (${item.typeLabel} - ${item.reason})`
            )

            // 核心铁律联动1：如果是系统参数配置变更，审批通过时正式覆盖更新写入业务目标表
            if (item.request_type === 'config_change') {
              systemConfigService.applyConfigApproval(item, user)
            }

            // 核心铁律联动2：如果是漏签补签申请，超管审批通过时正式扣课时、锁死快照并核算课酬
            if (item.request_type === 'makeup_attendance') {
              attendanceService.applyMakeupSignApproval(item, user)
            }

            // 核心铁律联动3：如果是薪资算错调账申请，超管审批通过后变更为 approved_pending_settlement，在下期发薪日自动挂入结算
            if (item.request_type === 'salary_adjustment') {
              salaryEngineService.applySalaryAdjustmentApproval(item, user)
            }

            // 核心铁律联动4：如果是课时冻结申请，管理员/超管审批通过后自动顺延到期日并累加冻结天数（90天双封顶）
            if (item.request_type === 'freeze_hours') {
              transferRefundService.applyFreezeApproval(item, user)
            }

            // 核心铁律联动5：如果是管理员手工调课时申请，超管审批通过后校验二次余额、增减课时并释放并发锁
            if (item.request_type === 'manual_hour_adjust' || item.request_type === 'balance_adjustment') {
              transferRefundService.applyManualHourAdjustApproval(item, user)
            }

            // 核心铁律联动6：如果是三转申请（转人/转课/转班），超管审批通过后校验二次余额、执行转移并释放并发锁
            if (item.request_type === 'transfer') {
              transferRefundService.applyTransferApproval(item, user)
            }

            // 核心铁律联动7：如果是退费清算申请，超管审批通过后核销课时包、联动退班、释放并发锁并归档退费档案
            if (item.request_type === 'refund') {
              transferRefundService.applyRefundApproval(item, user)
            }

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
    if (user.id === item.proposer_id) {
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
      success: (res) => {
        if (res.confirm) {
          const reason = (res.content && res.content.trim()) || '经审批人综合评估未予通过'
          try {
            const now = new Date().toISOString()
            db.update(
              db.TABLES.APPROVAL_REQUESTS,
              item.id,
              {
                status: 'rejected',
                approver_id: user.id,
                approver_name: user.name,
                approved_time: now,
                reject_reason: reason
              },
              `审批驳回：[${user.name}] 驳回了申请单 #${item.id}，理由：${reason}`
            )

            // 核心铁律联动：如果是漏签补签申请被驳回，恢复排课为 scheduled 未签状态，绝不扣课时
            if (item.request_type === 'makeup_attendance') {
              attendanceService.rejectMakeupSignApproval(item, reason, user)
            }

            // 核心铁律联动：如果是薪资算错调账申请被驳回，更新调账记录为 rejected 并记录驳回原因
            if (item.request_type === 'salary_adjustment') {
              salaryEngineService.rejectSalaryAdjustmentApproval(item, reason, user)
            }

            // 核心铁律联动4：如果是课时冻结申请被驳回
            if (item.request_type === 'freeze_hours') {
              transferRefundService.rejectFreezeApproval(item, reason, user)
            }

            // 核心铁律联动5：如果是手工调课时申请被驳回，释放并发锁
            if (item.request_type === 'manual_hour_adjust' || item.request_type === 'balance_adjustment') {
              transferRefundService.rejectManualHourAdjustApproval(item, reason, user)
            }

            // 核心铁律联动6：如果是三转申请被驳回，释放并发锁
            if (item.request_type === 'transfer') {
              transferRefundService.rejectTransferApproval(item, reason, user)
            }

            // 核心铁律联动7：如果是退费申请被驳回，释放并发锁
            if (item.request_type === 'refund') {
              transferRefundService.rejectRefundApproval(item, reason, user)
            }

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

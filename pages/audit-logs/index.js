// pages/audit-logs/index.js
const db = require('../../services/db')

Page({
  data: {
    currentUser: null,
    isSuperAdmin: false,
    logs: [],
    logCount: 0
  },

  onLoad() {
    this.checkPermissionAndLoad()
  },

  onShow() {
    this.checkPermissionAndLoad()
  },

  /** 角色切换回调 */
  onRoleChange() {
    wx.showToast({ title:'请退出后使用另一个账号登录', icon:'none' })
  }

  /** 核心角色死锁检验与日志加载 */
  checkPermissionAndLoad() {
    const app = getApp()
    const user = app && app.globalData && app.globalData.currentUser
    if (!user || !wx.getStorageSync('auth_token')) {
      wx.reLaunch({ url: '/pages/login/index' })
      return
    }

    const isSuperAdmin = user && user.role === 'super_admin'

    if (!isSuperAdmin) {
      this.setData({
        currentUser: user,
        isSuperAdmin: false,
        logs: [],
        logCount: 0
      })
      return
    }

    this.setData({
      currentUser: user,
      isSuperAdmin: true
    }, () => {
      this.loadAuditLogs()
    })
  },

  /** 格式化日期时间 */
  formatDate(isoStr) {
    if (!isoStr) return '--'
    try {
      const d = new Date(isoStr)
      if (isNaN(d.getTime())) return isoStr
      const pad = (n) => (n < 10 ? '0' + n : n)
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    } catch (e) {
      return isoStr
    }
  },

  /** 格式化 JSON 快照展示 */
  formatSnapshot(val) {
    if (!val) return '（无快照 / 初始状态）'
    if (typeof val === 'string') {
      try {
        const obj = JSON.parse(val)
        return JSON.stringify(obj, null, 2)
      } catch (e) {
        return val
      }
    }
    return JSON.stringify(val, null, 2)
  },

  /** 读取所有审计日志并倒序排序 */
  loadAuditLogs() {
    const rawLogs = db.getTable(db.TABLES.AUDIT_LOGS) || []

    const logs = rawLogs.map(item => {
      let actionTagClass = 'action-default'
      if (item.action === 'INSERT') actionTagClass = 'action-insert'
      if (item.action === 'UPDATE') actionTagClass = 'action-update'
      if (item.action === 'REMOVE') actionTagClass = 'action-remove'
      if (item.action === 'INIT')   actionTagClass = 'action-init'

      return Object.assign({}, item, {
        actionTagClass,
        formattedTime: this.formatDate(item.action_time),
        beforeText: this.formatSnapshot(item.before_snapshot_json),
        afterText: this.formatSnapshot(item.after_snapshot_json)
      })
    })

    // 按时间倒序展示
    logs.sort((a, b) => new Date(b.action_time || 0) - new Date(a.action_time || 0))

    this.setData({
      logs,
      logCount: logs.length
    })
  },

  /** 尝试删除/篡改此日志（测试底层防线拦截） */
  onTestTamper(e) {
    const id = e.currentTarget.dataset.id
    const item = this.data.logs.find(l => l.id === id)
    if (!item) return

    wx.showModal({
      title: '⚠️ 篡改测试确认',
      content: `您将作为超级管理员发起代码级删除操作：\n尝试删除日志 #${item.id} (${item.description || item.action})。\n\n是否立即触发底层安全检验？`,
      confirmText: '执行删除',
      confirmColor: '#dc2626',
      success: (res) => {
        if (res.confirm) {
          try {
            // 故意调用底层 remove 尝试删除 audit_logs
            db.remove(db.TABLES.AUDIT_LOGS, item.id, '恶意删除测试尝试')

            // 若未报错抛错，说明底层防线被穿透（严重安全漏洞）
            wx.showModal({
              title: '🚨 致命漏洞警告',
              content: '底层拦截器失效！日志被意外删除，请立即修复 db.js！',
              showCancel: false
            })
          } catch (err) {
            // 成功捕获到 db.js 抛出的防线拦截异常
            wx.showModal({
              title: '🛡️ 底层安全铁律拦截成功！',
              content: `核心引擎抛出底层防御异常：\n\n【${err.message}】\n\n经系统验证：即使当前登录身份为超级管理员/合伙人，任何对操作审计底册的修改或删除指令均被底层引擎强行熔断拦截！`,
              showCancel: false,
              confirmText: '验证完毕',
              confirmColor: '#16a34a'
            })
          }
        }
      }
    })
  },

  /** 返回首页 */
  onBackHome() {
    wx.navigateBack({
      fail: () => {
        wx.reLaunch({ url: '/pages/index/index' })
      }
    })
  }
})

// app.js
const db = require('./services/db')

App({
  onLaunch() {
    // 初始化本地日志（模版默认行为保留）
    const logs = wx.getStorageSync('logs') || []
    logs.unshift(Date.now())
    wx.setStorageSync('logs', logs)

    // 初始化数据库种子数据，并与后端服务实时同步
    db.initDatabase()
    db.startAutoSync(3000)

    // 默认把第一个超管设为 currentUser
    const users = db.getTable(db.TABLES.USERS)
    const superAdmin = users.find(u => u.role === 'super_admin')
    if (superAdmin) {
      this.globalData.currentUser = superAdmin
    }
  },

  globalData: {
    currentUser: null  // 当前登录用户对象 { id, name, role, ... }
  }
})

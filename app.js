const db = require('./services/db')

App({
  onLaunch() {
    const logs = wx.getStorageSync('logs') || []
    logs.unshift(Date.now())
    wx.setStorageSync('logs', logs)

    // Local sample data is for development only. Never bootstrap a super-admin identity.
    db.initDatabase()
    wx.removeStorageSync('current_user')
    this.globalData.currentUser = null

    const token = wx.getStorageSync('auth_token')
    if (!token) return
    wx.request({
      url: db.SERVER_API_BASE + '/api/auth/me',
      method: 'GET',
      header: { Authorization: 'Bearer ' + token },
      timeout: 4000,
      success: (res) => {
        const user = res.data && res.data.data && res.data.data.user
        if (res.statusCode !== 200 || !user ||
            !['super_admin', 'admin'].includes(user.role)) {
          wx.removeStorageSync('auth_token')
          this.globalData.currentUser = null
          return
        }
        this.globalData.currentUser = user
        db.syncFromServer()
      },
      fail: () => { this.globalData.currentUser = null }
    })
  },

  globalData: {
    currentUser: null
  }
})

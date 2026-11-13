const commands = require('./services/commandClient')
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
            !['super_admin', 'admin', 'teacher'].includes(user.role)) {
          wx.removeStorageSync('auth_token')
          this.globalData.currentUser = null
          return
        }
        this.globalData.currentUser = user
        commands.refresh().catch(() => {})
      },
      fail: () => { this.globalData.currentUser = null }
    })
  },

  onShow() {
    commands.startSync(() => {
      if(this._syncPrompt) return
      this._syncPrompt=true
      wx.showModal({title:'数据有更新',content:'其他设备已更新数据。现在刷新当前页面？未提交的填写需要重新核对。',confirmText:'刷新',success:async answer=>{
        try {
          if(answer.confirm) {
            await commands.refresh()
            const pages=getCurrentPages(); const page=pages[pages.length-1]
            if(page && page.onShow) await page.onShow()
          }
        } catch(error) { wx.showToast({title:'刷新失败，请稍后重试',icon:'none'}) }
        finally {this._syncPrompt=false}
      },fail:()=>{this._syncPrompt=false}})
    })
  },
  onHide() { commands.stopSync() },

  globalData: {
    currentUser: null
  }
})


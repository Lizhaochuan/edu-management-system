const commands = require('../../services/commandClient')
const db = require('../../services/db')

Page({
  data: {
    userId: '',
    password: '',
    busy: false,
    errorMessage: ''
  },
  onLoad() {
    const token = wx.getStorageSync('auth_token')
    if (!token) return
    wx.request({
      url: db.SERVER_API_BASE + '/api/auth/me',
      method: 'GET',
      timeout: 3500,
      header: { Authorization: 'Bearer ' + token },
      success: res => {
        const user = res.data && res.data.data && res.data.data.user
        if (res.statusCode === 200 && user &&
            ['admin','super_admin','teacher'].includes(user.role)) {
          getApp().globalData.currentUser = user
          commands.refresh().catch(() => {})
          wx.reLaunch({ url: '/pages/index/index' })
        } else {
          wx.removeStorageSync('auth_token')
        }
      }
    })
  },
  onUserIdInput(e) { this.setData({ userId: e.detail.value }) },
  onPasswordInput(e) { this.setData({ password: e.detail.value }) },
  onLogin() {
    if (this.data.busy) return
    const userId = this.data.userId.trim()
    const password = this.data.password
    if (!userId || !password) {
      this.setData({ errorMessage: '请输入用户ID和密码' })
      return
    }
    this.setData({ busy: true, errorMessage: '' })
    wx.request({
      url: db.SERVER_API_BASE + '/api/auth/login',
      method: 'POST',
      timeout: 7000,
      header: { 'Content-Type': 'application/json' },
      data: { user_id: userId, password },
      success: res => {
        const data = res.data && res.data.data
        if (res.statusCode !== 200 || !data || !data.token || !data.user) {
          this.setData({ errorMessage: (res.data && res.data.message) || '登录失败' })
          return
        }
        if (!['admin','super_admin','teacher'].includes(data.user.role)) {
          this.setData({ errorMessage: '家长端尚未开放，请使用已授权的教务或教师账号' })
          return
        }
        wx.setStorageSync('auth_token', data.token)
        getApp().globalData.currentUser = data.user
        this.setData({ password: '' })
        commands.refresh().catch(() => {})
        wx.reLaunch({ url: '/pages/index/index' })
      },
      fail: () => this.setData({ errorMessage: '无法连接后端。请检查开发服务器地址与网络配置。' }),
      complete: () => this.setData({ busy: false })
    })
  }
})


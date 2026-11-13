// Deprecated role-switcher: identity is read-only and comes from server login.
// Kept temporarily to preserve compatibility with older WeChat page manifests.
Component({
  properties: {
    activeUserId: { type:String, value:'' }
  },
  data: {
    users: [],
    userOptions: [],
    currentUserId: '',
    currentUser: null,
    pickerIndex: 0
  },
  lifetimes: {
    attached() { this.initUsers() }
  },
  pageLifetimes: {
    show() { this.initUsers() }
  },
  methods: {
    initUsers() {
      const app = getApp()
      const user = app && app.globalData && app.globalData.currentUser
      if (!user || !wx.getStorageSync('auth_token')) {
        this.setData({ users:[], userOptions:[], currentUserId:'', currentUser:null, pickerIndex:0 })
        return
      }
      this.setData({
        users:[user],
        userOptions:[{ id:user.id, label:user.name }],
        currentUserId:user.id,
        currentUser:user,
        pickerIndex:0
      })
    },
    onSelectUser() {
      wx.showToast({ title:'请退出后使用其他账号登录', icon:'none' })
    },
    onPickerChange() {
      wx.showToast({ title:'请退出后使用其他账号登录', icon:'none' })
    },
    switchUserById(id) {
      // No client-side identity changes, even when invoked programmatically.
      const app = getApp()
      const user = app && app.globalData && app.globalData.currentUser
      if (user && id === user.id) this.initUsers()
    }
  }
})

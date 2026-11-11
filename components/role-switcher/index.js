// components/role-switcher/index.js
const db = require('../../services/db')

const ROLE_NAME_MAP = {
  super_admin: '超管合伙人',
  admin: '教务管理',
  teacher: '授课教师',
  parent: '学员家长',
  guest: '待分配身份'
}

Component({
  properties: {
    // 外部传入指定的当前用户 ID（可选）
    activeUserId: {
      type: String,
      value: '',
      observer(newVal) {
        if (newVal && newVal !== this.data.currentUserId) {
          this.switchUserById(newVal, false)
        }
      }
    }
  },

  data: {
    users: [],
    userOptions: [],
    currentUserId: '',
    currentUser: null,
    pickerIndex: 0,
    roleNameMap: ROLE_NAME_MAP
  },

  lifetimes: {
    attached() {
      this.initUsers()
    }
  },

  pageLifetimes: {
    show() {
      this.initUsers()
    }
  },

  methods: {
    initUsers() {
      const rawUsers = db.getTable(db.TABLES.USERS) || []
      const app = getApp()
      const current = (app && app.globalData && app.globalData.currentUser) ||
                      wx.getStorageSync('current_user') ||
                      rawUsers[0] ||
                      null

      const users = rawUsers.map(u => {
        let avatarText = u.name ? u.name.slice(-2) : '用户'
        let subDesc = ''
        if (u.role === 'teacher') {
          subDesc = u.is_custom_rate ? '特聘阶梯' : (u.teacher_tier_id === 'tier_senior' ? '高级档' : '初级档')
        } else if (u.role === 'super_admin') {
          subDesc = '合伙人'
        } else if (u.role === 'admin') {
          subDesc = '教务/财务'
        } else if (u.role === 'parent') {
          subDesc = '家校通'
        } else if (u.role === 'guest') {
          subDesc = '待授权'
        }

        return Object.assign({}, u, {
          avatarText,
          subDesc
        })
      })

      const userOptions = users.map(u => ({
        id: u.id,
        label: `[${ROLE_NAME_MAP[u.role] || u.role}] ${u.name}`
      }))

      const currentUserId = current ? current.id : (users[0] ? users[0].id : '')
      const pickerIndex = Math.max(0, users.findIndex(u => u.id === currentUserId))

      this.setData({
        users,
        userOptions,
        currentUserId,
        currentUser: current,
        pickerIndex
      })
    },

    onSelectUser(e) {
      const id = e.currentTarget.dataset.id
      this.switchUserById(id, true)
    },

    onPickerChange(e) {
      const index = Number(e.detail.value)
      const user = this.data.users[index]
      if (user) {
        this.switchUserById(user.id, true)
      }
    },

    switchUserById(id, notify = true) {
      const target = this.data.users.find(u => u.id === id)
      if (!target) return

      const app = getApp()
      if (app && app.globalData) {
        app.globalData.currentUser = target
      }
      wx.setStorageSync('current_user', target)

      const pickerIndex = this.data.users.findIndex(u => u.id === id)
      this.setData({
        currentUserId: id,
        currentUser: target,
        pickerIndex
      })

      if (notify) {
        this.triggerEvent('rolechange', { user: target })
        wx.showToast({
          title: `已切换为：${target.name}`,
          icon: 'none',
          duration: 1500
        })
      }
    }
  }
})

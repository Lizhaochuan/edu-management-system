const commands = require('../../services/commandClient')
// pages/salary/index.js
// 教师课酬与薪资结算中心（Phase 4-C 结算单锁定、算错调账审批与脱敏校验）
const db = require('../../services/db')
const salaryEngineService = require('../../services/salaryEngineService')

const app = getApp()

Page({
  data: {
    currentUser: null,
    isTeacher: false,
    canManageSalary: false,
    salaryActionBusy: false,
    currentTab: 'settlement', // 'settlement' | 'adjustment' | 'fees'

    selectedMonth: '2026-03',
    teacherList: [],
    teacherListNoAll: [],
    teacherIndex: 0,
    adjTeacherIndex: 0,

    // 统计概览
    summary: {
      totalDisbursed: 0,
      settledCount: 0,
      draftCount: 0,
      pendingAdjCount: 0
    },

    // 列表数据
    settlements: [],
    adjustments: [],
    feesList: [],

    // 调账表单模态窗
    showAdjModal: false,
    adjForm: {
      teacher_id: '',
      direction: 'reissue', // 'reissue' | 'clawback'
      amount: '',
      reason: ''
    },

    // 结算单明细快照模态窗
    showDetailModal: false,
    selectedSettlement: null
  },

  onLoad() {
    this.initUserAndTeachers()
  },

  async onShow() {
    try { await commands.refresh(); await commands.recoverPending() } catch (err) { wx.showModal({title:"读取失败",content:err.message,showCancel:false}); return }
    this.refreshAllData()
  },

  /** 初始化当前用户与教师选项 */
  initUserAndTeachers() {
    const user = app && app.globalData && app.globalData.currentUser
    if (!user || !wx.getStorageSync('auth_token')) {
      wx.reLaunch({ url: '/pages/login/index' })
      return
    }

    const allUsers = db.getTable(db.TABLES.USERS) || []
    const teachers = allUsers.filter(u => u.role === 'teacher' && u.status === 'active')

    const teacherList = [{ id: '', name: '全部老师' }, ...teachers]
    const isTeacher = user.role === 'teacher'

    let teacherIndex = 0
    if (isTeacher) {
      const idx = teacherList.findIndex(t => t.id === user.id)
      teacherIndex = idx > -1 ? idx : 0
    }

    this.setData({
      currentUser: user,
      isTeacher: isTeacher,
      canManageSalary: user.role === 'super_admin',
      teacherList: teacherList,
      teacherListNoAll: teachers,
      teacherIndex: teacherIndex,
      'adjForm.teacher_id': teachers[0] ? teachers[0].id : ''
    }, () => {
      this.refreshAllData()
    })
  },

  /** 角色切换回调 */
  onRoleChange() {
    wx.showToast({ title:'请退出后使用另一个账号登录', icon:'none' })
  },

  /** Tab 切换 */
  switchTab(e) {
    const tab = e.currentTarget.dataset.tab
    this.setData({ currentTab: tab })
  },

  /** 周期月份切换 */
  onMonthChange(e) {
    this.setData({ selectedMonth: e.detail.value }, () => {
      this.refreshAllData()
    })
  },

  /** 教师筛选切换 */
  onTeacherChange(e) {
    if (this.data.isTeacher) return // 教师不能切换其他人
    this.setData({ teacherIndex: Number(e.detail.value) }, () => {
      this.refreshAllData()
    })
  },

  /** 刷新页面全部数据 */
  refreshAllData() {
    this.loadSettlements()
    this.loadAdjustments()
    this.loadFeesList()
  },

  /** 加载薪资结算单列表 */
  loadSettlements() {
    const { currentUser, isTeacher, teacherList, teacherIndex, selectedMonth } = this.data
    const targetTeacherId = isTeacher ? currentUser.id : (teacherList[teacherIndex] ? teacherList[teacherIndex].id : null)

    try {
      const list = salaryEngineService.getTeacherSettlements(
        targetTeacherId,
        { period: selectedMonth },
        currentUser
      )

      let totalDisbursed = 0
      let settledCount = 0
      let draftCount = 0

      const enriched = list.map(item => {
        if (item.status === 'settled') {
          totalDisbursed += Number(item.total_salary || 0)
          settledCount++
        } else {
          draftCount++
        }

        return Object.assign({}, item, {
          settled_at_short: item.settled_at ? item.settled_at.replace('T', ' ').slice(0, 16) : ''
        })
      })

      this.setData({
        settlements: enriched,
        'summary.totalDisbursed': totalDisbursed,
        'summary.settledCount': settledCount,
        'summary.draftCount': draftCount
      })
    } catch (err) {
      console.warn('[salary] loadSettlements failed:', err)
    }
  },

  /** 加载调账记录列表 */
  loadAdjustments() {
    const { currentUser, isTeacher, teacherList, teacherIndex } = this.data
    const targetTeacherId = isTeacher ? currentUser.id : (teacherList[teacherIndex] ? teacherList[teacherIndex].id : null)

    try {
      const list = salaryEngineService.getSalaryAdjustments(
        { teacher_id: targetTeacherId },
        currentUser
      )

      let pendingAdjCount = 0
      const enriched = list.map(item => {
        if (item.status === 'approved_pending_settlement') {
          pendingAdjCount++
        }

        let statusText = '待审批'
        let statusBadgeClass = 'badge-draft'
        if (item.status === 'pending_super_admin_approval') {
          statusText = '⏳ 待超管审批'
          statusBadgeClass = 'badge-draft'
        } else if (item.status === 'approved_pending_settlement') {
          statusText = '✅ 已批准·待下期结算'
          statusBadgeClass = 'badge-settled'
        } else if (item.status === 'settled') {
          statusText = '🔒 已结清(随结算单)'
          statusBadgeClass = 'badge-settled'
        } else if (item.status === 'rejected') {
          statusText = '❌ 已驳回'
          statusBadgeClass = 'badge-rejected'
        }

        return Object.assign({}, item, {
          statusText,
          statusBadgeClass,
          created_at_short: item.created_at ? item.created_at.slice(0, 10) : ''
        })
      })

      this.setData({
        adjustments: enriched,
        'summary.pendingAdjCount': pendingAdjCount
      })
    } catch (err) {
      console.warn('[salary] loadAdjustments failed:', err)
    }
  },

  /** 加载课酬明细台账 */
  loadFeesList() {
    const { currentUser, isTeacher, teacherList, teacherIndex, selectedMonth } = this.data
    const targetTeacherId = isTeacher ? currentUser.id : (teacherList[teacherIndex] ? teacherList[teacherIndex].id : null)

    try {
      const list = salaryEngineService.getTeacherLessonFees({
        teacher_id: targetTeacherId,
        start_date: `${selectedMonth}-01`,
        end_date: `${selectedMonth}-31`
      })

      const enriched = list.map(item => {
        let typeTitle = '正常课酬'
        let tagClass = 'tag-regular'

        if (item.fee_type === 'original_class_makeup_diff') {
          typeTitle = '原班累进补差'
          tagClass = 'tag-diff'
        } else if (item.is_substitute) {
          typeTitle = '代课课酬'
          tagClass = 'tag-substitute'
        }

        return Object.assign({}, item, {
          typeTitle,
          tagClass
        })
      })

      this.setData({ feesList: enriched })
    } catch (err) {
      console.warn('[salary] loadFeesList failed:', err)
    }
  },

  /** 服务端统一命令生成薪资草稿；批量模式遇到首个失败立即停止，避免不确定请求被换键重发。 */
  async onGenerateSettlement() {
    const { teacherList, teacherIndex, selectedMonth, currentUser } = this.data
    if (!currentUser || currentUser.role !== 'super_admin' || this.data.salaryActionBusy) {
      wx.showToast({title:'仅超级管理员可生成薪资结算单',icon:'none'})
      return
    }
    const selectedTeacher=teacherList[teacherIndex]
    const targets=selectedTeacher && selectedTeacher.id
      ? [selectedTeacher] : this.data.teacherListNoAll
    if (!targets.length) {
      wx.showToast({title:'暂无老师',icon:'none'})
      return
    }
    this.setData({salaryActionBusy:true})
    let successCount=0
    wx.showLoading({title:'正在提交服务端...'})
    try {
      // Commands enforce one draft per teacher/period and persist original retry envelopes.
      for (const teacher of targets) {
        await commands.run('salary.generate',{teacher_id:teacher.id,period:selectedMonth})
        successCount++
      }
      this.refreshAllData()
      wx.showToast({title:'已生成'+successCount+'份草稿',icon:'none'})
    } catch (err) {
      this.refreshAllData()
      wx.showModal({title:'薪资生成中断',content:'已生成'+successCount+'份；'+
        (err.message||'请检查服务器状态，勿重新发起不确定请求'),showCancel:false})
    } finally {
      wx.hideLoading()
      this.setData({salaryActionBusy:false})
    }
  },

  /** 服务器确认锁定单笔结算；禁止直接修改小程序本地薪资表。 */
  onSettleConfirm(e) {
    if (!this.data.currentUser || this.data.currentUser.role !== 'super_admin' ||
        this.data.salaryActionBusy) {
      wx.showToast({title:'仅超级管理员可确认结算',icon:'none'})
      return
    }
    const id=e.currentTarget.dataset.id
    const settlement=this.data.settlements.find(s=>s.id===id)
    if (!settlement || settlement.status !== 'draft') return
    wx.showModal({
      title:'确认结算并锁死该账单？',
      content:'老师：'+settlement.teacher_name+'，周期：'+settlement.period+
        '，总课酬：¥'+settlement.total_salary+
        '。确认后不可直接修改，若有错误需走审批调账。请先核实明细。',
      confirmColor:'#10b981',
      confirmText:'确认锁定',
      success:async res=>{
        if (!res.confirm || this.data.salaryActionBusy) return
        this.setData({salaryActionBusy:true})
        wx.showLoading({title:'服务端结算中...'})
        try {
          await commands.run('salary.settle',{settlement_id:id})
          this.refreshAllData()
          wx.showToast({title:'结算已锁定',icon:'none'})
        } catch (err) {
          wx.showModal({title:'结算未确认',content:err.message||'请核查服务端结果',
            showCancel:false})
        } finally {
          wx.hideLoading()
          this.setData({salaryActionBusy:false})
        }
      }
    })
  },

  /** 查看结算单明细快照 */
  onViewSettlementDetail(e) {
    const id = e.currentTarget.dataset.id
    const settlement = this.data.settlements.find(s => s.id === id)
    if (!settlement) return

    this.setData({
      selectedSettlement: settlement,
      showDetailModal: true
    })
  },

  closeDetailModal() {
    this.setData({
      showDetailModal: false,
      selectedSettlement: null
    })
  },

  /** 打开调账申请模态框 */
  openCreateAdjustmentModal() {
    const defaultTid = this.data.teacherListNoAll[0] ? this.data.teacherListNoAll[0].id : ''
    this.setData({
      showAdjModal: true,
      adjTeacherIndex: 0,
      adjForm: {
        teacher_id: defaultTid,
        direction: 'reissue',
        amount: '',
        reason: ''
      }
    })
  },

  closeAdjModal() {
    this.setData({ showAdjModal: false })
  },

  onAdjTeacherChange(e) {
    const idx = Number(e.detail.value)
    const teacher = this.data.teacherListNoAll[idx]
    this.setData({
      adjTeacherIndex: idx,
      'adjForm.teacher_id': teacher ? teacher.id : ''
    })
  },

  onAdjDirectionChange(e) {
    this.setData({
      'adjForm.direction': e.detail.value
    })
  },

  onAdjAmountInput(e) {
    this.setData({
      'adjForm.amount': e.detail.value
    })
  },

  onAdjReasonInput(e) {
    this.setData({
      'adjForm.reason': e.detail.value
    })
  },

  /** 提交薪资调账申请 */
  async submitSalaryAdjustment() {
    const { adjForm, currentUser } = this.data

    if (!adjForm.teacher_id) {
      wx.showToast({ title: '请选择调账老师', icon: 'none' })
      return
    }

    const amount = parseFloat(adjForm.amount)
    if (isNaN(amount) || amount <= 0) {
      wx.showToast({ title: '请输入大于0的有效金额', icon: 'none' })
      return
    }

    if (!adjForm.reason || !adjForm.reason.trim()) {
      wx.showToast({ title: '必须填写调账详细原因', icon: 'none' })
      return
    }

    try {
      await salaryEngineService.createSalaryAdjustment({
        teacher_id: adjForm.teacher_id,
        direction: adjForm.direction,
        amount: amount,
        reason: adjForm.reason.trim()
      }, currentUser)

      wx.showToast({
        title: '已提交超管审批',
        icon: 'success'
      })

      this.closeAdjModal()
      this.refreshAllData()
    } catch (err) {
      wx.showModal({
        title: '提交失败',
        content: err.message || '未知错误',
        showCancel: false
      })
    }
  },

  /** 跳转至审批中心 */
  gotoApprovalPage() {
    wx.navigateTo({
      url: '/pages/approval/index'
    })
  }
})


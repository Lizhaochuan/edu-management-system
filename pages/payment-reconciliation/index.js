// Payment reconciliation page: only server-authorized commands change financial state.
const commands = require('../../services/commandClient')
const db = require('../../services/db')
const REF = /^[A-Za-z0-9_-]{1,100}$/

function listPayments() {
  return new Promise((resolve, reject) => {
    const token = wx.getStorageSync('auth_token')
    wx.request({
      url: db.SERVER_API_BASE + '/api/payments/reconciliation',
      method: 'GET',
      header: { Authorization: 'Bearer ' + token },
      timeout: 10000,
      success(res) {
        if (token !== wx.getStorageSync('auth_token')) return reject(new Error('登录身份已变化，请重新读取'))
        if (res.statusCode === 200 && res.data && res.data.code === 0) resolve(res.data.data)
        else reject(new Error((res.data && res.data.message) || '读取收款记录失败'))
      },
      fail() { reject(new Error('网络异常，请重新读取')) }
    })
  })
}
Page({
  data: {
    role:'', isSuperAdmin:false, busy:false, strictMode:false,
    students:[], courses:[], terms:[], receipts:[],
    studentIndex:0, courseIndex:0, termIndex:0,
    paymentReference:'', amount:'', accountDestination:'进入公账',
    statementReference:'', rejectReason:'',
    selectedReceipt:null, paidHours:'', giftHours:'0'
  },
  async onShow() {
    const user = getApp().globalData.currentUser
    if (!user || !['admin','super_admin'].includes(user.role)) {
      wx.reLaunch({url:'/pages/login/index'})
      return
    }
    this.setData({role:user.role,isSuperAdmin:user.role==='super_admin'})
    try {
      await commands.refresh()
      await commands.recoverPending()
      this.setData({
        students:db.getTable(db.TABLES.STUDENTS),
        courses:db.getTable(db.TABLES.COURSES_AND_CLASS_TYPES),
        terms:db.getTable(db.TABLES.TERMS)
      })
      await this.loadReceipts()
    } catch (error) { this.report(error) }
  },
  async loadReceipts() {
    const result = await listPayments()
    // A new login must not reuse a response from an old session.
    if (!wx.getStorageSync('auth_token')) return
    const previous = this.data.selectedReceipt
    this.setData({receipts:result.items,strictMode:result.strict_mode,
      selectedReceipt:previous ? (result.items.find(r=>r.receipt_id===previous.receipt_id)||null) : null})
  },
  onPickStudent(event) { this.setData({studentIndex:Number(event.detail.value)}) },
  onPickCourse(event) { this.setData({courseIndex:Number(event.detail.value)}) },
  onPickTerm(event) { this.setData({termIndex:Number(event.detail.value)}) },
  onInput(event) { this.setData({[event.currentTarget.dataset.field]:event.detail.value}) },
  onDestination(event) { this.setData({accountDestination:event.currentTarget.dataset.value}) },
  report(error) { wx.showModal({title:'操作未完成',content:error.message || String(error),showCancel:false}) },
  async perform(command, params, success) {
    if (this.data.busy) return
    this.setData({busy:true})
    try {
      await commands.run(command,params)
      await this.loadReceipts()
      wx.showToast({title:success,icon:'none'})
    } catch (error) { this.report(error) }
    finally { this.setData({busy:false}) }
  },
  submitPayment() {
    const p=this.data, student=p.students[p.studentIndex], course=p.courses[p.courseIndex]
    const amount=Number(p.amount)
    if (!student || !course || !REF.test(p.paymentReference.trim()) ||
        !Number.isFinite(amount) || amount <= 0 || !/^\d+(\.\d{1,2})?$/.test(p.amount.trim())) {
      return this.report(new Error('请选择学员和课程，填写有效付款凭据及最多两位小数的金额'))
    }
    this.perform('payment.submit',{
      payment_reference:p.paymentReference.trim(), student_id:student.id,
      course_id:course.id, amount, account_destination:p.accountDestination
    },'已提交，等待另一名超级管理员人工核对')
  },
  selectReceipt(event) {
    const row=this.data.receipts.find(r=>r.receipt_id===event.currentTarget.dataset.id)
    if (!row) return
    const studentIndex=this.data.students.findIndex(s=>s.id===row.student_id)
    const courseIndex=this.data.courses.findIndex(c=>c.id===row.course_id)
    this.setData({selectedReceipt:row,paymentReference:row.payment_reference,
      amount:String(row.amount_cents/100), accountDestination:row.account_destination,
      studentIndex:studentIndex<0?0:studentIndex,
      courseIndex:courseIndex<0?0:courseIndex,statementReference:'',rejectReason:''})
  },
  confirmReceipt() {
    const row=this.data.selectedReceipt, reference=this.data.statementReference.trim()
    if (!this.data.isSuperAdmin || !row || row.status!=='pending' ||
        row.submitted_by===getApp().globalData.currentUser.id || !REF.test(reference))
      return this.report(new Error('请选中待核对收款并填写官方账单流水号'))
    wx.showModal({
      title:'人工到账确认',
      content:'请先在官方银行或支付平台核对金额、账户、付款人及实际入账。系统不能自动查证，是否确认已核对？',
      success:res=>{if(res.confirm)this.perform('payment.confirm',{
        payment_reference:row.payment_reference,statement_reference:reference
      },'已登记人工核对；请继续购课入账')}
    })
  },
  rejectReceipt() {
    const row=this.data.selectedReceipt, reason=this.data.rejectReason.trim()
    if (!this.data.isSuperAdmin || !row || row.status!=='pending' ||
        row.submitted_by===getApp().globalData.currentUser.id || !reason)
      return this.report(new Error('请选择待核对收款并填写拒绝理由'))
    this.perform('payment.reject',{payment_reference:row.payment_reference,reason},'已拒绝此收款登记')
  },
  purchase() {
    const p=this.data, row=p.selectedReceipt, term=p.terms[p.termIndex]
    const paid=Number(p.paidHours),gift=Number(p.giftHours)
    if (!row || row.status!=='confirmed' || !term ||
        !Number.isFinite(paid) || paid<=0 || !Number.isFinite(gift) || gift<0 ||
        !/^\d+(\.\d{1,2})?$/.test(String(p.paidHours)) ||
        !/^\d+(\.\d{1,2})?$/.test(String(p.giftHours))) {
      return this.report(new Error('请选择已人工确认的收款，选择学期并填写付费/赠送课时'))
    }
    wx.showModal({
      title:'购课入账确认',
      content:'将按已核对记录的学员、课程、金额和账户创建课时包，并冲抵已有欠课。请确认。',
      success:res=>{if(res.confirm)this.perform('package.purchase',{
        payment_reference:row.payment_reference,
        student_id:row.student_id,course_id:row.course_id,
        total_amount:row.amount_cents/100,account_destination:row.account_destination,
        paid_hours_total:paid,gift_hours_total:gift,term_id:term.id
      },'购课已入账，请返回课时包账本核对')}
    })
  }
})

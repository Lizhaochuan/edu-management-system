// pages/attendance/index.js
// 课堂点名签到、24H改签、排课异动、代课流转、缺勤补课与累进补差（Phase 2 ~ Phase 4）
const attendanceService = require('../../services/attendanceService')
const salaryEngineService = require('../../services/salaryEngineService')
const db = require('../../services/db')

Page({
  data: {
    currentUser: null,
    isTeacher: false,
    isAdmin: false, // super_admin 或 admin 拥有安排代课、客诉处理与取消课程权限
    schedules: [],
    selectedScheduleId: '',
    selectedSchedule: null,
    sheetData: null,
    scheduleDiffFees: [], // Phase 4-B: 原班累进补差明细列表

    // 点名考勤表状态：{ [student_id]: { is_present, is_late, is_early_leave, is_trial } }
    attendanceMap: {},

    // 实时人头核算预览
    stats: {
      formalPresentCount: 0,
      trialPresentCount: 0,
      absentCount: 0,
      hoursPerLesson: 1.5,
      maxCapacity: 3
    },

    // 提交成功或改签成功后的不可变快照展示
    lastSubmitResult: null,

    // 欠费即时预警弹框提示
    insufficientNotices: [],

    // 弹窗1：漏签补签申请弹窗
    showMakeupSignModal: false,
    makeupSignReason: '下课后教具整理匆忙漏点提交，现申请补录出勤',

    // 弹窗2：Phase 3-A 管理员取消单节排课弹窗
    showCancelLessonModal: false,
    cancelTargetSchedule: null,
    cancelForm: {
      reason: '暴雨恶劣天气停课通知',
      handle_mode: 'individual_makeup' // 'individual_makeup' (选项A) | 'postpone_entire_class' (选项B)
    },

    // 弹窗3：Phase 3-B 管理员安排代课弹窗
    showSubstituteModal: false,
    availableTeachers: [],
    substituteForm: {
      teacher_index: 0,
      teacher_id: '',
      reason: '教师临时事务调休，特指派代课'
    },

    // 弹窗4：Phase 3-B 代课客诉登记与个案处理弹窗
    showComplaintModal: false,
    scheduleComplaints: [], // 当前课次的客诉记录列表
    complaintForm: {
      student_index: 0,
      student_id: '',
      complaint_reason: '家长反映代课老师教学节奏偏快，孩子理解不透彻',
      decision: '退还当节课时', // '安排重上一节' | '退还当节课时' | '不予处理'
      decision_reason: '经教务核实教学反馈属实，为保障满意度予以全额退还当节课时'
    },

    // ── 弹窗 5：Phase 3-C 缺勤补课预约弹窗（三种补课路径） ──
    showMakeupModal: false,
    eligibleSelfSchedules: [], // 原老师名下同课程同课时未满封顶可选课次
    makeupForm: {
      student_id: '',
      student_name: '',
      hours_needed: 1.5,
      makeup_type: 'same_teacher', // 'same_teacher' (自己补) | 'cross_teacher' (跨师补) | 'waived' (不补)
      sub_mode: 'mount_existing',  // 'mount_existing' (挂入其他课次) | 'new_solo' (新建单独补课)
      target_schedule_index: 0,
      target_schedule_id: '',
      solo_date: '',
      solo_start_time: '16:00',
      solo_end_time: '17:30',
      remarks: ''
    },

    // ── 弹窗 6：Phase 3-C 管理员跨师补课安排弹窗 ──
    showAdminAssignModal: false,
    pendingMakeupRequests: [], // 待管理员协调安排的跨师工单
    eligibleCrossSchedules: [], // 跨师可选课次（同课程同课时未满封顶）
    adminAssignForm: {
      request_id: '',
      student_name: '',
      mode: 'mount_existing', // 'mount_existing' | 'new_solo'
      target_schedule_index: 0,
      target_schedule_id: '',
      teacher_index: 0,
      teacher_id: '',
      solo_date: '',
      solo_start_time: '16:00',
      solo_end_time: '17:30'
    }
  },

  onLoad(options) {
    this.initData(options && options.schedule_id)
  },

  onShow() {
    this.initData()
  },

  onRoleChange() {
    wx.showToast({ title:'请退出后使用另一个账号登录', icon:'none' })
  },

  initData(targetScheduleId) {
    const app = getApp()
    const user = app && app.globalData && app.globalData.currentUser
    if (!user || !wx.getStorageSync('auth_token')) {
      wx.reLaunch({ url: '/pages/login/index' })
      return
    }

    const isTeacher = user && user.role === 'teacher'
    const isAdmin = user && (user.role === 'admin' || user.role === 'super_admin')

    // 获取在职教师列表（排除离职）
    const availableTeachers = attendanceService.getAvailableTeachersList()

    this.setData({
      currentUser: user,
      isTeacher,
      isAdmin,
      availableTeachers
    }, () => {
      this.loadSchedules(targetScheduleId)
    })
  },

  /** 加载日程列表 */
  loadSchedules(targetScheduleId) {
    const user = this.data.currentUser
    const schedules = attendanceService.getSchedulesList({}, user)

    let currentSelectedId = targetScheduleId || this.data.selectedScheduleId
    if (!currentSelectedId && schedules.length > 0) {
      const pendingOne = schedules.find(s => s.status === 'scheduled')
      currentSelectedId = pendingOne ? pendingOne.id : schedules[0].id
    }

    this.setData({
      schedules,
      selectedScheduleId: currentSelectedId
    }, () => {
      if (currentSelectedId) {
        this.loadScheduleDetail(currentSelectedId)
      }
    })
  },

  /** 切换排课日程 */
  onSelectSchedule(e) {
    const scheduleId = e.currentTarget.dataset.id
    if (scheduleId === this.data.selectedScheduleId) return
    this.setData({
      selectedScheduleId: scheduleId,
      lastSubmitResult: null
    }, () => {
      this.loadScheduleDetail(scheduleId)
    })
  },

  /** 加载具体排课签到表与客诉留档 */
  loadScheduleDetail(scheduleId) {
    if (!scheduleId) return
    const user = this.data.currentUser

    try {
      const sheet = attendanceService.getAttendanceSheet(scheduleId, user)

      const attendanceMap = {}
      let formalPresent = 0
      let trialPresent = 0
      let absent = 0

      sheet.students.forEach(stu => {
        const isPresent = stu.status === 'present'
        attendanceMap[stu.student_id] = {
          student_id: stu.student_id,
          name: stu.name,
          is_present: isPresent,
          is_late: !!stu.is_late,
          is_early_leave: !!stu.is_early_leave,
          is_trial: !!stu.is_trial
        }

        if (isPresent) {
          if (stu.is_trial) {
            trialPresent++
          } else {
            formalPresent++
          }
        } else {
          absent++
        }
      })

      const targetSchedule = this.data.schedules.find(s => s.id === scheduleId)
      // 读取该日程的代课客诉记录
      const complaints = attendanceService.getSubstituteComplaints({ schedule_id: scheduleId })
      // Phase 3-C: 读取待管理员处理的跨师补课工单列表
      const pendingMakeupRequests = attendanceService.getPendingMakeupRequests()
      // Phase 4-B: 读取与当前排课相关的原班累进补差记录
      const allFees = salaryEngineService.getTeacherLessonFees()
      const scheduleDiffFees = allFees.filter(f =>
        f.fee_type === 'original_class_makeup_diff' &&
        (f.schedule_id === scheduleId || f.original_absent_schedule_id === scheduleId) &&
        !f.is_revoked
      )

      this.setData({
        selectedSchedule: targetSchedule,
        sheetData: sheet,
        attendanceMap,
        scheduleComplaints: complaints,
        pendingMakeupRequests,
        scheduleDiffFees,
        stats: {
          formalPresentCount: formalPresent,
          trialPresentCount: trialPresent,
          absentCount: absent,
          hoursPerLesson: sheet.schedule.hours_per_lesson,
          maxCapacity: sheet.schedule.max_capacity
        }
      })
    } catch (err) {
      wx.showModal({
        title: '加载签到表失败',
        content: err.message,
        showCancel: false
      })
    }
  },

  // ─────────────────────────────────────────
  // 点名交互：点亮 / 熄灭 / 迟到 / 早退
  // ─────────────────────────────────────────

  onToggleStudentPresent(e) {
    if (this.data.sheetData && (this.data.sheetData.schedule.is_locked_after_24h || this.data.sheetData.schedule.status === 'cancelled')) {
      wx.showToast({ title: '当前课程不可更改点名', icon: 'none' })
      return
    }

    const stuId = e.currentTarget.dataset.id
    const currentRecord = this.data.attendanceMap[stuId]
    if (!currentRecord) return

    const nextPresent = !currentRecord.is_present
    const nextRecord = Object.assign({}, currentRecord, {
      is_present: nextPresent,
      is_late: nextPresent ? currentRecord.is_late : false,
      is_early_leave: nextPresent ? currentRecord.is_early_leave : false
    })

    const newMap = Object.assign({}, this.data.attendanceMap, {
      [stuId]: nextRecord
    })

    this.setData({
      attendanceMap: newMap
    }, () => {
      this.recomputeStats()
    })
  },

  onToggleLate(e) {
    if (this.data.sheetData && (this.data.sheetData.schedule.is_locked_after_24h || this.data.sheetData.schedule.status === 'cancelled')) return
    const stuId = e.currentTarget.dataset.id
    const currentRecord = this.data.attendanceMap[stuId]
    if (!currentRecord || !currentRecord.is_present) return

    const newMap = Object.assign({}, this.data.attendanceMap, {
      [stuId]: Object.assign({}, currentRecord, {
        is_late: !currentRecord.is_late
      })
    })

    this.setData({ attendanceMap: newMap })
  },

  onToggleEarlyLeave(e) {
    if (this.data.sheetData && (this.data.sheetData.schedule.is_locked_after_24h || this.data.sheetData.schedule.status === 'cancelled')) return
    const stuId = e.currentTarget.dataset.id
    const currentRecord = this.data.attendanceMap[stuId]
    if (!currentRecord || !currentRecord.is_present) return

    const newMap = Object.assign({}, this.data.attendanceMap, {
      [stuId]: Object.assign({}, currentRecord, {
        is_early_leave: !currentRecord.is_early_leave
      })
    })

    this.setData({ attendanceMap: newMap })
  },

  onSelectAllPresent() {
    if (this.data.sheetData && (this.data.sheetData.schedule.is_locked_after_24h || this.data.sheetData.schedule.status === 'cancelled')) return
    const newMap = Object.assign({}, this.data.attendanceMap)
    Object.keys(newMap).forEach(id => {
      newMap[id] = Object.assign({}, newMap[id], { is_present: true })
    })

    this.setData({ attendanceMap: newMap }, () => {
      this.recomputeStats()
    })
  },

  onSelectAllAbsent() {
    if (this.data.sheetData && (this.data.sheetData.schedule.is_locked_after_24h || this.data.sheetData.schedule.status === 'cancelled')) return
    const newMap = Object.assign({}, this.data.attendanceMap)
    Object.keys(newMap).forEach(id => {
      newMap[id] = Object.assign({}, newMap[id], {
        is_present: false,
        is_late: false,
        is_early_leave: false
      })
    })

    this.setData({ attendanceMap: newMap }, () => {
      this.recomputeStats()
    })
  },

  recomputeStats() {
    const map = this.data.attendanceMap
    let formalPresent = 0
    let trialPresent = 0
    let absent = 0

    Object.keys(map).forEach(id => {
      const item = map[id]
      if (item.is_present) {
        if (item.is_trial) {
          trialPresent++
        } else {
          formalPresent++
        }
      } else {
        absent++
      }
    })

    this.setData({
      'stats.formalPresentCount': formalPresent,
      'stats.trialPresentCount': trialPresent,
      'stats.absentCount': absent
    })
  },

  // ─────────────────────────────────────────
  // 1. 初次提交点名签到
  // ─────────────────────────────────────────
  onSubmitAttendance() {
    const { selectedScheduleId, attendanceMap, sheetData, currentUser } = this.data
    if (!selectedScheduleId || !sheetData) {
      wx.showToast({ title: '未选中有效排课', icon: 'none' })
      return
    }

    const attendanceInputs = Object.keys(attendanceMap).map(id => attendanceMap[id])

    try {
      const res = attendanceService.submitAttendance(
        selectedScheduleId,
        attendanceInputs,
        currentUser
      )

      this.setData({
        lastSubmitResult: res,
        insufficientNotices: res.insufficient_balance_notices || []
      })

      this.loadSchedules(selectedScheduleId)

      let modalContent = `【签到成功！人头核算与快照锁死完成】\n` +
        `• 实际授课老师: ${res.teacher_tier_snapshot ? res.teacher_tier_snapshot.teacher_name : '任课老师'}\n` +
        `• 正式出勤人头: ${res.present_formal_headcount} 人 (决定课酬基数)\n` +
        `• 试听生出勤: ${res.present_trial_count} 人 (不扣课时/不算人头)\n` +
        `• 未出勤学员: ${res.absent_count} 人 (不扣课时/不算人头)\n` +
        `• 单节扣费快照: ${res.hours_per_lesson} 课时/正式人 (系统自动计算)\n` +
        `• 老师当节课酬快照: ¥${res.calculated_teacher_fee} 元 (由Phase 4课酬引擎核算)\n`

      if (res.insufficient_balance_notices && res.insufficient_balance_notices.length > 0) {
        modalContent += `\n⚠️ 【注意：存在余额不足学员】\n`
        res.insufficient_balance_notices.forEach(n => {
          modalContent += `• ${n.message}\n`
        })
      }

      wx.showModal({
        title: '点名签到提交成功',
        content: modalContent,
        showCancel: false,
        confirmText: '查看快照'
      })
    } catch (err) {
      wx.showModal({
        title: '点名签到失败',
        content: err.message,
        showCancel: false
      })
    }
  },

  // ─────────────────────────────────────────
  // 2. 24 小时内自主改签提交
  // ─────────────────────────────────────────
  onUpdateAttendanceWithin24Hours() {
    const { selectedScheduleId, attendanceMap, sheetData, currentUser } = this.data
    if (!selectedScheduleId || !sheetData) return

    const attendanceInputs = Object.keys(attendanceMap).map(id => attendanceMap[id])

    try {
      const res = attendanceService.updateAttendanceWithin24Hours(
        selectedScheduleId,
        attendanceInputs,
        currentUser
      )

      this.setData({
        lastSubmitResult: Object.assign({}, res, {
          hours_per_lesson: sheetData.schedule.hours_per_lesson
        }),
        insufficientNotices: res.insufficient_balance_notices || []
      })

      this.loadSchedules(selectedScheduleId)

      let content = `【24小时自主改签成功】\n` +
        `• 调整后正式出勤: ${res.present_formal_headcount} 人\n` +
        `• 调整后试听出勤: ${res.present_trial_count} 人\n` +
        `• 调整后未出勤: ${res.absent_count} 人\n` +
        `• 老师课酬已自动重算: ¥${res.calculated_teacher_fee} 元\n\n` +
        `变动执行明细：\n`

      if (res.changed_details && res.changed_details.length > 0) {
        res.changed_details.forEach(d => {
          content += `• ${d}\n`
        })
      } else {
        content += `• 出勤状态无变动\n`
      }

      wx.showModal({
        title: '24小时自主改签成功',
        content,
        showCancel: false,
        confirmText: '好的'
      })
    } catch (err) {
      wx.showModal({
        title: '改签拦截',
        content: err.message,
        showCancel: false
      })
    }
  },

  // ─────────────────────────────────────────
  // 3. 漏签补签审批流申请
  // ─────────────────────────────────────────
  onOpenMakeupSignModal() {
    this.setData({
      showMakeupSignModal: true,
      makeupSignReason: '下课后教具整理匆忙漏点提交，现申请补录出勤'
    })
  },

  onCloseMakeupSignModal() {
    this.setData({ showMakeupSignModal: false })
  },

  onMakeupReasonInput(e) {
    this.setData({ makeupSignReason: e.detail.value })
  },

  onSubmitMakeupSignRequest() {
    const { selectedScheduleId, attendanceMap, makeupSignReason, currentUser } = this.data
    if (!selectedScheduleId) return

    const attendanceInputs = Object.keys(attendanceMap).map(id => attendanceMap[id])

    try {
      const res = attendanceService.requestMakeupAttendance(
        selectedScheduleId,
        attendanceInputs,
        makeupSignReason,
        currentUser
      )

      this.setData({ showMakeupSignModal: false })
      this.loadSchedules(selectedScheduleId)

      wx.showModal({
        title: '补签申请已提交！',
        content: `申请单 #${res.approval_id} 已正式进入【通用审批中心】。\n\n铁律保障：系统不会替老师自动签到，当前排课状态已标记为 [待审批补签]，暂不扣减学生课时。\n\n请切换为【超级管理员】账号前往审批中心批准，批准后将正式落地扣费并锁死快照！`,
        showCancel: false,
        confirmText: '前往体验'
      })
    } catch (err) {
      wx.showModal({
        title: '提交补签申请失败',
        content: err.message,
        showCancel: false
      })
    }
  },

  // ─────────────────────────────────────────
  // 4. Phase 3-A：管理员取消排课（最高权限、三步联动与二选一）
  // ─────────────────────────────────────────
  onOpenCancelLessonModal(e) {
    if (!this.data.isAdmin) {
      wx.showToast({ title: '仅管理员或超级管理员可取消课程', icon: 'none' })
      return
    }

    const schId = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.id
    const targetId = schId || this.data.selectedScheduleId
    const target = this.data.schedules.find(s => s.id === targetId)
    if (!target) return

    this.setData({
      showCancelLessonModal: true,
      cancelTargetSchedule: target,
      'cancelForm.reason': '校区暴雨恶劣天气停课通知',
      'cancelForm.handle_mode': 'individual_makeup'
    })
  },

  onCloseCancelLessonModal() {
    this.setData({ showCancelLessonModal: false, cancelTargetSchedule: null })
  },

  onCancelReasonInput(e) {
    this.setData({ 'cancelForm.reason': e.detail.value })
  },

  onSelectCancelHandleMode(e) {
    const mode = e.currentTarget.dataset.mode
    this.setData({ 'cancelForm.handle_mode': mode })
  },

  onSubmitCancelLesson() {
    const { cancelTargetSchedule, cancelForm } = this.data
    if (!cancelTargetSchedule) return

    try {
      const res = attendanceService.cancelScheduleLesson(cancelTargetSchedule.id, {
        reason: cancelForm.reason,
        handle_mode: cancelForm.handle_mode
      })

      this.setData({ showCancelLessonModal: false, cancelTargetSchedule: null })
      this.loadSchedules(cancelTargetSchedule.id)

      let content = `【课程已成功取消】\n` +
        `• 排课班级: ${res.class_name}\n` +
        `• 取消课次: ${res.lesson_date}\n` +
        `• 误签退还: 已全额原路退还 ${res.refunded_students_count} 位已扣课时学员\n` +
        `• 老师课酬: 强制清零记为 0 元\n` +
        `• 通知推送: 全班家长与老师取消通知已下发\n\n`

      if (res.handle_mode === 'individual_makeup') {
        content += `【后续处理：选项 A 单独补课模式】\n• 课表后续日程时间保持不动；\n• 该节缺课学生已标记为可后续单独补课候选学员。`
      } else {
        content += `【后续处理：选项 B 整班顺延一节】\n• 本班自本节课之后的 ${res.postpone_result ? res.postpone_result.postponed_count : 0} 节未上课表已整体往后顺延一周！\n• 新课表通知已自动推送给全班家长与授课老师！`
      }

      wx.showModal({
        title: '单节课程取消成功',
        content,
        showCancel: false,
        confirmText: '完成验证'
      })
    } catch (err) {
      wx.showModal({
        title: '取消课程失败',
        content: err.message,
        showCancel: false
      })
    }
  },

  // ─────────────────────────────────────────
  // 5. Phase 3-B：安排代课相关交互
  // ─────────────────────────────────────────
  onOpenSubstituteModal(e) {
    if (!this.data.isAdmin) {
      wx.showToast({ title: '仅管理员可安排代课', icon: 'none' })
      return
    }

    const schedule = this.data.sheetData && this.data.sheetData.schedule
    if (!schedule) return

    // 过滤排除原任课老师
    const origTeacherId = this.data.sheetData.class_info.teacher_id || this.data.selectedSchedule.teacher_id
    const candidates = this.data.availableTeachers.filter(t => t.id !== origTeacherId)

    this.setData({
      showSubstituteModal: true,
      availableTeachers: candidates,
      substituteForm: {
        teacher_index: 0,
        teacher_id: candidates[0] ? candidates[0].id : '',
        reason: '主讲老师因临时事务调休，特指派代课老师'
      }
    })
  },

  onCloseSubstituteModal() {
    this.setData({ showSubstituteModal: false })
  },

  onSubTeacherPickerChange(e) {
    const idx = Number(e.detail.value)
    const t = this.data.availableTeachers[idx]
    if (!t) return
    this.setData({
      'substituteForm.teacher_index': idx,
      'substituteForm.teacher_id': t.id
    })
  },

  onSubReasonInput(e) {
    this.setData({ 'substituteForm.reason': e.detail.value })
  },

  onSubmitAssignSubstitute() {
    const { selectedScheduleId, substituteForm, availableTeachers } = this.data
    const selectedTeacher = availableTeachers[substituteForm.teacher_index]
    if (!selectedTeacher) {
      wx.showToast({ title: '请选择代课老师', icon: 'none' })
      return
    }

    try {
      const res = attendanceService.assignSubstituteTeacher(
        selectedScheduleId,
        selectedTeacher.id,
        substituteForm.reason
      )

      this.setData({ showSubstituteModal: false })
      this.loadSchedules(selectedScheduleId)

      wx.showModal({
        title: '代课安排成功！',
        content: `已成功将排课指派给【${res.substitute_teacher_name}老师】代课！\n\n铁律联动执行完毕：\n• 动态路由生效：当【${res.substitute_teacher_name}老师】登录时，该课次将直接呈现在其签到表里，由其负责点名！\n• 家校通知已推送：全班所有绑定的家长已接收到明确包含代课老师姓名的代课通知。`,
        showCancel: false,
        confirmText: '好的'
      })
    } catch (err) {
      wx.showModal({
        title: '安排代课失败',
        content: err.message,
        showCancel: false
      })
    }
  },

  onCancelSubstitute() {
    if (!this.data.isAdmin) return
    const scheduleId = this.data.selectedScheduleId

    wx.showModal({
      title: '确认取消代课？',
      content: '取消后将恢复由原执教老师授课与点名。',
      success: (res) => {
        if (res.confirm) {
          try {
            attendanceService.cancelSubstituteTeacher(scheduleId)
            wx.showToast({ title: '已恢复原老师', icon: 'success' })
            this.loadSchedules(scheduleId)
          } catch (e) {
            wx.showToast({ title: e.message, icon: 'none' })
          }
        }
      }
    })
  },

  // ─────────────────────────────────────────
  // 6. Phase 3-B：代课客诉登记与个案处理
  // ─────────────────────────────────────────
  onOpenComplaintModal() {
    if (!this.data.isAdmin) {
      wx.showToast({ title: '仅管理员可登记与处理客诉', icon: 'none' })
      return
    }

    const students = (this.data.sheetData && this.data.sheetData.students) || []
    if (students.length === 0) {
      wx.showToast({ title: '暂无在读学员可登记客诉', icon: 'none' })
      return
    }

    this.setData({
      showComplaintModal: true,
      complaintForm: {
        student_index: 0,
        student_id: students[0].student_id,
        complaint_reason: '家长反映代课老师教学节奏偏快，孩子理解不透彻',
        decision: '退还当节课时',
        decision_reason: '经教务核实教学反馈属实，为保障家校满意度予以退还当节课时'
      }
    })
  },

  onCloseComplaintModal() {
    this.setData({ showComplaintModal: false })
  },

  onComplaintStudentChange(e) {
    const idx = Number(e.detail.value)
    const stu = this.data.sheetData.students[idx]
    if (!stu) return
    this.setData({
      'complaintForm.student_index': idx,
      'complaintForm.student_id': stu.student_id
    })
  },

  onComplaintReasonInput(e) {
    this.setData({ 'complaintForm.complaint_reason': e.detail.value })
  },

  onComplaintDecisionReasonInput(e) {
    this.setData({ 'complaintForm.decision_reason': e.detail.value })
  },

  onSelectComplaintDecision(e) {
    const decision = e.currentTarget.dataset.decision
    this.setData({ 'complaintForm.decision': decision })
  },

  onSubmitComplaint() {
    const { selectedScheduleId, complaintForm } = this.data

    try {
      const res = attendanceService.handleSubstituteComplaint({
        schedule_id: selectedScheduleId,
        student_id: complaintForm.student_id,
        complaint_reason: complaintForm.complaint_reason,
        decision: complaintForm.decision,
        decision_reason: complaintForm.decision_reason
      })

      this.setData({ showComplaintModal: false })
      this.loadSchedules(selectedScheduleId)

      let content = `学员【${res.student_name}】的代课客诉已处理留档！\n• 处理决定: 【${res.decision}】\n• 决定事由: ${res.decision_reason}\n\n`

      if (res.decision === '退还当节课时') {
        if (res.is_refunded) {
          content += `⚡ 【已联动原路退还课时】\n系统已调用 rollbackHours 严格将该生当节所扣 ${res.refunded_hours} 课时原路退回课时包（冲减欠费并退还课时）！`
        } else {
          content += `提示：该生当节尚未扣课时，无需实际回滚课时包。`
        }
      } else if (res.decision === '安排重上一节') {
        content += `📅 该生已标记获得一次免费重上补课机会，后续可在补课中心安排插班重听！`
      } else {
        content += `该客诉已作为不予处理结案留档。`
      }

      wx.showModal({
        title: '客诉处理成功并留档',
        content,
        showCancel: false,
        confirmText: '查看留痕'
      })
    } catch (err) {
      wx.showModal({
        title: '处理客诉失败',
        content: err.message,
        showCancel: false
      })
    }
  },

  // ─────────────────────────────────────────
  // 7. Phase 3-C：缺勤补课预约全流程交互控制器
  // ─────────────────────────────────────────

  /** 打开缺勤补课预约弹窗（三种补课路径） */
  onOpenMakeupBookingModal(e) {
    const stuId = e.currentTarget.dataset.id
    const stu = this.data.sheetData && this.data.sheetData.students.find(s => s.student_id === stuId)
    if (!stu) return

    const schedule = this.data.sheetData.schedule
    const clsInfo = this.data.sheetData.class_info
    const cls = db.getById(db.TABLES.CLASSES, clsInfo.id)
    const courseId = cls ? cls.course_id : ''

    // 查询原老师名下同课程、同课时、未满封顶的可挂载课次
    const eligibleSelf = attendanceService.getEligibleMakeupSchedules({
      course_id: courseId,
      hours_per_lesson: schedule.hours_per_lesson,
      teacher_id: schedule.teacher_id,
      exclude_schedule_id: schedule.id
    })

    const tmrw = new Date(Date.now() + 86400000)
    const tmrwStr = `${tmrw.getFullYear()}-${String(tmrw.getMonth() + 1).padStart(2, '0')}-${String(tmrw.getDate()).padStart(2, '0')}`

    this.setData({
      showMakeupModal: true,
      eligibleSelfSchedules: eligibleSelf,
      makeupForm: {
        student_id: stu.student_id,
        student_name: stu.name,
        hours_needed: schedule.hours_per_lesson,
        makeup_type: 'same_teacher',
        sub_mode: eligibleSelf.length > 0 ? 'mount_existing' : 'new_solo',
        target_schedule_index: 0,
        target_schedule_id: eligibleSelf.length > 0 ? eligibleSelf[0].schedule_id : '',
        solo_date: tmrwStr,
        solo_start_time: '16:00',
        solo_end_time: '17:30',
        remarks: ''
      }
    })
  },

  onCloseMakeupModal() {
    this.setData({ showMakeupModal: false })
  },

  onSelectMakeupType(e) {
    const type = e.currentTarget.dataset.type
    this.setData({
      'makeupForm.makeup_type': type
    })
  },

  onSelectMakeupSubMode(e) {
    const mode = e.currentTarget.dataset.mode
    this.setData({
      'makeupForm.sub_mode': mode
    })
  },

  onTargetScheduleChange(e) {
    const idx = Number(e.detail.value)
    const target = this.data.eligibleSelfSchedules[idx]
    this.setData({
      'makeupForm.target_schedule_index': idx,
      'makeupForm.target_schedule_id': target ? target.schedule_id : ''
    })
  },

  onSoloDateChange(e) {
    this.setData({ 'makeupForm.solo_date': e.detail.value })
  },

  onSoloStartTimeChange(e) {
    this.setData({ 'makeupForm.solo_start_time': e.detail.value })
  },

  onSoloEndTimeChange(e) {
    this.setData({ 'makeupForm.solo_end_time': e.detail.value })
  },

  onMakeupRemarksInput(e) {
    this.setData({ 'makeupForm.remarks': e.detail.value })
  },

  /** 提交缺勤补课预约 */
  onSubmitMakeupBooking() {
    const form = this.data.makeupForm
    const scheduleId = this.data.selectedScheduleId
    const user = this.data.currentUser

    try {
      const res = attendanceService.bookMakeupLesson({
        original_schedule_id: scheduleId,
        student_id: form.student_id,
        makeup_type: form.makeup_type,
        sub_mode: form.sub_mode,
        target_schedule_id: form.target_schedule_id,
        solo_date: form.solo_date,
        solo_start_time: form.solo_start_time,
        solo_end_time: form.solo_end_time,
        remarks: form.remarks
      }, user)

      this.setData({ showMakeupModal: false })
      wx.showToast({ title: res.message || '预约成功', icon: 'success' })

      // 重新加载日程列表与当前签到表
      this.loadSchedules(scheduleId)
    } catch (err) {
      wx.showModal({
        title: '预约失败',
        content: err.message,
        showCancel: false
      })
    }
  },

  // ─────────────────────────────────────────
  // 8. Phase 3-C：管理员跨师补课工单协调与挂载
  // ─────────────────────────────────────────

  /** 管理员打开安排跨师补课弹窗 */
  onOpenAdminAssignMakeupModal(e) {
    const reqId = e.currentTarget.dataset.id
    const req = (this.data.pendingMakeupRequests || []).find(r => r.id === reqId)
    if (!req) return

    // 查询同课程同课时且未满封顶的可跨班挂载课次
    const eligibleCross = attendanceService.getEligibleMakeupSchedules({
      course_id: req.course_id,
      hours_per_lesson: req.original_hours_per_lesson
    })

    const teachers = this.data.availableTeachers || []
    const tmrw = new Date(Date.now() + 86400000)
    const tmrwStr = `${tmrw.getFullYear()}-${String(tmrw.getMonth() + 1).padStart(2, '0')}-${String(tmrw.getDate()).padStart(2, '0')}`

    this.setData({
      showAdminAssignModal: true,
      eligibleCrossSchedules: eligibleCross,
      adminAssignForm: {
        request_id: req.id,
        student_name: req.student_name_snapshot,
        hours_needed: req.original_hours_per_lesson,
        mode: eligibleCross.length > 0 ? 'mount_existing' : 'new_solo',
        target_schedule_index: 0,
        target_schedule_id: eligibleCross.length > 0 ? eligibleCross[0].schedule_id : '',
        teacher_index: 0,
        teacher_id: teachers.length > 0 ? teachers[0].id : '',
        solo_date: tmrwStr,
        solo_start_time: '16:00',
        solo_end_time: '17:30'
      }
    })
  },

  onCloseAdminAssignModal() {
    this.setData({ showAdminAssignModal: false })
  },

  onSelectAdminAssignMode(e) {
    const mode = e.currentTarget.dataset.mode
    this.setData({ 'adminAssignForm.mode': mode })
  },

  onAdminTargetScheduleChange(e) {
    const idx = Number(e.detail.value)
    const target = this.data.eligibleCrossSchedules[idx]
    this.setData({
      'adminAssignForm.target_schedule_index': idx,
      'adminAssignForm.target_schedule_id': target ? target.schedule_id : ''
    })
  },

  onAdminTeacherPickerChange(e) {
    const idx = Number(e.detail.value)
    const tch = this.data.availableTeachers[idx]
    this.setData({
      'adminAssignForm.teacher_index': idx,
      'adminAssignForm.teacher_id': tch ? tch.id : ''
    })
  },

  onAdminSoloDateChange(e) {
    this.setData({ 'adminAssignForm.solo_date': e.detail.value })
  },

  onAdminSoloStartTimeChange(e) {
    this.setData({ 'adminAssignForm.solo_start_time': e.detail.value })
  },

  onAdminSoloEndTimeChange(e) {
    this.setData({ 'adminAssignForm.solo_end_time': e.detail.value })
  },

  /** 确认跨师安排并挂载 */
  onSubmitAdminAssignMakeup() {
    const form = this.data.adminAssignForm
    const user = this.data.currentUser

    try {
      const res = attendanceService.assignCrossTeacherMakeup(form.request_id, {
        mode: form.mode,
        target_schedule_id: form.target_schedule_id,
        teacher_id: form.teacher_id,
        solo_date: form.solo_date,
        solo_start_time: form.solo_start_time,
        solo_end_time: form.solo_end_time
      }, user)

      this.setData({ showAdminAssignModal: false })
      wx.showToast({
        title: `已成功安排由【${res.target_teacher_name}】补课`,
        icon: 'success'
      })

      this.loadSchedules(this.data.selectedScheduleId)
    } catch (err) {
      wx.showModal({
        title: '安排跨师补课失败',
        content: err.message,
        showCancel: false
      })
    }
  },

  /** 快速新建一节测试排课日程 */
  onQuickCreateSchedule() {
    const classes = db.getTable(db.TABLES.CLASSES) || []
    if (classes.length === 0) {
      wx.showToast({ title: '暂无班级数据', icon: 'none' })
      return
    }

    const targetClass = classes[0]
    const today = new Date()
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

    try {
      const newSch = attendanceService.createSchedule({
        class_id: targetClass.id,
        lesson_date: dateStr,
        start_time: '16:00',
        end_time: '17:30',
        lesson_index: (targetClass.current_lesson_index || 0) + 1
      })

      wx.showToast({ title: '已新建第' + newSch.lesson_index + '次课日程', icon: 'success' })
      this.loadSchedules(newSch.id)
    } catch (err) {
      wx.showToast({ title: err.message, icon: 'none' })
    }
  }
})

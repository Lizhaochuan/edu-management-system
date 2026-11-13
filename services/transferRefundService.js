// services/transferRefundService.js
// 核心教务变更与资金结算服务（Phase 5-A 审批并发锁、课时冻结与手工调课时）
const db = require('./db')

const transferRefundService = {
  // ─────────────────────────────────────────
  // 1. [全局加固规则] 课时包审批并发锁工具方法
  // ─────────────────────────────────────────

  /**
   * 对课时包施加审批并发锁（发起退费/三转/手工扣课时时调用）
   * @param {string} packageId - 课时包ID
   * @param {string} approvalRequestId - 关联审批申请单ID
   * @param {Object} snapshotBalance - 发起时的余额快照
   * @param {string} reason - 锁定原因
   * @param {Object} operatorUser - 操作人
   */
  acquirePackageConcurrencyLock(packageId, approvalRequestId, snapshotBalance = null, reason = '', operatorUser = null) {
    if (!packageId) throw new Error('课时包ID不能为空')
    const pkg = db.getById(db.TABLES.COURSE_PACKAGES, packageId)
    if (!pkg) throw new Error(`未找到指定课时包 #${packageId}`)

    // 铁律：禁止重复叠加申请
    if (pkg.lock_status === 'pending_approval_locked') {
      throw new Error('该课时包当前有一笔待超级管理员审批的变更单，请等待审批完成或撤回后再操作')
    }

    const curPaid = Number(pkg.paid_hours_left || 0)
    const curGift = Number(pkg.gift_hours_left || 0)
    const curTotal = Number((curPaid + curGift).toFixed(2))

    const balanceSnapshot = snapshotBalance || {
      paid_hours_left: curPaid,
      gift_hours_left: curGift,
      total_available_hours: curTotal,
      snapshot_at: new Date().toISOString()
    }

    const updated = db.update(
      db.TABLES.COURSE_PACKAGES,
      packageId,
      {
        lock_status: 'pending_approval_locked',
        locked_by_approval_id: approvalRequestId,
        locked_at: new Date().toISOString(),
        snapshot_balance_at_propose: balanceSnapshot
      },
      `[审批并发锁-上锁] 课时包 #${packageId} 因审批申请单 #${approvalRequestId} (${reason || '发起变更'}) 上锁锁定`
    )

    return updated
  },

  /**
   * 释放课时包审批并发锁
   * @param {string} packageId
   * @param {Object} operatorUser
   * @param {string} reason
   */
  releasePackageConcurrencyLock(packageId, operatorUser = null, reason = '') {
    if (!packageId) return null
    const pkg = db.getById(db.TABLES.COURSE_PACKAGES, packageId)
    if (!pkg) return null

    if (pkg.lock_status === 'pending_approval_locked') {
      return db.update(
        db.TABLES.COURSE_PACKAGES,
        packageId,
        {
          lock_status: 'unlocked',
          locked_by_approval_id: null,
          snapshot_balance_at_propose: null,
          unlocked_at: new Date().toISOString()
        },
        `[审批并发锁-释放] 课时包 #${packageId} 释放并发锁: ${reason || '审批结束/撤回'}`
      )
    }
    return pkg
  },

  /**
   * 校验课时包实时余额与发起时的快照是否一致（超管审批时的二次校验）
   * @param {string} packageId
   * @param {Object} snapshotBalanceAtPropose
   * @returns {Object} { isValid, reason, current_paid, current_gift }
   */
  verifyPackageBalanceSnapshot(packageId, snapshotBalanceAtPropose) {
    if (!packageId) throw new Error('课时包ID不能为空')
    const pkg = db.getById(db.TABLES.COURSE_PACKAGES, packageId)
    if (!pkg) throw new Error(`课时包 #${packageId} 不存在`)

    if (!snapshotBalanceAtPropose) return { isValid: true }

    const curPaid = Number(pkg.paid_hours_left || 0)
    const curGift = Number(pkg.gift_hours_left || 0)
    const snapPaid = Number(snapshotBalanceAtPropose.paid_hours_left || 0)
    const snapGift = Number(snapshotBalanceAtPropose.gift_hours_left || 0)

    if (Math.abs(curPaid - snapPaid) > 0.0001 || Math.abs(curGift - snapGift) > 0.0001) {
      return {
        isValid: false,
        reason: '审批期间该生发生了上课考勤，余额已变动，原申请单已自动失效，请让管理员按最新余额重新提单',
        current_paid: curPaid,
        current_gift: curGift,
        snapshot_paid: snapPaid,
        snapshot_gift: snapGift
      }
    }

    return { isValid: true }
  },

  // ─────────────────────────────────────────
  // 2. 课时冻结（生病/出远门 —— 管理员审批，90天双封顶）
  // ─────────────────────────────────────────

  /**
   * 发起课时冻结申请
   * 
   * 90天双封顶铁律（100%严格执行）：
   * 1. 单次上限：一次冻结最多冻 3 个月（90 天），若申请超过 90 天，系统最多只允许冻 90 天；
   * 2. 多次冻结累计上限：系统统计该课时包历次已冻结天数总和 (total_frozen_days)，
   *    多次冻结加起来一共也不能超过 90 天（即本次最多可冻天数 = min(申请天数, 90 - total_frozen_days)）；
   *    一旦 total_frozen_days >= 90，系统硬性拦截，不再允许提交或审批新的冻结！
   * 3. 顺延效果：管理员审批通过后，将到期日 expire_date 自动往后顺延本次冻结的天数。
   *
   * @param {Object} params - { package_id, freeze_days, start_date, reason }
   * @param {Object} operatorUser - 提单人（家长提出，老师/管理员代提）
   */
  submitFreezeRequest(params = {}, operatorUser = null) {
    if (typeof wx !== 'undefined' && typeof wx.request === 'function' && !db.inServerTransaction()) return require('./commandClient').run('approval.propose',{type:'freeze',data:params})
    const { package_id, freeze_days, start_date, reason } = params

    if (!package_id) throw new Error('必须指定需要冻结的课时包ID')
    const pkg = db.getById(db.TABLES.COURSE_PACKAGES, package_id)
    if (!pkg) throw new Error(`未找到指定课时包 #${package_id}`)

    const student = db.getById(db.TABLES.STUDENTS, pkg.student_id) || { name: pkg.student_name_snapshot || '学员' }

    // 1. 累计冻结天数硬性拦截校验
    const totalFrozenBefore = Number(pkg.total_frozen_days || 0)
    if (totalFrozenBefore >= 90) {
      throw new Error(`【90天封顶拦截】该课时包累计已冻结 ${totalFrozenBefore} 天，已达系统 90 天累计封顶上限，不再允许申请冻结！`)
    }

    // 2. 单次上限与本次最多可冻天数计算
    let requestedDays = parseInt(freeze_days, 10)
    if (isNaN(requestedDays) || requestedDays <= 0) {
      throw new Error('冻结天数必须为大于0的整数')
    }
    // 单次上限：最多 90 天
    if (requestedDays > 90) {
      requestedDays = 90
    }
    // 多次累计上限：90 - total_frozen_days
    const maxAllowedThisTime = 90 - totalFrozenBefore
    const effectiveFreezeDays = Math.min(requestedDays, maxAllowedThisTime)

    if (effectiveFreezeDays <= 0) {
      throw new Error(`【90天封顶拦截】该课时包当前最多还可冻结 0 天，已达 90 天封顶上限`)
    }

    // 3. 理由必填
    if (!reason || !reason.trim() || reason.trim().length < 2) {
      throw new Error('必须填写详细的冻结原因（如：学生生病住院两周、全家出远门探亲等）')
    }

    const startDate = start_date || new Date().toISOString().slice(0, 10)
    const nowIso = new Date().toISOString()
    const reqId = 'req_frz_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

    const proposerId = operatorUser ? operatorUser.id : 'u_adm1'
    const proposerName = operatorUser ? operatorUser.name : '教务管理'

    const beforeSnapshot = {
      package_id: pkg.id,
      student_id: pkg.student_id,
      student_name: student.name,
      course_id: pkg.course_id,
      course_name: pkg.course_name_snapshot,
      expire_date: pkg.expire_date,
      total_frozen_days: totalFrozenBefore
    }

    const afterPayload = {
      package_id: pkg.id,
      freeze_days: effectiveFreezeDays,
      requested_days: requestedDays,
      start_date: startDate,
      reason: reason.trim(),
      total_frozen_days_after: totalFrozenBefore + effectiveFreezeDays
    }

    // 提交审批流（由管理员或超管审批即可）
    const approvalReq = {
      id: reqId,
      request_type: 'freeze_hours',
      proposer_id: proposerId,
      proposer_name: proposerName,
      target_table: db.TABLES.COURSE_PACKAGES,
      target_record_id: pkg.id,
      reason: `[课时冻结申请] 学员【${student.name}】课时包 #${pkg.id} 申请冻结 ${effectiveFreezeDays} 天 (已累积冻结 ${totalFrozenBefore}/90 天)。原因：${reason.trim()}`,
      before_data_json: JSON.stringify(beforeSnapshot),
      after_data_json: JSON.stringify(afterPayload),
      status: 'pending',
      action_time: nowIso
    }

    db.insert(
      db.TABLES.APPROVAL_REQUESTS,
      approvalReq,
      `[提交课时冻结] 学员【${student.name}】课时包 #${pkg.id} 申请冻结 ${effectiveFreezeDays} 天`
    )

    return {
      approval_request: approvalReq,
      effective_freeze_days: effectiveFreezeDays,
      total_frozen_before: totalFrozenBefore,
      max_allowed_this_time: maxAllowedThisTime
    }
  },

  /**
   * 管理员/超管审批通过课时冻结申请
   * 自动顺延到期日 expire_date 并更新 total_frozen_days
   */
  applyFreezeApproval(approvalItem, approverUser) {
    if (!approvalItem || !approvalItem.target_record_id) return null

    // 权限校验：admin 或 super_admin 可审批
    if (approverUser && approverUser.role !== 'admin' && approverUser.role !== 'super_admin') {
      throw new Error('仅教务主管(admin)或超级管理员(super_admin)可审批课时冻结申请')
    }

    // 自审拦截
    if (approverUser && approverUser.id === approvalItem.proposer_id) {
      throw new Error('违反内控铁律：不能审批自己发起的课时冻结申请！请切换其他管理账号')
    }

    const pkg = db.getById(db.TABLES.COURSE_PACKAGES, approvalItem.target_record_id)
    if (!pkg) throw new Error(`未找到目标课时包 #${approvalItem.target_record_id}`)

    const curTotalFrozen = Number(pkg.total_frozen_days || 0)
    if (curTotalFrozen >= 90) {
      throw new Error('【90天封顶拦截】该课时包累计冻结天数已达 90 天封顶，无法再次批准冻结')
    }

    let afterData = {}
    try {
      afterData = typeof approvalItem.after_data_json === 'string'
        ? JSON.parse(approvalItem.after_data_json)
        : (approvalItem.after_data_json || {})
    } catch (e) {
      afterData = {}
    }

    const freezeDays = Number(afterData.freeze_days || 0)
    if (freezeDays <= 0) throw new Error('无效的冻结天数')

    // 再次以数据库实时累计天数核算封顶
    const effectiveDays = Math.min(freezeDays, 90 - curTotalFrozen)
    if (effectiveDays <= 0) {
      throw new Error('该课时包已达 90 天累计封顶上限，不能继续顺延')
    }

    // 计算到期日顺延
    const oldExpire = pkg.expire_date || new Date().toISOString().slice(0, 10)
    const expireObj = new Date(oldExpire)
    expireObj.setDate(expireObj.getDate() + effectiveDays)
    const newExpire = expireObj.toISOString().slice(0, 10)

    const newTotalFrozen = curTotalFrozen + effectiveDays
    const nowIso = new Date().toISOString()

    const updatedPkg = db.update(
      db.TABLES.COURSE_PACKAGES,
      pkg.id,
      {
        expire_date: newExpire,
        total_frozen_days: newTotalFrozen,
        last_frozen_start_date: afterData.start_date || nowIso.slice(0, 10),
        last_frozen_days: effectiveDays,
        freeze_status: 'frozen'
      },
      `[课时冻结生效] 管理员【${approverUser ? approverUser.name : '管理员'}】批准冻结 ${effectiveDays} 天，课时包 #${pkg.id} 到期日自 ${oldExpire} 顺延至 ${newExpire} (累计已冻结: ${newTotalFrozen}/90天)`
    )

    return {
      package: updatedPkg,
      extended_days: effectiveDays,
      old_expire_date: oldExpire,
      new_expire_date: newExpire,
      total_frozen_days: newTotalFrozen
    }
  },

  /**
   * 管理员/超管驳回课时冻结申请
   */
  rejectFreezeApproval(approvalItem, rejectReason, approverUser) {
    if (!approvalItem || !approvalItem.target_record_id) return null
    return {
      package_id: approvalItem.target_record_id,
      status: 'rejected',
      reject_reason: rejectReason
    }
  },

  // ─────────────────────────────────────────
  // 3. 管理员手工调课时（超管独批、防负数、不改历史、自动上并发锁）
  // ─────────────────────────────────────────

  /**
   * 发起手工调课时申请
   * 
   * 四条铁律（100%严格执行）：
   * 1. 必填理由：必须填写调账理由，为空直接拦截；
   * 2. 防负数拦截与上锁：手工减课时绝对不能把学生余额减成负数，扣减时立即对该课时包施加审批并发锁；
   * 3. 不改历史：锁死历史出勤消课与课酬台账，新立独立调账申请与台账；
   * 4. 超管独批与留痕：提交至 approval_requests 由超级管理员一个人批，审批通过时生成完整调账档案。
   *
   * @param {Object} params - { package_id, direction, paid_hours_delta, gift_hours_delta, reason }
   * @param {Object} operatorUser - 发起人
   */
  submitManualHourAdjust(params = {}, operatorUser = null) {
    if (typeof wx !== 'undefined' && typeof wx.request === 'function' && !db.inServerTransaction()) return require('./commandClient').run('approval.propose',{type:'adjustHours',data:params})
    const { package_id, direction, paid_hours_delta, gift_hours_delta, reason } = params

    // 铁律 1：必填理由
    if (!reason || !reason.trim() || reason.trim().length < 2) {
      throw new Error('必须填写手工调账详细原因（不可为空，至少2字）')
    }

    if (!package_id) throw new Error('必须指定需要调账的课时包ID')
    const pkg = db.getById(db.TABLES.COURSE_PACKAGES, package_id)
    if (!pkg) throw new Error(`未找到指定课时包 #${package_id}`)

    const student = db.getById(db.TABLES.STUDENTS, pkg.student_id) || { name: pkg.student_name_snapshot || '学员' }

    if (!['increase', 'decrease'].includes(direction)) {
      throw new Error('调账方向必须为 增加(increase) 或 扣减(decrease)')
    }

    const paidDelta = Math.abs(Number(paid_hours_delta || 0))
    const giftDelta = Math.abs(Number(gift_hours_delta || 0))
    const totalDelta = Number((paidDelta + giftDelta).toFixed(2))

    if (totalDelta <= 0) {
      throw new Error('调整课时数必须大于0（付费课时或赠送课时至少调一项）')
    }

    const curPaid = Number(pkg.paid_hours_left || 0)
    const curGift = Number(pkg.gift_hours_left || 0)
    const curTotal = Number((curPaid + curGift).toFixed(2))

    // 铁律 2：防负数拦截
    if (direction === 'decrease') {
      if (paidDelta > curPaid) {
        throw new Error(`【防负数铁律拦截】申请扣减付费课时(${paidDelta})超过当前付费课时余额(${curPaid})，系统绝不允许将余额减为负数！`)
      }
      if (giftDelta > curGift) {
        throw new Error(`【防负数铁律拦截】申请扣减赠送课时(${giftDelta})超过当前赠送课时余额(${curGift})，系统绝不允许将余额减为负数！`)
      }
      if (totalDelta > curTotal || curTotal <= 0) {
        throw new Error(`【防负数铁律拦截】申请扣减总课时(${totalDelta})超过可用总课时(${curTotal})，系统绝不允许将余额减为负数！`)
      }

      // 检查当前是否已有并发锁
      if (pkg.lock_status === 'pending_approval_locked') {
        throw new Error('该课时包当前有一笔待超级管理员审批的变更单，请等待审批完成或撤回后再操作')
      }
    }

    const nowIso = new Date().toISOString()
    const reqId = 'req_mha_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    const snapshotBalance = {
      paid_hours_left: curPaid,
      gift_hours_left: curGift,
      total_available_hours: curTotal,
      snapshot_at: nowIso
    }

    // 扣减课时立即对课时包施加审批并发锁
    if (direction === 'decrease') {
      this.acquirePackageConcurrencyLock(
        pkg.id,
        reqId,
        snapshotBalance,
        `手工扣减课时: -${totalDelta}课时(付费:${paidDelta}, 赠送:${giftDelta})`,
        operatorUser
      )
    }

    const proposerId = operatorUser ? operatorUser.id : 'u_adm1'
    const proposerName = operatorUser ? operatorUser.name : '教务管理'

    const afterPaid = direction === 'increase'
      ? Number((curPaid + paidDelta).toFixed(2))
      : Number((curPaid - paidDelta).toFixed(2))

    const afterGift = direction === 'increase'
      ? Number((curGift + giftDelta).toFixed(2))
      : Number((curGift - giftDelta).toFixed(2))

    const beforeSnapshot = {
      package_id: pkg.id,
      student_id: pkg.student_id,
      student_name: student.name,
      course_id: pkg.course_id,
      course_name: pkg.course_name_snapshot,
      paid_hours_left: curPaid,
      gift_hours_left: curGift,
      total_available_hours: curTotal,
      snapshot_balance_at_propose: snapshotBalance
    }

    const afterPayload = {
      package_id: pkg.id,
      direction: direction,
      paid_hours_delta: paidDelta,
      gift_hours_delta: giftDelta,
      total_hours_delta: totalDelta,
      paid_hours_after: afterPaid,
      gift_hours_after: afterGift,
      reason: reason.trim(),
      snapshot_balance_at_propose: snapshotBalance
    }

    // 提交审批单至 approval_requests（必须超级管理员独批）
    const approvalReq = {
      id: reqId,
      request_type: 'manual_hour_adjust',
      proposer_id: proposerId,
      proposer_name: proposerName,
      target_table: db.TABLES.COURSE_PACKAGES,
      target_record_id: pkg.id,
      reason: `[手工调课时申请] 学员【${student.name}】课时包 #${pkg.id} 申请${direction === 'increase' ? '增加(+)' : '扣减(-)'}${totalDelta}课时(付费:${paidDelta}, 赠送:${giftDelta})。原因：${reason.trim()}`,
      before_data_json: JSON.stringify(beforeSnapshot),
      after_data_json: JSON.stringify(afterPayload),
      status: 'pending',
      action_time: nowIso
    }

    db.insert(
      db.TABLES.APPROVAL_REQUESTS,
      approvalReq,
      `[提交手工调课时] 课时包 #${pkg.id} 申请${direction === 'increase' ? '增加(+)' : '扣减(-)'}${totalDelta}课时`
    )

    return {
      approval_request: approvalReq,
      snapshot_balance: snapshotBalance,
      is_locked: direction === 'decrease'
    }
  },

  /**
   * 超管审批通过手工调课时申请
   * 二次校验余额、防负数、执行增减、释放并发锁并生成留痕台账
   */
  applyManualHourAdjustApproval(approvalItem, approverUser) {
    if (!approvalItem || !approvalItem.target_record_id) return null

    // 铁律 4：超管独批
    if (approverUser && approverUser.role !== 'super_admin') {
      throw new Error('权限拦截：仅超级管理员(super_admin)一人有权审批手工调课时申请')
    }

    // 自审拦截
    if (approverUser && approverUser.id === approvalItem.proposer_id) {
      throw new Error('违反内控铁律：不能审批自己发起的手工调课时申请！请切换其他超管账号')
    }

    const pkg = db.getById(db.TABLES.COURSE_PACKAGES, approvalItem.target_record_id)
    if (!pkg) throw new Error(`未找到目标课时包 #${approvalItem.target_record_id}`)

    let beforeData = {}
    let afterData = {}
    try {
      beforeData = typeof approvalItem.before_data_json === 'string'
        ? JSON.parse(approvalItem.before_data_json)
        : (approvalItem.before_data_json || {})
      afterData = typeof approvalItem.after_data_json === 'string'
        ? JSON.parse(approvalItem.after_data_json)
        : (approvalItem.after_data_json || {})
    } catch (e) {
      throw new Error('审批单快照数据解析异常')
    }

    // 扣减课时执行二次余额校验
    if (afterData.direction === 'decrease') {
      const verifyRes = this.verifyPackageBalanceSnapshot(pkg.id, beforeData.snapshot_balance_at_propose)
      if (!verifyRes.isValid) {
        // 自动释放并发锁并废止单据
        this.releasePackageConcurrencyLock(pkg.id, approverUser, '考勤消课余额变动，自动释放并发锁')
        db.update(
          db.TABLES.APPROVAL_REQUESTS,
          approvalItem.id,
          {
            status: 'invalidated_by_attendance',
            reject_reason: verifyRes.reason,
            reviewed_at: new Date().toISOString()
          },
          `[并发破锁] 申请单 #${approvalItem.id} 因考勤消课余额变动自动废止`
        )
        throw new Error(verifyRes.reason)
      }
    }

    // 计算调后课时
    const paidDelta = Number(afterData.paid_hours_delta || 0)
    const giftDelta = Number(afterData.gift_hours_delta || 0)

    const curPaid = Number(pkg.paid_hours_left || 0)
    const curGift = Number(pkg.gift_hours_left || 0)

    let newPaid = curPaid
    let newGift = curGift

    if (afterData.direction === 'increase') {
      newPaid = Number((curPaid + paidDelta).toFixed(2))
      newGift = Number((curGift + giftDelta).toFixed(2))
    } else {
      newPaid = Number((curPaid - paidDelta).toFixed(2))
      newGift = Number((curGift - giftDelta).toFixed(2))
      // 防负数二次铁律校验
      if (newPaid < 0 || newGift < 0) {
        this.releasePackageConcurrencyLock(pkg.id, approverUser, '防负数拦截释放锁')
        throw new Error('【防负数铁律拦截】计算后课时余额为负数，拒绝执行！')
      }
    }

    const nowIso = new Date().toISOString()

    // 1. 更新课时包余额并释放并发锁
    const updatedPkg = db.update(
      db.TABLES.COURSE_PACKAGES,
      pkg.id,
      {
        paid_hours_left: newPaid,
        gift_hours_left: newGift,
        lock_status: 'unlocked',
        locked_by_approval_id: null,
        snapshot_balance_at_propose: null
      },
      `[手工调课时生效] 超管【${approverUser ? approverUser.name : '超管'}】批准${afterData.direction === 'increase' ? '增加(+)' : '扣减(-)'}${afterData.total_hours_delta}课时，余额变更为 付费:${newPaid}, 赠送:${newGift}`
    )

    // 2. 建立不可篡改调账独立台账 manual_hour_adjustments
    const record = {
      id: 'mha_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      approval_id: approvalItem.id,
      package_id: pkg.id,
      student_id: pkg.student_id,
      student_name: beforeData.student_name,
      course_id: pkg.course_id,
      course_name: pkg.course_name_snapshot,
      direction: afterData.direction,
      paid_hours_before: curPaid,
      gift_hours_before: curGift,
      paid_hours_delta: paidDelta,
      gift_hours_delta: giftDelta,
      total_hours_delta: afterData.total_hours_delta,
      paid_hours_after: newPaid,
      gift_hours_after: newGift,
      reason: afterData.reason,
      operator_id: approvalItem.proposer_id,
      operator_name: approvalItem.proposer_name,
      approver_id: approverUser ? approverUser.id : 'u_sa1',
      approver_name: approverUser ? approverUser.name : '超级管理员',
      approved_time: nowIso,
      created_at: nowIso,
      updated_at: nowIso
    }

    db.insert(
      db.TABLES.MANUAL_HOUR_ADJUSTMENTS,
      record,
      `[手工调课时档案留痕] 学员【${record.student_name}】调账档案已建立 (调后付费:${newPaid}, 赠送:${newGift})`
    )

    return {
      package: updatedPkg,
      adjustment_record: record
    }
  },

  /**
   * 超管驳回手工调课时申请（自动释放并发锁）
   */
  rejectManualHourAdjustApproval(approvalItem, rejectReason, approverUser) {
    if (!approvalItem || !approvalItem.target_record_id) return null

    // 释放并发锁
    this.releasePackageConcurrencyLock(approvalItem.target_record_id, approverUser, '超管驳回申请，释放并发锁')

    return {
      package_id: approvalItem.target_record_id,
      status: 'rejected',
      reject_reason: rejectReason
    }
  },

  // ─────────────────────────────────────────
  // 4. 台账与历史查询接口
  // ─────────────────────────────────────────

  /**
   * 查询手工调课时记录列表
   */
  getManualAdjustments(filter = {}) {
    const list = db.getTable(db.TABLES.MANUAL_HOUR_ADJUSTMENTS) || []
    return list.filter(item => {
      if (filter.package_id && item.package_id !== filter.package_id) return false
      if (filter.student_id && item.student_id !== filter.student_id) return false
      if (filter.direction && item.direction !== filter.direction) return false
      return true
    }).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
  },

  // ─────────────────────────────────────────
  // 5. Phase 5-B：转人、转课、转班三大换算引擎
  // ─────────────────────────────────────────

  /**
   * 三转试算预览接口（供前端展示换算结果、差价/零头金额与防呆校验）
   * 
   * 核心业务铁律（100%严格执行）：
   * 1. 支持部分转移 & 先付费后赠送；
   * 2. 原到期日严格不变；
   * 3. 场景 A（转人）：同课程1:1平转，不按钱换算；
   * 4. 场景 B（转课）：付费课时按钱换算，赠送课时1:1平转，除不尽支持补钱(top_up)与退零头(refund_change)；
   * 5. 场景 C（转班）：新班满班拦截，同班型平转 vs 异价/异时长强制按新班整节课(Lessons)记账；
   * 6. 场景 D（又转人又转课）：严禁合并，系统强力拦截并引导分两步独立审批。
   *
   * @param {Object} params - { package_id, transfer_type, hours_to_transfer, target_student_id, target_course_id, target_class_id, remainder_option }
   * @returns {Object} 试算结果对象
   */
  previewTransfer(params = {}) {
    const {
      package_id,
      transfer_type,
      hours_to_transfer,
      target_student_id,
      target_course_id,
      target_class_id,
      remainder_option = 'top_up' // 'top_up' | 'refund_change'
    } = params

    if (!package_id) throw new Error('必须指定转出课时包ID')
    const sourcePkg = db.getById(db.TABLES.COURSE_PACKAGES, package_id)
    if (!sourcePkg) throw new Error(`未找到转出课时包 #${package_id}`)

    const sourceStudent = db.getById(db.TABLES.STUDENTS, sourcePkg.student_id) || { name: sourcePkg.student_name_snapshot || '原学员' }
    const sourceCourse = db.getById(db.TABLES.COURSES_AND_CLASS_TYPES, sourcePkg.course_id) || { course_name: sourcePkg.course_name_snapshot || '原课程' }

    // ─────────────────────────────────────────
    // 铁律 场景 D 拦截：严禁同时转人又转课
    // ─────────────────────────────────────────
    const isDiffStudent = target_student_id && target_student_id !== sourcePkg.student_id
    const isDiffCourse = target_course_id && target_course_id !== sourcePkg.course_id

    if (isDiffStudent && isDiffCourse) {
      throw new Error('【内控铁律拦截】系统严禁同时转人又转课！必须强制拆单为两笔：第一步在原课程下平转给目标学员并由超管审批通过；第二步由目标学员发起跨课程转课并由超管二次审批。')
    }

    if (!['transfer_student', 'transfer_course', 'transfer_class'].includes(transfer_type)) {
      throw new Error('转移类型必须为 转人(transfer_student)、转课(transfer_course) 或 转班(transfer_class)')
    }

    const curPaid = Number(sourcePkg.paid_hours_left || 0)
    const curGift = Number(sourcePkg.gift_hours_left || 0)
    const curTotal = Number((curPaid + curGift).toFixed(2))

    let hoursNum = parseFloat(hours_to_transfer)
    if (isNaN(hoursNum) || hoursNum <= 0) {
      throw new Error('转出课时数必须大于0')
    }
    hoursNum = Number(hoursNum.toFixed(2))

    if (hoursNum > curTotal) {
      throw new Error(`申请转出课时(${hoursNum})超过该课时包当前可用总课时(${curTotal}课时)`)
    }

    // ─────────────────────────────────────────
    // 铁律 1：先付费后赠送分解
    // ─────────────────────────────────────────
    const transferredPaid = Math.min(curPaid, hoursNum)
    const transferredGift = Math.min(curGift, Number((hoursNum - transferredPaid).toFixed(2)))
    const transferredTotal = Number((transferredPaid + transferredGift).toFixed(2))

    const remainingPaid = Number((curPaid - transferredPaid).toFixed(2))
    const remainingGift = Number((curGift - transferredGift).toFixed(2))
    const remainingTotal = Number((remainingPaid + remainingGift).toFixed(2))

    const sourceUnitPrice = Number(sourcePkg.unit_price_snapshot || 0)
    const expireDate = sourcePkg.expire_date // 铁律：原到期日严格不变

    let result = {
      transfer_type,
      package_id,
      source_student_id: sourcePkg.student_id,
      source_student_name: sourceStudent.name,
      source_course_id: sourcePkg.course_id,
      source_course_name: sourceCourse.course_name,
      source_unit_price: sourceUnitPrice,
      source_expire_date: expireDate,
      transferred_paid_hours: transferredPaid,
      transferred_gift_hours: transferredGift,
      transferred_total_hours: transferredTotal,
      remaining_paid_hours: remainingPaid,
      remaining_gift_hours: remainingGift,
      remaining_total_hours: remainingTotal,
      expire_date: expireDate, // 严格沿用
      remainder_option,
      top_up_amount: 0,
      refund_amount: 0
    }

    // ─────────────────────────────────────────
    // 场景 A：转人（同课程平转）
    // ─────────────────────────────────────────
    if (transfer_type === 'transfer_student') {
      if (!target_student_id) throw new Error('请选择转入目标学员')
      if (target_student_id === sourcePkg.student_id) throw new Error('转入学员不能与原转出学员相同')

      const targetStudent = db.getById(db.TABLES.STUDENTS, target_student_id)
      if (!targetStudent) throw new Error(`未找到目标转入学员 #${target_student_id}`)

      result = Object.assign(result, {
        transfer_type_name: '转人（同课程平转）',
        target_student_id: targetStudent.id,
        target_student_name: targetStudent.name,
        target_course_id: sourcePkg.course_id,
        target_course_name: sourceCourse.course_name,
        target_unit_price: sourceUnitPrice,
        target_paid_hours: transferredPaid,
        target_gift_hours: transferredGift,
        target_total_hours: transferredTotal,
        top_up_amount: 0,
        refund_amount: 0,
        summary_desc: `学员【${sourceStudent.name}】转给【${targetStudent.name}】同课程(${sourceCourse.course_name})课时 ${transferredTotal} 课时 (付费:${transferredPaid}, 赠送:${transferredGift})，1:1平转，原到期日不变。`
      })
      return result
    }

    // ─────────────────────────────────────────
    // 场景 B：跨课程转课（按钱换算 + 赠送平转）
    // ─────────────────────────────────────────
    if (transfer_type === 'transfer_course') {
      if (!target_course_id) throw new Error('请选择转入目标新课程')
      if (target_course_id === sourcePkg.course_id) throw new Error('目标新课程不能与原课程相同（跨课程才能转课）')

      const targetCourse = db.getById(db.TABLES.COURSES_AND_CLASS_TYPES, target_course_id)
      if (!targetCourse) throw new Error(`未找到目标新课程 #${target_course_id}`)

      const targetUnitPrice = Number(targetCourse.unit_price || 0)
      if (targetUnitPrice <= 0) throw new Error('目标新课程单价异常')

      const transferredPaidValue = Number((transferredPaid * sourceUnitPrice).toFixed(2))
      const rawTargetPaidHours = transferredPaidValue / targetUnitPrice

      let targetPaidHours = 0
      let topUpAmount = 0
      let refundAmount = 0

      // 判断是否除得尽凑成整数
      const isExactInteger = Math.abs(rawTargetPaidHours - Math.round(rawTargetPaidHours)) < 0.0001

      if (isExactInteger) {
        targetPaidHours = Math.round(rawTargetPaidHours)
      } else if (remainder_option === 'top_up') {
        targetPaidHours = Math.ceil(rawTargetPaidHours)
        topUpAmount = Number((targetPaidHours * targetUnitPrice - transferredPaidValue).toFixed(2))
      } else {
        // refund_change
        targetPaidHours = Math.floor(rawTargetPaidHours)
        refundAmount = Number((transferredPaidValue - targetPaidHours * targetUnitPrice).toFixed(2))
      }

      const targetGiftHours = transferredGift // 赠送课时1:1平转
      const targetTotalHours = Number((targetPaidHours + targetGiftHours).toFixed(2))

      result = Object.assign(result, {
        transfer_type_name: '跨课程转课（按钱换算）',
        target_student_id: sourcePkg.student_id,
        target_student_name: sourceStudent.name,
        target_course_id: targetCourse.id,
        target_course_name: targetCourse.course_name,
        target_unit_price: targetUnitPrice,
        transferred_paid_value: transferredPaidValue,
        raw_target_paid_hours: Number(rawTargetPaidHours.toFixed(2)),
        target_paid_hours: targetPaidHours,
        target_gift_hours: targetGiftHours,
        target_total_hours: targetTotalHours,
        top_up_amount: topUpAmount,
        refund_amount: refundAmount,
        summary_desc: `跨课程自【${sourceCourse.course_name}】(原单价¥${sourceUnitPrice})转入【${targetCourse.course_name}】(新单价¥${targetUnitPrice})。付费课时价值¥${transferredPaidValue}，换算付费课时${targetPaidHours}课时(赠送平转${targetGiftHours}课时)${topUpAmount > 0 ? `，家长补交差价¥${topUpAmount}` : ''}${refundAmount > 0 ? `，退还家长零头¥${refundAmount}` : ''}。原到期日不变。`
      })
      return result
    }

    // ─────────────────────────────────────────
    // 场景 C：转班（满班拦截 + 强制按新班整节课换算）
    // ─────────────────────────────────────────
    if (transfer_type === 'transfer_class') {
      if (!target_class_id) throw new Error('请选择转入目标班级')
      if (target_class_id === sourcePkg.class_id) throw new Error('目标新班级不能与原班级相同')

      const targetClass = db.getById(db.TABLES.CLASSES, target_class_id)
      if (!targetClass) throw new Error(`未找到目标班级 #${target_class_id}`)

      // 满班硬性拦截
      const enrolled = targetClass.enrolled_student_ids || []
      const maxCap = Number(targetClass.max_capacity_snapshot || 3)
      if (enrolled.length >= maxCap) {
        throw new Error(`【满班拦截】新班【${targetClass.name}】当前已有 ${enrolled.length} 人，已达封顶人数(${maxCap}人)，不可转入！`)
      }

      const targetUnitPrice = Number(targetClass.unit_price_snapshot || 0)
      const targetHoursPerLesson = Number(targetClass.hours_per_lesson_snapshot || 1.0)
      const targetLessonCost = Number((targetUnitPrice * targetHoursPerLesson).toFixed(2))

      const sourceClass = sourcePkg.class_id ? db.getById(db.TABLES.CLASSES, sourcePkg.class_id) : null
      const sourceHoursPerLesson = sourceClass ? Number(sourceClass.hours_per_lesson_snapshot || 1.0) : targetHoursPerLesson

      // 判定是否同班型转班（单价相同且每次课时长相同）
      const isSameClassType = (sourceUnitPrice === targetUnitPrice) && (sourceHoursPerLesson === targetHoursPerLesson)

      let targetPaidHours = 0
      let targetLessons = 0
      let topUpAmount = 0
      let refundAmount = 0
      let transferredPaidValue = Number((transferredPaid * sourceUnitPrice).toFixed(2))

      if (isSameClassType) {
        // 同班型平转：不用换算
        targetPaidHours = transferredPaid
        targetLessons = targetHoursPerLesson > 0 ? Number((targetPaidHours / targetHoursPerLesson).toFixed(2)) : 0
      } else {
        // 异价或异时长班：强制按新班“整节课 Lessons”记账
        const rawLessons = transferredPaidValue / targetLessonCost
        const isExactLessons = Math.abs(rawLessons - Math.round(rawLessons)) < 0.0001

        if (isExactLessons) {
          targetLessons = Math.round(rawLessons)
          targetPaidHours = Number((targetLessons * targetHoursPerLesson).toFixed(2))
        } else if (remainder_option === 'top_up') {
          targetLessons = Math.ceil(rawLessons)
          targetPaidHours = Number((targetLessons * targetHoursPerLesson).toFixed(2))
          topUpAmount = Number((targetLessons * targetLessonCost - transferredPaidValue).toFixed(2))
        } else {
          // refund_change
          targetLessons = Math.floor(rawLessons)
          targetPaidHours = Number((targetLessons * targetHoursPerLesson).toFixed(2))
          refundAmount = Number((transferredPaidValue - targetLessons * targetLessonCost).toFixed(2))
        }
      }

      const targetGiftHours = transferredGift // 赠送课时1:1平转
      const targetTotalHours = Number((targetPaidHours + targetGiftHours).toFixed(2))

      result = Object.assign(result, {
        transfer_type_name: isSameClassType ? '同班型转班（平转）' : '异价/异时长转班（按整节课换算）',
        target_student_id: sourcePkg.student_id,
        target_student_name: sourceStudent.name,
        target_course_id: targetClass.course_id,
        target_course_name: targetClass.name,
        target_class_id: targetClass.id,
        target_class_name: targetClass.name,
        target_unit_price: targetUnitPrice,
        target_hours_per_lesson: targetHoursPerLesson,
        target_lesson_cost: targetLessonCost,
        target_lessons: targetLessons,
        transferred_paid_value: transferredPaidValue,
        target_paid_hours: targetPaidHours,
        target_gift_hours: targetGiftHours,
        target_total_hours: targetTotalHours,
        top_up_amount: topUpAmount,
        refund_amount: refundAmount,
        summary_desc: `学员【${sourceStudent.name}】转入新班【${targetClass.name}】(当前${enrolled.length}/${maxCap}人)。${isSameClassType ? '同班型平转，课时直接跟随。' : `按新班单节¥${targetLessonCost}(${targetHoursPerLesson}课时/节)强制整节换算为 ${targetLessons} 节课(${targetPaidHours}课时)${topUpAmount > 0 ? `，家长补差¥${topUpAmount}` : ''}${refundAmount > 0 ? `，退零头¥${refundAmount}` : ''}。`}原到期日不变。`
      })
      return result
    }

    return result
  },

  /**
   * 提交三转申请（转人 / 转课 / 转班）
   * 立即施加并发锁，提交至 approval_requests 由超级管理员审批
   */
  submitTransferRequest(params = {}, operatorUser = null) {
    if (typeof wx !== 'undefined' && typeof wx.request === 'function' && !db.inServerTransaction()) return require('./commandClient').run('approval.propose',{type:'transfer',data:params})
    // 1. 试算并严格校验所有业务规则
    const preview = this.previewTransfer(params)

    const sourcePkg = db.getById(db.TABLES.COURSE_PACKAGES, params.package_id)
    if (!sourcePkg) throw new Error('未找到转出课时包')

    // 2. 检查审批并发锁
    if (sourcePkg.lock_status === 'pending_approval_locked') {
      throw new Error('该课时包当前有一笔待超级管理员审批的变更单，请等待审批完成或撤回后再操作')
    }

    const { reason = '' } = params
    if (!reason || !reason.trim() || reason.trim().length < 2) {
      throw new Error('必须填写转移详细原因（不可为空，至少2字）')
    }

    const nowIso = new Date().toISOString()
    const reqId = 'req_trf_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

    const snapshotBalance = {
      paid_hours_left: Number(sourcePkg.paid_hours_left || 0),
      gift_hours_left: Number(sourcePkg.gift_hours_left || 0),
      total_available_hours: Number((Number(sourcePkg.paid_hours_left || 0) + Number(sourcePkg.gift_hours_left || 0)).toFixed(2)),
      snapshot_at: nowIso
    }

    // 3. 立即施加审批并发锁
    this.acquirePackageConcurrencyLock(
      sourcePkg.id,
      reqId,
      snapshotBalance,
      `发起${preview.transfer_type_name}申请: ${preview.summary_desc}`,
      operatorUser
    )

    const proposerId = operatorUser ? operatorUser.id : 'u_adm1'
    const proposerName = operatorUser ? operatorUser.name : '教务管理'

    const beforeSnapshot = {
      package_id: sourcePkg.id,
      student_id: sourcePkg.student_id,
      student_name: preview.source_student_name,
      course_id: sourcePkg.course_id,
      course_name: preview.source_course_name,
      class_id: sourcePkg.class_id,
      paid_hours_left: sourcePkg.paid_hours_left,
      gift_hours_left: sourcePkg.gift_hours_left,
      expire_date: sourcePkg.expire_date,
      snapshot_balance_at_propose: snapshotBalance
    }

    const afterPayload = Object.assign({}, preview, {
      reason: reason.trim(),
      proposer_id: proposerId,
      proposer_name: proposerName,
      snapshot_balance_at_propose: snapshotBalance
    })

    // 4. 提交审批流（必须超级管理员独批）
    const approvalReq = {
      id: reqId,
      request_type: 'transfer',
      proposer_id: proposerId,
      proposer_name: proposerName,
      target_table: db.TABLES.COURSE_PACKAGES,
      target_record_id: sourcePkg.id,
      reason: `[${preview.transfer_type_name}] 学员【${preview.source_student_name}】转出 ${preview.transferred_total_hours} 课时。原因：${reason.trim()}`,
      before_data_json: JSON.stringify(beforeSnapshot),
      after_data_json: JSON.stringify(afterPayload),
      status: 'pending',
      action_time: nowIso
    }

    db.insert(
      db.TABLES.APPROVAL_REQUESTS,
      approvalReq,
      `[提交三转申请] 课时包 #${sourcePkg.id} 申请${preview.transfer_type_name}`
    )

    return {
      approval_request: approvalReq,
      preview: preview
    }
  },

  /**
   * 超级管理员批准三转申请（转人 / 转课 / 转班）
   * 执行原包扣减、新包落库、转班移入、释放并发锁与建立留痕台账
   */
  applyTransferApproval(approvalItem, approverUser) {
    if (!approvalItem || !approvalItem.target_record_id) return null

    // 铁律：超管独批
    if (approverUser && approverUser.role !== 'super_admin') {
      throw new Error('权限拦截：仅超级管理员(super_admin)一人有权审批转班/转课/转人申请')
    }

    // 自审拦截
    if (approverUser && approverUser.id === approvalItem.proposer_id) {
      throw new Error('违反内控铁律：不能审批自己发起的转移申请！请切换其他超管账号')
    }

    const sourcePkg = db.getById(db.TABLES.COURSE_PACKAGES, approvalItem.target_record_id)
    if (!sourcePkg) throw new Error(`未找到转出源课时包 #${approvalItem.target_record_id}`)

    let beforeData = {}
    let afterData = {}
    try {
      beforeData = typeof approvalItem.before_data_json === 'string'
        ? JSON.parse(approvalItem.before_data_json)
        : (approvalItem.before_data_json || {})
      afterData = typeof approvalItem.after_data_json === 'string'
        ? JSON.parse(approvalItem.after_data_json)
        : (approvalItem.after_data_json || {})
    } catch (e) {
      throw new Error('审批单快照数据解析异常')
    }

    // 二次余额校验与破锁
    const verifyRes = this.verifyPackageBalanceSnapshot(sourcePkg.id, beforeData.snapshot_balance_at_propose)
    if (!verifyRes.isValid) {
      this.releasePackageConcurrencyLock(sourcePkg.id, approverUser, '考勤消课余额变动，释放审批锁')
      db.update(
        db.TABLES.APPROVAL_REQUESTS,
        approvalItem.id,
        {
          status: 'invalidated_by_attendance',
          reject_reason: verifyRes.reason,
          reviewed_at: new Date().toISOString()
        },
        `[并发破锁] 三转申请单 #${approvalItem.id} 因考勤消课余额变动自动废止`
      )
      throw new Error(verifyRes.reason)
    }

    const nowIso = new Date().toISOString()
    const transferType = afterData.transfer_type

    // 1. 扣减源课时包余额并释放并发锁
    const newPaidLeft = Number((Number(sourcePkg.paid_hours_left || 0) - Number(afterData.transferred_paid_hours || 0)).toFixed(2))
    const newGiftLeft = Number((Number(sourcePkg.gift_hours_left || 0) - Number(afterData.transferred_gift_hours || 0)).toFixed(2))

    if (newPaidLeft < 0 || newGiftLeft < 0) {
      this.releasePackageConcurrencyLock(sourcePkg.id, approverUser, '防负数拦截释放锁')
      throw new Error('【防负数拦截】转出后原课时包余额为负，拒绝执行！')
    }

    db.update(
      db.TABLES.COURSE_PACKAGES,
      sourcePkg.id,
      {
        paid_hours_left: newPaidLeft,
        gift_hours_left: newGiftLeft,
        lock_status: 'unlocked',
        locked_by_approval_id: null,
        snapshot_balance_at_propose: null
      },
      `[三转执行-源包扣减] 课时包 #${sourcePkg.id} 转出付费${afterData.transferred_paid_hours}课时, 赠送${afterData.transferred_gift_hours}课时，剩余付费:${newPaidLeft}, 赠送:${newGiftLeft}`
    )

    let createdPackageId = null

    // ─────────────────────────────────────────
    // 场景 A：转人（同课程新增目标学员课时包）
    // ─────────────────────────────────────────
    if (transferType === 'transfer_student') {
      const targetPkgRecord = {
        student_id: afterData.target_student_id,
        student_name_snapshot: afterData.target_student_name,
        course_id: sourcePkg.course_id,
        course_name_snapshot: sourcePkg.course_name_snapshot,
        class_id: null,
        paid_hours_total: afterData.target_paid_hours,
        paid_hours_left: afterData.target_paid_hours,
        gift_hours_total: afterData.target_gift_hours,
        gift_hours_left: afterData.target_gift_hours,
        unit_price_snapshot: sourcePkg.unit_price_snapshot,
        account_destination: sourcePkg.account_destination,
        term_id: sourcePkg.term_id,
        term_name_snapshot: sourcePkg.term_name_snapshot,
        expire_date: sourcePkg.expire_date, // 铁律：原到期日严格不变
        total_frozen_days: 0,
        debt_hours: 0,
        lock_status: 'normal',
        locked_by_approval_id: null,
        source_transfer_package_id: sourcePkg.id
      }

      const newPkg = db.insert(
        db.TABLES.COURSE_PACKAGES,
        targetPkgRecord,
        `[三转-转人完成] 学员【${afterData.target_student_name}】接收学员【${beforeData.student_name}】转入 ${afterData.target_total_hours} 课时`
      )
      createdPackageId = newPkg.id
    }

    // ─────────────────────────────────────────
    // 场景 B：跨课程转课（原学员名下新增目标新课程课时包）
    // ─────────────────────────────────────────
    if (transferType === 'transfer_course') {
      const targetPkgRecord = {
        student_id: sourcePkg.student_id,
        student_name_snapshot: beforeData.student_name,
        course_id: afterData.target_course_id,
        course_name_snapshot: afterData.target_course_name,
        class_id: null,
        paid_hours_total: afterData.target_paid_hours,
        paid_hours_left: afterData.target_paid_hours,
        gift_hours_total: afterData.target_gift_hours,
        gift_hours_left: afterData.target_gift_hours,
        unit_price_snapshot: afterData.target_unit_price,
        account_destination: sourcePkg.account_destination,
        term_id: sourcePkg.term_id,
        term_name_snapshot: sourcePkg.term_name_snapshot,
        expire_date: sourcePkg.expire_date, // 铁律：原到期日严格不变
        total_frozen_days: 0,
        debt_hours: 0,
        lock_status: 'normal',
        locked_by_approval_id: null,
        source_transfer_package_id: sourcePkg.id
      }

      const newPkg = db.insert(
        db.TABLES.COURSE_PACKAGES,
        targetPkgRecord,
        `[三转-转课完成] 学员【${beforeData.student_name}】跨课程换算转入【${afterData.target_course_name}】${afterData.target_total_hours} 课时`
      )
      createdPackageId = newPkg.id
    }

    // ─────────────────────────────────────────
    // 场景 C：转班（满班校验、班级移入、按整节课换算落库）
    // ─────────────────────────────────────────
    if (transferType === 'transfer_class') {
      const targetClass = db.getById(db.TABLES.CLASSES, afterData.target_class_id)
      if (!targetClass) throw new Error(`未找到目标班级 #${afterData.target_class_id}`)

      // 再次校验封顶人数
      const enrolled = targetClass.enrolled_student_ids || []
      const maxCap = Number(targetClass.max_capacity_snapshot || 3)
      if (enrolled.length >= maxCap && !enrolled.includes(sourcePkg.student_id)) {
        throw new Error(`【满班拦截】新班【${targetClass.name}】已达封顶(${maxCap}人)，无法转入！`)
      }

      // 将学员从原班移除并移入新班
      if (sourcePkg.class_id) {
        const sourceClass = db.getById(db.TABLES.CLASSES, sourcePkg.class_id)
        if (sourceClass && sourceClass.enrolled_student_ids) {
          const updatedOldEnrolled = sourceClass.enrolled_student_ids.filter(id => id !== sourcePkg.student_id)
          db.update(
            db.TABLES.CLASSES,
            sourceClass.id,
            { enrolled_student_ids: updatedOldEnrolled },
            `[三转-原班移出] 学员【${beforeData.student_name}】转出原班【${sourceClass.name}】`
          )
        }
      }

      if (!enrolled.includes(sourcePkg.student_id)) {
        const updatedNewEnrolled = [...enrolled, sourcePkg.student_id]
        db.update(
          db.TABLES.CLASSES,
          targetClass.id,
          { enrolled_student_ids: updatedNewEnrolled },
          `[三转-新班移入] 学员【${beforeData.student_name}】正式移入新班【${targetClass.name}】`
        )
      }

      // 建立挂载新班的新课时包
      const targetPkgRecord = {
        student_id: sourcePkg.student_id,
        student_name_snapshot: beforeData.student_name,
        course_id: targetClass.course_id,
        course_name_snapshot: targetClass.name,
        class_id: targetClass.id,
        paid_hours_total: afterData.target_paid_hours,
        paid_hours_left: afterData.target_paid_hours,
        gift_hours_total: afterData.target_gift_hours,
        gift_hours_left: afterData.target_gift_hours,
        unit_price_snapshot: afterData.target_unit_price,
        account_destination: sourcePkg.account_destination,
        term_id: targetClass.term_id || sourcePkg.term_id,
        expire_date: sourcePkg.expire_date, // 铁律：原到期日严格不变
        total_frozen_days: 0,
        debt_hours: 0,
        lock_status: 'normal',
        locked_by_approval_id: null,
        source_transfer_package_id: sourcePkg.id
      }

      const newPkg = db.insert(
        db.TABLES.COURSE_PACKAGES,
        targetPkgRecord,
        `[三转-转班完成] 学员【${beforeData.student_name}】转入班级【${targetClass.name}】课时包建立(${afterData.target_paid_hours}付费+${afterData.target_gift_hours}赠送)`
      )
      createdPackageId = newPkg.id
    }

    // 2. 建立不可篡改三转独立台账 transfer_records
    const transferRecord = {
      id: 'trf_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      approval_id: approvalItem.id,
      transfer_type: transferType,
      transfer_type_name: afterData.transfer_type_name,
      source_package_id: sourcePkg.id,
      created_package_id: createdPackageId,
      source_student_id: sourcePkg.student_id,
      source_student_name: beforeData.student_name,
      target_student_id: afterData.target_student_id || sourcePkg.student_id,
      target_student_name: afterData.target_student_name || beforeData.student_name,
      source_course_id: sourcePkg.course_id,
      source_course_name: beforeData.course_name,
      target_course_id: afterData.target_course_id || sourcePkg.course_id,
      target_course_name: afterData.target_course_name || beforeData.course_name,
      source_class_id: sourcePkg.class_id || null,
      target_class_id: afterData.target_class_id || null,
      transferred_paid_hours: afterData.transferred_paid_hours,
      transferred_gift_hours: afterData.transferred_gift_hours,
      target_paid_hours: afterData.target_paid_hours,
      target_gift_hours: afterData.target_gift_hours,
      target_lessons: afterData.target_lessons || null,
      remainder_option: afterData.remainder_option || null,
      top_up_amount: Number(afterData.top_up_amount || 0),
      refund_amount: Number(afterData.refund_amount || 0),
      reason: afterData.reason,
      operator_id: approvalItem.proposer_id,
      operator_name: approvalItem.proposer_name,
      approver_id: approverUser ? approverUser.id : 'u_sa1',
      approver_name: approverUser ? approverUser.name : '超级管理员',
      approved_time: nowIso,
      created_at: nowIso,
      updated_at: nowIso
    }

    db.insert(
      db.TABLES.TRANSFER_RECORDS,
      transferRecord,
      `[三转执行留痕] ${afterData.transfer_type_name} 单据 #${transferRecord.id} 已执行归档 (补差:¥${transferRecord.top_up_amount}, 退零头:¥${transferRecord.refund_amount})`
    )

    return {
      transfer_record: transferRecord,
      created_package_id: createdPackageId
    }
  },

  /**
   * 超级管理员驳回三转申请（自动释放并发锁）
   */
  rejectTransferApproval(approvalItem, rejectReason, approverUser) {
    if (!approvalItem || !approvalItem.target_record_id) return null

    // 释放并发锁
    this.releasePackageConcurrencyLock(approvalItem.target_record_id, approverUser, '超管驳回三转申请，释放并发锁')

    return {
      package_id: approvalItem.target_record_id,
      status: 'rejected',
      reject_reason: rejectReason
    }
  },

  /**
   * 查询三转历史流水列表
   */
  getTransferHistory(filter = {}) {
    const list = db.getTable(db.TABLES.TRANSFER_RECORDS) || []
    return list.filter(item => {
      if (filter.transfer_type && item.transfer_type !== filter.transfer_type) return false
      if (filter.student_id && item.source_student_id !== filter.student_id && item.target_student_id !== filter.student_id) return false
      if (filter.source_package_id && item.source_package_id !== filter.source_package_id) return false
      return true
    }).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
  },

  // ─────────────────────────────────────────
  // 6. Phase 5-C：退费核算引擎与四期到期顺延处理
  // ─────────────────────────────────────────

  /**
   * 判断资金去向是否为个人账户（免手续费）
   * @param {string} destination 
   * @returns {boolean}
   */
  _isPersonalAccount(destination) {
    if (!destination) return false
    return destination === '进入个人账户' || destination.indexOf('个人') !== -1 || destination.indexOf('对私') !== -1
  },

  /**
   * 退费试算预览接口
   * 
   * 核心业务铁律（100%严格执行）：
   * 1. 赠送课时绝不退费：仅退还剩余付费课时，赠送课时一分钱不退；
   * 2. 按原价快照核算：应退总额 = paid_hours_left × unit_price_snapshot；
   * 3. 手续费双轨规则：
   *    - 个人账户：强制 0 手续费（不可更改）；
   *    - 公账账户：由管理员手动输入手续费（0 <= 手续费 <= 应退总额）；
   * 4. 实际退款金额 = 应退总额 - 手续费；
   * 5. 计算已上课时留存档案。
   *
   * @param {string} packageId - 课时包ID
   * @param {Object} params - { handling_fee, refund_method, refund_reason }
   * @returns {Object} 试算结果对象
   */
  previewRefund(packageId, params = {}) {
    if (!packageId) throw new Error('必须指定退费课时包ID')
    const sourcePkg = db.getById(db.TABLES.COURSE_PACKAGES, packageId)
    if (!sourcePkg) throw new Error(`未找到课时包 #${packageId}`)

    if (sourcePkg.lock_status === 'refunded' || sourcePkg.refund_status === 'refunded') {
      throw new Error('该课时包已被退费核销，无法重复发起退费')
    }

    const curPaid = Number(sourcePkg.paid_hours_left || 0)
    const curGift = Number(sourcePkg.gift_hours_left || 0)
    const curTotal = Number((curPaid + curGift).toFixed(2))

    if (curTotal <= 0) {
      throw new Error('该课时包已无可用课时，无需退费')
    }

    const student = db.getById(db.TABLES.STUDENTS, sourcePkg.student_id) || { name: sourcePkg.student_name_snapshot || '学员' }
    const course = db.getById(db.TABLES.COURSES_AND_CLASS_TYPES, sourcePkg.course_id) || { course_name: sourcePkg.course_name_snapshot || '课程' }

    const unitPrice = Number(sourcePkg.unit_price_snapshot || 0)
    // 铁律：只退付费课时，按购买时单价快照折算
    const grossRefund = Number((curPaid * unitPrice).toFixed(2))

    const accountDest = sourcePkg.account_destination || ''
    const isPersonal = this._isPersonalAccount(accountDest)

    let handlingFee = 0
    if (isPersonal) {
      // 个人账户：强制锁定为 0，不收手续费
      handlingFee = 0
    } else {
      // 公账账户：管理员手动填写
      if (params.handling_fee !== undefined && params.handling_fee !== null && params.handling_fee !== '') {
        handlingFee = parseFloat(params.handling_fee)
        if (isNaN(handlingFee) || handlingFee < 0) {
          throw new Error('手续费必须为大于或等于0的数字')
        }
        handlingFee = Number(handlingFee.toFixed(2))
        if (handlingFee > grossRefund) {
          throw new Error(`手续费(¥${handlingFee})不能大于应退学费总额(¥${grossRefund})`)
        }
      } else {
        handlingFee = 0
      }
    }

    const netRefund = Number((grossRefund - handlingFee).toFixed(2))

    // 统计已上课时
    const paidTotal = Number(sourcePkg.paid_hours_total || 0)
    const giftTotal = Number(sourcePkg.gift_hours_total || 0)
    const paidUsed = Number((paidTotal - curPaid).toFixed(2))
    const giftUsed = Number((giftTotal - curGift).toFixed(2))
    const totalUsed = Number((paidUsed + giftUsed).toFixed(2))

    const refundMethod = params.refund_method || '微信转账'
    const refundReason = (params.refund_reason || params.reason || '').trim()

    return {
      package_id: sourcePkg.id,
      student_id: sourcePkg.student_id,
      student_name: student.name,
      course_id: sourcePkg.course_id,
      course_name: course.course_name,
      class_id: sourcePkg.class_id || null,
      term_id: sourcePkg.term_id || null,
      unit_price_snapshot: unitPrice,
      account_destination: accountDest,
      is_personal_account: isPersonal,
      paid_hours_total: paidTotal,
      gift_hours_total: giftTotal,
      paid_hours_used: paidUsed,
      gift_hours_used: giftUsed,
      total_hours_used: totalUsed,
      paid_hours_left: curPaid,
      gift_hours_left: curGift,
      gift_hours_forfeited: curGift, // 作废赠送课时
      gross_refund: grossRefund,
      handling_fee: handlingFee,
      net_refund: netRefund,
      refund_method: refundMethod,
      refund_reason: refundReason,
      expire_date: sourcePkg.expire_date,
      summary_desc: `学员【${student.name}】退费核算：剩余付费课时 ${curPaid} 课时(原单价¥${unitPrice})，应退学费¥${grossRefund}；作废赠送课时 ${curGift} 课时；资金去向【${accountDest}】(${isPersonal ? '个人账户免手续费' : `公账扣除手续费¥${handlingFee}`})；实际退还¥${netRefund} (方式:${refundMethod})。`
    }
  },

  /**
   * 提交退费清算申请
   * 立即施加并发锁，提交至 approval_requests 由超级管理员独批
   */
  submitRefundRequest(params = {}, operatorUser = null) {
    if (typeof wx !== 'undefined' && typeof wx.request === 'function' && !db.inServerTransaction()) return require('./commandClient').run('approval.propose',{type:'refund',data:params})
    const packageId = params.package_id || params.packageId
    if (!packageId) throw new Error('必须指定退费课时包ID')

    const sourcePkg = db.getById(db.TABLES.COURSE_PACKAGES, packageId)
    if (!sourcePkg) throw new Error('未找到指定课时包')

    // 检查审批并发锁
    if (sourcePkg.lock_status === 'pending_approval_locked') {
      throw new Error('该课时包当前有一笔待超级管理员审批的变更单，请等待审批完成或撤回后再操作')
    }

    if (sourcePkg.lock_status === 'refunded' || sourcePkg.refund_status === 'refunded') {
      throw new Error('该课时包已被退费核销，无法重复发起退费')
    }

    const refundMethod = (params.refund_method || '微信转账').trim()
    const refundReason = (params.refund_reason || params.reason || '').trim()

    if (!refundReason || refundReason.length < 2) {
      throw new Error('必须填写详细退费原因（不可为空，至少2字）')
    }

    // 执行试算核验
    const preview = this.previewRefund(packageId, Object.assign({}, params, { refund_method: refundMethod, refund_reason: refundReason }))

    const nowIso = new Date().toISOString()
    const reqId = 'req_ref_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

    const snapshotBalance = {
      paid_hours_left: preview.paid_hours_left,
      gift_hours_left: preview.gift_hours_left,
      total_available_hours: Number((preview.paid_hours_left + preview.gift_hours_left).toFixed(2)),
      snapshot_at: nowIso
    }

    // 立即施加审批并发锁
    this.acquirePackageConcurrencyLock(
      sourcePkg.id,
      reqId,
      snapshotBalance,
      `发起退费清算申请: ${preview.summary_desc}`,
      operatorUser
    )

    const proposerId = operatorUser ? operatorUser.id : 'u_adm2'
    const proposerName = operatorUser ? operatorUser.name : '教务/财务'

    const beforeSnapshot = {
      package_id: sourcePkg.id,
      student_id: sourcePkg.student_id,
      student_name: preview.student_name,
      course_id: sourcePkg.course_id,
      course_name: preview.course_name,
      class_id: sourcePkg.class_id,
      paid_hours_left: sourcePkg.paid_hours_left,
      gift_hours_left: sourcePkg.gift_hours_left,
      unit_price_snapshot: sourcePkg.unit_price_snapshot,
      account_destination: sourcePkg.account_destination,
      expire_date: sourcePkg.expire_date,
      snapshot_balance_at_propose: snapshotBalance
    }

    const afterPayload = Object.assign({}, preview, {
      proposer_id: proposerId,
      proposer_name: proposerName,
      snapshot_balance_at_propose: snapshotBalance
    })

    const approvalReq = {
      id: reqId,
      request_type: 'refund',
      proposer_id: proposerId,
      proposer_name: proposerName,
      target_table: db.TABLES.COURSE_PACKAGES,
      target_record_id: sourcePkg.id,
      reason: `[退费清算] 学员【${preview.student_name}】退费 (应退:¥${preview.gross_refund}, 手续费:¥${preview.handling_fee}, 实退:¥${preview.net_refund}, 退还方式:${refundMethod})。原因：${refundReason}`,
      before_data_json: JSON.stringify(beforeSnapshot),
      after_data_json: JSON.stringify(afterPayload),
      status: 'pending',
      action_time: nowIso
    }

    db.insert(
      db.TABLES.APPROVAL_REQUESTS,
      approvalReq,
      `[提交退费申请] 课时包 #${sourcePkg.id} 申请退费清算`
    )

    return {
      approval_request: approvalReq,
      preview: preview
    }
  },

  /**
   * 超级管理员批准退费清算申请
   * 执行原包课时清零作废、同步退班解绑、释放并发锁并建立不可篡改退费档案
   */
  applyRefundApproval(approvalItem, approverUser) {
    if (!approvalItem || !approvalItem.target_record_id) return null

    // 铁律：超管独批
    if (approverUser && approverUser.role !== 'super_admin') {
      throw new Error('权限拦截：仅超级管理员(super_admin)一人有权审批退费清算申请')
    }

    // 自审拦截
    if (approverUser && approverUser.id === approvalItem.proposer_id) {
      throw new Error('违反内控铁律：不能审批自己发起的退费申请！请切换其他超管账号')
    }

    const sourcePkg = db.getById(db.TABLES.COURSE_PACKAGES, approvalItem.target_record_id)
    if (!sourcePkg) throw new Error(`未找到退费源课时包 #${approvalItem.target_record_id}`)

    let beforeData = {}
    let afterData = {}
    try {
      beforeData = typeof approvalItem.before_data_json === 'string'
        ? JSON.parse(approvalItem.before_data_json)
        : (approvalItem.before_data_json || {})
      afterData = typeof approvalItem.after_data_json === 'string'
        ? JSON.parse(approvalItem.after_data_json)
        : (approvalItem.after_data_json || {})
    } catch (e) {
      throw new Error('审批单快照数据解析异常')
    }

    // 二次余额校验与破锁机制
    const verifyRes = this.verifyPackageBalanceSnapshot(sourcePkg.id, beforeData.snapshot_balance_at_propose)
    if (!verifyRes.isValid) {
      this.releasePackageConcurrencyLock(sourcePkg.id, approverUser, '考勤消课余额变动，释放审批锁')
      db.update(
        db.TABLES.APPROVAL_REQUESTS,
        approvalItem.id,
        {
          status: 'invalidated_by_attendance',
          reject_reason: verifyRes.reason,
          reviewed_at: new Date().toISOString()
        },
        `[并发破锁] 退费申请单 #${approvalItem.id} 因考勤消课余额变动自动废止`
      )
      throw new Error(verifyRes.reason)
    }

    const nowIso = new Date().toISOString()

    // 1. 原课时包清零作废核销并释放并发锁
    db.update(
      db.TABLES.COURSE_PACKAGES,
      sourcePkg.id,
      {
        paid_hours_left: 0,
        gift_hours_left: 0,
        lock_status: 'refunded',
        refund_status: 'refunded',
        refund_time: nowIso,
        locked_by_approval_id: null,
        snapshot_balance_at_propose: null
      },
      `[退费清算生效] 超管【${approverUser ? approverUser.name : '超管'}】批准退费：实退¥${afterData.net_refund}，剩余付费${afterData.paid_hours_left}及赠送${afterData.gift_hours_forfeited}全部清零作废`
    )

    // 2. 若学生仍在某班级中，同步处理退班解绑
    if (sourcePkg.class_id) {
      const cls = db.getById(db.TABLES.CLASSES, sourcePkg.class_id)
      if (cls && cls.enrolled_student_ids && cls.enrolled_student_ids.includes(sourcePkg.student_id)) {
        const newEnrolled = cls.enrolled_student_ids.filter(id => id !== sourcePkg.student_id)
        db.update(
          db.TABLES.CLASSES,
          cls.id,
          { enrolled_student_ids: newEnrolled },
          `[退费联动退班] 学员【${afterData.student_name}】退费核销，自动移出班级【${cls.name}】`
        )
      }
    }

    // 3. 建立不可篡改退费独立档案 refund_records
    const refundRecord = {
      id: 'ref_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      approval_id: approvalItem.id,
      package_id: sourcePkg.id,
      student_id: sourcePkg.student_id,
      student_name: afterData.student_name,
      course_id: sourcePkg.course_id,
      course_name: afterData.course_name,
      class_id: sourcePkg.class_id || null,
      term_id: sourcePkg.term_id || null,
      unit_price_snapshot: afterData.unit_price_snapshot,
      account_destination: afterData.account_destination,
      paid_hours_total: sourcePkg.paid_hours_total,
      gift_hours_total: sourcePkg.gift_hours_total,
      paid_hours_used: afterData.paid_hours_used,
      gift_hours_used: afterData.gift_hours_used,
      total_hours_used: afterData.total_hours_used,
      paid_hours_left_at_refund: afterData.paid_hours_left,
      gift_hours_forfeited: afterData.gift_hours_forfeited,
      gross_refund_amount: afterData.gross_refund,
      handling_fee: afterData.handling_fee,
      net_refund_amount: afterData.net_refund,
      refund_method: afterData.refund_method,
      refund_reason: afterData.refund_reason,
      operator_id: approvalItem.proposer_id,
      operator_name: approvalItem.proposer_name,
      approver_id: approverUser ? approverUser.id : 'u_sa1',
      approver_name: approverUser ? approverUser.name : '超级管理员',
      approved_time: nowIso,
      created_at: nowIso,
      updated_at: nowIso
    }

    db.insert(
      db.TABLES.REFUND_RECORDS,
      refundRecord,
      `[退费档案归档] 学员【${refundRecord.student_name}】退费档案 #${refundRecord.id} 建立 (实退:¥${refundRecord.net_refund_amount})`
    )

    return {
      refund_record: refundRecord,
      package_id: sourcePkg.id,
      status: 'refunded'
    }
  },

  /**
   * 超级管理员驳回退费清算申请（自动释放并发锁）
   */
  rejectRefundApproval(approvalItem, rejectReason, approverUser) {
    if (!approvalItem || !approvalItem.target_record_id) return null

    // 释放并发锁
    this.releasePackageConcurrencyLock(approvalItem.target_record_id, approverUser, '超管驳回退费申请，释放并发锁')

    return {
      package_id: approvalItem.target_record_id,
      status: 'rejected',
      reject_reason: rejectReason
    }
  },

  /**
   * 查询退费历史流水档案
   */
  getRefundHistory(filter = {}) {
    const list = db.getTable(db.TABLES.REFUND_RECORDS) || []
    return list.filter(item => {
      if (filter.student_id && item.student_id !== filter.student_id) return false
      if (filter.package_id && item.package_id !== filter.package_id) return false
      if (filter.refund_method && item.refund_method !== filter.refund_method) return false
      return true
    }).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
  },

  // ─────────────────────────────────────────
  // 7. 课程四期到期扫描与“顺延 / 不续退费”引擎
  // ─────────────────────────────────────────

  /**
   * 到期扫描查询接口
   * 当某期(春/夏/秋/冬)固定到期日到达或临近时，扫描并列出该期所有剩余可用总课时 > 0 的课时包
   *
   * @param {Object} params - { term_id, days_before = 30, reference_date }
   * @returns {Object} { packages, current_term, next_term, terms_list }
   */
  scanExpiringPackages(params = {}) {
    const allPackages = db.getTable(db.TABLES.COURSE_PACKAGES) || []
    const allTerms = db.getTable(db.TABLES.TERMS) || []
    const allStudents = db.getTable(db.TABLES.STUDENTS) || []
    const allClasses = db.getTable(db.TABLES.CLASSES) || []

    const refDate = params.reference_date ? new Date(params.reference_date) : new Date()
    const daysBefore = params.days_before !== undefined ? Number(params.days_before) : 30

    // 找到指定学期或按日期匹配当前学期
    let currentTerm = null
    if (params.term_id) {
      currentTerm = allTerms.find(t => t.id === params.term_id)
    }
    if (!currentTerm && allTerms.length > 0) {
      currentTerm = allTerms[0]
    }

    // 匹配下一期候选（按到期日升序排列取后一个）
    const sortedTerms = [...allTerms].sort((a, b) => (a.fixed_expire_date || '').localeCompare(b.fixed_expire_date || ''))
    let nextTerm = null
    if (currentTerm) {
      const curIdx = sortedTerms.findIndex(t => t.id === currentTerm.id)
      if (curIdx !== -1 && curIdx + 1 < sortedTerms.length) {
        nextTerm = sortedTerms[curIdx + 1]
      }
    }

    // 筛选有效课时包（有剩余课时且未核销退费）
    const matchingPackages = []
    allPackages.forEach(pkg => {
      if (pkg.lock_status === 'refunded' || pkg.refund_status === 'refunded') return

      const paidLeft = Number(pkg.paid_hours_left || 0)
      const giftLeft = Number(pkg.gift_hours_left || 0)
      const totalLeft = Number((paidLeft + giftLeft).toFixed(2))
      if (totalLeft <= 0) return

      // 若指定了学期，进行匹配
      if (params.term_id && pkg.term_id && pkg.term_id !== params.term_id) {
        return
      }

      // 计算到期天数
      let daysRemaining = null
      let isExpiringSoon = false
      let isExpired = false
      if (pkg.expire_date) {
        const expDate = new Date(pkg.expire_date + 'T23:59:59.999Z')
        const diffMs = expDate.getTime() - refDate.getTime()
        daysRemaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24))
        if (daysRemaining < 0) {
          isExpired = true
        } else if (daysRemaining <= daysBefore) {
          isExpiringSoon = true
        }
      }

      const stu = allStudents.find(s => s.id === pkg.student_id) || { name: pkg.student_name_snapshot || '学员' }
      const cls = pkg.class_id ? (allClasses.find(c => c.id === pkg.class_id) || { name: '班级#' + pkg.class_id }) : null
      const term = allTerms.find(t => t.id === pkg.term_id) || { name: pkg.term_name_snapshot || '所属学期' }

      matchingPackages.push(Object.assign({}, pkg, {
        student_name: stu.name,
        term_name: term.name,
        class_name: cls ? cls.name : '未绑定班级',
        paid_hours_left: paidLeft,
        gift_hours_left: giftLeft,
        total_available_hours: totalLeft,
        days_remaining: daysRemaining,
        is_expired: isExpired,
        is_expiring_soon: isExpiringSoon,
        expire_tag: isExpired ? '已到期' : (isExpiringSoon ? `即将到期(${daysRemaining}天)` : `正常(剩余${daysRemaining}天)`)
      }))
    })

    // 按到期紧急程度排序（已过期的排最前，其次即将到期）
    matchingPackages.sort((a, b) => {
      const d1 = a.days_remaining !== null ? a.days_remaining : 9999
      const d2 = b.days_remaining !== null ? b.days_remaining : 9999
      return d1 - d2
    })

    return {
      packages: matchingPackages,
      current_term: currentTerm,
      next_term: nextTerm,
      all_terms: sortedTerms
    }
  },

  /**
   * 家长选择顺延续费（期末顺延）
   * 将课时包剩余课时（付费+赠送）折算顺延至下一期，更新 term_id 与 expire_date，记录补费金额并留档
   *
   * @param {Object} params - { package_id, target_term_id, top_up_fee, remark }
   * @param {Object} operatorUser
   */
  executeTermRollover(params = {}, operatorUser = null) {
    const packageId = params.package_id || params.packageId
    if (!packageId) throw new Error('必须指定顺延课时包ID')

    const sourcePkg = db.getById(db.TABLES.COURSE_PACKAGES, packageId)
    if (!sourcePkg) throw new Error(`未找到课时包 #${packageId}`)

    if (sourcePkg.lock_status === 'pending_approval_locked') {
      throw new Error('该课时包当前处于待审批锁定状态，不可顺延')
    }
    if (sourcePkg.lock_status === 'refunded' || sourcePkg.refund_status === 'refunded') {
      throw new Error('该课时包已被退费核销，不可顺延')
    }

    const { target_term_id, top_up_fee = 0, remark = '' } = params
    if (!target_term_id) throw new Error('请选择顺延的目标下一期学期')

    const targetTerm = db.getById(db.TABLES.TERMS, target_term_id)
    if (!targetTerm || !targetTerm.fixed_expire_date) {
      throw new Error('目标学期不存在或未配置固定到期日')
    }

    const curPaid = Number(sourcePkg.paid_hours_left || 0)
    const curGift = Number(sourcePkg.gift_hours_left || 0)
    const curTotal = Number((curPaid + curGift).toFixed(2))

    if (curTotal <= 0) {
      throw new Error('该课时包已无剩余课时，无需顺延')
    }

    let topUpFeeNum = parseFloat(top_up_fee)
    if (isNaN(topUpFeeNum) || topUpFeeNum < 0) {
      throw new Error('补齐下一期课费金额必须为大于等于0的数字')
    }
    topUpFeeNum = Number(topUpFeeNum.toFixed(2))

    const nowIso = new Date().toISOString()
    const oldExpireDate = sourcePkg.expire_date
    const oldTermId = sourcePkg.term_id

    // 1. 更新原课时包学期与到期日
    const updatedPkg = db.update(
      db.TABLES.COURSE_PACKAGES,
      sourcePkg.id,
      {
        term_id: targetTerm.id,
        term_name_snapshot: targetTerm.name,
        expire_date: targetTerm.fixed_expire_date,
        rollover_count: (sourcePkg.rollover_count || 0) + 1,
        last_rollover_time: nowIso
      },
      `[期末顺延] 课时包 #${sourcePkg.id} 顺延至【${targetTerm.name}】，到期日更新为 ${targetTerm.fixed_expire_date} (顺延课时:${curTotal}, 家长补费:¥${topUpFeeNum})`
    )

    // 2. 生成顺延流水留档 term_rollover_records
    const student = db.getById(db.TABLES.STUDENTS, sourcePkg.student_id) || { name: sourcePkg.student_name_snapshot || '学员' }
    const course = db.getById(db.TABLES.COURSES_AND_CLASS_TYPES, sourcePkg.course_id) || { course_name: sourcePkg.course_name_snapshot || '课程' }

    const rolloverRecord = {
      id: 'tro_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      package_id: sourcePkg.id,
      student_id: sourcePkg.student_id,
      student_name: student.name,
      course_id: sourcePkg.course_id,
      course_name: course.course_name,
      source_term_id: oldTermId,
      target_term_id: targetTerm.id,
      target_term_name: targetTerm.name,
      prev_expire_date: oldExpireDate,
      new_expire_date: targetTerm.fixed_expire_date,
      rolled_over_paid_hours: curPaid,
      rolled_over_gift_hours: curGift,
      rolled_over_total_hours: curTotal,
      top_up_fee: topUpFeeNum,
      remark: remark.trim(),
      operator_id: operatorUser ? operatorUser.id : 'u_adm1',
      operator_name: operatorUser ? operatorUser.name : '教务管理',
      created_at: nowIso,
      updated_at: nowIso
    }

    db.insert(
      db.TABLES.TERM_ROLLOVER_RECORDS,
      rolloverRecord,
      `[顺延流水归档] 学员【${student.name}】课时包 #${sourcePkg.id} 顺延记录已建立`
    )

    return {
      package: updatedPkg,
      rollover_record: rolloverRecord
    }
  },

  /**
   * 查询顺延历史流水
   */
  getTermRolloverHistory(filter = {}) {
    const list = db.getTable(db.TABLES.TERM_ROLLOVER_RECORDS) || []
    return list.filter(item => {
      if (filter.package_id && item.package_id !== filter.package_id) return false
      if (filter.student_id && item.student_id !== filter.student_id) return false
      if (filter.target_term_id && item.target_term_id !== filter.target_term_id) return false
      return true
    }).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
  }
}

module.exports = transferRefundService


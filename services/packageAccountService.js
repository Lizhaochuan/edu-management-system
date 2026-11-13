// services/packageAccountService.js
// 课时包与账户流水管理服务（Phase 1-B & Phase 2-A 升级版）
const db = require('./db')
const notificationService = require('./notificationService')

// Historical approval snapshots can be JSON strings or objects. Match complete
// IDs, so pkg_1 never invalidates an unrelated request referring to pkg_10.
function referencesPackage(snapshot, packageId) {
  if (typeof snapshot === 'string') {
    try { return referencesPackage(JSON.parse(snapshot), packageId) } catch (_e) { return snapshot === packageId }
  }
  return !!snapshot && typeof snapshot === 'object' && Object.values(snapshot).some(value =>
    value === packageId || (value && typeof value === 'object' && referencesPackage(value, packageId)))
}

/**
 * 校验当前登录人是否为管理员或超级管理员
 */
function checkAdminPermission() {
  const app = getApp()
  const user = (app && app.globalData && app.globalData.currentUser) || wx.getStorageSync('current_user')
  if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) {
    throw new Error('权限拦截：仅教务管理(admin)或超级管理员(super_admin)可登记买课与操作课时包')
  }
  return user
}

const packageAccountService = {
  // ─────────────────────────────────────────
  // 1. 买课登记（与入班分离、统一有效期、欠费优先冲抵）
  // ─────────────────────────────────────────

  /**
   * 登记新购课时包
   * @param {string} studentId - 学生ID
   * @param {Object} purchaseData
   *   - course_id: 课程ID (必填)
   *   - paid_hours_total: 付费课时数 (必填, >= 0)
   *   - gift_hours_total: 赠送课时数 (推荐奖励等, >= 0)
   *   - total_amount: 实付总金额 (元)
   *   - unit_price_snapshot: 单价快照 (元/课时, 选填, 默认自动计算)
   *   - account_destination: 资金去向 ('进入公账' | '进入个人账户')
   *   - term_id: 所属期数ID ('term_spring_2026' 等)
   *   - remark: 选填备注
   */
  purchasePackage(studentId, purchaseData, operatorUser) {
    const operator = operatorUser || checkAdminPermission()
    if (!['admin', 'super_admin'].includes(operator.role)) throw new Error('无权登记购课')

    if (!studentId) throw new Error('必须指定购课学员')
    const student = db.getById(db.TABLES.STUDENTS, studentId)
    if (!student) throw new Error(`未找到指定学员 (id=${studentId})`)

    const {
      course_id,
      paid_hours_total,
      gift_hours_total = 0,
      total_amount,
      unit_price_snapshot,
      account_destination,
      term_id,
      remark = ''
    } = purchaseData

    if (!course_id) throw new Error('必须选择购买的课程')
    const course = db.getById(db.TABLES.COURSES_AND_CLASS_TYPES, course_id)
    if (!course) throw new Error(`未找到指定课程 (id=${course_id})`)

    const paidTotal = Number(paid_hours_total)
    const giftTotal = Number(gift_hours_total || 0)
    const amount = Number(total_amount)

    if (isNaN(paidTotal) || paidTotal <= 0) throw new Error('付费课时数必须为大于0的数字')
    if (isNaN(giftTotal) || giftTotal < 0) throw new Error('赠送课时数不能为负数')
    if (isNaN(amount) || amount < 0) throw new Error('购买总金额必须填写且不能为负')

    if (!account_destination || (account_destination !== '进入公账' && account_destination !== '进入个人账户')) {
      throw new Error('资金去向必须指定为【进入公账】或【进入个人账户】')
    }

    if (!term_id) throw new Error('必须指定所属学期期数')
    // 联动 Phase 1-A：自动读取对应期数的固定到期日
    const term = db.getById(db.TABLES.TERMS, term_id)
    if (!term || !term.fixed_expire_date) {
      throw new Error(`所选学期未配置固定到期日或不存在 (term_id=${term_id})`)
    }
    const expireDate = term.fixed_expire_date

    // 折算单价快照
    let unitPrice = Number(unit_price_snapshot)
    if (isNaN(unitPrice) || unitPrice <= 0) {
      unitPrice = paidTotal > 0 ? Number((amount / paidTotal).toFixed(2)) : course.unit_price
    }

    // ─────────────────────────────────────────
    // 核心铁律：欠费优先自动冲抵
    // 检查该生在该课程下是否有历史欠课时 (debt_hours > 0)
    // ─────────────────────────────────────────
    const allPackages = db.getTable(db.TABLES.COURSE_PACKAGES) || []
    const debtPackages = allPackages.filter(
      pkg => pkg.student_id === studentId && pkg.course_id === course_id && Number(pkg.debt_hours || 0) > 0
    )

    let totalDebtBefore = debtPackages.reduce((sum, pkg) => sum + Number(pkg.debt_hours || 0), 0)
    let remainingDebtToOffset = totalDebtBefore
    let offsetPaid = 0
    let offsetGift = 0
    const offsetDetails = []

    if (remainingDebtToOffset > 0) {
      // 1. 优先使用本次新购的付费课时抵扣欠课
      if (paidTotal >= remainingDebtToOffset) {
        offsetPaid = remainingDebtToOffset
        remainingDebtToOffset = 0
      } else {
        offsetPaid = paidTotal
        remainingDebtToOffset -= paidTotal

        // 2. 付费课时抵完还有欠课，再用新赠送课时抵扣
        if (giftTotal >= remainingDebtToOffset) {
          offsetGift = remainingDebtToOffset
          remainingDebtToOffset = 0
        } else {
          offsetGift = giftTotal
          remainingDebtToOffset -= giftTotal
        }
      }

      // 将冲抵扣除分摊到历史欠费包并更新 debt_hours
      let needOffset = offsetPaid + offsetGift
      debtPackages.forEach(debtPkg => {
        if (needOffset <= 0) return
        const curDebt = Number(debtPkg.debt_hours || 0)
        if (curDebt <= 0) return

        const deductDebt = Math.min(curDebt, needOffset)
        const updatedDebt = curDebt - deductDebt
        needOffset -= deductDebt

        db.update(
          db.TABLES.COURSE_PACKAGES,
          debtPkg.id,
          { debt_hours: updatedDebt },
          `[欠费自动冲抵] 学员【${student.name}】新购课时自动冲抵历史包 #${debtPkg.id} 欠费 ${deductDebt} 课时 (原欠:${curDebt}, 现欠:${updatedDebt})`
        )

        offsetDetails.push({
          package_id: debtPkg.id,
          cleared_debt: deductDebt,
          left_debt: updatedDebt
        })
      })
    }

    // 计算抵扣后本包真正可用的付费与赠送课时余量
    const paidHoursLeft = Number((paidTotal - offsetPaid).toFixed(2))
    const giftHoursLeft = Number((giftTotal - offsetGift).toFixed(2))

    let offsetSummaryText = ''
    if (offsetPaid + offsetGift > 0) {
      offsetSummaryText = `自动冲抵欠课 ${offsetPaid + offsetGift} 课时 (抵付费:${offsetPaid}, 抵赠送:${offsetGift}); 剩余仍欠:${remainingDebtToOffset} 课时`
    }

    // 组装新课时包记录
    const newPackageRecord = {
      student_id: studentId,
      student_name_snapshot: student.name,
      course_id: course_id,
      course_name_snapshot: course.course_name,
      class_id: null, // 买课与入班分离：此时不绑定具体班级
      term_id: term_id,
      term_name_snapshot: term.name,
      paid_hours_total: paidTotal,
      paid_hours_left: paidHoursLeft,
      gift_hours_total: giftTotal,
      gift_hours_left: giftHoursLeft,
      total_amount: amount,
      unit_price_snapshot: unitPrice,
      account_destination: account_destination,
      expire_date: expireDate, // 统一有效期（寒暑假开学日）
      total_frozen_days: 0,
      debt_hours: 0,
      lock_status: 'normal',
      locked_by_approval_id: null,
      offset_debt_summary: offsetSummaryText || null,
      remark: remark || ''
    }

    const desc = `[${operator.name}] 为学员【${student.name}】登记购买课程【${course.course_name}】课时包: 付费${paidTotal}课时, 赠送${giftTotal}课时, 金额¥${amount}, 资金去向:${account_destination}, 到期日:${expireDate}。${offsetSummaryText}`

    const createdPackage = db.insert(db.TABLES.COURSE_PACKAGES, newPackageRecord, desc)

    return {
      package: createdPackage,
      debtOffset: {
        totalDebtBefore,
        offsetPaid,
        offsetGift,
        totalOffset: offsetPaid + offsetGift,
        remainingDebt: remainingDebtToOffset,
        details: offsetDetails
      }
    }
  },

  // ─────────────────────────────────────────
  // 2. 核心扣费引擎与逆向回滚（Phase 2-A 升级）
  // ─────────────────────────────────────────

  /**
   * [Phase 2-A 核心升级] 扣减学员课时（多包 FIFO + 先付费后赠送 + 破锁 + 预警 + 记欠）
   *
   * @param {Object} options
   *   - student_id: 学员ID (必填)
   *   - course_id: 课程ID (必填)
   *   - hours_needed: 本次需扣减的课时数 (必填, > 0)
   *   - context_desc: 业务说明 (如 "第3次课到课签到消课")
   * @returns {Object} 包含 deducted_detail_json, low_balance_warning 等全量执行结果
   */
  deductHours(options) {
    const { student_id, course_id, hours_needed, context_desc = '课堂消课' } = options

    if (!student_id) throw new Error('必须指定消课学员 student_id')
    if (!course_id) throw new Error('必须指定消课课程 course_id')

    const hoursToDeduct = Number(hours_needed)
    if (isNaN(hoursToDeduct) || hoursToDeduct <= 0) {
      throw new Error('需扣减的课时数必须为大于0的数字')
    }

    const student = db.getById(db.TABLES.STUDENTS, student_id)
    const course = db.getById(db.TABLES.COURSES_AND_CLASS_TYPES, course_id)
    const studentName = student ? student.name : '未知学员'
    const courseName = course ? course.course_name : '未知课程'

    // ─────────────────────────────────────────
    // 铁律 1：排序规则（到期日由近及远 FIFO，同到期日按购买时间先后）
    // 过滤排除休学冻结（lock_status === 'frozen'），但审批锁定（pending_approval_locked）不可阻止实际消课！
    // ─────────────────────────────────────────
    const allPackages = db.getTable(db.TABLES.COURSE_PACKAGES) || []
    const validPackages = allPackages
      .filter(p => p.student_id === student_id && p.course_id === course_id && p.lock_status !== 'frozen')
      .sort((a, b) => {
        const timeA = new Date(a.expire_date || '2099-12-31').getTime()
        const timeB = new Date(b.expire_date || '2099-12-31').getTime()
        if (timeA !== timeB) return timeA - timeB
        return new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime()
      })

    let remainingNeed = hoursToDeduct
    let totalPaidDeducted = 0
    let totalGiftDeducted = 0
    let totalDebtAdded = 0
    let debtPackageId = null
    const packagesBreakdown = []
    const invalidatedApprovals = []

    // ─────────────────────────────────────────
    // 铁律 2：遍历可用课时包扣减（包内严格先扣付费，后扣赠送）
    // 铁律 4：上课消课最高优先级并发破锁
    // ─────────────────────────────────────────
    for (const pkg of validPackages) {
      if (remainingNeed <= 0) break

      let curPaidLeft = Number(pkg.paid_hours_left || 0)
      let curGiftLeft = Number(pkg.gift_hours_left || 0)
      let pkgPaidDeduct = 0
      let pkgGiftDeduct = 0

      // 如果课时包处于审批锁定中，消课具有最高物理优先级，破除锁定
      let shouldUnlock = false
      if (pkg.lock_status === 'pending_approval_locked' || pkg.locked_by_approval_id) {
        shouldUnlock = true
      }

      // 1. 优先扣减付费课时
      if (curPaidLeft > 0) {
        pkgPaidDeduct = Math.min(curPaidLeft, remainingNeed)
        curPaidLeft = Number((curPaidLeft - pkgPaidDeduct).toFixed(2))
        remainingNeed = Number((remainingNeed - pkgPaidDeduct).toFixed(2))
        totalPaidDeducted = Number((totalPaidDeducted + pkgPaidDeduct).toFixed(2))
      }

      // 2. 付费课时扣完后，再扣减赠送课时
      if (remainingNeed > 0 && curGiftLeft > 0) {
        pkgGiftDeduct = Math.min(curGiftLeft, remainingNeed)
        curGiftLeft = Number((curGiftLeft - pkgGiftDeduct).toFixed(2))
        remainingNeed = Number((remainingNeed - pkgGiftDeduct).toFixed(2))
        totalGiftDeducted = Number((totalGiftDeducted + pkgGiftDeduct).toFixed(2))
      }

      // 若发生扣费或需要破锁，执行更新
      if (pkgPaidDeduct > 0 || pkgGiftDeduct > 0 || shouldUnlock) {
        const updatePayload = {
          paid_hours_left: curPaidLeft,
          gift_hours_left: curGiftLeft
        }

        if (shouldUnlock) {
          updatePayload.lock_status = 'unlocked'
          updatePayload.locked_by_approval_id = null
          updatePayload.snapshot_balance_at_propose = null
        }

        let desc = `[消课扣费] ${context_desc}: 课时包 #${pkg.id} 扣除付费${pkgPaidDeduct}课时(余${curPaidLeft}), 赠送${pkgGiftDeduct}课时(余${curGiftLeft})`
        if (shouldUnlock) {
          desc += '；【上课破锁】上课消课优先物理执行，解除原审批锁定状态'
        }

        db.update(db.TABLES.COURSE_PACKAGES, pkg.id, updatePayload, desc)

        packagesBreakdown.push({
          package_id: pkg.id,
          paid_deducted: pkgPaidDeduct,
          gift_deducted: pkgGiftDeduct,
          paid_left_after: curPaidLeft,
          gift_left_after: curGiftLeft
        })

        // 破锁逻辑：若该课时包有关联的未决审批单，将其状态置为 invalidated_by_attendance
        if (pkg.locked_by_approval_id || shouldUnlock) {
          const approvalId = pkg.locked_by_approval_id
          const allApprovals = db.getTable(db.TABLES.APPROVAL_REQUESTS) || []
          const relatedApprovals = allApprovals.filter(app =>
            (app.id === approvalId || app.target_record_id === pkg.id || referencesPackage(app.before_data_json, pkg.id)) &&
            app.status === 'pending'
          )

          relatedApprovals.forEach(pendingApp => {
            db.update(
              db.TABLES.APPROVAL_REQUESTS,
              pendingApp.id,
              {
                status: 'invalidated_by_attendance',
                approval_comment: '【系统自动废止】因期间发生上课考勤消课，原核算余额已变动失效，请按最新余额重新提交申请',
                reviewed_at: new Date().toISOString()
              },
              `[并发破锁] 待审单 #${pendingApp.id} 因关联课时包发生实际上课消课，原余额失效，系统自动置为失效`
            )
            invalidatedApprovals.push({
              approval_id: pendingApp.id,
              request_type: pendingApp.request_type,
              reason: '因上课考勤消课自动失效'
            })
          })
        }
      }
    }

    // ─────────────────────────────────────────
    // 铁律 3：兜底机制（余额不够一节课的记欠，可用课时只扣至0绝不记负数）
    // ─────────────────────────────────────────
    let insufficientBalanceFlagged = false
    if (remainingNeed > 0) {
      insufficientBalanceFlagged = true
      totalDebtAdded = remainingNeed
      remainingNeed = 0

      // 选定一个课时包挂载欠费（优先最后一个课时包，若无任何包则自动建零余额欠费包）
      if (validPackages.length > 0) {
        const lastPkg = validPackages[validPackages.length - 1]
        debtPackageId = lastPkg.id
        const oldDebt = Number(lastPkg.debt_hours || 0)
        const newDebt = Number((oldDebt + totalDebtAdded).toFixed(2))

        db.update(
          db.TABLES.COURSE_PACKAGES,
          lastPkg.id,
          { debt_hours: newDebt },
          `[欠费透支] ${context_desc}: 课时余额不足一节课，超额透支 ${totalDebtAdded} 课时累加至课时包 #${lastPkg.id} (原欠:${oldDebt}, 现欠:${newDebt})`
        )
      } else {
        const emptyDebtPkg = {
          student_id,
          student_name_snapshot: studentName,
          course_id,
          course_name_snapshot: courseName,
          class_id: null,
          term_id: 'term_spring_2026',
          term_name_snapshot: '欠费建账期',
          paid_hours_total: 0,
          paid_hours_left: 0,
          gift_hours_total: 0,
          gift_hours_left: 0,
          total_amount: 0,
          unit_price_snapshot: course ? course.unit_price : 0,
          account_destination: '进入公账',
          expire_date: '2099-12-31',
          total_frozen_days: 0,
          debt_hours: totalDebtAdded,
          lock_status: 'normal',
          locked_by_approval_id: null,
          remark: `透支扣课自动生成欠费记录 (${context_desc})`
        }

        const insertedDebtPkg = db.insert(
          db.TABLES.COURSE_PACKAGES,
          emptyDebtPkg,
          `[欠费透支建账] 学员【${studentName}】无可用课时包，直接透支欠费 ${totalDebtAdded} 课时`
        )
        debtPackageId = insertedDebtPkg.id
      }
    }

    // ─────────────────────────────────────────
    // 扣减后状态统计与结构化留痕
    // ─────────────────────────────────────────
    const currentBalance = this.getStudentCourseBalance(student_id, course_id)

    // 组装标准 deducted_detail_json
    const deductedDetailObj = {
      student_id,
      student_name: studentName,
      course_id,
      course_name: courseName,
      total_hours_needed: hoursToDeduct,
      total_paid_deducted: totalPaidDeducted,
      total_gift_deducted: totalGiftDeducted,
      total_debt_added: totalDebtAdded,
      debt_package_id: debtPackageId,
      packages_breakdown: packagesBreakdown,
      context_desc,
      timestamp: new Date().toISOString()
    }
    const deductedDetailJson = JSON.stringify(deductedDetailObj)

    // ─────────────────────────────────────────
    // 铁律 2：4 课时预警线联动
    // 扣费完成计算学员在该课程下的可用总课时（付费课时剩余 + 赠送课时剩余）
    // 若 < 4 课时，立即触发家校通知与标红预警
    // ─────────────────────────────────────────
    let lowBalanceWarning = false
    let warningNoticeResult = null

    if (currentBalance.total_available_hours < 4) {
      lowBalanceWarning = true
      try {
        warningNoticeResult = notificationService.sendLowBalanceWarning(
          student_id,
          course_id,
          currentBalance.total_available_hours
        )
      } catch (e) {
        if (db.inServerTransaction()) throw e
        console.warn('[deductHours] sendLowBalanceWarning failed:', e)
      }
    }

    return {
      success: true,
      student_id,
      student_name: studentName,
      course_id,
      course_name: courseName,
      hours_needed: hoursToDeduct,
      paid_deducted: totalPaidDeducted,
      gift_deducted: totalGiftDeducted,
      debt_added: totalDebtAdded,
      debt_package_id: debtPackageId,
      packages_breakdown: packagesBreakdown,
      deducted_detail_json: deductedDetailJson,
      deducted_detail_obj: deductedDetailObj,
      insufficient_balance_flagged: insufficientBalanceFlagged,
      low_balance_warning: lowBalanceWarning,
      warning_notice_result: warningNoticeResult,
      invalidated_approvals: invalidatedApprovals,
      current_balance: currentBalance
    }
  },

  /**
   * [Phase 2-A 精准逆向回滚] 根据消课扣费留痕原路 100% 精准回滚
   *
   * 铁律：
   * 1. 优先从对应挂账课时包冲减掉本次增加的欠费 (total_debt_added)；
   * 2. 严格按原路课时包批次退回：先退回 gift_hours_left，再退回 paid_hours_left（对称逆操作）；
   * 3. 必须调用 db.update 并写入不可篡改审计日志留痕；
   * 4. 必填回滚原因 reason。
   *
   * @param {Object|string} deductedDetail - 之前扣费生成的 deducted_detail_obj 或 deducted_detail_json 字符串
   * @param {string} reason - 回滚必填原因（如 "老师点名手滑撤回"）
   * @returns {Object} 回滚执行明细与最新账户余额
   */
  rollbackHours(deductedDetail, reason) {
    if (!reason || !reason.trim()) {
      throw new Error('回滚操作必须填写明确合规的业务原因 (reason)')
    }

    let detail = deductedDetail
    if (typeof deductedDetail === 'string') {
      try {
        detail = JSON.parse(deductedDetail)
      } catch (e) {
        throw new Error('解析 deducted_detail_json 失败：不是合法的 JSON 字符串')
      }
    }

    if (!detail || typeof detail !== 'object') {
      throw new Error('回滚参数无效：缺少有效的 deducted_detail 明细数据')
    }

    const {
      student_id,
      course_id,
      total_paid_deducted = 0,
      total_gift_deducted = 0,
      total_debt_added = 0,
      debt_package_id,
      packages_breakdown = []
    } = detail

    if (!student_id || !course_id) {
      throw new Error('回滚数据缺失 student_id 或 course_id')
    }

    // Validate all original destinations before changing any balance. A refund,
    // transfer or paid-off debt requires a new reviewed adjustment, not a stale
    // replay of credits into the old package (or an arbitrary replacement debt).
    const originalPackages = new Set(packages_breakdown.map(item => item.package_id));
    if (total_debt_added > 0) originalPackages.add(debt_package_id);
    for (const packageId of originalPackages) {
      const original = db.getById(db.TABLES.COURSE_PACKAGES, packageId);
      if (!original || original.student_id !== student_id || original.course_id !== course_id || original.lock_status === 'refunded' || original.refund_status === 'refunded' || original.lock_status === 'pending_approval_locked') {
        throw new Error('原课时包已变更或不存在，请通过人工调课时审批处理');
      }
      if (db.getTable(db.TABLES.TRANSFER_RECORDS).some(t => t.source_package_id === packageId && (!detail.timestamp || t.created_at >= detail.timestamp))) throw new Error('原课时包已发生三转，请通过人工调课时审批处理');
    }
    if (total_debt_added > 0 && Number(db.getById(db.TABLES.COURSE_PACKAGES,debt_package_id).debt_hours || 0) < total_debt_added) throw new Error('原欠费已经冲抵，请通过人工调课时审批处理');

    const student = db.getById(db.TABLES.STUDENTS, student_id)
    const course = db.getById(db.TABLES.COURSES_AND_CLASS_TYPES, course_id)
    const studentName = student ? student.name : (detail.student_name || '学员')
    const courseName = course ? course.course_name : (detail.course_name || '课程')

    // ─────────────────────────────────────────
    // 第一步：冲减欠费 (若本次消课曾产生欠费，优先扣除对应课时包的 debt_hours)
    // ─────────────────────────────────────────
    let debtCleared = 0
    if (total_debt_added > 0) {
      let targetDebtPkg = null
      if (debt_package_id) {
        targetDebtPkg = db.getById(db.TABLES.COURSE_PACKAGES, debt_package_id)
      }
      if (!targetDebtPkg) {
        // 若找不到指定包，查找该生该课程有欠费的包
        const allPkgs = db.getTable(db.TABLES.COURSE_PACKAGES) || []
        targetDebtPkg = allPkgs.find(p => p.student_id === student_id && p.course_id === course_id && Number(p.debt_hours || 0) > 0)
      }

      if (targetDebtPkg) {
        const curDebt = Number(targetDebtPkg.debt_hours || 0)
        debtCleared = Math.min(curDebt, total_debt_added)
        const updatedDebt = Number((curDebt - debtCleared).toFixed(2))

        db.update(
          db.TABLES.COURSE_PACKAGES,
          targetDebtPkg.id,
          { debt_hours: updatedDebt },
          `[消课原路回滚-冲减欠费] 原因: ${reason}。冲减课时包 #${targetDebtPkg.id} 欠费 ${debtCleared} 课时 (原欠:${curDebt}, 现欠:${updatedDebt})`
        )
      }
    }

    // ─────────────────────────────────────────
    // 第二步：原路退回课时包（对称逆操作：先退回赠送课时，再退回付费课时）
    // ─────────────────────────────────────────
    const refundedPackages = []
    let totalPaidRefunded = 0
    let totalGiftRefunded = 0

    packages_breakdown.forEach(item => {
      const pkg = db.getById(db.TABLES.COURSE_PACKAGES, item.package_id)
      if (!pkg) {
        console.warn(`[rollbackHours] 未找到原课时包 #${item.package_id}，跳过该包退还`)
        return
      }

      const refundGift = Number(item.gift_deducted || 0)
      const refundPaid = Number(item.paid_deducted || 0)

      const curGiftLeft = Number(pkg.gift_hours_left || 0)
      const curPaidLeft = Number(pkg.paid_hours_left || 0)

      // 对称逆操作：先退赠送，再退付费
      const newGiftLeft = Number((curGiftLeft + refundGift).toFixed(2))
      const newPaidLeft = Number((curPaidLeft + refundPaid).toFixed(2))

      db.update(
        db.TABLES.COURSE_PACKAGES,
        pkg.id,
        {
          gift_hours_left: newGiftLeft,
          paid_hours_left: newPaidLeft
        },
        `[消课原路回滚-退回课时] 原因: ${reason}。课时包 #${pkg.id} 退回赠送${refundGift}课时(现余${newGiftLeft}), 退回付费${refundPaid}课时(现余${newPaidLeft})`
      )

      totalGiftRefunded = Number((totalGiftRefunded + refundGift).toFixed(2))
      totalPaidRefunded = Number((totalPaidRefunded + refundPaid).toFixed(2))

      refundedPackages.push({
        package_id: pkg.id,
        gift_refunded: refundGift,
        paid_refunded: refundPaid,
        gift_left_after: newGiftLeft,
        paid_left_after: newPaidLeft
      })
    })

    // 重新获取聚合余额
    const currentBalance = this.getStudentCourseBalance(student_id, course_id)

    return {
      success: true,
      reason,
      student_id,
      student_name: studentName,
      course_id,
      course_name: courseName,
      total_paid_refunded: totalPaidRefunded,
      total_gift_refunded: totalGiftRefunded,
      debt_cleared: debtCleared,
      refunded_packages: refundedPackages,
      current_balance: currentBalance,
      rolled_back_at: new Date().toISOString()
    }
  },

  // ─────────────────────────────────────────
  // 3. 查询与统计辅助方法
  // ─────────────────────────────────────────

  /** 查询某个学员名下所有的课时包列表 */
  getStudentPackages(studentId) {
    const packages = db.getTable(db.TABLES.COURSE_PACKAGES) || []
    return packages.filter(p => p.student_id === studentId)
  },

  /** 查询学员在某门课程上的聚合余额（可用付费、可用赠送、欠课时） */
  getStudentCourseBalance(studentId, courseId) {
    const packages = this.getStudentPackages(studentId).filter(p => p.course_id === courseId)

    let paidLeft = 0
    let giftLeft = 0
    let debtHours = 0

    packages.forEach(p => {
      paidLeft = Number((paidLeft + Number(p.paid_hours_left || 0)).toFixed(2))
      giftLeft = Number((giftLeft + Number(p.gift_hours_left || 0)).toFixed(2))
      debtHours = Number((debtHours + Number(p.debt_hours || 0)).toFixed(2))
    })

    return {
      student_id: studentId,
      course_id: courseId,
      paid_hours_left: paidLeft,
      gift_hours_left: giftLeft,
      total_available_hours: Number((paidLeft + giftLeft).toFixed(2)),
      debt_hours: debtHours,
      has_debt: debtHours > 0,
      packages_count: packages.length
    }
  },

  /** 查询全部课时包列表（支持按课程、资金去向、学期等过滤） */
  getAllPackages(filter = {}) {
    const packages = db.getTable(db.TABLES.COURSE_PACKAGES) || []
    return packages.filter(p => {
      if (filter.student_id && p.student_id !== filter.student_id) return false
      if (filter.course_id && p.course_id !== filter.course_id) return false
      if (filter.account_destination && p.account_destination !== filter.account_destination) return false
      if (filter.term_id && p.term_id !== filter.term_id) return false
      if (filter.has_debt === true && Number(p.debt_hours || 0) <= 0) return false
      return true
    }).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
  }
}

module.exports = packageAccountService


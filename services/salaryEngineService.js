const superAdminPolicy = require('./superAdminPolicy');
// services/salaryEngineService.js
// 教师课时费精准核算引擎（Phase 4-A 基础算薪铁律、代课算薪与跨师补课人头核算）
const db = require('./db')

const salaryEngineService = {
  // ─────────────────────────────────────────
  // 1. 单节课老师课酬实时核算核心引擎（Phase 4-A）
  // ─────────────────────────────────────────

  /**
   * 计算指定排课的老师课时费
   * 
   * 核心业务铁律与算薪公式（100%严格执行）：
   * 1. 【无保底】：老师没有保底，严格按每节课实际点名出勤的有效正式计费人头拿钱，0人出勤则记0元；
   * 2. 【试听生不算人头】：试听学生 (is_trial) 即使标了出勤，也绝不算入老师人头数；
   * 3. 【按老师的档走，不按班走】：老师换了班，档位不变，永远按实际授课老师自己的档位（或超管审批过的个人专属价表）计算；
   * 4. 【人数上限封顶截断】：当节课算薪人头数最多按该班锁定的封顶人数 (snapshot_max_capacity) 截断计算；
   * 5. 【代课老师课时费】：排课存在 substitute_teacher_id 时，原班老师拿 0 元，代课老师按代课老师自己的档位算，并在签到时落库代课老师的价格快照；
   * 6. 【补课双轨制 情况 A：跨老师补课】：
   *    - 若当前实际授课老师 current_teacher_id ≠ 原班缺勤老师 original_teacher_id：算进补课班人头，合并封顶截断，原班老师不拿这笔钱；
   *    - 若 current_teacher_id === original_teacher_id：原老师自己补课，当节课绝不算进新课基础人头（单独拉出的补课课次基础课酬记为0元，累进补差在 Phase 4-B 实现）。
   *
   * @param {string} scheduleId - 排课ID
   * @returns {Object} 课酬核算结果
   */
  calculateLessonFee(scheduleId) {
    if (!scheduleId) return null

    const schedule = db.getById(db.TABLES.SCHEDULES_AND_ATTENDANCE, scheduleId)
    if (!schedule) {
      console.warn(`[salaryEngine] 未找到排课记录 #${scheduleId}，跳过课酬计算`)
      return null
    }

    // Settled salary is immutable financial history; corrections require a separate approval.
    const settledLedger = (db.getTable(db.TABLES.TEACHER_LESSON_FEES) || []).some(f =>
      f.schedule_id === schedule.id && f.fee_type !== 'original_class_makeup_diff' &&
      (f.settlement_status === 'settled' || f.is_settled === true)
    )
    if (schedule.is_settled === true || settledLedger) {
      throw new Error('已结算历史课酬禁止直接重算，请走薪酬调整审批流程')
    }

    const cls = db.getById(db.TABLES.CLASSES, schedule.class_id)
    const className = cls ? cls.name : '未知班级'
    const maxCapacity = Number(schedule.snapshot_max_capacity || (cls ? cls.max_capacity_snapshot : 3))
    const lessonHours = this._getLessonHours(schedule, cls)

    // ─────────────────────────────────────────
    // 铁律 1：排课已取消 (status === 'cancelled')，老师课酬强制记为 0 元
    // ─────────────────────────────────────────
    if (schedule.status === 'cancelled') {
      const zeroFeeResult = {
        schedule_id: schedule.id,
        class_id: schedule.class_id,
        class_name: className,
        lesson_date: schedule.lesson_date,
        teacher_id: schedule.teacher_id,
        teacher_name: '原任课老师',
        effective_teacher_id: null,
        is_substitute: false,
        is_cancelled: true,
        formal_present_count: 0,
        cross_makeup_count: 0,
        same_makeup_count: 0,
        trial_present_count: 0,
        raw_headcount: 0,
        effective_headcount: 0,
        max_capacity: maxCapacity,
        lesson_hours: lessonHours,
        is_truncated: false,
        calculated_teacher_fee: 0,
        tier_name: '课程已取消',
        rate_used: 0,
        fee_type: 'cancelled',
        calculated_at: new Date().toISOString()
      }

      this._saveOrUpdateTeacherLessonFee(zeroFeeResult)
      db.update(
        db.TABLES.SCHEDULES_AND_ATTENDANCE,
        schedule.id,
        { calculated_teacher_fee: 0 },
        `[课酬核算] 排课 #${schedule.id} 已取消，老师课酬强制记为 ¥0`
      )
      return zeroFeeResult
    }

    // ─────────────────────────────────────────
    // 铁律 2：授课教师判定与代课逻辑 (按实际执教老师的档走，原老师拿0元)
    // ─────────────────────────────────────────
    const isSubstitute = !!schedule.substitute_teacher_id
    const effectiveTeacherId = schedule.substitute_teacher_id || schedule.teacher_id || (cls ? cls.teacher_id : '')
    const originalTeacherId = schedule.teacher_id || (cls ? cls.teacher_id : '')

    const teacher = db.getById(db.TABLES.USERS, effectiveTeacherId)
    const teacherName = teacher ? teacher.name : (schedule.substitute_teacher_name_snapshot || '授课老师')

    // ─────────────────────────────────────────
    // 铁律 3：出勤人头核算 (试听不计、跨师补课计入、原师补课不计、封顶截断)
    // ─────────────────────────────────────────
    let formalPresentCount = 0
    let trialPresentCount = 0

    // 1. 统计本班学员出勤情况
    const attendees = schedule.attendees_json || []
    attendees.forEach(a => {
      const isPresent = a.status === 'present'
      if (isPresent) {
        if (a.is_trial) {
          trialPresentCount++ // 铁律：试听生即使标了出勤，也绝不算入老师人头数！
        } else {
          formalPresentCount++ // 正式学员标了出勤
        }
      }
    })

    // 2. 统计补课学员出勤情况（补课双轨制 情况 A：跨老师补课）
    let crossTeacherMakeupCount = 0
    let sameTeacherMakeupCount = 0
    const makeupStudents = schedule.makeup_students || []

    makeupStudents.forEach(mk => {
      const isPresent = mk.status === 'present'
      if (isPresent) {
        const origTid = mk.original_teacher_id
        // 比对当前实际授课老师与该补课生的原班缺勤老师
        if (origTid && origTid !== effectiveTeacherId) {
          // 情况 A：跨老师补课 —— 直接算进本补课班实到计费人头！
          crossTeacherMakeupCount++
        } else {
          // 情况 B：原老师自己补课 —— 当节课绝不算进新课基础人头！
          sameTeacherMakeupCount++
        }
      }
    })

    // 原始有效计费人头 = 本班正式出勤生 + 跨老师补课出勤生
    const rawHeadcount = formalPresentCount + crossTeacherMakeupCount

    // 铁律 4：人数上限封顶截断（最多按建班封顶人数计算）
    const isTruncated = rawHeadcount > maxCapacity
    const effectiveHeadcount = Math.min(rawHeadcount, maxCapacity)

    // ─────────────────────────────────────────
    // 铁律 5：无保底原则（0人出勤则记0元，无任何底薪保底）
    // ─────────────────────────────────────────
    if (effectiveHeadcount <= 0) {
      const zeroResult = {
        schedule_id: schedule.id,
        class_id: schedule.class_id,
        class_name: className,
        lesson_date: schedule.lesson_date,
        teacher_id: effectiveTeacherId,
        teacher_name: teacherName,
        is_substitute: isSubstitute,
        original_teacher_id: isSubstitute ? originalTeacherId : null,
        formal_present_count: formalPresentCount,
        cross_makeup_count: crossTeacherMakeupCount,
        same_makeup_count: sameTeacherMakeupCount,
        trial_present_count: trialPresentCount,
        raw_headcount: rawHeadcount,
        effective_headcount: 0,
        max_capacity: maxCapacity,
        lesson_hours: lessonHours,
        is_truncated: false,
        calculated_teacher_fee: 0,
        tier_name: '无有效出勤',
        rate_used: 0,
        fee_type: isSubstitute ? 'substitute' : (schedule.is_solo_makeup ? 'solo_makeup' : 'regular'),
        calculated_at: new Date().toISOString()
      }

      this._saveOrUpdateTeacherLessonFee(zeroResult)
      db.update(
        db.TABLES.SCHEDULES_AND_ATTENDANCE,
        schedule.id,
        {
          calculated_teacher_fee: 0,
          initial_present_headcount: 0
        },
        `[课酬核算] 排课 #${schedule.id} 有效计费人头为0(正式出勤:0, 跨师补课:0)，课酬记为 ¥0(无保底)`
      )
      return zeroResult
    }

    // ─────────────────────────────────────────
    // 铁律 6：档位阶梯人头价匹配 (按老师自己的档走，不按班走)
    // 优先读取经超管批过的个人专属价表；其次读取标准档位阶梯价
    // ─────────────────────────────────────────
    let ratesMap = {}
    let tierName = '标准教师档'
    let tierId = 'tier_junior'

    const historicalSnapshot = schedule.teacher_salary_tier_snapshot_json
    if (historicalSnapshot && historicalSnapshot.teacher_id === effectiveTeacherId &&
        historicalSnapshot.headcount_rates_json) {
      // Use rate snapshot from that lesson, not later price changes.
      ratesMap = historicalSnapshot.headcount_rates_json
      tierName = historicalSnapshot.tier_name || tierName
      tierId = historicalSnapshot.tier_id || tierId
    } else if (teacher && teacher.teacher_category === 'partner_teacher') {
      const config = db.getById(db.TABLES.PARTNER_TEACHER_RATE_CONFIG, 'partner_teacher')
      if (!config || !config.headcount_rates_json) {
        throw new Error('合伙人老师尚未配置1～8人课时费，禁止猜测金额')
      }
      ratesMap = require('./salaryRateConfig').normalizeManualRates(config.headcount_rates_json)
      tierName = '合伙人老师'
      tierId = 'partner_teacher'
    } else if (teacher && teacher.is_custom_rate && teacher.custom_tier_rates_json) {
      // 个人专属价格表（经超管审批）
      ratesMap = teacher.custom_tier_rates_json
      tierName = `【${teacher.name}】专属定制价`
      tierId = 'custom_rates'
    } else {
      tierId = teacher ? (teacher.teacher_tier_id || 'tier_junior') : 'tier_junior'
      const tier = db.getById(db.TABLES.TEACHER_TIERS, tierId)
      ratesMap = tier ? (tier.headcount_rates_json || {}) : { 1: 100, 2: 140, 3: 180 }
      tierName = tier ? tier.name : '标准教师档'
    }

    // Every headcount bracket is a manually configured rate. Never infer it
    // from a neighbour, extrapolate past a legacy 1–3 table or make up ¥100.
    const rateUsed = this._getRateForHeadcount(effectiveHeadcount, ratesMap)
    let calculatedFee = Number((rateUsed * lessonHours).toFixed(2))

    // ─────────────────────────────────────────
    // 保存授课老师档位价格快照至排课记录
    // ─────────────────────────────────────────
    const tierSnapshot = {
      teacher_id: effectiveTeacherId,
      teacher_name: teacherName,
      tier_id: tierId,
      tier_name: tierName,
      is_custom: !!(teacher && teacher.is_custom_rate),
      lesson_hours: lessonHours,
      headcount_rates_json: ratesMap
    }

    const feeType = isSubstitute ? 'substitute' : (schedule.is_solo_makeup ? 'solo_makeup' : 'regular')

    const feeResult = {
      schedule_id: schedule.id,
      class_id: schedule.class_id,
      class_name: className,
      lesson_date: schedule.lesson_date,
      teacher_id: effectiveTeacherId,
      teacher_name: teacherName,
      is_substitute: isSubstitute,
      original_teacher_id: isSubstitute ? originalTeacherId : null,
      formal_present_count: formalPresentCount,
      cross_makeup_count: crossTeacherMakeupCount,
      same_makeup_count: sameTeacherMakeupCount,
      trial_present_count: trialPresentCount,
      raw_headcount: rawHeadcount,
      effective_headcount: effectiveHeadcount,
      max_capacity: maxCapacity,
      lesson_hours: lessonHours,
      is_truncated: isTruncated,
      calculated_teacher_fee: Number((rateUsed * lessonHours).toFixed(2)),
      tier_id: tierId,
      tier_name: tierName,
      rate_used: rateUsed,
      rates_snapshot_json: ratesMap,
      fee_type: feeType,
      calculated_at: new Date().toISOString()
    }

    calculatedFee = feeResult.calculated_teacher_fee

    // 落库独立课酬明细台账 teacher_lesson_fees
    this._saveOrUpdateTeacherLessonFee(feeResult)

    // 更新排课记录中的课酬字段与快照
    const updateDesc = `[课酬核算] 排课 #${schedule.id} ${isSubstitute ? `(代课: ${teacherName})` : ''}有效计费人头:${effectiveHeadcount}人(正式出勤:${formalPresentCount}, 跨师补课:${crossTeacherMakeupCount}${isTruncated ? `, 封顶截断原${rawHeadcount}人` : ''})。档位【${tierName}】，阶梯核算课酬: ¥${calculatedFee}`

    db.update(
      db.TABLES.SCHEDULES_AND_ATTENDANCE,
      schedule.id,
      {
        calculated_teacher_fee: calculatedFee,
        initial_present_headcount: effectiveHeadcount,
        teacher_salary_tier_snapshot_json: tierSnapshot
      },
      updateDesc
    )

    return feeResult
  },

  // ─────────────────────────────────────────
  // 2. 课酬台账持久化与同步
  // ─────────────────────────────────────────

  /**
   * 写入或更新独立课酬台账表 teacher_lesson_fees
   * @private
   */
  _saveOrUpdateTeacherLessonFee(feeData) {
    try {
      const feesTable = db.getTable(db.TABLES.TEACHER_LESSON_FEES) || []
      const existing = feesTable.find(f => f.schedule_id === feeData.schedule_id)
      const nowIso = new Date().toISOString()

      if (existing) {
        db.update(
          db.TABLES.TEACHER_LESSON_FEES,
          existing.id,
          Object.assign({}, feeData, { updated_at: nowIso }),
          `[课酬台账更新] 排课 #${feeData.schedule_id} 老师【${feeData.teacher_name}】课酬为 ¥${feeData.calculated_teacher_fee}`
        )
      } else {
        const record = Object.assign({}, feeData, {
          created_at: nowIso,
          updated_at: nowIso,
          settlement_status: 'unsettled'
        })
        db.insert(
          db.TABLES.TEACHER_LESSON_FEES,
          record,
          `[课酬台账生成] 排课 #${feeData.schedule_id} 老师【${feeData.teacher_name}】课酬 ¥${feeData.calculated_teacher_fee}`
        )
      }
    } catch (e) {
      console.warn('[salaryEngine] _saveOrUpdateTeacherLessonFee failed:', e)
    }
  },

  // ─────────────────────────────────────────
  // 3. 课酬重算与台账查询接口
  // ─────────────────────────────────────────

  /**
   * 重新计算单节课酬（支持手动触发或24小时改签触发）
   * @param {string} scheduleId
   */
  recalculateSalary(scheduleId) {
    return this.calculateLessonFee(scheduleId)
  },

  /**
   * 查询课酬明细列表
   * @param {Object} filter - { teacher_id, class_id, start_date, end_date, fee_type }
   */
  getTeacherLessonFees(filter = {}) {
    const list = db.getTable(db.TABLES.TEACHER_LESSON_FEES) || []
    return list.filter(item => {
      if (filter.teacher_id && item.teacher_id !== filter.teacher_id) return false
      if (filter.class_id && item.class_id !== filter.class_id) return false
      if (filter.fee_type && item.fee_type !== filter.fee_type) return false
      if (filter.start_date && item.lesson_date < filter.start_date) return false
      if (filter.end_date && item.lesson_date > filter.end_date) return false
      return true
    }).sort((a, b) => new Date(b.lesson_date || 0) - new Date(a.lesson_date || 0))
  },

  /**
   * 查询指定老师在某周期内的课酬汇总概览
   * @param {string} teacherId - 教师用户ID
   * @param {Object} periodFilter - { start_date, end_date }
   */
  getTeacherSalarySummary(teacherId, periodFilter = {}) {
    if (!teacherId) throw new Error('教师ID不能为空')

    const teacher = db.getById(db.TABLES.USERS, teacherId)
    const teacherName = teacher ? teacher.name : '未知老师'

    const fees = this.getTeacherLessonFees(Object.assign({ teacher_id: teacherId }, periodFilter))

    let totalFee = 0
    let regularFee = 0
    let substituteFee = 0
    let makeupDiffFee = 0
    let totalLessons = 0
    let substituteLessons = 0
    let makeupDiffCount = 0
    let totalHeadcount = 0

    fees.forEach(f => {
      const fee = Number(f.calculated_teacher_fee || 0)
      if (f.is_revoked || f.is_cancelled) return

      totalFee += fee

      if (f.fee_type === 'original_class_makeup_diff') {
        makeupDiffFee += fee
        makeupDiffCount++
      } else if (f.is_substitute) {
        substituteFee += fee
        substituteLessons++
        totalLessons++
        totalHeadcount += Number(f.effective_headcount || 0)
      } else {
        regularFee += fee
        totalLessons++
        totalHeadcount += Number(f.effective_headcount || 0)
      }
    })

    return {
      teacher_id: teacherId,
      teacher_name: teacherName,
      total_fee: totalFee,
      regular_fee: regularFee,
      substitute_fee: substituteFee,
      makeup_diff_fee: makeupDiffFee,
      total_lessons: totalLessons,
      substitute_lessons: substituteLessons,
      makeup_diff_count: makeupDiffCount,
      total_headcount: totalHeadcount,
      fees_list: fees
    }
  },

  // ─────────────────────────────────────────
  // 4. Phase 4-B：原老师补课“原班累进补差精确算法”
  // ─────────────────────────────────────────

  /**
   * 应用原老师补课的原班累进补差算法
   *
   * 触发条件：
   * 补课授课老师 == 原班缺勤老师 (current_teacher_id === original_teacher_id)
   *
   * 算法核心：
   * 1. 新课零增费：补课课次不增加当节基础人头费；
   * 2. 回溯原班历史快照：
   *    - N_init: initial_present_headcount
   *    - C_prev: makeup_compensated_count (此前已补差人头)
   *    - M: snapshot_max_capacity (封顶)
   *    - R: snapshot_teacher_rates_json (当时档位价表字典，R[0]=0)
   * 3. 计算补差前原班计费基数：N_before = min(N_init + C_prev, M)
   * 4. 计算补课算回后的新计费基数：N_after = min(N_before + 1, M)
   * 5. 计算本次补差金额：diff_fee = R[N_after] - R[N_before]
   * 6. 更新原班 makeup_compensated_count 加 1，落库独立补差台账 original_class_makeup_diff
   *
   * @param {Object} params - { original_absent_schedule_id, student_id, student_name, makeup_schedule_id, operatorUser }
   * @returns {Object} 补差计算结果
   */
  applyMakeupProgressiveDifferential(params) {
    const {
      original_absent_schedule_id,
      student_id,
      student_name,
      makeup_schedule_id,
      operatorUser
    } = params

    if (!original_absent_schedule_id) throw new Error('必须指定原班缺勤排课ID (original_absent_schedule_id)')
    if (!student_id) throw new Error('必须指定补课学员ID (student_id)')

    const origSchedule = db.getById(db.TABLES.SCHEDULES_AND_ATTENDANCE, original_absent_schedule_id)
    if (!origSchedule) {
      console.warn(`[salaryEngine] 未找到原班缺勤排课 #${original_absent_schedule_id}`)
      return null
    }

    const makeupSchedule = makeup_schedule_id ? db.getById(db.TABLES.SCHEDULES_AND_ATTENDANCE, makeup_schedule_id) : null
    const origCls = db.getById(db.TABLES.CLASSES, origSchedule.class_id)
    const origClassName = origCls ? origCls.name : '未知原班'
    const lessonHours = this._getLessonHours(origSchedule, origCls)

    // 检查是否已有该学员针对该原排课在该补课课次下的有效补差记录（防重复计算）
    const feesTable = db.getTable(db.TABLES.TEACHER_LESSON_FEES) || []
    const existing = feesTable.find(f =>
      f.fee_type === 'original_class_makeup_diff' &&
      f.original_absent_schedule_id === original_absent_schedule_id &&
      f.student_id === student_id &&
      (!makeup_schedule_id || f.schedule_id === makeup_schedule_id) &&
      !f.is_revoked
    )

    if (existing) {
      return existing
    }

    // 1. 读取原班历史快照参数
    const nInit = Number(origSchedule.initial_present_headcount || 0)
    const cPrev = Number(origSchedule.makeup_compensated_count || 0)
    const maxCapacity = Number(origSchedule.snapshot_max_capacity || (origCls ? origCls.max_capacity_snapshot : 3))

    // 2. 优先使用原课次锁定的历史档位；无快照时保持同一套回退规则。
    const { ratesMap, tierName, teacherId } = this._resolveOriginalClassRates(origSchedule, origCls)

    const teacher = db.getById(db.TABLES.USERS, teacherId)
    const teacherName = teacher ? teacher.name : (origCls ? origCls.teacher_name_snapshot : '原任课老师')

    // 3. 计算本次补课前后的原班有效计费人头
    const nBefore = Math.min(nInit + cPrev, maxCapacity)
    const nAfter = Math.min(nBefore + 1, maxCapacity)

    // 4. 阶梯差额计算：diff = R[nAfter] - R[nBefore]
    const feeBefore = this._getRateForHeadcount(nBefore, ratesMap)
    const feeAfter = this._getRateForHeadcount(nAfter, ratesMap)
    const diffRate = Math.max(0, feeAfter - feeBefore)
    const diffFee = Number((diffRate * lessonHours).toFixed(2))

    const nowIso = new Date().toISOString()
    const diffRecordId = 'diff_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

    const diffRecord = {
      id: diffRecordId,
      fee_type: 'original_class_makeup_diff',
      schedule_id: makeup_schedule_id || origSchedule.id,
      original_absent_schedule_id: original_absent_schedule_id,
      student_id: student_id,
      student_name: student_name,
      teacher_id: teacherId,
      teacher_name: teacherName,
      class_id: origSchedule.class_id,
      class_name: origClassName,
      lesson_date: makeupSchedule ? makeupSchedule.lesson_date : origSchedule.lesson_date,
      absent_lesson_date: origSchedule.lesson_date,
      n_init: nInit,
      c_prev: cPrev,
      n_before: nBefore,
      n_after: nAfter,
      max_capacity: maxCapacity,
      calculated_teacher_fee: diffFee,
      lesson_hours: lessonHours,
      rate_used: diffRate,
      rates_snapshot_json: ratesMap,
      tier_name: tierName,
      is_substitute: false,
      is_cancelled: false,
      is_revoked: false,
      settlement_status: 'unsettled',
      calculated_at: nowIso,
      created_at: nowIso,
      updated_at: nowIso
    }

    // 落库独立补差台账
    db.insert(
      db.TABLES.TEACHER_LESSON_FEES,
      diffRecord,
      `[原班累进补差] 学员【${student_name}】完成原师补课，原班 #${origSchedule.id} 人头自 ${nBefore} 累进至 ${nAfter}，生成补差课酬 ¥${diffFee}`
    )

    // 更新原班排课记录的已补差人头计数
    db.update(
      db.TABLES.SCHEDULES_AND_ATTENDANCE,
      origSchedule.id,
      {
        makeup_compensated_count: cPrev + 1
      },
      `[原班补差计数更新] 原班排课 #${origSchedule.id} 已补差人头计数从 ${cPrev} 更新为 ${cPrev + 1}`
    )

    // 执行对齐重算，确保总金额守恒
    this.realignOriginalClassCompensations(original_absent_schedule_id)

    return diffRecord
  },

  /**
   * 24 小时内自主改签撤回时的原班补差逆向回退
   * @param {Object} params - { original_absent_schedule_id, student_id, makeup_schedule_id, operatorUser }
   */
  revokeMakeupProgressiveDifferential(params) {
    const {
      original_absent_schedule_id,
      student_id,
      makeup_schedule_id,
      operatorUser
    } = params

    if (!original_absent_schedule_id || !student_id) return null

    const feesTable = db.getTable(db.TABLES.TEACHER_LESSON_FEES) || []
    const targetFee = feesTable.find(f =>
      f.fee_type === 'original_class_makeup_diff' &&
      f.original_absent_schedule_id === original_absent_schedule_id &&
      f.student_id === student_id &&
      (!makeup_schedule_id || f.schedule_id === makeup_schedule_id) &&
      !f.is_revoked
    )

    if (!targetFee) {
      console.warn(`[salaryEngine] 未找到待撤销的原班补差记录 (orig=${original_absent_schedule_id}, stu=${student_id})`)
      return null
    }

    // 标记撤销并清零
    db.update(
      db.TABLES.TEACHER_LESSON_FEES,
      targetFee.id,
      {
        is_revoked: true,
        calculated_teacher_fee: 0,
        revoked_at: new Date().toISOString()
      },
      `[原班补差撤回] 24小时内改签回滚：撤回学员【${targetFee.student_name}】的原班补差 ¥${targetFee.calculated_teacher_fee}`
    )

    // 重新对齐并更新原班的所有有效补差明细，保证金额绝对守恒
    return this.realignOriginalClassCompensations(original_absent_schedule_id)
  },

  /**
   * 重新对齐原班的所有有效补差记录（阶梯重整与绝对守恒算法）
   * 无论补课发生或撤销顺序如何，始终严谨按签到先后顺序重新计算阶梯阶次
   * @param {string} originalAbsentScheduleId
   */
  realignOriginalClassCompensations(originalAbsentScheduleId) {
    if (!originalAbsentScheduleId) return null

    const origSchedule = db.getById(db.TABLES.SCHEDULES_AND_ATTENDANCE, originalAbsentScheduleId)
    if (!origSchedule) return null

    const origCls = db.getById(db.TABLES.CLASSES, origSchedule.class_id)
    const nInit = Number(origSchedule.initial_present_headcount || 0)
    const lessonHours = this._getLessonHours(origSchedule, origCls)
    const maxCapacity = Number(origSchedule.snapshot_max_capacity || (origCls ? origCls.max_capacity_snapshot : 3))

    // 与新增补差使用同一个历史档位解析逻辑，避免合伙人老师回退到普通 Level。
    const { ratesMap } = this._resolveOriginalClassRates(origSchedule, origCls)

    // 查找该原班名下所有有效的（未被撤销的）原班补差记录，按生成时间升序排列
    const allFees = db.getTable(db.TABLES.TEACHER_LESSON_FEES) || []
    const activeDiffs = allFees.filter(f =>
      f.fee_type === 'original_class_makeup_diff' &&
      f.original_absent_schedule_id === originalAbsentScheduleId &&
      !f.is_revoked
    ).sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0))

    let currentHeadcount = nInit
    let totalCompensated = 0

    activeDiffs.forEach((record, index) => {
      const stepBefore = Math.min(currentHeadcount, maxCapacity)
      const stepAfter = Math.min(stepBefore + 1, maxCapacity)
      const feeBefore = this._getRateForHeadcount(stepBefore, ratesMap)
      const feeAfter = this._getRateForHeadcount(stepAfter, ratesMap)
      const newDiffRate = Math.max(0, feeAfter - feeBefore)
      const newDiffFee = Number((newDiffRate * lessonHours).toFixed(2))

      currentHeadcount = stepAfter
      totalCompensated += newDiffFee

      if (record.n_before !== stepBefore || record.n_after !== stepAfter || record.calculated_teacher_fee !== newDiffFee) {
        db.update(
          db.TABLES.TEACHER_LESSON_FEES,
          record.id,
          {
            n_before: stepBefore,
            n_after: stepAfter,
            calculated_teacher_fee: newDiffFee,
            lesson_hours: lessonHours,
            rate_used: newDiffRate,
            updated_at: new Date().toISOString()
          },
          `[原班补差重对齐] 重新对齐学员【${record.student_name}】补差基数: ${stepBefore} -> ${stepAfter}，补差课酬 ¥${newDiffFee}`
        )
      }
    })

    // 更新原班排课记录的 makeup_compensated_count
    db.update(
      db.TABLES.SCHEDULES_AND_ATTENDANCE,
      origSchedule.id,
      {
        makeup_compensated_count: activeDiffs.length
      },
      `[原班补差守恒校准] 原班排课 #${origSchedule.id} 有效补差人头更新为 ${activeDiffs.length}人，累计补差额 ¥${totalCompensated}`
    )

    return {
      original_absent_schedule_id: originalAbsentScheduleId,
      active_compensated_count: activeDiffs.length,
      total_differential_fee: totalCompensated
    }
  },

  /**
   * 根据人头数与价格表字典安全匹配价格 (确保 count<=0 时为 0)
   * @private
   */
  /**
   * 为原任课老师的补课补差统一取价。
   * 优先原课次价格快照，其次同课次已产生的补差价表快照；
   * 两者均不存在时才回退到老师当前类别/档位。
   */
  _resolveOriginalClassRates(origSchedule, origCls) {
    const tierSnapshot = origSchedule.teacher_salary_tier_snapshot_json
    const originalTeacherId = origSchedule.teacher_id || (origCls ? origCls.teacher_id : '')
    if (tierSnapshot && tierSnapshot.headcount_rates_json) {
      return {
        ratesMap: tierSnapshot.headcount_rates_json,
        tierName: tierSnapshot.tier_name || '原班快照档',
        teacherId: tierSnapshot.teacher_id || originalTeacherId
      }
    }

    const savedDiff = (db.getTable(db.TABLES.TEACHER_LESSON_FEES) || []).find(f =>
      f.fee_type === 'original_class_makeup_diff' &&
      f.original_absent_schedule_id === origSchedule.id &&
      !f.is_revoked && f.rates_snapshot_json
    )
    if (savedDiff) {
      return {
        ratesMap: savedDiff.rates_snapshot_json,
        tierName: savedDiff.tier_name || '历史补课价格快照',
        teacherId: savedDiff.teacher_id || originalTeacherId
      }
    }

    // Legacy schedules also contain a locked original hourly-rate snapshot.
    // It must outrank today's teacher category or today's rate settings.
    const legacySnapshot = origSchedule.snapshot_teacher_rates_json
    if (legacySnapshot && typeof legacySnapshot === 'object' &&
        Object.keys(legacySnapshot).length > 0) {
      return {
        ratesMap: legacySnapshot,
        tierName: '原班旧版价格快照',
        teacherId: originalTeacherId
      }
    }

    const teacher = db.getById(db.TABLES.USERS, originalTeacherId)
    if (teacher && teacher.teacher_category === 'partner_teacher') {
      const partner = db.getById(db.TABLES.PARTNER_TEACHER_RATE_CONFIG, 'partner_teacher')
      if (!partner || !partner.headcount_rates_json) {
        throw new Error('合伙人老师尚未配置1～8人课时费，禁止猜测补课差额')
      }
      return {
        ratesMap: require('./salaryRateConfig').normalizeManualRates(partner.headcount_rates_json),
        tierName: '合伙人老师',
        teacherId: originalTeacherId
      }
    }

    if (teacher && teacher.is_custom_rate && teacher.custom_tier_rates_json) {
      return {
        ratesMap: teacher.custom_tier_rates_json,
        tierName: '个人专属价表',
        teacherId: originalTeacherId
      }
    }

    const tierId = teacher ? (teacher.teacher_tier_id || 'tier_junior') : 'tier_junior'
    const tier = db.getById(db.TABLES.TEACHER_TIERS, tierId)
    return {
      ratesMap: tier ? tier.headcount_rates_json : { 1: 100, 2: 140, 3: 180 },
      tierName: tier ? tier.name : '标准教师档',
      teacherId: originalTeacherId
    }
  },

  /** Use the lesson's locked duration, then its class snapshot. Never guess salary hours. */
  _getLessonHours(schedule, cls) {
    const raw = schedule && schedule.snapshot_hours_per_lesson != null
      ? schedule.snapshot_hours_per_lesson
      : (cls && cls.hours_per_lesson_snapshot)
    const lessonHours = Number(raw)
    if (raw == null || !Number.isFinite(lessonHours) || lessonHours <= 0) {
      throw new Error(`无法核算课酬：排课 ${schedule ? schedule.id : ''} 缺少有效的课时快照`)
    }
    return lessonHours
  },

  _getRateForHeadcount(count, ratesMap) {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error('计费人数必须是非负整数')
    }
    if (count === 0) return 0
    if (!ratesMap || !Object.prototype.hasOwnProperty.call(ratesMap, String(count))) {
      throw new Error(`缺少${count}人档位的独立课时费配置，禁止自动推算金额`)
    }
    const raw = ratesMap[count]
    const rate = Number(raw)
    if (raw === null || raw === '' || typeof raw === 'boolean' ||
        !Number.isFinite(rate) || rate < 0) {
      throw new Error(`${count}人档位课时费无效`)
    }
    return rate
  },

  // ─────────────────────────────────────────
  // 5. Phase 4-C：薪资结算单生成、锁定、算错调账审批与脱敏校验
  // ─────────────────────────────────────────

  /**
   * 生成指定老师的周期薪资结算单（汇总正常班、代课、原班补差与待结调账）
   *
   * 汇总铁律（100%严格执行）：
   * 1. 正常班课时费小计 (regular_fee)
   * 2. 代课课时费小计 (substitute_fee)
   * 3. 原班累进补差课时费小计 (makeup_diff_fee)
   * 4. 已批准待结算的调账项 (adjustments_fee: 补发+ / 扣回-)
   * 5. 实发课酬合计 = regular_fee + substitute_fee + makeup_diff_fee + adjustments_fee
   * 
   * @param {string} teacherId - 教师用户ID
   * @param {string} period - 结算周期（如 '2026-03'）
   * @param {Object} options - { start_date, end_date, auto_settle }
   * @param {Object} operatorUser - 操作人
   * @returns {Object} 结算单记录
   */
  generateTeacherSalarySettlement(teacherId, period = '2026-03', options = {}, operatorUser = null) {
    if (!teacherId) throw new Error('教师ID不能为空')

    const teacher = db.getById(db.TABLES.USERS, teacherId)
    if (!teacher) throw new Error(`未找到教师用户 #${teacherId}`)

    // 1. 周期时间范围计算
    let startDate = options.start_date
    let endDate = options.end_date

    if (!startDate || !endDate) {
      if (/^\d{4}-\d{2}$/.test(period)) {
        const parts = period.split('-')
        const y = parseInt(parts[0], 10)
        const m = parseInt(parts[1], 10)
        startDate = `${period}-01`
        const lastDay = new Date(y, m, 0).getDate()
        endDate = `${period}-${String(lastDay).padStart(2, '0')}`
      } else {
        startDate = '2000-01-01'
        endDate = '2099-12-31'
      }
    }

    // 2. 查询该老师在指定周期内所有未结算且有效的课酬明细台账 (settlement_status !== 'settled')
    const allFees = db.getTable(db.TABLES.TEACHER_LESSON_FEES) || []
    const matchingFees = allFees.filter(f => {
      if (f.teacher_id !== teacherId) return false
      if (f.is_revoked || f.is_cancelled) return false
      if (f.settlement_status === 'settled') return false
      const lessonDate = f.lesson_date || ''
      if (startDate && lessonDate < startDate) return false
      if (endDate && lessonDate > endDate) return false
      return true
    })

    let regularFeeTotal = 0
    let substituteFeeTotal = 0
    let makeupDiffFeeTotal = 0
    let regularLessonsCount = 0
    let substituteLessonsCount = 0
    let makeupDiffCount = 0
    let totalHeadcount = 0

    matchingFees.forEach(f => {
      const fee = Number(f.calculated_teacher_fee || 0)
      if (f.fee_type === 'original_class_makeup_diff') {
        makeupDiffFeeTotal += fee
        makeupDiffCount++
      } else if (f.is_substitute) {
        substituteFeeTotal += fee
        substituteLessonsCount++
        totalHeadcount += Number(f.effective_headcount || 0)
      } else {
        regularFeeTotal += fee
        regularLessonsCount++
        totalHeadcount += Number(f.effective_headcount || 0)
      }
    })

    const totalLessons = regularLessonsCount + substituteLessonsCount

    // 3. 查询该老师所有已批准待结算的调账记录 (status === 'approved_pending_settlement')
    const allAdjustments = db.getTable(db.TABLES.SALARY_ADJUSTMENTS) || []
    const pendingAdjustments = allAdjustments.filter(a => {
      return a.teacher_id === teacherId && a.status === 'approved_pending_settlement'
    })

    let adjustmentsFeeTotal = 0
    pendingAdjustments.forEach(a => {
      adjustmentsFeeTotal += Number(a.signed_amount || 0)
    })

    // 4. 实发课酬合计
    const totalSalary = Math.max(0, regularFeeTotal + substituteFeeTotal + makeupDiffFeeTotal + adjustmentsFeeTotal)

    // 5. 组装结算单
    const nowIso = new Date().toISOString()
    const settlementId = 'settle_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    const cleanPeriod = period ? period.replace(/[^0-9]/g, '') : '2026'
    const settlementNo = `JS-${cleanPeriod}-${(teacher.phone || teacherId).slice(-4)}`

    const tier = teacher.teacher_tier_id ? db.getById(db.TABLES.TEACHER_TIERS, teacher.teacher_tier_id) : null
    const tierName = teacher.is_custom_rate ? '专属定制价' : (tier ? tier.name : '标准教师档')

    const detailsSnapshot = {
      lesson_fees: matchingFees.map(f => ({
        id: f.id,
        schedule_id: f.schedule_id,
        class_id: f.class_id,
        class_name: f.class_name,
        lesson_date: f.lesson_date,
        fee_type: f.fee_type,
        is_substitute: !!f.is_substitute,
        effective_headcount: f.effective_headcount || 0,
        rate_used: f.rate_used || 0,
        calculated_teacher_fee: f.calculated_teacher_fee || 0,
        student_name: f.student_name || null
      })),
      adjustments: pendingAdjustments.map(a => ({
        id: a.id,
        adjustment_no: a.adjustment_no,
        direction: a.direction,
        amount: a.amount,
        signed_amount: a.signed_amount,
        reason: a.reason,
        related_schedule_id: a.related_schedule_id || null,
        related_settlement_id: a.related_settlement_id || null,
        created_at: a.created_at
      })),
      generated_at: nowIso
    }

    const isAutoSettle = !!options.auto_settle
    const settlementRecord = {
      id: settlementId,
      settlement_no: settlementNo,
      period: period,
      start_date: startDate,
      end_date: endDate,
      teacher_id: teacherId,
      teacher_name: teacher.name,
      teacher_tier_name: tierName,
      regular_fee: regularFeeTotal,
      substitute_fee: substituteFeeTotal,
      makeup_diff_fee: makeupDiffFeeTotal,
      adjustments_fee: adjustmentsFeeTotal,
      total_salary: totalSalary,
      total_lessons: totalLessons,
      substitute_lessons: substituteLessonsCount,
      makeup_diff_count: makeupDiffCount,
      total_headcount: totalHeadcount,
      status: isAutoSettle ? 'settled' : 'draft',
      settled_at: isAutoSettle ? nowIso : null,
      settled_by_id: isAutoSettle ? (operatorUser ? operatorUser.id : 'system') : null,
      settled_by_name: isAutoSettle ? (operatorUser ? operatorUser.name : '系统') : null,
      lesson_fee_ids: matchingFees.map(f => f.id),
      adjustment_ids: pendingAdjustments.map(a => a.id),
      details_snapshot_json: detailsSnapshot,
      created_at: nowIso,
      updated_at: nowIso
    }

    db.insert(
      db.TABLES.SALARY_SETTLEMENTS,
      settlementRecord,
      `[生成薪资结算单] 老师【${teacher.name}】周期 ${period} 结算单 #${settlementNo} 已生成(${settlementRecord.status === 'settled' ? '已结算' : '草稿'})，总课酬 ¥${totalSalary}`
    )

    // 如果指定了自动锁定结算
    if (isAutoSettle) {
      this._archiveSettledItems(settlementRecord, nowIso)
    }

    return settlementRecord
  },

  /**
   * 锁定结算单（标记为 settled 并锁死，不可篡改）
   * 
   * 锁定铁律：
   * 1. 结算单一旦标记为 'settled'，永久锁死，严禁任何直接修改或删除；
   * 2. 对应的所有课酬明细台账标记为已结算 (settlement_status = 'settled')；
   * 3. 挂入的所有调账记录标记为已在当前结算单结清 (status = 'settled')；
   * 4. 结算后如发现算错，严禁修改旧结算单，必须走新建调账审批流！
   *
   * @param {string} settlementId - 结算单ID
   * @param {Object} operatorUser - 管理员或超管用户
   * @returns {Object} 已锁定的结算单
   */
  settleTeacherSalary(settlementId, operatorUser = null) {
    if (!settlementId) throw new Error('结算单ID不能为空')

    const settlement = db.getById(db.TABLES.SALARY_SETTLEMENTS, settlementId)
    if (!settlement) throw new Error(`未找到结算单 #${settlementId}`)

    if (settlement.status === 'settled') {
      throw new Error('财务安全铁律：该结算单已处于【已结算锁定】状态，不可重复结算')
    }

    if (operatorUser && operatorUser.role !== 'super_admin' && operatorUser.role !== 'admin') {
      throw new Error('权限不足：只有管理员或超级管理员可执行薪资结算锁定操作')
    }

    const nowIso = new Date().toISOString()
    const opId = operatorUser ? operatorUser.id : 'system'
    const opName = operatorUser ? operatorUser.name : '教务财务'

    // 1. 更新结算单状态为 settled（触发锁定防篡改铁律）
    const updatedSettlement = db.update(
      db.TABLES.SALARY_SETTLEMENTS,
      settlementId,
      {
        status: 'settled',
        settled_at: nowIso,
        settled_by_id: opId,
        settled_by_name: opName
      },
      `[薪资结算锁定] 结算单 #${settlement.settlement_no || settlementId} 确认结算并锁死。老师: ${settlement.teacher_name}, 周期: ${settlement.period}, 实发课酬: ¥${settlement.total_salary}`
    )

    // 2. 归档关联的课酬台账与调账记录
    this._archiveSettledItems(updatedSettlement, nowIso)

    return updatedSettlement
  },

  /**
   * 内部方法：归档结算单中的明细与调账项
   * @private
   */
  _archiveSettledItems(settlement, nowIso) {
    const settlementId = settlement.id

    // 1. 归档课酬明细
    const feeIds = settlement.lesson_fee_ids || []
    feeIds.forEach(fid => {
      const fee = db.getById(db.TABLES.TEACHER_LESSON_FEES, fid)
      if (fee) {
        db.update(
          db.TABLES.TEACHER_LESSON_FEES,
          fee.id,
          {
            settlement_status: 'settled',
            settlement_id: settlementId,
            settled_at: nowIso
          },
          `[课酬归档] 课酬明细 #${fee.id} 已归档至结算单 #${settlement.settlement_no || settlementId}`
        )
      }
    })

    // 2. 归档调账项（标记为已随本期结清）
    const adjIds = settlement.adjustment_ids || []
    adjIds.forEach(aid => {
      const adj = db.getById(db.TABLES.SALARY_ADJUSTMENTS, aid)
      if (adj) {
        db.update(
          db.TABLES.SALARY_ADJUSTMENTS,
          adj.id,
          {
            status: 'settled',
            settled_in_settlement_id: settlementId,
            settled_at: nowIso
          },
          `[调账结清] 调账记录 #${adj.id} 已在结算单 #${settlement.settlement_no || settlementId} 中完成结清`
        )
      }
    })
  },

  /**
   * 管理员发起薪资算错调账申请（补发/扣回）
   *
   * 调账铁律（100%严格执行）：
   * 1. 历史不可篡改：旧结算单绝不修改，原样留档；
   * 2. 补发与扣回方向：
   *    - reissue: 补发（少发了，+金额）
   *    - clawback: 扣回（多发了，-金额）
   * 3. 必须详细注明原因，可关联原排课或原结算单ID；
   * 4. 提交至 approval_requests 走超级管理员审批（严禁发起人自审）；
   * 5. 超管批准后状态变为 approved_pending_settlement，在下期结算单自动挂入结清。
   *
   * @param {Object} params - { teacher_id, direction, amount, reason, related_schedule_id, related_settlement_id }
   * @param {Object} operatorUser - 发起人
   * @returns {Object} { adjustment, approval_request }
   */
  createSalaryAdjustment(params = {}, operatorUser = null) {
    if (typeof wx !== 'undefined' && typeof wx.request === 'function' && !db.inServerTransaction()) return require('./commandClient').run('approval.propose',{type:'salaryAdjustment',data:params})
    const { teacher_id, direction, amount, reason, related_schedule_id, related_settlement_id } = params

    if (!teacher_id) throw new Error('必须指定调账教师ID')
    const teacher = db.getById(db.TABLES.USERS, teacher_id)
    if (!teacher) throw new Error(`未找到教师用户 #${teacher_id}`)

    if (!['reissue', 'clawback'].includes(direction)) {
      throw new Error('调账方向必须为 补发(reissue) 或 扣回(clawback)')
    }

    const numAmount = Math.abs(Number(amount))
    if (!numAmount || isNaN(numAmount) || numAmount <= 0) {
      throw new Error('调账金额必须为大于0的有效数值')
    }

    if (!reason || !reason.trim() || reason.trim().length < 2) {
      throw new Error('必须填写详细的调账原因（至少2个字）')
    }

    const signedAmount = direction === 'clawback' ? -numAmount : numAmount
    const nowIso = new Date().toISOString()
    const adjId = 'adj_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    const monthTag = `${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}`
    const adjNo = `TZ-${monthTag}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`

    const proposerId = operatorUser ? operatorUser.id : 'u_adm1'
    const proposerName = operatorUser ? operatorUser.name : '教务主管'

    const adjRecord = {
      id: adjId,
      adjustment_no: adjNo,
      teacher_id: teacher.id,
      teacher_name: teacher.name,
      direction: direction,
      amount: numAmount,
      signed_amount: signedAmount,
      reason: reason.trim(),
      related_schedule_id: related_schedule_id || null,
      related_settlement_id: related_settlement_id || null,
      status: 'pending_super_admin_approval',
      proposer_id: proposerId,
      proposer_name: proposerName,
      created_at: nowIso,
      updated_at: nowIso
    }

    // 1. 写入薪资调账申请表
    db.insert(
      db.TABLES.SALARY_ADJUSTMENTS,
      adjRecord,
      `[发起薪资调账] 为老师【${teacher.name}】发起${direction === 'reissue' ? '补发(+)' : '扣回(-)'}申请 ¥${numAmount}。原因: ${reason}`
    )

    // 2. 提交至审批中心 approval_requests，必须由超级管理员审批
    const reqId = 'req_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    const approvalReq = {
      id: reqId,
      request_type: 'salary_adjustment',
      proposer_id: proposerId,
      proposer_name: proposerName,
      target_table: db.TABLES.SALARY_ADJUSTMENTS,
      target_record_id: adjId,
      reason: `[${direction === 'reissue' ? '薪资补发(+)' : '薪资扣回(-)'}] 老师【${teacher.name}】调整金额 ¥${numAmount}。详细原因：${reason}`,
      before_data_json: null,
      after_data_json: adjRecord,
      status: 'pending',
      action_time: nowIso
    }

    db.insert(
      db.TABLES.APPROVAL_REQUESTS,
      approvalReq,
      `[提交调账审批] 调账单 #${adjNo} 提交超管审批 (申请人: ${proposerName})`
    )

    return {
      adjustment: adjRecord,
      approval_request: approvalReq
    }
  },

  /**
   * 超级管理员批准薪资算错调账申请
   * 批准后调账状态变为 approved_pending_settlement，在下期结算单自动挂入
   * @param {Object} approvalItem
   * @param {Object} approverUser
   */
  applySalaryAdjustmentApproval(approvalItem, approverUser) {
    if (!approvalItem || !approvalItem.target_record_id) return null

    // 自审拦截
    if (approverUser && approverUser.id === approvalItem.proposer_id && !superAdminPolicy.mayApproveOwnRequest(db.getTable(db.TABLES.USERS), approverUser)) {
      throw new Error('违反内控铁律：不能审批自己发起的调账申请！请切换其他超管账号')
    }

    // 权限校验：必须为 super_admin
    if (approverUser && approverUser.role !== 'super_admin') {
      throw new Error('仅超级管理员有权审批薪资算错调账申请')
    }

    const adj = db.getById(db.TABLES.SALARY_ADJUSTMENTS, approvalItem.target_record_id)
    if (!adj) throw new Error(`未找到调账单 #${approvalItem.target_record_id}`)

    const nowIso = new Date().toISOString()
    const updatedAdj = db.update(
      db.TABLES.SALARY_ADJUSTMENTS,
      adj.id,
      {
        status: 'approved_pending_settlement',
        approver_id: approverUser.id,
        approver_name: approverUser.name,
        approved_time: nowIso
      },
      `[超管审批通过] 超管【${approverUser.name}】批准了老师【${adj.teacher_name}】的调账申请 #${adj.adjustment_no || adj.id} (${adj.direction === 'reissue' ? '补发' : '扣回'} ¥${adj.amount})，待下期结算单自动挂入结清`
    )

    return updatedAdj
  },

  /**
   * 超级管理员驳回薪资算错调账申请
   * @param {Object} approvalItem
   * @param {string} rejectReason
   * @param {Object} approverUser
   */
  rejectSalaryAdjustmentApproval(approvalItem, rejectReason, approverUser) {
    if (!approvalItem || !approvalItem.target_record_id) return null

    if (approverUser && approverUser.id === approvalItem.proposer_id && !superAdminPolicy.mayApproveOwnRequest(db.getTable(db.TABLES.USERS), approverUser)) {
      throw new Error('违反内控铁律：不能驳回自己发起的申请')
    }

    const adj = db.getById(db.TABLES.SALARY_ADJUSTMENTS, approvalItem.target_record_id)
    if (!adj) return null

    const nowIso = new Date().toISOString()
    const updatedAdj = db.update(
      db.TABLES.SALARY_ADJUSTMENTS,
      adj.id,
      {
        status: 'rejected',
        approver_id: approverUser.id,
        approver_name: approverUser.name,
        approved_time: nowIso,
        reject_reason: rejectReason || '超管综合评估未予通过'
      },
      `[超管审批驳回] 超管【${approverUser.name}】驳回了调账申请 #${adj.adjustment_no || adj.id}，理由：${rejectReason}`
    )

    return updatedAdj
  },

  /**
   * 查询历史薪资结算单列表
   * 
   * 权限隔离铁律：
   * 教师只能查看属于自己的结算单；若传入或试图查询其他老师的数据直接拦截！
   * 返回给老师端的数据必须执行严格财务脱敏（剥离学生购课金额、剩余课时、公私账去向等）。
   *
   * @param {string} teacherId - 可选指定的教师ID
   * @param {Object} filter - { status, period }
   * @param {Object} currentUser - 当前请求用户
   */
  getTeacherSettlements(teacherId = null, filter = {}, currentUser = null) {
    let targetTeacherId = teacherId

    // 教师角色隔离与越权拦截
    if (currentUser && currentUser.role === 'teacher') {
      if (teacherId && teacherId !== currentUser.id) {
        throw new Error('权限隔离铁律：教师只能查看自己的课酬与结算单')
      }
      targetTeacherId = currentUser.id
    }

    const allSettlements = db.getTable(db.TABLES.SALARY_SETTLEMENTS) || []
    const filtered = allSettlements.filter(s => {
      if (targetTeacherId && s.teacher_id !== targetTeacherId) return false
      if (filter.status && s.status !== filter.status) return false
      if (filter.period && s.period !== filter.period) return false
      return true
    }).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))

    // 若是老师端查看，执行严格脱敏保护
    if (currentUser && currentUser.role === 'teacher') {
      return filtered.map(item => this._maskSettlementForTeacher(item))
    }

    return filtered
  },

  /**
   * 查询调账记录列表
   * 教师只能查看属于自己的调账记录
   */
  getSalaryAdjustments(filter = {}, currentUser = null) {
    let targetTeacherId = filter.teacher_id

    if (currentUser && currentUser.role === 'teacher') {
      if (filter.teacher_id && filter.teacher_id !== currentUser.id) {
        throw new Error('权限隔离铁律：教师只能查看自己的调账记录')
      }
      targetTeacherId = currentUser.id
    }

    const allList = db.getTable(db.TABLES.SALARY_ADJUSTMENTS) || []
    return allList.filter(item => {
      if (targetTeacherId && item.teacher_id !== targetTeacherId) return false
      if (filter.status && item.status !== filter.status) return false
      if (filter.direction && item.direction !== filter.direction) return false
      return true
    }).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
  },

  /**
   * 老师端结算单明细财务脱敏
   * 绝不暴露学生课时余额、单价、公私账去向、退费等信息
   * @private
   */
  _maskSettlementForTeacher(settlement) {
    if (!settlement) return null
    const copy = Object.assign({}, settlement)

    if (copy.details_snapshot_json && copy.details_snapshot_json.lesson_fees) {
      const maskedFees = copy.details_snapshot_json.lesson_fees.map(fee => {
        const fCopy = Object.assign({}, fee)
        delete fCopy.unit_price
        delete fCopy.account_destination
        delete fCopy.total_amount
        delete fCopy.paid_hours_left
        delete fCopy.gift_hours_left
        return fCopy
      })

      copy.details_snapshot_json = Object.assign({}, copy.details_snapshot_json, {
        lesson_fees: maskedFees,
        privacy_masked: true
      })
    }

    return copy
  },

  /**
   * 全局学员财务隐私严格脱敏工具函数
   * 
   * 脱敏铁律：
   * 全局扫描并物理剥离学员购课总金额、折算单价、资金去向(公账/私账)、剩余课时数(付费/赠送)及退费信息。
   *
   * @param {Object} studentOrAttendee
   * @returns {Object} 彻底脱敏后的安全副本
   */
  maskStudentFinancialPrivacy(studentOrAttendee) {
    if (!studentOrAttendee) return null
    const copy = Object.assign({}, studentOrAttendee)

    delete copy.paid_hours_left
    delete copy.gift_hours_left
    delete copy.total_available_hours
    delete copy.total_hours
    delete copy.debt_hours
    delete copy.paid_hours_total
    delete copy.gift_hours_total
    delete copy.total_amount
    delete copy.unit_price_snapshot
    delete copy.unit_price
    delete copy.account_destination
    delete copy.packages
    delete copy.refund_records
    delete copy.admin_debug_balance
    delete copy.deducted_detail_json

    copy.privacy_masked = true
    return copy
  },

  /**
   * 教师财务越权防线：验证当前请求是否跨老师越权
   * @param {string} targetTeacherId
   * @param {Object} currentUser
   */
  checkTeacherFinancialIsolation(targetTeacherId, currentUser) {
    if (currentUser && currentUser.role === 'teacher') {
      if (targetTeacherId && targetTeacherId !== currentUser.id) {
        throw new Error('权限隔离铁律：教师只能查看自己的课酬与结算单，严禁跨老师查看财务数据！')
      }
    }
  },

  /**
   * 财务课酬周期报表统计
   * @param {Object} query - { period, teacher_id }
   * @param {Object} currentUser
   */
  getSalaryReport(query = {}, currentUser = null) {
    this.checkTeacherFinancialIsolation(query.teacher_id, currentUser)
    const settlements = this.getTeacherSettlements(query.teacher_id, query, currentUser)
    const adjustments = this.getSalaryAdjustments(query, currentUser)

    let totalDisbursed = 0
    let totalSettledCount = 0
    let totalDraftCount = 0

    settlements.forEach(s => {
      if (s.status === 'settled') {
        totalDisbursed += Number(s.total_salary || 0)
        totalSettledCount++
      } else {
        totalDraftCount++
      }
    })

    return {
      period: query.period || '全部周期',
      total_disbursed: totalDisbursed,
      settled_count: totalSettledCount,
      draft_count: totalDraftCount,
      settlements: settlements,
      adjustments: adjustments
    }
  }
}

module.exports = salaryEngineService


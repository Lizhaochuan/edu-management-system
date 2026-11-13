// web-admin/js/components/inspector.js
// 2. 全量数据与快照透视镜 (Data & Snapshot Inspector)

const InspectorComponent = {
  template: `
    <div>
      <!-- 子 Tab 切换 -->
      <div style="margin-bottom: 16px; display: flex; gap: 10px;">
        <button 
          class="btn" 
          :class="{'btn-primary': subTab === 'schedules'}" 
          @click="subTab = 'schedules'"
        >
          📅 排课与考勤明细
        </button>
        <button 
          class="btn" 
          :class="{'btn-primary': subTab === 'packages'}" 
          @click="subTab = 'packages'"
        >
          👛 学生课时包账本透视 (Student Packages & Ledger)
        </button>
      </div>

      <!-- ── 子 Tab 1：排课与考勤快照透视 ── -->
      <div v-if="subTab === 'schedules'" class="console-card">
        <div class="card-header">
          <div class="card-title-group">
            <span style="font-size: 18px;">🔎</span>
            <div>
              <div class="card-title">排课与考勤核对</div>
              <div class="card-subtitle">查看每次课程的出勤人数、代课、补课、扣课和教师课酬</div>
            </div>
          </div>
          <button class="btn btn-sm btn-primary" @click="fetchSchedules">
            <span>🔄</span> 刷新课次列表
          </button>
        </div>

        <div class="card-body">
          <div class="table-container">
            <table class="dense-table">
              <thead>
                <tr>
                  <th style="width: 110px;">课次编号</th>
                  <th style="width: 140px;">班级名称</th>
                  <th style="width: 130px;">上课时间</th>
                  <th style="width: 100px;">授课老师</th>
                  <th style="width: 100px;">状态</th>
                  <th style="width: 90px; text-align: center;">初始人头</th>
                  <th style="width: 90px; text-align: center;">已补差数</th>
                  <th style="width: 110px;">代课老师</th>
                  <th>跨班补课学员</th>
                  <th style="width: 120px; text-align: center;">当节消课明细</th>
                  <th style="width: 110px; text-align: right;">当节课酬</th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="loadingSchedules">
                  <td colspan="11" style="text-align: center; padding: 30px; color: #94a3b8;">加载排课数据中...</td>
                </tr>
                <tr v-else-if="schedules.length === 0">
                  <td colspan="11" style="text-align: center; padding: 30px; color: #94a3b8;">暂无排课记录</td>
                </tr>
                <tr v-for="s in schedules" :key="s.id">
                  <td style="font-family: monospace; font-weight: 600;">#{{ s.id }}</td>
                  <td style="font-weight: 600; color: #1e40af;">{{ s.class_name }}</td>
                  <td style="font-family: monospace; font-size: 11px;">{{ s.date }} {{ s.start_time }}-{{ s.end_time }}</td>
                  <td>
                    <span>{{ s.actual_teacher_name || s.teacher_name }}</span>
                    <span v-if="s.actual_teacher_id && s.actual_teacher_id !== s.teacher_id" class="badge badge-orange" style="margin-left: 4px; font-size: 9px;">代</span>
                  </td>
                  <td>
                    <span :class="getStatusBadgeClass(s.status)">{{ statusText(s.status) }}</span>
                  </td>
                  <!-- 初始出勤人头 (铁律不可篡改) -->
                  <td style="text-align: center;">
                    <span class="badge badge-blue" style="font-weight: 700;">{{ s.initial_present_headcount }} 人</span>
                  </td>
                  <!-- 原班已补差人头计数 -->
                  <td style="text-align: center;">
                    <span class="badge badge-purple" style="font-weight: 700;">{{ s.makeup_compensated_count }} 人</span>
                  </td>
                  <!-- 代课老师 -->
                  <td>
                    <span v-if="s.substitute_teacher_id" class="badge badge-orange">
                      {{ s.substitute_teacher_name || s.substitute_teacher_id }}
                    </span>
                    <span v-else style="color: #94a3b8;">无</span>
                  </td>
                  <!-- 跨班补课学员数组 -->
                  <td>
                    <div v-if="s.makeup_students_list && s.makeup_students_list.length > 0">
                      <div 
                        v-for="(m, idx) in s.makeup_students_list" 
                        :key="idx" 
                        style="font-size: 11px; margin-bottom: 2px; background: #f8fafc; padding: 2px 6px; border-radius: 4px; border: 1px solid #e2e8f0;"
                      >
                        <strong>{{ m.student_name || '学员姓名待核对' }}</strong>
                        <span style="color: #64748b; margin-left: 4px;">
                          (原老师: {{ m.original_teacher_name || '原教师姓名待核对' }}, 缺勤课: #{{ m.original_absent_schedule_id }})
                        </span>
                      </div>
                    </div>
                    <span v-else style="color: #cbd5e1;">-</span>
                  </td>
                  <!-- 消课扣费快照 -->
                  <td style="text-align: center;">
                    <button 
                      v-if="s.deducted_detail_json" 
                      class="btn btn-sm" 
                      style="color: #2563eb; border-color: #bfdbfe;"
                      @click="openDeductModal(s)"
                    >
                      ⚡ 查看扣费
                    </button>
                    <span v-else style="color: #cbd5e1;">未扣费</span>
                  </td>
                  <!-- 当节课酬 -->
                  <td style="text-align: right; font-weight: 700; color: #16a34a; font-family: monospace;">
                    ¥{{ (s.calculated_teacher_fee !== undefined && s.calculated_teacher_fee !== null) ? s.calculated_teacher_fee : '--' }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- ── 子 Tab 2：学生课时包账本透视 ── -->
      <div v-if="subTab === 'packages'" class="console-card">
        <div class="card-header">
          <div class="card-title-group">
            <span style="font-size: 18px;">👛</span>
            <div>
              <div class="card-title">学生课时包与流水记录</div>
              <div class="card-subtitle">一屏穿透名下全量课时包批次、可用课时、透支欠课、冻结天数、审批并发锁及不可变流水</div>
            </div>
          </div>
          <div class="card-actions">
            <input 
              class="input-control" 
              style="width: 220px;" 
              v-model="studentSearchKeyword" 
              @keyup.enter="fetchStudentPackages"
              placeholder="输入学员姓名或联系电话检索..." 
            />
            <button class="btn btn-sm btn-primary" @click="fetchStudentPackages">搜索学员</button>
          </div>
        </div>

        <div class="card-body">
          <div v-if="loadingStudentPkgs" style="text-align: center; padding: 40px; color: #94a3b8;">
            检索学员课时包账本中...
          </div>

          <div v-else-if="studentPackagesList.length === 0" style="text-align: center; padding: 40px; color: #94a3b8;">
            没有找到符合条件的学员课时记录
          </div>

          <!-- 学员账本透视卡片列表 -->
          <div v-else v-for="item in studentPackagesList" :key="item.student.id" style="margin-bottom: 24px;">
            <!-- 学员统计顶栏 -->
            <div class="snapshot-summary-box">
              <div class="ss-item">
                <span class="ss-label">学员姓名</span>
                <span class="ss-value" style="color: #1e40af;">{{ item.student.name }} (#{{ item.student.id }})</span>
              </div>
              <div class="ss-item">
                <span class="ss-label">可用总课时 (付费+赠送)</span>
                <span class="ss-value" style="color: #16a34a;">{{ item.stats.total_available_hours }} 课时</span>
              </div>
              <div class="ss-item">
                <span class="ss-label">付费剩余</span>
                <span class="ss-value">{{ item.stats.total_paid_left }} 课时</span>
              </div>
              <div class="ss-item">
                <span class="ss-label">赠送剩余 (绝不退费)</span>
                <span class="ss-value" style="color: #d97706;">{{ item.stats.total_gift_left }} 课时</span>
              </div>
              <div class="ss-item">
                <span class="ss-label">累计透支欠费</span>
                <span class="ss-value" :style="{color: item.stats.total_debt_hours > 0 ? '#dc2626' : '#64748b'}">
                  {{ item.stats.total_debt_hours }} 课时
                </span>
              </div>
              <div class="ss-item">
                <span class="ss-label">累计冻结天数</span>
                <span class="ss-value">{{ item.stats.total_frozen_days }} / 90 天</span>
              </div>
              <div class="ss-item">
                <span class="ss-label">课时包批次总数</span>
                <span class="ss-value">{{ item.stats.package_count }} 笔</span>
              </div>
            </div>

            <!-- 课时包表格 -->
            <div class="table-container" style="margin-bottom: 12px;">
              <table class="dense-table">
                <thead>
                  <tr>
                    <th style="width: 100px;">批次ID</th>
                    <th style="width: 130px;">课程名称</th>
                    <th style="width: 120px;">所属学期</th>
                    <th style="width: 120px;">统一到期日</th>
                    <th style="width: 90px;">单价快照</th>
                    <th style="width: 120px;">资金去向</th>
                    <th style="width: 110px;">付费 (余/总)</th>
                    <th style="width: 110px;">赠送 (余/总)</th>
                    <th style="width: 90px;">透支欠课</th>
                    <th style="width: 90px;">冻结天数</th>
                    <th style="width: 120px;">并发锁状态</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="pkg in item.packages" :key="pkg.id">
                    <td style="font-family: monospace; font-weight: 600;">#{{ pkg.id }}</td>
                    <td style="font-weight: 600;">{{ pkg.course_name_snapshot }}</td>
                    <td>{{ pkg.term_name_snapshot }}</td>
                    <td style="font-family: monospace;">{{ pkg.expire_date }}</td>
                    <td style="font-weight: 600;">¥{{ pkg.unit_price_snapshot }}</td>
                    <td>
                      <span :class="pkg.account_destination === '进入公账' ? 'badge badge-blue' : 'badge badge-green'">
                        {{ pkg.account_destination }}
                      </span>
                    </td>
                    <td style="font-weight: 600; color: #2563eb;">{{ pkg.paid_hours_left }} / {{ pkg.paid_hours_total }}</td>
                    <td style="font-weight: 600; color: #d97706;">{{ pkg.gift_hours_left }} / {{ pkg.gift_hours_total }}</td>
                    <td>
                      <span v-if="pkg.debt_hours > 0" class="badge badge-red">{{ pkg.debt_hours }} 课时</span>
                      <span v-else style="color: #94a3b8;">0</span>
                    </td>
                    <td>{{ pkg.total_frozen_days || 0 }} 天</td>
                    <td>
                      <span v-if="pkg.lock_status === 'pending_approval_locked'" class="badge badge-red">
                        🔒 审批锁定中 (#{{ pkg.locked_by_approval_id }})
                      </span>
                      <span v-else-if="pkg.lock_status === 'refunded'" class="badge badge-gray">
                        💸 已退费核销
                      </span>
                      <span v-else-if="pkg.lock_status === 'frozen'" class="badge badge-orange">
                        ❄️ 休学冻结中
                      </span>
                      <span v-else class="badge badge-green">正常解锁</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <!-- 历史流水折叠/展示 -->
            <div style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 6px; padding: 10px 14px; font-size: 12px;">
              <span style="font-weight: 700; color: #334155;">📜 关联教务与财务不可变流水：</span>
              <span style="color: #64748b; margin-left: 8px;">
                手工调账 {{ item.history.manual_adjustments.length }} 笔 · 
                教务三转 {{ item.history.transfers.length }} 笔 · 
                退费档案 {{ item.history.refunds.length }} 笔 · 
                四期顺延 {{ item.history.rollovers.length }} 笔
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- 消课扣费明细 Modal -->
      <div v-if="deductModal.visible" class="modal-mask" @click="deductModal.visible = false">
        <div class="modal-content" @click.stop style="width: 750px;">
          <div class="modal-header">
            <span class="modal-title">本次课时扣除明细</span>
            <button class="modal-close" @click="deductModal.visible = false">✕</button>
          </div>
          <div class="modal-body">
            <p style="color:#3c5067;line-height:1.6;">按学员列出实际扣除的课时；不会显示内部记录格式。</p>
            <div v-if="readableDeduction.rows.length" class="table-container">
              <table class="dense-table">
                <thead><tr><th>学员</th><th>课时扣除</th><th>课程类别</th></tr></thead>
                <tbody>
                  <tr v-for="(row, idx) in readableDeduction.rows" :key="idx">
                    <td>{{ row.name }}</td><td>{{ row.hours }}</td><td>{{ row.type }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p style="color:#6b7484;line-height:1.6;">{{ readableDeduction.note }}</p>
          </div>
          <div class="modal-footer">
            <button class="btn" @click="deductModal.visible = false">关闭</button>
          </div>
        </div>
      </div>
    </div>
  `,

  data() {
    return {
      subTab: 'schedules',
      schedules: [],
      loadingSchedules: false,
      studentPackagesList: [],
      loadingStudentPkgs: false,
      studentSearchKeyword: '',
      deductModal: {
        visible: false,
        schedule: {}
      }
    };
  },

  mounted() {
    this.fetchSchedules();
    this.fetchStudentPackages();
  },

  computed: {
    readableDeduction() {
      return window.BusinessDisplay.readableDeduction(this.deductModal.schedule);
    }
  },

  methods: {
    async fetchSchedules() {
      this.loadingSchedules = true;
      try {
        const res = await window.api.getSchedules();
        if (res && res.data) {
          this.schedules = res.data;
        }
      } catch (err) {
        console.error('fetchSchedules error:', err);
      } finally {
        this.loadingSchedules = false;
      }
    },

    async fetchStudentPackages() {
      this.loadingStudentPkgs = true;
      try {
        const res = await window.api.getStudentPackages({
          keyword: this.studentSearchKeyword
        });
        if (res && res.data) {
          this.studentPackagesList = res.data;
        }
      } catch (err) {
        console.error('fetchStudentPackages error:', err);
      } finally {
        this.loadingStudentPkgs = false;
      }
    },

    getStatusBadgeClass(status) {
      if (status === 'signed') return 'badge badge-green';
      if (status === 'scheduled') return 'badge badge-blue';
      if (status === 'cancelled') return 'badge badge-red';
      return 'badge badge-gray';
    },

    openDeductModal(schedule) {
      this.deductModal.schedule = schedule;
      this.deductModal.visible = true;
    },

    statusText(status) {
      return window.BusinessDisplay.readableScheduleStatus(status);
    },

    handleLiveMutation(data) {
      // 实时收到数据变更时静默刷新
      if (this.subTab === 'schedules') {
        this.fetchSchedules();
      } else {
        this.fetchStudentPackages();
      }
    }
  }
};

window.InspectorComponent = InspectorComponent;

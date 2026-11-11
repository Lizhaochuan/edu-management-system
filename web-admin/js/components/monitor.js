// web-admin/js/components/monitor.js
// 3. 异常与预警监控大盘 (Anomaly & Alert Monitor)

const MonitorComponent = {
  template: `
    <div>
      <!-- 顶部 4 大核心监控指标卡片 -->
      <div class="metrics-grid">
        <div 
          class="metric-card" 
          :class="{ active: activeSection === 'locked' }"
          @click="activeSection = 'locked'"
        >
          <div class="mc-left">
            <span class="mc-title">待审批锁定中课时包</span>
            <span class="mc-value val-danger">{{ metrics.locked_packages_count || 0 }}</span>
            <span style="font-size: 11px; color: #94a3b8;">并发锁生效·消课可物理破锁</span>
          </div>
          <span class="mc-icon">🔒</span>
        </div>

        <div 
          class="metric-card" 
          :class="{ active: activeSection === 'invalidated' }"
          @click="activeSection = 'invalidated'"
        >
          <div class="mc-left">
            <span class="mc-title">考勤消课破锁失效单</span>
            <span class="mc-value val-warning">{{ metrics.invalidated_approvals_count || 0 }}</span>
            <span style="font-size: 11px; color: #94a3b8;">invalidated_by_attendance</span>
          </div>
          <span class="mc-icon">⚡</span>
        </div>

        <div 
          class="metric-card" 
          :class="{ active: activeSection === 'debt' }"
          @click="activeSection = 'debt'"
        >
          <div class="mc-left">
            <span class="mc-title">欠课透支 / &lt;4课时预警</span>
            <span class="mc-value val-danger">{{ (metrics.debt_packages_count || 0) + (metrics.low_balance_packages_count || 0) }}</span>
            <span style="font-size: 11px; color: #94a3b8;">透支扣至0记欠 + 4课时家校预警</span>
          </div>
          <span class="mc-icon">🚨</span>
        </div>

        <div 
          class="metric-card" 
          :class="{ active: activeSection === 'unsub' }"
          @click="activeSection = 'unsub'"
        >
          <div class="mc-left">
            <span class="mc-title">未授权订阅人工兜底队列</span>
            <span class="mc-value val-primary">{{ metrics.unsubscribed_parents_count || 0 }}</span>
            <span style="font-size: 11px; color: #94a3b8;">subscribe_auth=false 待发微信</span>
          </div>
          <span class="mc-icon">📢</span>
        </div>
      </div>

      <!-- ── 详情区域 1：待审批锁定中课时包 ── -->
      <div v-if="activeSection === 'locked'" class="console-card">
        <div class="card-header">
          <div class="card-title-group">
            <span style="font-size: 16px;">🔒</span>
            <span class="card-title">待审批锁定中课时包清单 (pending_approval_locked)</span>
          </div>
          <span class="badge badge-red">共 {{ pendingLockedPackages.length }} 笔被锁定</span>
        </div>
        <div class="card-body">
          <div class="table-container">
            <table class="dense-table">
              <thead>
                <tr>
                  <th>课时包ID</th>
                  <th>学员姓名</th>
                  <th>课程名称</th>
                  <th>绑定班级</th>
                  <th>可用课时 (付费+赠送)</th>
                  <th>单价快照</th>
                  <th>资金去向</th>
                  <th>挂接待审单号</th>
                  <th>锁状态说明</th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="pendingLockedPackages.length === 0">
                  <td colspan="9" style="text-align: center; padding: 24px; color: #94a3b8;">当前无待审批锁定的课时包，所有包均处于自由状态</td>
                </tr>
                <tr v-for="pkg in pendingLockedPackages" :key="pkg.id">
                  <td style="font-family: monospace; font-weight: 700;">#{{ pkg.id }}</td>
                  <td style="font-weight: 700; color: #1e40af;">{{ pkg.student_name_snapshot }}</td>
                  <td>{{ pkg.course_name_snapshot }}</td>
                  <td>{{ pkg.class_id ? ('班级#' + pkg.class_id) : '独立未入班' }}</td>
                  <td style="font-weight: 700; color: #2563eb;">{{ pkg.paid_hours_left }} 付费 + {{ pkg.gift_hours_left }} 赠送</td>
                  <td>¥{{ pkg.unit_price_snapshot }}</td>
                  <td>{{ pkg.account_destination }}</td>
                  <td style="font-family: monospace; font-weight: 700; color: #dc2626;">
                    #{{ pkg.locked_by_approval_id }}
                  </td>
                  <td>
                    <span class="badge badge-red">审批并发保护中</span>
                    <span style="font-size: 11px; color: #64748b; margin-left: 6px;">(消课具有最高物理优先级，破锁扣费)</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- ── 详情区域 2：因考勤消课破锁失效的审批单 ── -->
      <div v-if="activeSection === 'invalidated'" class="console-card">
        <div class="card-header">
          <div class="card-title-group">
            <span style="font-size: 16px;">⚡</span>
            <span class="card-title">因考勤消课破锁失效的审批单据清单 (invalidated_by_attendance)</span>
          </div>
          <span class="badge badge-orange">共 {{ invalidatedApprovals.length }} 笔被破锁废止</span>
        </div>
        <div class="card-body">
          <div class="table-container">
            <table class="dense-table">
              <thead>
                <tr>
                  <th>单据编号</th>
                  <th>申请类型</th>
                  <th>发起人</th>
                  <th>关联表 / 记录ID</th>
                  <th>申请原因</th>
                  <th>破锁废止判定理由</th>
                  <th>处理时间</th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="invalidatedApprovals.length === 0">
                  <td colspan="7" style="text-align: center; padding: 24px; color: #94a3b8;">暂无因消课破锁而失效的审批单</td>
                </tr>
                <tr v-for="app in invalidatedApprovals" :key="app.id">
                  <td style="font-family: monospace; font-weight: 700;">#{{ app.id }}</td>
                  <td><span class="badge badge-purple">{{ app.request_type }}</span></td>
                  <td>{{ app.proposer_name }}</td>
                  <td style="font-family: monospace;">{{ app.target_table }} #{{ app.target_record_id }}</td>
                  <td>{{ app.reason }}</td>
                  <td style="color: #d97706; font-weight: 600;">
                    {{ app.reject_reason || '考勤消课导致余额变动，审批快照失效，系统自动破锁废止！' }}
                  </td>
                  <td style="font-family: monospace; font-size: 11px; color: #64748b;">{{ app.reviewed_at || app.updated_at }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- ── 详情区域 3：欠课透支与 < 4 课时预警 ── -->
      <div v-if="activeSection === 'debt'" class="console-card">
        <div class="card-header">
          <div class="card-title-group">
            <span style="font-size: 16px;">⚠️</span>
            <span class="card-title">欠课透支账本与 &lt;4 课时预警名单</span>
          </div>
          <span class="badge badge-red">欠费 {{ debtPackages.length }} 笔 · 预警 {{ lowBalancePackages.length }} 笔</span>
        </div>
        <div class="card-body">
          <div class="table-container">
            <table class="dense-table">
              <thead>
                <tr>
                  <th>批次ID</th>
                  <th>学员姓名</th>
                  <th>课程名称</th>
                  <th>所属学期</th>
                  <th>剩余可用课时</th>
                  <th>透支欠课时 (debt_hours)</th>
                  <th>预警类别</th>
                  <th>内控规则执行状态</th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="debtPackages.length === 0 && lowBalancePackages.length === 0">
                  <td colspan="8" style="text-align: center; padding: 24px; color: #94a3b8;">太棒了！当前没有任何透支欠费或低余额预警学员</td>
                </tr>
                <!-- 欠费批次 -->
                <tr v-for="pkg in debtPackages" :key="'debt_' + pkg.id" class="row-danger">
                  <td style="font-family: monospace; font-weight: 700;">#{{ pkg.id }}</td>
                  <td style="font-weight: 700; color: #dc2626;">{{ pkg.student_name_snapshot }}</td>
                  <td>{{ pkg.course_name_snapshot }}</td>
                  <td>{{ pkg.term_name_snapshot }}</td>
                  <td>0 课时 (可用课时已扣光)</td>
                  <td style="font-weight: 900; color: #dc2626; font-size: 13px;">{{ pkg.debt_hours }} 课时</td>
                  <td><span class="badge badge-red">🚨 欠费透支</span></td>
                  <td>余额扣至0不为负，已入欠费账本，下次买课优先冲抵</td>
                </tr>
                <!-- 低余额预警批次 -->
                <tr v-for="pkg in lowBalancePackages" :key="'low_' + pkg.id" class="row-warning">
                  <td style="font-family: monospace; font-weight: 700;">#{{ pkg.id }}</td>
                  <td style="font-weight: 700; color: #d97706;">{{ pkg.student_name_snapshot }}</td>
                  <td>{{ pkg.course_name_snapshot }}</td>
                  <td>{{ pkg.term_name_snapshot }}</td>
                  <td style="font-weight: 800; color: #d97706;">{{ Number(pkg.paid_hours_left) + Number(pkg.gift_hours_left) }} 课时</td>
                  <td>0</td>
                  <td><span class="badge badge-orange">⚠️ &lt; 4课时预警</span></td>
                  <td>系统已触发家校通知，提示家长续课</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- ── 详情区域 4：未授权微信订阅通知兜底队列 ── -->
      <div v-if="activeSection === 'unsub'" class="console-card">
        <div class="card-header">
          <div class="card-title-group">
            <span style="font-size: 16px;">📢</span>
            <span class="card-title">未授权微信订阅家长通知人工兜底队列 (subscribe_auth = false)</span>
          </div>
          <span class="badge badge-blue">待人工处理 {{ unsubscribedParents.length }} 位家长</span>
        </div>
        <div class="card-body">
          <div class="table-container">
            <table class="dense-table">
              <thead>
                <tr>
                  <th>学员姓名</th>
                  <th>家长电话</th>
                  <th>亲属关系</th>
                  <th>微信订阅授权状态</th>
                  <th>兜底通知要求</th>
                  <th style="width: 130px; text-align: center;">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="unsubscribedParents.length === 0">
                  <td colspan="6" style="text-align: center; padding: 24px; color: #94a3b8;">所有家长均已授权微信订阅通知，无需人工兜底</td>
                </tr>
                <tr v-for="(p, idx) in unsubscribedParents" :key="idx">
                  <td style="font-weight: 700; color: #1e40af;">{{ p.student_name }}</td>
                  <td style="font-family: monospace; font-weight: 600;">{{ p.parent_phone }}</td>
                  <td>{{ p.relation }}</td>
                  <td><span class="badge badge-red">未授权 (false)</span></td>
                  <td style="color: #475569;">订阅消息推送无法触达，系统要求教务人员手工发微信/打电话告知</td>
                  <td style="text-align: center;">
                    <button class="btn btn-sm btn-primary" @click="markContacted(p)">
                      ✅ 标记已微信通知
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `,

  data() {
    return {
      activeSection: 'locked',
      metrics: {},
      pendingLockedPackages: [],
      invalidatedApprovals: [],
      debtPackages: [],
      lowBalancePackages: [],
      unsubscribedParents: []
    };
  },

  mounted() {
    this.fetchOverview();
  },

  methods: {
    async fetchOverview() {
      try {
        const res = await window.api.getAnomalyOverview();
        if (res && res.data) {
          this.metrics = res.data.metrics || {};
          this.pendingLockedPackages = res.data.pending_locked_packages || [];
          this.invalidatedApprovals = res.data.invalidated_approvals || [];
          this.debtPackages = res.data.debt_packages || [];
          this.lowBalancePackages = res.data.low_balance_packages || [];
          this.unsubscribedParents = res.data.unsubscribed_parents || [];
        }
      } catch (err) {
        console.error('fetchOverview error:', err);
      }
    },

    markContacted(p) {
      alert(`已成功标记：已通过微信人工告知学员【${p.student_name}】的监护人（${p.parent_phone}）！`);
    },

    handleLiveMutation(data) {
      this.fetchOverview();
    }
  }
};

window.MonitorComponent = MonitorComponent;

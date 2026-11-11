// web-admin/js/components/approval-center.js
// Phase 6-B 板块 1：超级管理员审批工作台 (Approval Center)

const ApprovalCenterComponent = {
  template: `
    <div class="console-card">
      <div class="card-header">
        <div class="card-title-group">
          <span style="font-size: 18px;">⚖️</span>
          <div>
            <div class="card-title">超级管理员审批工作台 (Approval Center)</div>
            <div class="card-subtitle">集中处理核心教务、财务退费三转、课时调账与算薪调整 · 双超管互审防线与自审硬性拦截</div>
          </div>
        </div>

        <div class="card-actions">
          <span class="badge badge-red" v-if="pendingCount > 0">{{ pendingCount }} 单待审批</span>
          <button class="btn btn-sm btn-primary" @click="fetchApprovals">
            <span>🔄</span> 刷新待办
          </button>
        </div>
      </div>

      <div class="card-body">
        <!-- 顶部筛选与状态切换 -->
        <div class="filter-bar">
          <div class="filter-item">
            <span class="filter-label">审批状态:</span>
            <select class="input-control" v-model="statusFilter" @change="fetchApprovals">
              <option value="pending">待我审批 (Pending)</option>
              <option value="processed">已处理历史 (Processed)</option>
              <option value="">全部单据</option>
            </select>
          </div>

          <div class="filter-item">
            <span class="filter-label">业务类型:</span>
            <select class="input-control" v-model="typeFilter" @change="fetchApprovals">
              <option value="">全部类型</option>
              <option value="transfer">转人 / 转课 / 转班 (transfer)</option>
              <option value="refund">退费清算申请 (refund)</option>
              <option value="manual_hour_adjust">手工调课时 (manual_hour_adjust)</option>
              <option value="freeze_hours">课时休学冻结 (freeze_hours)</option>
              <option value="salary_adjustment">薪资调账补发扣回 (salary_adjustment)</option>
              <option value="makeup_attendance">漏签补签申请 (makeup_attendance)</option>
              <option value="config_change">底座配置变更 (config_change)</option>
            </select>
          </div>

          <button class="btn btn-sm" @click="resetFilters">重置条件</button>
        </div>

        <div v-if="loading" style="text-align: center; padding: 40px; color: #94a3b8;">
          加载审批单据列表中...
        </div>

        <div v-else-if="approvals.length === 0" style="text-align: center; padding: 40px; color: #94a3b8;">
          当前没有符合条件的审批申请单据
        </div>

        <!-- 审批单据卡片列表 -->
        <div v-else style="display: flex; flex-direction: column; gap: 16px;">
          <div 
            v-for="item in approvals" 
            :key="item.id"
            style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 18px; box-shadow: 0 1px 3px rgba(0,0,0,0.04);"
            :style="{ borderLeft: item.status === 'pending' ? '4px solid #1890ff' : (item.status === 'approved' ? '4px solid #52c41a' : '4px solid #ef4444') }"
          >
            <!-- 卡片顶栏 -->
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;">
              <div>
                <span style="font-family: monospace; font-weight: 700; font-size: 14px; margin-right: 8px;">#{{ item.id }}</span>
                <span :class="getTypeBadgeClass(item.request_type)">{{ getTypeLabel(item.request_type) }}</span>
                <span style="margin-left: 8px; font-size: 12px; color: #64748b;">
                  发起人: <strong>{{ item.proposer_name }}</strong> (ID: {{ item.proposer_id }})
                </span>
                <span style="margin-left: 8px; font-size: 11px; color: #94a3b8;">
                  {{ item.action_time || item.created_at }}
                </span>
              </div>

              <div>
                <span v-if="item.status === 'pending'" class="badge badge-blue">⏳ 待审批</span>
                <span v-else-if="item.status === 'approved'" class="badge badge-green">
                  ✅ 批准通过 ({{ item.approver_name }})
                </span>
                <span v-else-if="item.status === 'rejected'" class="badge badge-red">
                  ❌ 已驳回 ({{ item.reject_reason || '评估不符' }})
                </span>
                <span v-else-if="item.status === 'invalidated_by_attendance'" class="badge badge-orange">
                  ⚡ 考勤消课自动破锁失效
                </span>
              </div>
            </div>

            <!-- 申请事由摘要 -->
            <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 10px 14px; margin-bottom: 14px; font-size: 13px; font-weight: 500; color: #1e293b;">
              <strong>📝 申请事由：</strong> {{ item.reason }}
            </div>

            <!-- ── 算账明细与快照对比面板 ── -->
            <!-- 1. 三转详情 (Transfer) -->
            <div v-if="item.request_type === 'transfer' && item.parsed_after" style="background: #f0f7ff; border: 1px solid #bae0ff; border-radius: 6px; padding: 12px; margin-bottom: 12px; font-size: 12px;">
              <div style="font-weight: 700; color: #0050b3; margin-bottom: 6px;">📊 三转算账与换算明细预览：</div>
              <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 8px;">
                <div>转出学员: <strong>{{ item.parsed_after.source_student_name }}</strong></div>
                <div>目标学员: <strong>{{ item.parsed_after.target_student_name }}</strong></div>
                <div>先付费后赠送分解: <span style="color:#1890ff; font-weight:700;">扣付费{{ item.parsed_after.transferred_paid_hours }}</span> + <span style="color:#52c41a; font-weight:700;">扣赠送{{ item.parsed_after.transferred_gift_hours }}</span></div>
                <div>目标所得课时: <strong style="color:#722ed1;">{{ item.parsed_after.target_total_hours }} 课时</strong> ({{ item.parsed_after.target_paid_hours }}付费 + {{ item.parsed_after.target_gift_hours }}赠送)</div>
                <div v-if="item.parsed_after.target_lessons">折合新班节数: <strong>{{ item.parsed_after.target_lessons }} 节 (强制整节换算)</strong></div>
                <div v-if="item.parsed_after.top_up_amount > 0" style="color: #52c41a; font-weight: 700;">家长需补差价: +¥{{ item.parsed_after.top_up_amount }}</div>
                <div v-if="item.parsed_after.refund_amount > 0" style="color: #fa8c16; font-weight: 700;">需退还家长零头: -¥{{ item.parsed_after.refund_amount }}</div>
                <div>到期日继承: <strong>{{ item.parsed_after.expire_date }} (严格不变)</strong></div>
              </div>
            </div>

            <!-- 2. 退费详情 (Refund) -->
            <div v-if="item.request_type === 'refund' && item.parsed_after" style="background: #fff1f0; border: 1px solid #ffa39e; border-radius: 6px; padding: 12px; margin-bottom: 12px; font-size: 12px;">
              <div style="font-weight: 700; color: #a8071a; margin-bottom: 6px;">💸 退费清算核算明细：</div>
              <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 8px;">
                <div>退费学员: <strong>{{ item.parsed_after.student_name }}</strong></div>
                <div>剩余付费课时: <strong style="color: #1890ff;">{{ item.parsed_after.paid_hours_left }} 课时 (只退付费)</strong></div>
                <div>作废赠送课时: <strong style="color: #fa8c16;">{{ item.parsed_after.gift_hours_forfeited }} 课时 (一分不退，核销清零)</strong></div>
                <div>应退学费总额: <strong>¥{{ item.parsed_after.gross_refund }}</strong> (单价: ¥{{ item.parsed_after.unit_price_snapshot }})</div>
                <div>资金去向与手续费: <span :style="{color: item.parsed_after.is_personal_account ? '#52c41a' : '#fa8c16'}">
                  {{ item.parsed_after.account_destination }} (扣减手续费: ¥{{ item.parsed_after.handling_fee }})
                </span></div>
                <div style="font-size: 14px; font-weight: 800; color: #f5222d;">实际退还金额: ¥{{ item.parsed_after.net_refund }} ({{ item.parsed_after.refund_method }})</div>
              </div>
            </div>

            <!-- 3. 手工调课时详情 (Manual Adjust) -->
            <div v-if="(item.request_type === 'manual_hour_adjust' || item.request_type === 'balance_adjustment') && item.parsed_after" style="background: #f9f0ff; border: 1px solid #d3adf7; border-radius: 6px; padding: 12px; margin-bottom: 12px; font-size: 12px;">
              <div style="font-weight: 700; color: #531dab; margin-bottom: 6px;">⚖️ 课时调账核算预览：</div>
              <div style="display: flex; gap: 24px;">
                <div>调整方向: <strong>{{ item.parsed_after.direction === 'increase' ? '➕ 增加课时' : '➖ 扣减课时' }}</strong></div>
                <div>付费课时变动: <strong>{{ item.parsed_after.paid_hours_delta || item.parsed_after.paid_delta }} 课时</strong></div>
                <div>赠送课时变动: <strong>{{ item.parsed_after.gift_hours_delta || item.parsed_after.gift_delta }} 课时</strong></div>
                <div>调后余额: 付费 {{ item.parsed_after.new_paid_hours || item.parsed_after.paid_hours_after }} / 赠送 {{ item.parsed_after.new_gift_hours || item.parsed_after.gift_hours_after }} (防负数校验通过)</div>
              </div>
            </div>

            <!-- 4. 冻结详情 (Freeze) -->
            <div v-if="item.request_type === 'freeze_hours' && item.parsed_after" style="background: #e6fffb; border: 1px solid #87e8de; border-radius: 6px; padding: 12px; margin-bottom: 12px; font-size: 12px;">
              <div style="font-weight: 700; color: #006d75; margin-bottom: 6px;">❄️ 休学冻结进度条 (90天双封顶)：</div>
              <div style="display: flex; gap: 24px; align-items: center;">
                <div>本次申请冻结: <strong>{{ item.parsed_after.freeze_days }} 天</strong> (单次 &le; 90天)</div>
                <div>顺延后新到期日: <strong style="color: #08979c;">{{ item.parsed_after.new_expire_date }}</strong></div>
              </div>
            </div>

            <!-- 5. 薪资调账详情 (Salary Adjustment) -->
            <div v-if="item.request_type === 'salary_adjustment' && item.parsed_after" style="background: #fffbe6; border: 1px solid #ffe58f; border-radius: 6px; padding: 12px; margin-bottom: 12px; font-size: 12px;">
              <div style="font-weight: 700; color: #ad6800; margin-bottom: 6px;">💰 教师课酬算错调账明细：</div>
              <div style="display: flex; gap: 24px;">
                <div>调账类型: <strong :style="{color: (item.parsed_after.adjustment_type === 'supplement' || item.parsed_after.direction === 'reissue') ? '#52c41a' : '#f5222d'}">
                  {{ (item.parsed_after.adjustment_type === 'supplement' || item.parsed_after.direction === 'reissue') ? '➕ 补发课酬' : '➖ 扣回课酬' }}
                </strong></div>
                <div>金额: <strong>¥{{ item.parsed_after.amount }}</strong></div>
                <div>受薪教师: <strong>{{ item.parsed_after.teacher_name }}</strong></div>
                <div>状态: 下期发薪日自动挂入结算单抵扣/发放</div>
              </div>
            </div>

            <!-- 底部操作按钮栏 -->
            <div v-if="item.status === 'pending'" style="display: flex; justify-content: flex-end; align-items: center; gap: 12px; border-top: 1px solid #f1f5f9; padding-top: 12px;">
              <!-- 自审拦截提示 -->
              <span v-if="isSelfProposer(item)" style="color: #dc2626; font-size: 12px; font-weight: 600;">
                ⚠️ 违反内控自审铁律：不能审批自己发起的申请，请切换其他超管账号
              </span>

              <!-- 权限不足提示 -->
              <span v-else-if="!canApprove(item)" style="color: #d97706; font-size: 12px; font-weight: 600;">
                🔒 仅超级管理员一人有权审批此项单据
              </span>

              <!-- 批准与驳回按钮 -->
              <button 
                class="btn btn-sm btn-danger"
                :disabled="!canApprove(item) || isSelfProposer(item)"
                @click="onReject(item)"
              >
                ❌ 驳回申请
              </button>

              <button 
                class="btn btn-sm btn-primary"
                :disabled="!canApprove(item) || isSelfProposer(item)"
                @click="onApprove(item)"
              >
                ✅ 确认批准通过
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,

  data() {
    return {
      approvals: [],
      loading: false,
      statusFilter: 'pending',
      typeFilter: '',
      pendingCount: 0
    };
  },

  mounted() {
    this.fetchApprovals();
  },

  methods: {
    async fetchApprovals() {
      this.loading = true;
      try {
        const res = await window.api.getApprovals({
          status: this.statusFilter,
          request_type: this.typeFilter
        });
        if (res && res.data) {
          this.approvals = res.data;
          this.pendingCount = this.approvals.filter(a => a.status === 'pending').length;
        }
      } catch (err) {
        console.error('fetchApprovals error:', err);
      } finally {
        this.loading = false;
      }
    },

    resetFilters() {
      this.statusFilter = 'pending';
      this.typeFilter = '';
      this.fetchApprovals();
    },

    isSelfProposer(item) {
      const cur = window.api.getCurrentIdentity();
      return cur && cur.id === item.proposer_id;
    },

    canApprove(item) {
      const cur = window.api.getCurrentIdentity();
      if (!cur) return false;
      if (cur.role === 'super_admin') return true;
      if (cur.role === 'admin' && item.request_type === 'freeze_hours') return true;
      return false;
    },

    async onApprove(item) {
      if (!confirm(`确认批准单据 #${item.id} (${this.getTypeLabel(item.request_type)}) 吗？\n事由：${item.reason}`)) {
        return;
      }
      try {
        const res = await window.api.approveApproval(item.id);
        alert(res.message || '审批已成功通过并生效！');
        this.fetchApprovals();
      } catch (err) {
        alert(`审批失败：${err.message}`);
      }
    },

    async onReject(item) {
      const reason = prompt(`请输入驳回单据 #${item.id} 的详细原因：`, '经超管评估未予通过');
      if (reason === null) return;
      if (!reason.trim()) {
        alert('驳回理由不能为空！');
        return;
      }
      try {
        const res = await window.api.rejectApproval(item.id, reason.trim());
        alert(res.message || '已成功驳回并释放锁定！');
        this.fetchApprovals();
      } catch (err) {
        alert(`驳回操作失败：${err.message}`);
      }
    },

    getTypeLabel(type) {
      const map = {
        transfer: '转人/转课/转班',
        refund: '退费清算',
        manual_hour_adjust: '手工调课时',
        balance_adjustment: '余额调账',
        freeze_hours: '课时休学冻结',
        salary_adjustment: '薪资算错调账',
        makeup_attendance: '漏签补签',
        config_change: '系统参数配置'
      };
      return map[type] || type;
    },

    getTypeBadgeClass(type) {
      if (type === 'transfer') return 'badge badge-purple';
      if (type === 'refund') return 'badge badge-red';
      if (type === 'manual_hour_adjust' || type === 'balance_adjustment') return 'badge badge-orange';
      if (type === 'freeze_hours') return 'badge badge-blue';
      if (type === 'salary_adjustment') return 'badge badge-orange';
      if (type === 'makeup_attendance') return 'badge badge-green';
      return 'badge badge-gray';
    },

    handleLiveMutation(data) {
      this.fetchApprovals();
    }
  }
};

window.ApprovalCenterComponent = ApprovalCenterComponent;

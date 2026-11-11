// web-admin/js/api.js
// 统一通信与实时同步引擎 (REST API + SSE 实时流)

const API_BASE = window.location.origin;

// 预设可选身份视角列表 (全量角色覆盖)
const MOCK_IDENTITIES = [
  { id: 'u_sa1', name: '张校长(创始人)', role: 'super_admin', roleText: '超级管理员 (独批与全局最高权限)', badgeClass: 'badge-purple' },
  { id: 'u_sa2', name: '李合伙人', role: 'super_admin', roleText: '超级管理员 (双超管互审防线)', badgeClass: 'badge-purple' },
  { id: 'u_adm1', name: '王教务主管', role: 'admin', roleText: '教务管理 (排课/冻结/申请)', badgeClass: 'badge-blue' },
  { id: 'u_adm2', name: '赵财务主管', role: 'admin', roleText: '财务管理 (课时包/调账/退费申请)', badgeClass: 'badge-blue' },
  { id: 'u_tch1', name: '陈老师(初级)', role: 'teacher', roleText: '教师视角 (隐私脱敏·仅本班与代课)', badgeClass: 'badge-green' },
  { id: 'u_tch2', name: '林老师(高级)', role: 'teacher', roleText: '教师视角 (隐私脱敏·仅本班与代课)', badgeClass: 'badge-green' },
  { id: 'u_tch3', name: '周特聘名师', role: 'teacher', roleText: '名师视角 (自定义课酬标准)', badgeClass: 'badge-green' },
  { id: 'u_par1', name: '刘小宝家长', role: 'parent', student_id: 'stu_1', roleText: '家长视角 (已授权微信订阅·仅名下学员)', badgeClass: 'badge-orange' },
  { id: 'u_par2', name: '孙小乐家长', role: 'parent', student_id: 'stu_3', roleText: '家长视角 (未授权订阅·人工兜底)', badgeClass: 'badge-orange' }
];

let currentIdentity = MOCK_IDENTITIES[0];

const api = {
  getIdentities() {
    return MOCK_IDENTITIES;
  },

  getCurrentIdentity() {
    return currentIdentity;
  },

  setCurrentIdentity(id) {
    const found = MOCK_IDENTITIES.find(u => u.id === id);
    if (found) {
      currentIdentity = found;
      localStorage.setItem('current_admin_identity', JSON.stringify(found));
    }
    return currentIdentity;
  },

  async request(path, options = {}) {
    const url = `${API_BASE}${path}`;
    const headers = Object.assign({
      'Content-Type': 'application/json',
      'X-User-Id': currentIdentity.id,
      'X-User-Role': currentIdentity.role
    }, options.headers || {});

    const resp = await fetch(url, Object.assign({}, options, { headers }));
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    }
    return await resp.json();
  },

  // 1. 获取服务状态
  async getStatus() {
    return await this.request('/api/status');
  },

  // 2. 获取操作审计日志
  async getLogs(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return await this.request(`/api/logs?${qs}`);
  },

  // 3. 获取排课与考勤快照
  async getSchedules() {
    return await this.request('/api/inspector/schedules');
  },

  // 4. 获取学员课时包透视
  async getStudentPackages(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return await this.request(`/api/inspector/student-packages?${qs}`);
  },

  // 5. 获取异常与预警大盘
  async getAnomalyOverview() {
    return await this.request('/api/anomaly/overview');
  },

  // 6. 执行开发调试沙盒动作
  async runDebugAction(action, extraParams = {}) {
    return await this.request('/api/debug/action', {
      method: 'POST',
      body: JSON.stringify(Object.assign({ action }, extraParams))
    });
  },

  // 7. 获取全库数据
  async getAllDb() {
    return await this.request('/api/db/all');
  },

  // ─────────────────────────────────────────
  // Phase 6-B：超管审批中心 API
  // ─────────────────────────────────────────
  async getApprovals(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return await this.request(`/api/approvals?${qs}`);
  },

  async approveApproval(approvalId) {
    return await this.request('/api/approvals/approve', {
      method: 'POST',
      body: JSON.stringify({ approval_id: approvalId })
    });
  },

  async rejectApproval(approvalId, rejectReason) {
    return await this.request('/api/approvals/reject', {
      method: 'POST',
      body: JSON.stringify({ approval_id: approvalId, reject_reason: rejectReason })
    });
  },

  // ─────────────────────────────────────────
  // Phase 6-B：教务与排课管理 API
  // ─────────────────────────────────────────
  async getClasses(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return await this.request(`/api/academic/classes?${qs}`);
  },

  async createClass(payload) {
    return await this.request('/api/academic/class/create', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  async changeTeacher(payload) {
    return await this.request('/api/academic/class/change-teacher', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  async enrollStudent(payload) {
    return await this.request('/api/academic/class/enroll', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  async addTrialStudent(payload) {
    return await this.request('/api/academic/class/add-trial', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  async removeStudentFromClass(payload) {
    return await this.request('/api/academic/class/remove-student', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  async cancelSchedule(payload) {
    return await this.request('/api/academic/schedule/cancel', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  async postponeSchedule(payload) {
    return await this.request('/api/academic/schedule/postpone', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  async assignSubstitute(payload) {
    return await this.request('/api/academic/schedule/substitute', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  async handleComplaint(payload) {
    return await this.request('/api/academic/schedule/complaint', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  async getPendingMakeup() {
    return await this.request('/api/academic/makeup/pending');
  },

  async getEligibleMakeupSchedules(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return await this.request(`/api/academic/makeup/eligible-schedules?${qs}`);
  },

  async dispatchMakeup(payload) {
    return await this.request('/api/academic/makeup/dispatch', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  // ─────────────────────────────────────────
  // Phase 6-B：财务、三转退费与薪资结算 API
  // ─────────────────────────────────────────
  async purchasePackage(payload) {
    return await this.request('/api/finance/purchase', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  async freezePackage(payload) {
    return await this.request('/api/finance/freeze', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  async adjustPackageHours(payload) {
    return await this.request('/api/finance/adjust-hours', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  async previewTransfer(payload) {
    return await this.request('/api/finance/transfer/preview', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  async submitTransfer(payload) {
    return await this.request('/api/finance/transfer/submit', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  async previewRefund(payload) {
    return await this.request('/api/finance/refund/preview', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  async submitRefund(payload) {
    return await this.request('/api/finance/refund/submit', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  async rolloverTerm(payload) {
    return await this.request('/api/finance/rollover', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  async getSalaryReport(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return await this.request(`/api/salary/report?${qs}`);
  },

  async generateSettlement(payload) {
    return await this.request('/api/salary/generate-settlement', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  async settleSalary(settlementId) {
    return await this.request('/api/salary/settle', {
      method: 'POST',
      body: JSON.stringify({ settlement_id: settlementId })
    });
  },

  async submitSalaryAdjustment(payload) {
    return await this.request('/api/salary/adjustment', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  // 8. 建立 SSE 实时长连接
  connectSSE(onMessage, onStatusChange) {
    let eventSource = null;
    let isConnected = false;

    function connect() {
      try {
        if (onStatusChange) onStatusChange('connecting');
        eventSource = new EventSource(`${API_BASE}/api/events`);

        eventSource.onopen = () => {
          isConnected = true;
          if (onStatusChange) onStatusChange('connected');
        };

        eventSource.onmessage = (e) => {
          try {
            const data = JSON.parse(e.data);
            if (onMessage) onMessage('message', data);
          } catch (err) {}
        };

        eventSource.addEventListener('mutation', (e) => {
          try {
            const data = JSON.parse(e.data);
            if (onMessage) onMessage('mutation', data);
          } catch (err) {}
        });

        eventSource.onerror = (err) => {
          isConnected = false;
          if (onStatusChange) onStatusChange('disconnected');
          eventSource.close();
          // 3秒后自动重连
          setTimeout(connect, 3000);
        };
      } catch (e) {
        if (onStatusChange) onStatusChange('error');
        setTimeout(connect, 3000);
      }
    }

    connect();

    return {
      close() {
        if (eventSource) eventSource.close();
      }
    };
  }
};

// 恢复本地保存的身份
try {
  const saved = localStorage.getItem('current_admin_identity');
  if (saved) {
    const parsed = JSON.parse(saved);
    const found = MOCK_IDENTITIES.find(u => u.id === parsed.id);
    if (found) currentIdentity = found;
  }
} catch (e) {}

window.api = api;

// web-admin/js/api.js
// 统一通信与实时同步引擎 (REST API + SSE 实时流)

const API_BASE = window.location.origin;

// Only a server-authenticated account can select a role.
// The old client-side identity switcher is intentionally removed.
let currentIdentity = { id:'', name:'请登录', role:'none', roleText:'未登录', badgeClass:'badge-gray' };

const api = {
  getIdentities() { return currentIdentity.id ? [currentIdentity] : []; },
  getCurrentIdentity() { return currentIdentity; },
  setCurrentIdentity(_id) {
    throw new Error('身份必须在服务器登录验证，不能通过前端切换');
  },
  async whoAmI() {
    const response = await fetch(API_BASE + '/api/auth/me', { credentials: 'same-origin' });
    if (!response.ok) return null;
    const payload = await response.json();
    const user = payload && payload.data && payload.data.user;
    if (!user || !user.id) return null;
    currentIdentity = {
      id:user.id, name:user.name, role:user.role,
      roleText: user.role === 'super_admin' ? '超级管理员' :
        user.role === 'admin' ? '管理员' : user.role,
      badgeClass: user.role === 'super_admin' ? 'badge-purple' : 'badge-blue'
    };
    return currentIdentity;
  },
  async logout() {
    await fetch(API_BASE + '/api/auth/logout', { method:'POST', credentials:'same-origin' });
    window.location.replace('/login.html');
  },
  async request(path, options = {}) {
    const url = `${API_BASE}${path}`;
    const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
    const response = await fetch(url, Object.assign({ credentials:'same-origin' }, options, { headers }));
    if (response.status === 401) {
      window.location.replace('/login.html');
      throw new Error('登录已失效，请重新登录');
    }
    if (!response.ok) {
      let detail = '';
      try { detail = (await response.json()).message || ''; } catch (_err) {}
      throw new Error(detail || `HTTP ${response.status} ${response.statusText}`);
    }
    return await response.json();
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

window.api = api;

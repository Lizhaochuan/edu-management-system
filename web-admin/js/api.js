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
    if (user.id !== currentIdentity.id) this._commandContext=null;
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
      const error = new Error(detail || `HTTP ${response.status} ${response.statusText}`); error.status=response.status; throw error;
    }
    return await response.json();
  },

  async commandContext() {
    const userId=currentIdentity.id;
    const res = await this.request('/api/commands/context');
    if (currentIdentity.id !== userId) throw new Error('登录身份已变化，请重新读取');
    if (this._commandContext && res.data.version < this._commandContext.version) return {code:0,data:this._commandContext};
    this._commandContext = res.data;
    return res;
  },
  async executeCommand(command, params) {
    const signature = JSON.stringify([currentIdentity.id,command,params]);
    this._runningCommands = this._runningCommands || new Map();
    if (this._runningCommands.has(signature)) return this._runningCommands.get(signature);
    // Reserve before the first await: a second action must not overwrite an
    // uncertain request while both are waiting for their initial read.
    if (this._activeCommand) throw new Error('有操作正在确认，请等待或重试原操作');
    const userId=currentIdentity.id;
    const storageKey='pending_business_command_'+userId;
    this._activeCommand=signature;
    const task = (async () => {
      let saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
      if (saved && saved.signature !== signature) throw new Error('有未确认操作，请先使用原参数重试');
      if (!saved) {
        if (!this._commandContext) await this.commandContext();
        if (currentIdentity.id !== userId) throw new Error('登录身份已变化，请重新读取');
        saved = {signature,envelope:{command,params,idempotencyKey:crypto.randomUUID(),expectedVersion:this._commandContext.version}};
        sessionStorage.setItem(storageKey,JSON.stringify(saved));
      }
      try {
        if (currentIdentity.id !== userId) throw new Error('登录身份已变化，原操作请重新登录后确认');
        const res = await this.request('/api/commands/execute',{method:'POST',body:JSON.stringify(saved.envelope)});
        if (currentIdentity.id !== userId) throw new Error('登录身份已变化，原操作请重新登录后确认');
        sessionStorage.removeItem(storageKey);
        this._commandContext = null;
        return {code:0,data:res.data.result};
      } catch (error) {
        if ([400,404,409,413,428].includes(error.status)) { sessionStorage.removeItem(storageKey); this._commandContext=null; }
        throw error;
      }
    })().finally(() => { this._runningCommands.delete(signature); this._activeCommand=null; });
    this._runningCommands.set(signature,task);
    return task;
  },
  async submitAttendance(scheduleId, inputs) { return this.executeCommand('attendance.submit',{schedule_id:scheduleId,attendance_inputs:inputs}); },
  async updateAttendance(scheduleId, inputs) { return this.executeCommand('attendance.update',{schedule_id:scheduleId,attendance_inputs:inputs}); },

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
    const res=await this.commandContext();
    return {code:0,data:res.data.snapshot};
  },

  // ─────────────────────────────────────────
  // Phase 6-B：超管审批中心 API
  // ─────────────────────────────────────────
  async getApprovals(params = {}) {
    await this.commandContext();
    const qs = new URLSearchParams(params).toString();
    return await this.request(`/api/approvals?${qs}`);
  },

  async approveApproval(approvalId) { return this.executeCommand('approval.approve',{approval_id:approvalId}); },
  async rejectApproval(approvalId,rejectReason) { return this.executeCommand('approval.reject',{approval_id:approvalId,reject_reason:rejectReason}); },

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
  async getPaymentReconciliations() { return this.request('/api/payments/reconciliation'); },
  async submitPaymentReceipt(payload) { return this.executeCommand('payment.submit',payload); },
  async confirmPaymentReceipt(payload) { return this.executeCommand('payment.confirm',payload); },
  async rejectPaymentReceipt(payload) { return this.executeCommand('payment.reject',payload); },
  async purchasePackage(payload) { return this.executeCommand('package.purchase',payload); },

  async freezePackage(payload) { return this.executeCommand('approval.propose',{type:'freeze',data:payload}); },

  async adjustPackageHours(payload) { return this.executeCommand('approval.propose',{type:'adjustHours',data:payload}); },

  async previewTransfer(payload) {
    return await this.request('/api/finance/transfer/preview', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  async submitTransfer(payload) { return this.executeCommand('approval.propose',{type:'transfer',data:payload}); },

  async previewRefund(payload) {
    return await this.request('/api/finance/refund/preview', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  },

  async submitRefund(payload) { return this.executeCommand('approval.propose',{type:'refund',data:payload}); },

  async rolloverTerm(payload) {
    // Only zero-fee rollovers are allowed until top-up receipts can be verified.
    return this.executeCommand('finance.rollover',{
      package_id:payload.package_id,
      target_term_id:payload.target_term_id,
      top_up_fee:payload.top_up_fee === undefined ? 0 : Number(payload.top_up_fee),
      ...(payload.remark === undefined ? {} : {remark:payload.remark})
    });
  },

  async getSalaryReport(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return await this.request(`/api/salary/report?${qs}`);
  },

  async generateSettlement(payload) {
    return this.executeCommand('salary.generate',{
      teacher_id:payload.teacher_id,period:payload.period
    });
  },

  async settleSalary(settlementId) {
    return this.executeCommand('salary.settle',{settlement_id:settlementId});
  },

  async submitSalaryAdjustment(payload) { return this.executeCommand('approval.propose',{type:'salaryAdjustment',data:payload}); },

  // 8. 建立 SSE 实时长连接
  connectSSE(onMessage, onStatusChange) {
    let eventSource = null;
    let isConnected = false;
    let closed = false;
    let retryTimer = null;
    const reconnect = () => { if (!closed) retryTimer = setTimeout(connect,3000); };

    function connect() {
      if (closed) return;
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

        eventSource.addEventListener('version', e => {
          try { const payload=JSON.parse(e.data); if(onMessage) onMessage('version',payload.data); } catch(_e) {}
        });
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
          reconnect();
        };
      } catch (e) {
        if (onStatusChange) onStatusChange('error');
        reconnect();
      }
    }

    connect();

    return {
      close() {
        closed=true; clearTimeout(retryTimer);
        if (eventSource) eventSource.close();
      }
    };
  }
};

window.api = api;


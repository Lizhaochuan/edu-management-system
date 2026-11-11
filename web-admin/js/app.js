// web-admin/js/app.js
// PC Web 管理控制台主应用入口

const { createApp } = Vue;

const app = createApp({
  data() {
    return {
      currentTab: 'logs', // 'logs' | 'inspector' | 'monitor' | 'toolbox'
      identities: window.api.getIdentities(),
      selectedIdentityId: window.api.getCurrentIdentity().id,
      currentIdentity: window.api.getCurrentIdentity(),
      sseStatus: 'connecting',
      lastSyncTime: '--',
      liveEventCount: 0,
      recentToastMsg: '',
      anomalyMetrics: {
        locked_packages_count: 0,
        invalidated_approvals_count: 0,
        debt_packages_count: 0,
        low_balance_packages_count: 0,
        unsubscribed_parents_count: 0
      }
    };
  },

  mounted() {
    this.updateLastSyncTime();
    this.initSSE();
    this.fetchAnomalyMetrics();

    // 默认每 10 秒兜底静默同步一次大盘指标
    setInterval(() => {
      this.fetchAnomalyMetrics();
    }, 10000);
  },

  methods: {
    onTabChange(tab) {
      this.currentTab = tab;
    },

    onLogout() {
      window.api.logout();
    },

    initSSE() {
      window.api.connectSSE(
        (event, data) => {
          this.liveEventCount++;
          this.updateLastSyncTime();

          if (event === 'mutation') {
            this.showToast(`[实时数据更新] ${data.table} 执行了 ${data.action} 操作！`);
            this.fetchAnomalyMetrics();

            // 通知子组件
            if (this.$refs.logsRef && this.$refs.logsRef.handleLiveMutation) {
              this.$refs.logsRef.handleLiveMutation(data);
            }
            if (this.$refs.inspectorRef && this.$refs.inspectorRef.handleLiveMutation) {
              this.$refs.inspectorRef.handleLiveMutation(data);
            }
            if (this.$refs.monitorRef && this.$refs.monitorRef.handleLiveMutation) {
              this.$refs.monitorRef.handleLiveMutation(data);
            }
          }
        },
        (status) => {
          this.sseStatus = status;
        }
      );
    },

    async fetchAnomalyMetrics() {
      try {
        const res = await window.api.getAnomalyOverview();
        if (res && res.data && res.data.metrics) {
          this.anomalyMetrics = res.data.metrics;
        }
      } catch (err) {}
    },

    updateLastSyncTime() {
      const now = new Date();
      const pad = (n) => (n < 10 ? '0' + n : n);
      this.lastSyncTime = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    },

    showToast(msg) {
      this.recentToastMsg = msg;
      setTimeout(() => {
        if (this.recentToastMsg === msg) {
          this.recentToastMsg = '';
        }
      }, 3500);
    }
  }
});

// 注册子组件
app.component('audit-logs-view', window.AuditLogsComponent);
app.component('inspector-view', window.InspectorComponent);
app.component('monitor-view', window.MonitorComponent);
app.component('toolbox-view', window.ToolboxComponent);

// Do not mount the admin dashboard or request business data until the server
// confirms a real login. Old localStorage identity selections are ignored.
window.api.whoAmI().then((user) => {
  if (!user || !['admin', 'super_admin'].includes(user.role)) {
    window.location.replace('/login.html');
    return;
  }
  app.mount('#app');
}).catch(() => {
  window.location.replace('/login.html');
});

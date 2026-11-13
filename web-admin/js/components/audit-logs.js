// web-admin/js/components/audit-logs.js
// 1. 全局操作审计日志台 (Operation Logs Viewer - 实时滚动)

const AuditLogsComponent = {
  template: `
    <div class="console-card">
      <div class="card-header">
        <div class="card-title-group">
          <span style="font-size: 18px;">📋</span>
          <div>
            <div class="card-title">业务操作记录</div>
            <div class="card-subtitle">记录由谁在什么时候修改了什么，展示业务前后数值。原始记录保留供授权核查。</div>
          </div>
        </div>
        <div class="card-actions">
          <label style="display: flex; align-items: center; gap: 6px; font-size: 12px; color: #475569; cursor: pointer;">
            <input type="checkbox" v-model="autoScroll" /> 实时滚动置顶
          </label>
          <span class="badge badge-blue">共 {{ total }} 条记录</span>
          <button class="btn btn-sm btn-primary" @click="fetchLogs(true)">
            <span>🔄</span> 立即刷新
          </button>
        </div>
      </div>

      <div class="card-body">
        <!-- 搜索与筛选工具条 -->
        <div class="filter-bar">
          <div class="filter-item">
            <span class="filter-label">关键字检索:</span>
            <input 
              class="input-control" 
              style="width: 200px;" 
              v-model="filters.keyword" 
              @keyup.enter="fetchLogs(true)"
              placeholder="搜说明 / ID / 学员 / 班级" 
            />
          </div>

          <div class="filter-item">
            <span class="filter-label">业务模块/表:</span>
            <select class="input-control" v-model="filters.target_table" @change="fetchLogs(true)">
              <option value="">全部模块</option>
              <option value="course_packages">学员课时包</option>
              <option value="schedules_and_attendance">排课与考勤</option>
              <option value="approval_requests">审批申请</option>
              <option value="classes">班级</option>
              <option value="students">学员档案</option>
              <option value="salary_settlements">工资单</option>
              <option value="salary_adjustments">工资调账</option>
              <option value="manual_hour_adjustments">课时调整</option>
              <option value="transfer_records">转人／转课／转班</option>
              <option value="refund_records">学员退费</option>
              <option value="term_rollover_records">学期顺延</option>
            </select>
          </div>

          <div class="filter-item">
            <span class="filter-label">操作类型:</span>
            <select class="input-control" v-model="filters.action" @change="fetchLogs(true)">
              <option value="">全部操作</option>
              <option value="INSERT">新增</option>
              <option value="UPDATE">修改</option>
              <option value="REMOVE">删除</option>
            </select>
          </div>

          <button class="btn btn-sm" @click="resetFilters">重置筛选</button>
        </div>

        <!-- 实时日志表格 -->
        <div class="table-container" ref="tableContainer">
          <table class="dense-table">
            <thead>
              <tr>
                <th style="width: 150px;">日志时间</th>
                <th style="width: 120px;">操作人</th>
                <th style="width: 90px;">类型</th>
                <th style="width: 180px;">业务事项</th>
                <th style="width: 140px;">记录内容</th>
                <th>操作描述摘要</th>
                <th style="width: 100px; text-align: center;">变化详情</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="loading && logs.length === 0">
                <td colspan="7" style="text-align: center; padding: 30px; color: #94a3b8;">加载中...</td>
              </tr>
              <tr v-else-if="logs.length === 0">
                <td colspan="7" style="text-align: center; padding: 30px; color: #94a3b8;">暂无符合条件的审计日志</td>
              </tr>
              <tr 
                v-for="item in logs" 
                :key="item.id" 
                :class="{'row-danger': item.action === 'REMOVE', 'row-warning': item.description && item.description.includes('破锁')}"
              >
                <td style="font-family: monospace; font-size: 11px; color: #64748b;">{{ formatTime(item.action_time) }}</td>
                <td>
                  <span class="badge badge-purple" style="font-size: 10px;">{{ item.operator_name || '系统' }}</span>
                </td>
                <td>
                  <span :class="getActionBadgeClass(item.action)">{{ actionText(item.action) }}</span>
                </td>
                <td style="font-family: monospace; font-weight: 600; color: #2563eb;">{{ item.readable.title }}</td>
                <td style="font-family: monospace; color: #475569;">{{ item.readable.rows.length }} 项变化</td>
                <td style="font-weight: 500;">
                  <span>{{ item.description }}</span>
                </td>
                <td style="text-align: center;">
                  <button class="btn btn-sm btn-primary" @click="openDiffModal(item)">
                    查看业务变化
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 分页控件 -->
        <div class="pagination-bar">
          <div class="page-info">
            显示第 {{ (page - 1) * pageSize + 1 }} - {{ Math.min(page * pageSize, total) }} 条，共 {{ total }} 条
          </div>
          <div class="page-controls">
            <button class="btn btn-sm" :disabled="page <= 1" @click="changePage(page - 1)">上一页</button>
            <span style="font-weight: 600; padding: 0 8px; font-size: 12px; align-self: center;">{{ page }} / {{ totalPages || 1 }}</span>
            <button class="btn btn-sm" :disabled="page >= totalPages" @click="changePage(page + 1)">下一页</button>
          </div>
        </div>
      </div>

      <!-- 中文业务变化对比：不向用户展示 JSON 或内部数据库字段 -->
      <div v-if="diffModal.visible" class="modal-mask" @click="diffModal.visible = false">
        <div class="modal-content" @click.stop style="width: min(880px,95vw);">
          <div class="modal-header">
            <span class="modal-title">{{ diffModal.item.readable && diffModal.item.readable.title }}</span>
            <button class="modal-close" @click="diffModal.visible = false">关闭</button>
          </div>
          <div class="modal-body">
            <p style="line-height:1.6;color:#334155;">{{ diffModal.item.description || '本次操作暂无补充说明' }}</p>
            <p style="color:#64748b;">操作人：{{ diffModal.item.operator_name || '系统自动' }} · 时间：{{ formatTime(diffModal.item.action_time) }}</p>
            <div v-if="diffModal.item.readable && diffModal.item.readable.rows.length" class="table-container">
              <table class="dense-table">
                <thead><tr><th>业务项目</th><th>操作前</th><th>操作后</th></tr></thead>
                <tbody>
                  <tr v-for="row in diffModal.item.readable.rows" :key="row.label">
                    <td>{{ row.label }}</td><td>{{ row.beforeText }}</td><td>{{ row.afterText }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-if="diffModal.item.readable && diffModal.item.readable.note" style="color:#795d25;line-height:1.6;">
              {{ diffModal.item.readable.note }}
            </p>
          </div>
          <div class="modal-footer"><button class="btn" @click="diffModal.visible = false">返回操作记录</button></div>
        </div>
      </div>
    </div>
  `,

  data() {
    return {
      logs: [],
      total: 0,
      page: 1,
      pageSize: 20,
      totalPages: 1,
      loading: false,
      autoScroll: true,
      filters: {
        keyword: '',
        target_table: '',
        action: ''
      },
      diffModal: {
        visible: false,
        item: {}
      }
    };
  },

  mounted() {
    this.fetchLogs();
  },

  methods: {
    async fetchLogs(resetPage = false) {
      if (resetPage) this.page = 1;
      this.loading = true;
      try {
        const res = await window.api.getLogs({
          page: this.page,
          pageSize: this.pageSize,
          target_table: this.filters.target_table,
          action: this.filters.action,
          keyword: this.filters.keyword
        });
        if (res && res.data) {
          this.logs = (res.data.list||[]).map(item=>({ ...item,
            readable:window.BusinessDisplay.auditChange(item) }));
          this.total = res.data.total;
          this.totalPages = res.data.totalPages;
        }
      } catch (err) {
        console.error('fetchLogs error:', err);
      } finally {
        this.loading = false;
      }
    },

    changePage(p) {
      this.page = p;
      this.fetchLogs();
    },

    resetFilters() {
      this.filters = { keyword: '', target_table: '', action: '' };
      this.fetchLogs(true);
    },

    formatTime(isoStr) {
      if (!isoStr) return '--';
      try {
        const d = new Date(isoStr);
        const pad = (n) => (n < 10 ? '0' + n : n);
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      } catch (e) {
        return isoStr;
      }
    },

    actionText(action) {
      return {INSERT:'新增',UPDATE:'修改',REMOVE:'删除',INIT:'初始化'}[action]||'其他操作';
    },

    getActionBadgeClass(action) {
      if (action === 'INSERT') return 'badge badge-green';
      if (action === 'UPDATE') return 'badge badge-blue';
      if (action === 'REMOVE') return 'badge badge-red';
      return 'badge badge-gray';
    },

    openDiffModal(item) {
      this.diffModal.item = item;
      this.diffModal.visible = true;
    },

    // 接收 SSE 实时推送刷新
    handleLiveMutation(data) {
      if (this.autoScroll) {
        this.fetchLogs(true);
      }
    }
  }
};

window.AuditLogsComponent = AuditLogsComponent;

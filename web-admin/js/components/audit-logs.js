// web-admin/js/components/audit-logs.js
// 1. 全局操作审计日志台 (Operation Logs Viewer - 实时滚动)

const AuditLogsComponent = {
  template: `
    <div class="console-card">
      <div class="card-header">
        <div class="card-title-group">
          <span style="font-size: 18px;">📋</span>
          <div>
            <div class="card-title">全局操作审计日志台 (Operation Logs Viewer)</div>
            <div class="card-subtitle">底层拦截器实时记录 · 全量不可篡改留痕 · 快照前/后 JSON Diff 深度对比</div>
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
              <option value="course_packages">课时包账本 (course_packages)</option>
              <option value="schedules_and_attendance">排课与考勤 (schedules_and_attendance)</option>
              <option value="approval_requests">审批流申请 (approval_requests)</option>
              <option value="classes">班级名册 (classes)</option>
              <option value="students">学员档案 (students)</option>
              <option value="salary_settlements">薪资结算单 (salary_settlements)</option>
              <option value="salary_adjustments">薪资调账 (salary_adjustments)</option>
              <option value="manual_hour_adjustments">手工调课时 (manual_hour_adjustments)</option>
              <option value="transfer_records">教务三转档案 (transfer_records)</option>
              <option value="refund_records">退费核销档案 (refund_records)</option>
              <option value="term_rollover_records">四期顺延档案 (term_rollover_records)</option>
            </select>
          </div>

          <div class="filter-item">
            <span class="filter-label">操作类型:</span>
            <select class="input-control" v-model="filters.action" @change="fetchLogs(true)">
              <option value="">全部操作</option>
              <option value="INSERT">INSERT (新增/建账)</option>
              <option value="UPDATE">UPDATE (变更/消课/生效)</option>
              <option value="REMOVE">REMOVE (删除/解绑)</option>
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
                <th style="width: 180px;">目标表</th>
                <th style="width: 140px;">记录 ID</th>
                <th>操作描述摘要</th>
                <th style="width: 100px; text-align: center;">快照对比</th>
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
                  <span :class="getActionBadgeClass(item.action)">{{ item.action }}</span>
                </td>
                <td style="font-family: monospace; font-weight: 600; color: #2563eb;">{{ item.target_table }}</td>
                <td style="font-family: monospace; color: #475569;">#{{ item.target_record_id }}</td>
                <td style="font-weight: 500;">
                  <span>{{ item.description }}</span>
                </td>
                <td style="text-align: center;">
                  <button class="btn btn-sm btn-primary" @click="openDiffModal(item)">
                    🔍 JSON Diff
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

      <!-- JSON Diff 弹窗 Modal -->
      <div v-if="diffModal.visible" class="modal-mask" @click="diffModal.visible = false">
        <div class="modal-content" @click.stop style="width: 1000px;">
          <div class="modal-header">
            <div>
              <span class="modal-title">🔍 快照变更对比 (JSON Diff)</span>
              <span style="margin-left: 10px; font-size: 12px; color: #64748b;">
                [{{ diffModal.item.target_table }} #{{ diffModal.item.target_record_id }}]
              </span>
            </div>
            <button class="modal-close" @click="diffModal.visible = false">✕</button>
          </div>

          <div class="modal-body">
            <div style="margin-bottom: 12px; font-size: 12px; color: #334155; background: #f1f5f9; padding: 8px 12px; border-radius: 6px;">
              <strong>📝 操作说明：</strong> {{ diffModal.item.description || '无详细说明' }}<br/>
              <strong>👤 操作人：</strong> {{ diffModal.item.operator_name }} (ID: {{ diffModal.item.operator_id }}) · 
              <strong>⏰ 发生时间：</strong> {{ diffModal.item.action_time }}
            </div>

            <div class="diff-container">
              <div class="diff-pane">
                <div class="diff-header diff-header-before">
                  ⏮️ 修改前数据快照 (Before Snapshot)
                </div>
                <pre class="diff-code">{{ formatJson(diffModal.item.before_snapshot_json) }}</pre>
              </div>

              <div class="diff-pane">
                <div class="diff-header diff-header-after">
                  ⏭️ 修改后数据快照 (After Snapshot)
                </div>
                <pre class="diff-code">{{ formatJson(diffModal.item.after_snapshot_json) }}</pre>
              </div>
            </div>
          </div>

          <div class="modal-footer">
            <button class="btn" @click="diffModal.visible = false">关闭窗口</button>
          </div>
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
          this.logs = res.data.list;
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

    formatJson(str) {
      if (!str) return '（无快照数据，记录可能已删除或新建）';
      try {
        const obj = typeof str === 'string' ? JSON.parse(str) : str;
        return JSON.stringify(obj, null, 2);
      } catch (e) {
        return str;
      }
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

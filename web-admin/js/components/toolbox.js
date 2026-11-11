// web-admin/js/components/toolbox.js
// 4. 开发调试沙盒工具 (Debug Toolbox)

const ToolboxComponent = {
  template: `
    <div class="console-card">
      <div class="card-header">
        <div class="card-title-group">
          <span style="font-size: 18px;">🛠️</span>
          <div>
            <div class="card-title">开发调试沙盒工具箱 (Debug Sandbox Toolbox)</div>
            <div class="card-subtitle">一键模拟极端边界条件 · 24小时超时锁死测试 · 四期到期扫描 · 双端实时广播</div>
          </div>
        </div>
      </div>

      <div class="card-body">
        <div class="toolbox-grid">
          <!-- 工具 1：24小时改签窗口超时锁死测试 -->
          <div class="tool-card">
            <div class="tc-info">
              <h4>⏱️ 24小时自主改签窗口超时锁死测试</h4>
              <p>
                根据业务铁律，老师签到后 24 小时以内可自主改签，超过 24 小时必须硬性锁死并只能走超管补签审批流。
                点击此按钮一键将最近一节课的签到时间强行置为 <strong>25 小时前</strong>，模拟超时锁死环境。
              </p>
            </div>
            <div>
              <button class="btn btn-primary" :disabled="loadingAction === '25h'" @click="runAction('set_schedule_25h_ago', '25h')">
                <span v-if="loadingAction === '25h'">执行中...</span>
                <span v-else>⚡ 签到时间置为 25 小时前</span>
              </button>
            </div>
          </div>

          <!-- 工具 2：四期到期扫描引擎测试 -->
          <div class="tool-card">
            <div class="tc-info">
              <h4>📅 课程四期到期扫描引擎 (期末顺延/退费)</h4>
              <p>
                扫描当前机构春/夏/秋/冬各学期的固定到期日，列出所有剩余可用总课时 > 0 的课时包，进行到期倒计时预警及二选一闭环（顺延续费 vs 不续退费）。
              </p>
            </div>
            <div>
              <button class="btn btn-primary" :disabled="loadingAction === 'scan'" @click="runAction('scan_expiring_terms', 'scan')">
                <span v-if="loadingAction === 'scan'">扫描中...</span>
                <span v-else>🔍 一键执行四期到期扫描</span>
              </button>
            </div>
          </div>

          <!-- 工具 3：模拟课堂到课消课扣费测试 -->
          <div class="tool-card">
            <div class="tc-info">
              <h4>⚡ 模拟课堂消课扣费 (多包FIFO + 先付费后赠送)</h4>
              <p>
                模拟老师在课堂上对一名已购课学生进行到课点名消课扣费 1.0 课时。验证多课时包先进先出（FIFO）、包内先扣付费后扣赠送、破锁与实时广播流水。
              </p>
            </div>
            <div>
              <button class="btn btn-primary" :disabled="loadingAction === 'deduct'" @click="runAction('mock_attendance_deduct', 'deduct')">
                <span v-if="loadingAction === 'deduct'">扣费中...</span>
                <span v-else>⚡ 一键模拟消课扣费 1.0 课时</span>
              </button>
            </div>
          </div>

          <!-- 工具 4：双端广播同步测试 -->
          <div class="tool-card">
            <div class="tc-info">
              <h4>📡 手动触发双端 SSE / 广播同步</h4>
              <p>
                向所有处于连接状态的 PC 网页端以及小程序端广播实时数据同步指令，用于排查网络断连或调试双端跳动更新。
              </p>
            </div>
            <div>
              <button class="btn" :disabled="loadingAction === 'ping'" @click="runAction('trigger_broadcast', 'ping')">
                <span v-if="loadingAction === 'ping'">广播中...</span>
                <span v-else>📡 发送双端广播同步信号</span>
              </button>
            </div>
          </div>

          <!-- 工具 5：重置并恢复初始种子数据 -->
          <div class="tool-card" style="border-color: #fca5a5; background: #fffdfd;">
            <div class="tc-info">
              <h4 style="color: #dc2626;">♻️ 数据库重置与恢复种子数据</h4>
              <p style="color: #7f1d1d;">
                清空当前 data/db.json 并重新加载机构完整的演示种子数据（包含张校长、李合伙人、各授课教师、各班级、学生刘小宝/孙小乐等初始账本）。
              </p>
            </div>
            <div>
              <button class="btn btn-danger" :disabled="loadingAction === 'reseed'" @click="confirmReseed">
                <span v-if="loadingAction === 'reseed'">重置中...</span>
                <span v-else>♻️ 恢复初始演示种子数据</span>
              </button>
            </div>
          </div>
        </div>

        <!-- 调试输出控制台面板 -->
        <div v-if="resultOutput" style="margin-top: 24px;">
          <div style="font-weight: 700; font-size: 13px; margin-bottom: 8px; color: #1e293b; display: flex; justify-content: space-between; align-items: center;">
            <span>🖥️ 沙盒指令执行结果返回：</span>
            <button class="btn btn-sm" @click="resultOutput = null">清空输出</button>
          </div>
          <pre class="diff-code" style="background:#1e1e1e; color:#4ade80; padding:16px; border-radius:6px; max-height: 350px;">{{ resultOutput }}</pre>
        </div>
      </div>
    </div>
  `,

  data() {
    return {
      loadingAction: null,
      resultOutput: null
    };
  },

  methods: {
    async runAction(actionName, loadingKey) {
      this.loadingAction = loadingKey;
      this.resultOutput = '执行中...';
      try {
        const res = await window.api.runDebugAction(actionName);
        this.resultOutput = JSON.stringify(res, null, 2);
        alert(res.message || '执行成功！');
      } catch (err) {
        this.resultOutput = `[执行报错] ${err.message}`;
        alert(`执行失败: ${err.message}`);
      } finally {
        this.loadingAction = null;
      }
    },

    confirmReseed() {
      if (confirm('确定要重置数据库为初始种子数据吗？当前所有测试产生的新数据将被重置回初始状态。')) {
        this.runAction('reseed_database', 'reseed');
      }
    }
  }
};

window.ToolboxComponent = ToolboxComponent;

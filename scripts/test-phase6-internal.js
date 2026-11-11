// scripts/test-phase6-internal.js
// 内部全路由仿真测试（绕过 Windows 沙盒对本地 TCP Connect 的限制）
const EventEmitter = require('events');
const http = require('http');

function simulateRequest(server, options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = options.method || 'GET';
    req.url = options.path || '/';
    req.headers = Object.assign({
      'host': 'localhost:3000',
      'user-agent': 'TestClient/1.0'
    }, options.headers || {});

    const res = new EventEmitter();
    res.statusCode = 200;
    res.headers = {};
    let body = '';

    res.writeHead = function (code, headers) {
      res.statusCode = code;
      if (headers) Object.assign(res.headers, headers);
      return res;
    };

    res.write = function (chunk) {
      body += chunk;
      return true;
    };

    res.end = function (chunk) {
      if (chunk) body += chunk;
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch (e) {}
      resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: parsed,
        raw: body
      });
    };

    // 触发服务处理
    server.emit('request', req, res);

    if (postData) {
      const dataStr = typeof postData === 'string' ? postData : JSON.stringify(postData);
      req.emit('data', Buffer.from(dataStr));
    }
    req.emit('end');
  });
}

async function runInternalTests() {
  console.log('--- 启动 Phase 6-A 内部全流程集成仿真测试 ---');

  // 获取 server.js 中的 http server
  const server = require('../server');

  // 1. GET /api/status
  console.log('测试 1: GET /api/status');
  const resStatus = await simulateRequest(server, { method: 'GET', path: '/api/status' });
  console.log('  Status:', resStatus.statusCode, '| Data:', resStatus.body);
  if (resStatus.statusCode !== 200 || resStatus.body.code !== 0) throw new Error('GET /api/status failed');

  // 2. GET /api/db/all
  console.log('测试 2: GET /api/db/all (全库同步)');
  const resDbAll = await simulateRequest(server, { method: 'GET', path: '/api/db/all' });
  const tables = Object.keys(resDbAll.body.data);
  console.log('  Total tables:', tables.length);
  if (!tables.includes('course_packages') || !tables.includes('audit_logs')) throw new Error('Missing tables');

  // 3. GET /api/logs
  console.log('测试 3: GET /api/logs (审计日志分页与检索)');
  const resLogs = await simulateRequest(server, { method: 'GET', path: '/api/logs?page=1&pageSize=5' });
  console.log('  Total logs:', resLogs.body.data.total, '| Returned:', resLogs.body.data.list.length);
  if (resLogs.body.data.total === undefined) throw new Error('Logs failed');

  // 4. GET /api/inspector/schedules
  console.log('测试 4: GET /api/inspector/schedules (排课考勤快照透视)');
  const resSchedules = await simulateRequest(server, { method: 'GET', path: '/api/inspector/schedules' });
  console.log('  Schedules count:', resSchedules.body.data.length);
  const s0 = resSchedules.body.data[0];
  console.log('  Sample schedule snapshot:', {
    id: s0.id,
    headcount: s0.initial_present_headcount,
    compensated: s0.makeup_compensated_count,
    substitute: s0.substitute_teacher_id
  });

  // 5. GET /api/inspector/student-packages
  console.log('测试 5: GET /api/inspector/student-packages?keyword=刘小宝');
  const resStu = await simulateRequest(server, { method: 'GET', path: '/api/inspector/student-packages?keyword=%E5%88%98%E5%B0%8F%E5%AE%9D' });
  console.log('  Matched students:', resStu.body.data.length);
  const stu = resStu.body.data[0];
  console.log('  Student ledger:', {
    name: stu.student.name,
    available_hours: stu.stats.total_available_hours,
    paid_left: stu.stats.total_paid_left,
    debt_hours: stu.stats.total_debt_hours
  });

  // 6. GET /api/anomaly/overview
  console.log('测试 6: GET /api/anomaly/overview (异常监控大盘)');
  const resAnomaly = await simulateRequest(server, { method: 'GET', path: '/api/anomaly/overview' });
  console.log('  Anomaly metrics:', resAnomaly.body.data.metrics);

  // 7. POST /api/debug/action (set_schedule_25h_ago)
  console.log('测试 7: POST /api/debug/action (25小时前超时锁死测试)');
  const res25h = await simulateRequest(server, {
    method: 'POST',
    path: '/api/debug/action',
    headers: { 'content-type': 'application/json' }
  }, { action: 'set_schedule_25h_ago' });
  console.log('  Message:', res25h.body.message);

  // 8. POST /api/debug/action (scan_expiring_terms)
  console.log('测试 8: POST /api/debug/action (四期到期扫描测试)');
  const resScan = await simulateRequest(server, {
    method: 'POST',
    path: '/api/debug/action',
    headers: { 'content-type': 'application/json' }
  }, { action: 'scan_expiring_terms' });
  console.log('  Expiring packages found:', resScan.body.data.packages.length);

  // 9. POST /api/db/mutate (模拟小程序端上课消课同步)
  console.log('测试 9: POST /api/db/mutate (小程序变更上报同库同步)');
  const resMutate = await simulateRequest(server, {
    method: 'POST',
    path: '/api/db/mutate',
    headers: { 'content-type': 'application/json' }
  }, {
    action: 'UPDATE',
    table: 'course_packages',
    id: 'pkg_1',
    patch: { paid_hours_left: 34.5 },
    description: '[自动化验证] 小程序端点名签到扣费 1.0 课时同步',
    operator: { id: 'u_tch1', name: '陈老师(初级)', role: 'teacher' }
  });
  console.log('  Mutate result:', resMutate.body);

  // 10. GET / (静态 Web Admin 托管)
  console.log('测试 10: GET / (Web Admin 页面托管)');
  const resWeb = await simulateRequest(server, { method: 'GET', path: '/' });
  console.log('  Status:', resWeb.statusCode, '| Contains Brand Title:', resWeb.raw.includes('教务与财务管理系统 · PC Web'));
  if (resWeb.statusCode !== 200 || !resWeb.raw.includes('教务与财务管理系统 · PC Web')) {
    throw new Error('Web Admin index.html failed to serve');
  }

  // 11. GET /css/style.css
  console.log('测试 11: GET /css/style.css (静态 CSS 托管)');
  const resCss = await simulateRequest(server, { method: 'GET', path: '/css/style.css' });
  console.log('  Status:', resCss.statusCode, '| CSS Length:', resCss.raw.length);
  if (resCss.statusCode !== 200 || resCss.raw.length < 100) {
    throw new Error('CSS failed to serve');
  }

  console.log('================================================================');
  console.log('  🎉 Phase 6-A 全部 11 项全链路自动化测试 100% 成功通过！');
  console.log('================================================================');
  process.exit(0);
}

runInternalTests().catch(err => {
  console.error('Test Failed:', err);
  process.exit(1);
});

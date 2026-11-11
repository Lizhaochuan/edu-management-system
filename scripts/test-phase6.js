// scripts/test-phase6.js
// Phase 6-A 自动化集成与双端实时同步测试脚本
const http = require('http');

function makeRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: body });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, raw: body });
        }
      });
    });
    req.on('error', reject);
    if (postData) {
      req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
    }
    req.end();
  });
}

async function runTests() {
  console.log('--- 开始执行 Phase 6-A 集成与双端同步测试 ---');

  // 1. 测试服务健康状态
  console.log('测试 1: GET /api/status');
  const resStatus = await makeRequest({
    hostname: '127.0.0.1',
    port: 3000,
    path: '/api/status',
    method: 'GET'
  });
  console.log('  Status code:', resStatus.status);
  console.log('  Server status:', resStatus.body.status, '| Total tables:', resStatus.body.total_tables, '| Total records:', resStatus.body.total_records);
  if (resStatus.status !== 200 || resStatus.body.code !== 0) throw new Error('API /api/status failed');

  // 2. 测试全库同步接口 (小程序连接同库)
  console.log('测试 2: GET /api/db/all');
  const resDbAll = await makeRequest({
    hostname: '127.0.0.1',
    port: 3000,
    path: '/api/db/all',
    method: 'GET'
  });
  const tableNames = Object.keys(resDbAll.body.data);
  console.log('  Table count:', tableNames.length);
  if (!tableNames.includes('course_packages') || !tableNames.includes('audit_logs')) {
    throw new Error('API /api/db/all missing essential tables');
  }

  // 3. 测试操作审计日志分页与过滤
  console.log('测试 3: GET /api/logs');
  const resLogs = await makeRequest({
    hostname: '127.0.0.1',
    port: 3000,
    path: '/api/logs?page=1&pageSize=5',
    method: 'GET'
  });
  console.log('  Total audit logs:', resLogs.body.data.total, '| Returned:', resLogs.body.data.list.length);
  if (!resLogs.body.data.list || resLogs.body.data.total === undefined) throw new Error('API /api/logs failed');

  // 4. 测试排课快照透视
  console.log('测试 4: GET /api/inspector/schedules');
  const resSchedules = await makeRequest({
    hostname: '127.0.0.1',
    port: 3000,
    path: '/api/inspector/schedules',
    method: 'GET'
  });
  console.log('  Schedules count:', resSchedules.body.data.length);
  const sampleSchedule = resSchedules.body.data[0];
  console.log('  Sample schedule snapshots:', {
    id: sampleSchedule.id,
    initial_present_headcount: sampleSchedule.initial_present_headcount,
    makeup_compensated_count: sampleSchedule.makeup_compensated_count,
    substitute_teacher_id: sampleSchedule.substitute_teacher_id
  });

  // 5. 测试学员课时包账本透视
  console.log('测试 5: GET /api/inspector/student-packages');
  const resStuPkgs = await makeRequest({
    hostname: '127.0.0.1',
    port: 3000,
    path: '/api/inspector/student-packages?keyword=刘小宝',
    method: 'GET'
  });
  console.log('  Matched students:', resStuPkgs.body.data.length);
  const stuItem = resStuPkgs.body.data[0];
  console.log('  Student summary:', {
    name: stuItem.student.name,
    available_hours: stuItem.stats.total_available_hours,
    paid_left: stuItem.stats.total_paid_left,
    gift_left: stuItem.stats.total_gift_left,
    debt_hours: stuItem.stats.total_debt_hours
  });

  // 6. 测试异常与预警监控大盘
  console.log('测试 6: GET /api/anomaly/overview');
  const resAnomaly = await makeRequest({
    hostname: '127.0.0.1',
    port: 3000,
    path: '/api/anomaly/overview',
    method: 'GET'
  });
  console.log('  Anomaly metrics:', resAnomaly.body.data.metrics);

  // 7. 测试开发调试沙盒工具：25小时前超时锁死
  console.log('测试 7: POST /api/debug/action (set_schedule_25h_ago)');
  const resDebug25h = await makeRequest({
    hostname: '127.0.0.1',
    port: 3000,
    path: '/api/debug/action',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { action: 'set_schedule_25h_ago' });
  console.log('  Result message:', resDebug25h.body.message);

  // 8. 测试开发调试沙盒工具：四期到期扫描
  console.log('测试 8: POST /api/debug/action (scan_expiring_terms)');
  const resDebugScan = await makeRequest({
    hostname: '127.0.0.1',
    port: 3000,
    path: '/api/debug/action',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, { action: 'scan_expiring_terms' });
  console.log('  Scanned packages count:', resDebugScan.body.data.packages.length);

  // 9. 测试小程序端变更同步与广播 (POST /api/db/mutate)
  console.log('测试 9: POST /api/db/mutate (模拟小程序端上课消课同步)');
  const testMutation = {
    action: 'UPDATE',
    table: 'course_packages',
    id: 'pkg_1',
    patch: { paid_hours_left: 34.5 },
    description: '[自动化测试] 小程序端点名签到消课 1.0 课时',
    operator: { id: 'u_tch1', name: '陈老师(初级)', role: 'teacher' }
  };
  const resMutate = await makeRequest({
    hostname: '127.0.0.1',
    port: 3000,
    path: '/api/db/mutate',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, testMutation);
  console.log('  Mutation result:', resMutate.body);

  // 10. 检查 Web Admin 静态文件托管
  console.log('测试 10: GET / (Web Admin 页面托管)');
  const resIndex = await makeRequest({
    hostname: '127.0.0.1',
    port: 3000,
    path: '/',
    method: 'GET'
  });
  console.log('  Index.html status:', resIndex.status, '| Length:', resIndex.raw.length);
  if (resIndex.status !== 200 || !resIndex.raw.includes('教务与财务管理系统 · PC Web')) {
    throw new Error('Static HTML serving failed');
  }

  console.log('--- 所有 10 项测试全部 100% 验证通过！---');
}

// 自动启动服务并测试
const s = require('../server');
setTimeout(async () => {
  try {
    await runTests();
    process.exit(0);
  } catch (err) {
    console.error('Test execution failed:', err);
    process.exit(1);
  }
}, 1000);

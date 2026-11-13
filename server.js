// server.js
// 培训机构教务与财务管理系统 - PC Web & 小程序双端同库实时服务
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const db = require('./services/db');
const authService = require('./services/authService');
const businessCommands = require('./services/businessCommandService');
const packageAccountService = require('./services/packageAccountService');
const attendanceService = require('./services/attendanceService');
const salaryEngineService = require('./services/salaryEngineService');
const transferRefundService = require('./services/transferRefundService');
const systemConfigService = require('./services/systemConfigService');
const notificationService = require('./services/notificationService');

const PORT = process.env.PORT || 3000;
const WEB_ADMIN_DIR = path.join(__dirname, 'web-admin');

// SSE 实时连接客户端集合
const sseClients = new Set();

/** 广播实时数据变更事件到所有 PC Web 网页端 */
function broadcast(event, data) {
  const payload = JSON.stringify({
    event,
    data,
    timestamp: new Date().toISOString()
  });
  sseClients.forEach((client) => {
    try {
      if (!authService.authenticate(client.req)) {
        client.res.end();
        sseClients.delete(client);
        return;
      }
      client.res.write(`event: ${event}\n`);
      client.res.write(`data: ${payload}\n\n`);
    } catch (e) {
      sseClients.delete(client);
    }
  });
}

// 确保数据库已加载
db.initDatabase();

// MIME 映射表
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

/** 解析请求 JSON Body */
function parseJsonBody(req, strict = false) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (strict && bytes > 16 * 1024) {
        reject(new businessCommands.CommandError(413, 'BODY_TOO_LARGE', '请求体超过16KiB'));
        return;
      }
      body += chunk;
      if (body.length > 5 * 1024 * 1024) {
        reject(new Error('Body too large'));
      }
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        if (strict) reject(new businessCommands.CommandError(400, 'INVALID_JSON', 'JSON格式无效'));
        else resolve({});
      }
    });
    req.on('error', reject);
  });
}

/** 统一 JSON 响应辅助函数 */
function sendJson(res, statusCode, data, extraHeaders = {}) {
  res.writeHead(statusCode, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  }, extraHeaders));
  res.end(JSON.stringify(data));
}

/** 从 HTTP 请求中提取操作人身份信息 */
function getOperatorFromReq(req) {
  // This is established by credential authentication, not by untrusted request headers.
  if (!req.auth || !req.auth.user) throw new Error('未认证的操作人');
  return req.auth.user;
}

// Database-only rollback helper for synchronous JSON-backed business handlers.
// This cannot undo external notifications and is not a replacement for SQL transactions.
function withJsonDbRollback(handler, operator) {
  return db.transaction(handler, operator);
}

// 创建 HTTP 服务
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // Loopback-only dev servers must reject attacker-controlled DNS rebinding hosts.
  if (!process.env.ALLOW_INSECURE_NETWORK) {
    let hostname = '';
    try { hostname = new URL('http://' + String(req.headers.host || '')).hostname; }
    catch (_err) { /* invalid Host */ }
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) {
      return sendJson(res, 403, { code:403, message:'无效的本机服务器 Host' });
    }
  }

  // A foreign website must not access this unauthenticated local API via CORS.
  // Same-origin Web requests and native mini-program requests remain compatible.
  const origin = req.headers.origin;
  if (origin) {
    let sameOrigin = false;
    try {
      const parsedOrigin = new URL(origin);
      sameOrigin = parsedOrigin.host === req.headers.host &&
        (parsedOrigin.protocol === 'http:' || parsedOrigin.protocol === 'https:');
    } catch (e) { /* malformed Origin is rejected */ }
    if (!sameOrigin) {
      return sendJson(res, 403, { code: 403, message: '跨站请求不允许访问本地教务接口' });
    }
  }

  // 1. 处理 CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end();
    return;
  }

  // 2. SSE 只允许已登录的管理人员订阅，防止泄漏机构业务事件。
  if (pathname === '/api/events') {
    const identity = authService.authenticate(req);
    if (!identity || !authService.authorize(pathname, req.method, identity.user.role, req)) {
      return sendJson(res, identity ? 403 : 401, { code: identity ? 403 : 401, message: '无权订阅业务事件' });
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.write(`data: ${JSON.stringify({ type: 'connected', time: new Date().toISOString() })}\n\n`);

    const client = { req, res };
    sseClients.add(client);
    req.on('close', () => sseClients.delete(client));
    return;
  }

  // 3. API 路由分发
  if (pathname.startsWith('/api/')) {
    try {
      // Minimal public health check. Do not disclose database table/record counts.
      if (pathname === '/api/status' && req.method === 'GET') {
        return sendJson(res, 200, {
          code: 0, status: 'running', uptime: process.uptime(),
          timestamp: new Date().toISOString()
        });
      }

      // Credential authentication for Web cookie sessions and mini-program Bearer tokens.
      if (pathname === '/api/auth/login' && req.method === 'POST') {
        const payload = await parseJsonBody(req);
        const result = authService.login(payload.user_id, payload.password, req.socket.remoteAddress);
        if (result.status !== 200) {
          return sendJson(res, result.status, { code: result.status, message: result.message });
        }
        const secure = !!req.socket.encrypted || process.env.COOKIE_SECURE === '1';
        return sendJson(res, 200, { code: 0, data: { user: result.user, token: result.token } },
          { 'Set-Cookie': authService.sessionCookie(result.token, secure) });
      }

      if (pathname === '/api/auth/me' && req.method === 'GET') {
        const identity = authService.authenticate(req);
        return identity
          ? sendJson(res, 200, { code: 0, data: { user: authService.publicUser(identity.user) } })
          : sendJson(res, 401, { code: 401, message: '请先登录' });
      }

      if (pathname === '/api/auth/logout' && req.method === 'POST') {
        authService.logout(req);
        const secure = !!req.socket.encrypted || process.env.COOKIE_SECURE === '1';
        return sendJson(res, 200, { code: 0, message: '已退出登录' },
          { 'Set-Cookie': authService.clearCookie(secure) });
      }

      // All remaining APIs require a valid server-issued session and an allowlisted role.
      const identity = authService.authenticate(req);
      if (!identity) return sendJson(res, 401, { code: 401, message: '请先登录' });
      req.auth = identity;
      if (!authService.authorize(pathname, req.method, identity.user.role, req)) {
        return sendJson(res, 403, { code: 403, message: '当前账号无权访问此接口' });
      }

      if (pathname === '/api/commands/version' && req.method === 'GET') {
        return sendJson(res, 200, { code: 0, data: { version: db.getWriteState().version } });
      }
      if (pathname === '/api/commands/execute' && req.method === 'POST') {
        const envelope = await parseJsonBody(req, true);
        try {
          const result = businessCommands.execute(req, envelope);
          return sendJson(res, 200, { code: 0, data: result });
        } catch (error) {
          if (error instanceof businessCommands.CommandError) throw error;
          console.error('[commands] transaction failed:', error);
          return sendJson(res, 500, { code: 'COMMAND_FAILED', message: '写入失败，请使用原幂等键重试' });
        }
      }

      // Authenticated snapshot for the native mini-program.
      // Admins receive business data but never raw audit or salary settlement ledgers.
      if (pathname === '/api/db/all' && req.method === 'GET') {
        const allDb = db.dumpAll();
        if (identity.user.role === 'admin') {
          const protectedTables = new Set([
            db.TABLES.AUDIT_LOGS, db.TABLES.SALARY_SETTLEMENTS,
            db.TABLES.SALARY_ADJUSTMENTS, db.TABLES.TEACHER_LESSON_FEES
          ]);
          const filtered = {};
          for (const [table, rows] of Object.entries(allDb)) {
            filtered[table] = protectedTables.has(table) ? [] :
              table === db.TABLES.APPROVAL_REQUESTS
                ? rows.filter(a => a.request_type === 'freeze_hours' ||
                  a.proposer_id === identity.user.id)
                : rows;
          }
          return sendJson(res, 200, { code: 0, data: filtered });
        }
        return sendJson(res, 200, { code: 0, data: allDb });
      }

      // 3.3 小程序 / Web 端实时变更上报
      if (pathname === '/api/db/mutate' && req.method === 'POST') {
        const payload = await parseJsonBody(req);
        const { action, table, id, record, patch, description, operator, audit_log } = payload;

        if (!table) {
          return sendJson(res, 400, { code: 1, message: '必须指定操作目标表 table' });
        }

        // 同步落盘
        if (action === 'INSERT') {
          const existing = db.getById(table, id || (record && record.id));
          if (!existing && record) {
            db.insert(table, record, description || '来自客户端同步写入');
          }
        } else if (action === 'UPDATE') {
          if (id && patch) {
            try {
              db.update(table, id, patch, description || '来自客户端同步更新');
            } catch (err) {
              // 忽略已更新报错
            }
          }
        } else if (action === 'REMOVE') {
          if (id) {
            try {
              db.remove(table, id, description || '来自客户端同步删除');
            } catch (err) {}
          }
        }

        // 若携带额外审计日志同步补全
        if (audit_log && audit_log.id) {
          const logs = db.getTable(db.TABLES.AUDIT_LOGS);
          if (!logs.some(l => l.id === audit_log.id)) {
            logs.push(audit_log);
            const allDb = db.dumpAll();
            allDb[db.TABLES.AUDIT_LOGS] = logs;
            db.replaceAll(allDb);
          }
        }

        // 立即向所有连接的 Web 客户端广播实时数据刷新
        broadcast('mutation', {
          action,
          table,
          id,
          description,
          operator: operator ? operator.name : '未知操作人',
          timestamp: new Date().toISOString()
        });

        return sendJson(res, 200, { code: 0, message: '同步成功' });
      }

      // 3.4 模块 1：全局操作审计日志实时分页查询
      if (pathname === '/api/logs' && req.method === 'GET') {
        const query = parsedUrl.query;
        const page = parseInt(query.page || '1', 10);
        const pageSize = parseInt(query.pageSize || '20', 10);
        const operatorId = query.operator_id;
        const targetTable = query.target_table;
        const action = query.action;
        const keyword = (query.keyword || '').trim().toLowerCase();
        const startTime = query.start_time;
        const endTime = query.end_time;

        const allLogs = db.getTable(db.TABLES.AUDIT_LOGS) || [];

        let filtered = allLogs.filter(log => {
          if (operatorId && log.operator_id !== operatorId) return false;
          if (targetTable && log.target_table !== targetTable) return false;
          if (action && log.action !== action) return false;
          if (startTime && new Date(log.action_time) < new Date(startTime)) return false;
          if (endTime && new Date(log.action_time) > new Date(endTime)) return false;
          if (keyword) {
            const desc = (log.description || '').toLowerCase();
            const targetId = (log.target_record_id || '').toLowerCase();
            const opName = (log.operator_name || '').toLowerCase();
            const beforeStr = (log.before_snapshot_json || '').toLowerCase();
            const afterStr = (log.after_snapshot_json || '').toLowerCase();
            if (
              !desc.includes(keyword) &&
              !targetId.includes(keyword) &&
              !opName.includes(keyword) &&
              !beforeStr.includes(keyword) &&
              !afterStr.includes(keyword)
            ) {
              return false;
            }
          }
          return true;
        });

        // 倒序排列（最新在前）
        filtered.sort((a, b) => new Date(b.action_time || 0) - new Date(a.action_time || 0));

        const total = filtered.length;
        const start = (page - 1) * pageSize;
        const list = filtered.slice(start, start + pageSize);

        return sendJson(res, 200, {
          code: 0,
          data: {
            list,
            total,
            page,
            pageSize,
            totalPages: Math.ceil(total / pageSize)
          }
        });
      }

      // 3.5 模块 2A：排课与考勤快照透视
      if (pathname === '/api/inspector/schedules' && req.method === 'GET') {
        const schedules = db.getTable(db.TABLES.SCHEDULES_AND_ATTENDANCE) || [];
        const classes = db.getTable(db.TABLES.CLASSES) || [];
        const users = db.getTable(db.TABLES.USERS) || [];
        const terms = db.getTable(db.TABLES.TERMS) || [];

        const enriched = schedules.map(s => {
          const cls = classes.find(c => c.id === s.class_id) || {};
          const teacher = users.find(u => u.id === s.teacher_id) || {};
          const actualTeacher = users.find(u => u.id === s.actual_teacher_id) || teacher;
          const subTeacher = s.substitute_teacher_id ? users.find(u => u.id === s.substitute_teacher_id) : null;
          const term = terms.find(t => t.id === s.term_id) || {};

          let deductedDetail = null;
          if (s.deducted_detail_json) {
            try {
              deductedDetail = typeof s.deducted_detail_json === 'string'
                ? JSON.parse(s.deducted_detail_json)
                : s.deducted_detail_json;
            } catch (e) {}
          }

          let rateSnapshot = null;
          if (s.rate_snapshot_json) {
            try {
              rateSnapshot = typeof s.rate_snapshot_json === 'string'
                ? JSON.parse(s.rate_snapshot_json)
                : s.rate_snapshot_json;
            } catch (e) {}
          }

          return Object.assign({}, s, {
            class_name: cls.name || '班级#' + s.class_id,
            term_name: term.name || s.term_id,
            teacher_name: teacher.name || s.teacher_id,
            actual_teacher_name: actualTeacher.name || s.actual_teacher_id,
            substitute_teacher_name: subTeacher ? subTeacher.name : null,
            initial_present_headcount: s.initial_present_headcount !== undefined ? s.initial_present_headcount : (s.present_student_ids || []).length,
            makeup_compensated_count: s.makeup_compensated_count || 0,
            parsed_deducted_detail: deductedDetail,
            parsed_rate_snapshot: rateSnapshot,
            makeup_students_list: s.makeup_students || []
          });
        });

        // 按日期时间倒序
        enriched.sort((a, b) => new Date((b.date + ' ' + (b.start_time || '00:00')) || 0) - new Date((a.date + ' ' + (a.start_time || '00:00')) || 0));

        return sendJson(res, 200, { code: 0, data: enriched });
      }

      // 3.6 模块 2B：学生课时包与流水账本透视
      if (pathname === '/api/inspector/student-packages' && req.method === 'GET') {
        const query = parsedUrl.query;
        const studentId = query.student_id;
        const keyword = (query.keyword || '').trim().toLowerCase();

        const students = db.getTable(db.TABLES.STUDENTS) || [];
        const allPackages = db.getTable(db.TABLES.COURSE_PACKAGES) || [];
        const manualAdjustments = db.getTable(db.TABLES.MANUAL_HOUR_ADJUSTMENTS) || [];
        const transfers = db.getTable(db.TABLES.TRANSFER_RECORDS) || [];
        const refunds = db.getTable(db.TABLES.REFUND_RECORDS) || [];
        const rollovers = db.getTable(db.TABLES.TERM_ROLLOVER_RECORDS) || [];

        let matchedStudents = students;
        if (studentId) {
          matchedStudents = students.filter(s => s.id === studentId);
        } else if (keyword) {
          matchedStudents = students.filter(s =>
            (s.name || '').toLowerCase().includes(keyword) ||
            (s.id || '').toLowerCase().includes(keyword) ||
            (s.bound_parents || []).some(p => (p.phone || '').includes(keyword))
          );
        }

        const result = matchedStudents.map(stu => {
          const stuPkgs = allPackages.filter(p => p.student_id === stu.id);
          const stuAdjusts = manualAdjustments.filter(m => m.student_id === stu.id);
          const stuTransfers = transfers.filter(t => t.source_student_id === stu.id || t.target_student_id === stu.id);
          const stuRefunds = refunds.filter(r => r.student_id === stu.id);
          const stuRollovers = rollovers.filter(ro => ro.student_id === stu.id);

          const totalPaidLeft = stuPkgs.reduce((sum, p) => sum + Number(p.paid_hours_left || 0), 0);
          const totalGiftLeft = stuPkgs.reduce((sum, p) => sum + Number(p.gift_hours_left || 0), 0);
          const totalDebt = stuPkgs.reduce((sum, p) => sum + Number(p.debt_hours || 0), 0);
          const totalFrozenDays = stuPkgs.reduce((sum, p) => sum + Number(p.total_frozen_days || 0), 0);

          return {
            student: stu,
            packages: stuPkgs,
            stats: {
              total_paid_left: Number(totalPaidLeft.toFixed(2)),
              total_gift_left: Number(totalGiftLeft.toFixed(2)),
              total_available_hours: Number((totalPaidLeft + totalGiftLeft).toFixed(2)),
              total_debt_hours: Number(totalDebt.toFixed(2)),
              total_frozen_days: totalFrozenDays,
              package_count: stuPkgs.length
            },
            history: {
              manual_adjustments: stuAdjusts,
              transfers: stuTransfers,
              refunds: stuRefunds,
              rollovers: stuRollovers
            }
          };
        });

        return sendJson(res, 200, { code: 0, data: result });
      }

      // 3.7 模块 3：异常与预警监控大盘
      if (pathname === '/api/anomaly/overview' && req.method === 'GET') {
        const packages = db.getTable(db.TABLES.COURSE_PACKAGES) || [];
        const approvals = db.getTable(db.TABLES.APPROVAL_REQUESTS) || [];
        const students = db.getTable(db.TABLES.STUDENTS) || [];

        // 1. 待审批锁定中的课时包列表
        const pendingLockedPackages = packages.filter(p => p.lock_status === 'pending_approval_locked');

        // 2. 因考勤消课破锁失效的审批单列表
        const invalidatedApprovals = approvals.filter(a => a.status === 'invalidated_by_attendance');

        // 3. 欠费透支名单 (debt_hours > 0)
        const debtPackages = packages.filter(p => Number(p.debt_hours || 0) > 0);

        // 4. 可用余额不足 4 课时的预警名单 (未核销退费)
        const lowBalancePackages = packages.filter(p => {
          if (p.lock_status === 'refunded' || p.refund_status === 'refunded') return false;
          const total = Number(p.paid_hours_left || 0) + Number(p.gift_hours_left || 0);
          return total > 0 && total < 4;
        });

        // 5. 家长未授权订阅通知队列 (subscribe_auth = false)
        const unsubscribedParents = [];
        students.forEach(stu => {
          (stu.bound_parents || []).forEach(parent => {
            if (parent.subscribe_auth === false) {
              unsubscribedParents.push({
                student_id: stu.id,
                student_name: stu.name,
                parent_phone: parent.phone,
                relation: parent.relation,
                subscribe_auth: false
              });
            }
          });
        });

        return sendJson(res, 200, {
          code: 0,
          data: {
            metrics: {
              locked_packages_count: pendingLockedPackages.length,
              invalidated_approvals_count: invalidatedApprovals.length,
              debt_packages_count: debtPackages.length,
              low_balance_packages_count: lowBalancePackages.length,
              unsubscribed_parents_count: unsubscribedParents.length
            },
            pending_locked_packages: pendingLockedPackages,
            invalidated_approvals: invalidatedApprovals,
            debt_packages: debtPackages,
            low_balance_packages: lowBalancePackages,
            unsubscribed_parents: unsubscribedParents
          }
        });
      }

      // 3.8 模块 4：开发调试沙盒工具接口
      // 保护真实数据：此接口可重置全库、改签到时间和模拟扣费。
      // 默认关闭；仅在本机调试时显式设置 ENABLE_DEBUG_ACTIONS=1 才可启用。
      // 不信任客户端传入的 X-User-Role / X-User-Id 作为权限凭证。
      if (pathname === '/api/debug/action' && req.method === 'POST') {
        const remoteAddress = req.socket && req.socket.remoteAddress;
        const isLoopback = remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1';
        if (process.env.ENABLE_DEBUG_ACTIONS !== '1' || !isLoopback) {
          return sendJson(res, 403, { code: 403, message: '调试接口已禁用；仅允许显式开启后的本机调试' });
        }
        const payload = await parseJsonBody(req);
        const { action, schedule_id, package_id } = payload;

        if (action === 'set_schedule_25h_ago') {
          // 一键将排课时间置为 25 小时前，以测试 24 小时超时锁死与拦截
          const schedules = db.getTable(db.TABLES.SCHEDULES_AND_ATTENDANCE) || [];
          let targetSchedule = null;
          if (schedule_id) {
            targetSchedule = schedules.find(s => s.id === schedule_id);
          } else {
            targetSchedule = schedules.find(s => s.status === 'signed') || schedules[0];
          }

          if (!targetSchedule) {
            return sendJson(res, 400, { code: 1, message: '未找到可修改的排课记录' });
          }

          const twentyFiveHoursAgo = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
          const updated = db.update(
            db.TABLES.SCHEDULES_AND_ATTENDANCE,
            targetSchedule.id,
            {
              signed_at: twentyFiveHoursAgo,
              actual_start_time: twentyFiveHoursAgo,
              status: 'signed'
            },
            `[沙盒调试] 模拟将课次 #${targetSchedule.id} 签到时间调整为 25 小时前 (${twentyFiveHoursAgo})，测试超时锁死拦截`
          );

          broadcast('mutation', { action: 'DEBUG_ACTION', type: action, target_id: targetSchedule.id });
          return sendJson(res, 200, {
            code: 0,
            message: `排课 #${targetSchedule.id} 签到时间已调整为 25 小时前 (${twentyFiveHoursAgo})，24小时自主修改窗口现已关闭！`,
            data: updated
          });
        }

        if (action === 'scan_expiring_terms') {
          // 扫描四期到期课时包
          const scanRes = transferRefundService.scanExpiringPackages();
          return sendJson(res, 200, { code: 0, message: '到期扫描执行完毕', data: scanRes });
        }

        if (action === 'reseed_database') {
          // 一键重置全库种子数据
          db.initDatabase(true);
          broadcast('mutation', { action: 'RESEED_ALL' });
          return sendJson(res, 200, { code: 0, message: '数据库已成功恢复初始种子数据！' });
        }

        if (action === 'mock_attendance_deduct') {
          // 模拟课堂消课扣费测试
          const pkgs = db.getTable(db.TABLES.COURSE_PACKAGES) || [];
          const validPkg = pkgs.find(p => Number(p.paid_hours_left || 0) > 0) || pkgs[0];
          if (!validPkg) {
            return sendJson(res, 400, { code: 1, message: '无可用课时包进行模拟消课' });
          }
          const deductRes = packageAccountService.deductHours({
            student_id: validPkg.student_id,
            course_id: validPkg.course_id,
            hours_needed: 1.0,
            context_desc: 'PC Web 调试沙盒一键模拟消课'
          });
          broadcast('mutation', { action: 'MOCK_DEDUCT', student_id: validPkg.student_id });
          return sendJson(res, 200, { code: 0, message: '模拟消课扣费执行成功！', data: deductRes });
        }

        if (action === 'trigger_broadcast') {
          broadcast('mutation', { action: 'MANUAL_PING' });
          return sendJson(res, 200, { code: 0, message: '已向所有客户端广播同步信号' });
        }

        return sendJson(res, 400, { code: 1, message: `未知的沙盒调试指令: ${action}` });
      }

      // ─────────────────────────────────────────
      // 3.10 Phase 6-B：超管审批中心 API
      // ─────────────────────────────────────────
      if (pathname === '/api/approvals' && req.method === 'GET') {
        const query = parsedUrl.query;
        const allApprovals = db.getTable(db.TABLES.APPROVAL_REQUESTS) || [];
        const status = query.status; // 'pending' | 'processed'
        const reqType = query.request_type;

        let filtered = allApprovals.filter(a => {
          if (identity.user.role === 'admin' &&
              a.request_type !== 'freeze_hours' && a.proposer_id !== identity.user.id) {
            return false;
          }
          if (status === 'pending' && a.status !== 'pending') return false;
          if (status === 'processed' && a.status === 'pending') return false;
          if (reqType && a.request_type !== reqType) return false;
          return true;
        });

        filtered.sort((a, b) => new Date(b.created_at || b.action_time || 0) - new Date(a.created_at || a.action_time || 0));

        // 丰富快照解析与算账明细预览
        const enriched = filtered.map(item => {
          let beforeObj = null;
          let afterObj = null;
          try { beforeObj = typeof item.before_data_json === 'string' ? JSON.parse(item.before_data_json) : item.before_data_json; } catch (e) {}
          try { afterObj = typeof item.after_data_json === 'string' ? JSON.parse(item.after_data_json) : item.after_data_json; } catch (e) {}
          return Object.assign({}, item, {
            parsed_before: beforeObj,
            parsed_after: afterObj
          });
        });

        return sendJson(res, 200, { code: 0, data: enriched });
      }

      if (pathname === '/api/approvals/approve' && req.method === 'POST') {
        const payload = await parseJsonBody(req);
        const { approval_id } = payload;
        const operator = getOperatorFromReq(req);
        const approvalItem = db.getById(db.TABLES.APPROVAL_REQUESTS, approval_id);
        if (!approvalItem) return sendJson(res, 404, { code: 1, message: '未找到审批单' });
        if (approvalItem.status !== 'pending') return sendJson(res, 409, { code: 409, message: '审批单已处理，禁止重复审批或重复撤销' });

        // 自审拦截
        if (operator.id === approvalItem.proposer_id) {
          return sendJson(res, 403, { code: 1, message: '违反内控铁律：不能审批自己发起的申请！请切换其他超管账号' });
        }

        // 权限校验
        if (approvalItem.request_type !== 'freeze_hours' && operator.role !== 'super_admin') {
          return sendJson(res, 403, { code: 1, message: '权限不足：仅超级管理员一人有权审批此项申请' });
        }

        const now = new Date().toISOString();
        try {
          withJsonDbRollback(() => {
          if (approvalItem.request_type === 'config_change') {
            systemConfigService.applyConfigApproval(approvalItem, operator);
          } else if (approvalItem.request_type === 'freeze_hours') {
            transferRefundService.applyFreezeApproval(approvalItem, operator);
          } else if (approvalItem.request_type === 'manual_hour_adjust' || approvalItem.request_type === 'balance_adjustment') {
            transferRefundService.applyManualHourAdjustApproval(approvalItem, operator);
          } else if (approvalItem.request_type === 'transfer') {
            transferRefundService.applyTransferApproval(approvalItem, operator);
          } else if (approvalItem.request_type === 'refund') {
            transferRefundService.applyRefundApproval(approvalItem, operator);
          } else if (approvalItem.request_type === 'makeup_attendance') {
            attendanceService.applyMakeupSignApproval(approvalItem, operator);
          } else if (approvalItem.request_type === 'salary_adjustment') {
            salaryEngineService.applySalaryAdjustmentApproval(approvalItem, operator);
          } else {
            throw new Error('不支持的审批类型，禁止直接标记为已批准');
          }
          // Mark approved only after successful business application.
          db.update(db.TABLES.APPROVAL_REQUESTS, approvalItem.id, {
            status: 'approved', approver_id: operator.id,
            approver_name: operator.name, approved_time: now
          }, `[Web端审批通过] ${operator.name} 批准单据 #${approvalItem.id}`);
          }, operator);
        } catch (bizErr) {
          return sendJson(res, 400, { code: 1, message: bizErr.message || '业务执行拦截' });
        }

        broadcast('mutation', { action: 'APPROVAL_APPROVED', approval_id: approvalItem.id, table: 'approval_requests' });
        return sendJson(res, 200, { code: 0, message: '审批已批准通过并正式生效！' });
      }

      if (pathname === '/api/approvals/reject' && req.method === 'POST') {
        const payload = await parseJsonBody(req);
        const { approval_id, reject_reason } = payload;
        const operator = getOperatorFromReq(req);
        const approvalItem = db.getById(db.TABLES.APPROVAL_REQUESTS, approval_id);
        if (!approvalItem) return sendJson(res, 404, { code: 1, message: '未找到审批单' });
        if (approvalItem.status !== 'pending') return sendJson(res, 409, { code: 409, message: '审批单已处理，禁止重复审批或重复撤销' });

        if (operator.id === approvalItem.proposer_id) {
          return sendJson(res, 403, { code: 1, message: '违反内控铁律：不能审批自己发起的申请！请切换其他账号' });
        }

        const reason = (reject_reason || '经审批人综合评估未予通过').trim();
        const now = new Date().toISOString();

        try {
          withJsonDbRollback(() => {
            if (approvalItem.request_type === 'freeze_hours') {
          transferRefundService.rejectFreezeApproval(approvalItem, reason, operator);
        } else if (approvalItem.request_type === 'manual_hour_adjust' || approvalItem.request_type === 'balance_adjustment') {
          transferRefundService.rejectManualHourAdjustApproval(approvalItem, reason, operator);
        } else if (approvalItem.request_type === 'transfer') {
          transferRefundService.rejectTransferApproval(approvalItem, reason, operator);
        } else if (approvalItem.request_type === 'refund') {
          transferRefundService.rejectRefundApproval(approvalItem, reason, operator);
        } else if (approvalItem.request_type === 'makeup_attendance') {
          attendanceService.rejectMakeupSignApproval(approvalItem, reason, operator);
        } else if (approvalItem.request_type === 'salary_adjustment') {
          salaryEngineService.rejectSalaryAdjustmentApproval(approvalItem, reason, operator);
        }
          db.update(db.TABLES.APPROVAL_REQUESTS, approvalItem.id, {
            status: 'rejected', approver_id: operator.id, approver_name: operator.name,
            approved_time: now, reject_reason: reason
          }, `[Web端审批驳回] ${operator.name} 驳回单据 #${approvalItem.id}，理由：${reason}`);
          }, operator);
        } catch (bizErr) {
          return sendJson(res, 400, { code:1, message: bizErr.message || '审批驳回执行失败' });
        }

        broadcast('mutation', { action: 'APPROVAL_REJECTED', approval_id: approvalItem.id, table: 'approval_requests' });
        return sendJson(res, 200, { code: 0, message: '审批单已驳回并释放并发锁！' });
      }

      // ─────────────────────────────────────────
      // 3.11 Phase 6-B：教务与排课管理大屏 API
      // ─────────────────────────────────────────
      if (pathname === '/api/academic/classes' && req.method === 'GET') {
        const query = parsedUrl.query;
        const list = classService.getClassList(query);
        return sendJson(res, 200, { code: 0, data: list });
      }

      if (pathname === '/api/academic/class/create' && req.method === 'POST') {
        const payload = await parseJsonBody(req);
        const operator = getOperatorFromReq(req);
        try {
          const resCls = classService.createClass(payload);
          broadcast('mutation', { action: 'CREATE_CLASS', table: 'classes' });
          return sendJson(res, 200, { code: 0, message: '班级创建成功！', data: resCls });
        } catch (err) {
          return sendJson(res, 400, { code: 1, message: err.message });
        }
      }

      if (pathname === '/api/academic/class/change-teacher' && req.method === 'POST') {
        const payload = await parseJsonBody(req);
        const { class_id, new_teacher_id, reason } = payload;
        try {
          const resUpd = classService.changeTeacher(class_id, new_teacher_id, reason);
          broadcast('mutation', { action: 'CHANGE_TEACHER', table: 'classes' });
          return sendJson(res, 200, { code: 0, message: '换师成功！历史课次已切割留痕，新老师立即接管后续排课。', data: resUpd });
        } catch (err) {
          return sendJson(res, 400, { code: 1, message: err.message });
        }
      }

      if (pathname === '/api/academic/class/enroll' && req.method === 'POST') {
        const payload = await parseJsonBody(req);
        const { class_id, student_id, start_lesson_index, remark } = payload;
        try {
          const resEnr = classService.enrollStudent(class_id, student_id, { start_lesson_index, remark });
          broadcast('mutation', { action: 'ENROLL_STUDENT', table: 'classes' });
          return sendJson(res, 200, { code: 0, message: '排班/插班成功！', data: resEnr });
        } catch (err) {
          return sendJson(res, 400, { code: 1, message: err.message });
        }
      }

      if (pathname === '/api/academic/class/add-trial' && req.method === 'POST') {
        const payload = await parseJsonBody(req);
        const { class_id, student_id } = payload;
        try {
          const resTr = classService.addTrialStudent(class_id, student_id);
          broadcast('mutation', { action: 'ADD_TRIAL', table: 'classes' });
          return sendJson(res, 200, { code: 0, message: '试听生登记成功！不占正式满班名额/不触发开班门槛/不扣课/不计老师人头。', data: resTr });
        } catch (err) {
          return sendJson(res, 400, { code: 1, message: err.message });
        }
      }

      if (pathname === '/api/academic/class/remove-student' && req.method === 'POST') {
        const payload = await parseJsonBody(req);
        const { class_id, student_id, is_trial, reason } = payload;
        try {
          const resRem = classService.removeStudentFromClass(class_id, student_id, is_trial, reason);
          broadcast('mutation', { action: 'REMOVE_STUDENT', table: 'classes' });
          return sendJson(res, 200, { code: 0, message: '已成功移出班级！', data: resRem });
        } catch (err) {
          return sendJson(res, 400, { code: 1, message: err.message });
        }
      }

      if (pathname === '/api/academic/schedule/cancel' && req.method === 'POST') {
        const payload = await parseJsonBody(req);
        const { schedule_id, reason, handle_mode } = payload;
        try {
          const resCancel = attendanceService.cancelScheduleLesson(schedule_id, {
            reason: reason || '教务排课调整停课',
            handle_mode: handle_mode || 'postpone_entire_class'
          });
          broadcast('mutation', { action: 'CANCEL_LESSON', table: 'schedules_and_attendance' });
          return sendJson(res, 200, { code: 0, message: '单节课程取消成功！若之前误扣课时已原路全额逆向回滚退回。', data: resCancel });
        } catch (err) {
          return sendJson(res, 400, { code: 1, message: err.message });
        }
      }

      if (pathname === '/api/academic/schedule/postpone' && req.method === 'POST') {
        const payload = await parseJsonBody(req);
        const { class_id, from_schedule_id, reason } = payload;
        const operator = getOperatorFromReq(req);
        try {
          const resPostpone = attendanceService.postponeClassSchedules(class_id, from_schedule_id, reason || '教务整班顺延', operator);
          broadcast('mutation', { action: 'POSTPONE_CLASS', table: 'schedules_and_attendance' });
          return sendJson(res, 200, { code: 0, message: '整班顺延成功！后续排课已按序后移一节。', data: resPostpone });
        } catch (err) {
          return sendJson(res, 400, { code: 1, message: err.message });
        }
      }

      if (pathname === '/api/academic/schedule/substitute' && req.method === 'POST') {
        const payload = await parseJsonBody(req);
        const { schedule_id, substitute_teacher_id, reason } = payload;
        try {
          const resSub = attendanceService.assignSubstituteTeacher(schedule_id, substitute_teacher_id, reason || '教师临时事务代课');
          broadcast('mutation', { action: 'ASSIGN_SUBSTITUTE', table: 'schedules_and_attendance' });
          return sendJson(res, 200, { code: 0, message: '代课老师指定成功！代课签到表动态路由已切换，已触发家长通知。', data: resSub });
        } catch (err) {
          return sendJson(res, 400, { code: 1, message: err.message });
        }
      }

      if (pathname === '/api/academic/schedule/complaint' && req.method === 'POST') {
        const payload = await parseJsonBody(req);
        try {
          const resComp = attendanceService.handleSubstituteComplaint(payload);
          broadcast('mutation', { action: 'HANDLE_COMPLAINT', table: 'substitute_complaints' });
          return sendJson(res, 200, { code: 0, message: '代课客诉处理成功！', data: resComp });
        } catch (err) {
          return sendJson(res, 400, { code: 1, message: err.message });
        }
      }

      if (pathname === '/api/academic/makeup/pending' && req.method === 'GET') {
        const list = attendanceService.getPendingMakeupRequests();
        return sendJson(res, 200, { code: 0, data: list });
      }

      if (pathname === '/api/academic/makeup/eligible-schedules' && req.method === 'GET') {
        const query = parsedUrl.query;
        const list = attendanceService.getEligibleMakeupSchedules(query);
        return sendJson(res, 200, { code: 0, data: list });
      }

      if (pathname === '/api/academic/makeup/dispatch' && req.method === 'POST') {
        const payload = await parseJsonBody(req);
        const operator = getOperatorFromReq(req);
        try {
          const reqId = payload.request_id || payload.makeup_request_id || payload.id;
          const targetData = payload.target_data || payload;
          const resMkp = attendanceService.assignCrossTeacherMakeup(reqId, targetData, operator);
          broadcast('mutation', { action: 'DISPATCH_MAKEUP', table: 'schedules_and_attendance' });
          return sendJson(res, 200, { code: 0, message: '跨师补课调度成功！补课学员已挂载进目标课次签到表。', data: resMkp });
        } catch (err) {
          return sendJson(res, 400, { code: 1, message: err.message });
        }
      }

      // ─────────────────────────────────────────
      // 3.12 Phase 6-B：财务、三转退费与薪资结算中心 API
      // ─────────────────────────────────────────
      if (pathname === '/api/finance/purchase' && req.method === 'POST') {
        const payload = await parseJsonBody(req);
        const { student_id, ...purchaseData } = payload;
        try {
          const resPkg = packageAccountService.purchasePackage(student_id, purchaseData);
          broadcast('mutation', { action: 'PURCHASE_PACKAGE', table: 'course_packages' });
          return sendJson(res, 200, { code: 0, message: '新购课时包登记成功！欠费优先自动冲抵。', data: resPkg });
        } catch (err) {
          return sendJson(res, 400, { code: 1, message: err.message });
        }
      }

      if (pathname === '/api/finance/freeze' && req.method === 'POST') {
        const payload = await parseJsonBody(req);
        const operator = getOperatorFromReq(req);
        try {
          const resFrz = transferRefundService.submitFreezeRequest(payload, operator);
          broadcast('mutation', { action: 'SUBMIT_FREEZE', table: 'approval_requests' });
          return sendJson(res, 200, { code: 0, message: '课时冻结申请已提交超管审批！', data: resFrz });
        } catch (err) {
          return sendJson(res, 400, { code: 1, message: err.message });
        }
      }

      if (pathname === '/api/finance/adjust-hours' && req.method === 'POST') {
        const payload = await parseJsonBody(req);
        const operator = getOperatorFromReq(req);
        try {
          const resAdj = transferRefundService.submitManualHourAdjust(payload, operator);
          broadcast('mutation', { action: 'SUBMIT_ADJUST', table: 'approval_requests' });
          return sendJson(res, 200, { code: 0, message: '手工调课时申请已提交超管审批（并发锁已施加）！', data: resAdj });
        } catch (err) {
          return sendJson(res, 400, { code: 1, message: err.message });
        }
      }

      if (pathname === '/api/finance/transfer/preview' && req.method === 'POST') {
        const payload = await parseJsonBody(req);
        try {
          const preview = transferRefundService.previewTransfer(payload);
          return sendJson(res, 200, { code: 0, data: preview });
        } catch (err) {
          return sendJson(res, 400, { code: 1, message: err.message });
        }
      }

      if (pathname === '/api/finance/transfer/submit' && req.method === 'POST') {
        const payload = await parseJsonBody(req);
        const operator = getOperatorFromReq(req);
        try {
          const resTrf = transferRefundService.submitTransferRequest(payload, operator);
          broadcast('mutation', { action: 'SUBMIT_TRANSFER', table: 'approval_requests' });
          return sendJson(res, 200, { code: 0, message: '教务三转申请已提交超管审批（并发锁已生效）！', data: resTrf });
        } catch (err) {
          return sendJson(res, 400, { code: 1, message: err.message });
        }
      }

      if (pathname === '/api/finance/refund/preview' && req.method === 'POST') {
        const payload = await parseJsonBody(req);
        try {
          const preview = transferRefundService.previewRefund(payload.package_id, payload);
          return sendJson(res, 200, { code: 0, data: preview });
        } catch (err) {
          return sendJson(res, 400, { code: 1, message: err.message });
        }
      }

      if (pathname === '/api/finance/refund/submit' && req.method === 'POST') {
        const payload = await parseJsonBody(req);
        const operator = getOperatorFromReq(req);
        try {
          const resRef = transferRefundService.submitRefundRequest(payload, operator);
          broadcast('mutation', { action: 'SUBMIT_REFUND', table: 'approval_requests' });
          return sendJson(res, 200, { code: 0, message: '退费清算申请已提交超管审批（并发锁已生效）！', data: resRef });
        } catch (err) {
          return sendJson(res, 400, { code: 1, message: err.message });
        }
      }

      if (pathname === '/api/finance/rollover' && req.method === 'POST') {
        const payload = await parseJsonBody(req);
        const operator = getOperatorFromReq(req);
        try {
          const resRollover = transferRefundService.executeTermRollover(payload, operator);
          broadcast('mutation', { action: 'EXECUTE_ROLLOVER', table: 'course_packages' });
          return sendJson(res, 200, { code: 0, message: '期末顺延执行成功！新到期日与补费已安全留档。', data: resRollover });
        } catch (err) {
          return sendJson(res, 400, { code: 1, message: err.message });
        }
      }

      if (pathname === '/api/salary/report' && req.method === 'GET') {
        const query = parsedUrl.query;
        const report = salaryEngineService.getSalaryReport(query);
        return sendJson(res, 200, { code: 0, data: report });
      }

      if (pathname === '/api/salary/settle' && req.method === 'POST') {
        const payload = await parseJsonBody(req);
        const operator = getOperatorFromReq(req);
        try {
          const resSettle = salaryEngineService.settleTeacherSalary(payload.settlement_id, operator);
          broadcast('mutation', { action: 'SETTLE_SALARY', table: 'salary_settlements' });
          return sendJson(res, 200, { code: 0, message: '薪资结算单已锁死归档！已结算记录不可修改删除。', data: resSettle });
        } catch (err) {
          return sendJson(res, 400, { code: 1, message: err.message });
        }
      }

      if (pathname === '/api/salary/generate-settlement' && req.method === 'POST') {
        const payload = await parseJsonBody(req);
        const operator = getOperatorFromReq(req);
        try {
          const resGen = salaryEngineService.generateTeacherSalarySettlement(payload.teacher_id, payload.period || '2026-03', payload.options || payload, operator);
          broadcast('mutation', { action: 'GENERATE_SETTLEMENT', table: 'salary_settlements' });
          return sendJson(res, 200, { code: 0, message: '薪资结算单生成成功！', data: resGen });
        } catch (err) {
          return sendJson(res, 400, { code: 1, message: err.message });
        }
      }

      if (pathname === '/api/salary/adjustment' && req.method === 'POST') {
        const payload = await parseJsonBody(req);
        const operator = getOperatorFromReq(req);
        try {
          const resAdj = salaryEngineService.createSalaryAdjustment(payload, operator);
          broadcast('mutation', { action: 'CREATE_SALARY_ADJUSTMENT', table: 'approval_requests' });
          return sendJson(res, 200, { code: 0, message: '薪资算错调账申请（补发/扣回）已提交超管审批！', data: resAdj });
        } catch (err) {
          return sendJson(res, 400, { code: 1, message: err.message });
        }
      }

      // 3.9 通用表查询
      if (pathname.startsWith('/api/db/')) {
        const tableName = pathname.replace('/api/db/', '');
        const table = db.getTable(tableName);
        return sendJson(res, 200, { code: 0, data: table || [] });
      }

      return sendJson(res, 404, { code: 404, message: 'API Route Not Found' });
    } catch (apiErr) {
      if (apiErr instanceof businessCommands.CommandError) {
        return sendJson(res, apiErr.status, { code: apiErr.code, message: apiErr.message });
      }
      console.error('[server] API Error:', apiErr);
      return sendJson(res, 500, { code: 500, message: apiErr.message || 'Server Internal Error' });
    }
  }

  // 4. 静态 Web 资源托管 (托管 ./web-admin)
  let requestedPath;
  try { requestedPath = decodeURIComponent(pathname === '/' ? '/index.html' : pathname); }
  catch (_err) {
    res.writeHead(400); res.end('Bad Path'); return;
  }
  if (requestedPath.includes('\\0') || requestedPath.includes('\\\\')) {
    res.writeHead(403); res.end('Access Denied'); return;
  }
  const filePath = path.resolve(WEB_ADMIN_DIR, '.' + requestedPath);
  const relativePath = path.relative(WEB_ADMIN_DIR, filePath);
  // Canonical path containment, not a string-prefix check (which accepts web-admin2).
  if (relativePath === '..' || relativePath.startsWith('..' + path.sep) ||
      path.isAbsolute(relativePath)) {
    res.writeHead(403);
    res.end('Access Denied');
    return;
  }

  // 检查文件是否存在
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // SPA Fallback: 回退到 index.html
      filePath = path.join(WEB_ADMIN_DIR, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(500);
        res.end('Error loading ' + filePath);
        return;
      }
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache'
      });
      res.end(content);
    });
  });
});

// 未完成服务端身份认证之前，默认只开放给本机访问。
// 非回环地址要求显式确认风险，仅用于隔离测试。
const HOST = process.env.HOST || '127.0.0.1';
const IS_LOOPBACK_HOST = HOST === '127.0.0.1' || HOST === '::1' || HOST === 'localhost';
if (!IS_LOOPBACK_HOST && process.env.ALLOW_INSECURE_NETWORK !== '1') {
  console.error('[server] Refusing non-loopback bind: server-side authentication is not implemented.');
  console.error('[server] Use HOST=127.0.0.1, or explicitly set ALLOW_INSECURE_NETWORK=1 for isolated testing only.');
  process.exitCode = 1;
} else {
  server.listen(PORT, HOST, () => {
  console.log(`================================================================`);
  console.log(`  教务与财务管理系统 - PC Web 网页端 & 同步服务端启动成功！`);
  console.log(`  PC Web 监控调试控制台: http://localhost:${PORT}`);
  console.log(`  实时数据 SSE 广播流:   http://localhost:${PORT}/api/events`);
  console.log(`  后端 REST API 基地址:   http://localhost:${PORT}/api`);
  console.log(`  小程序端连接地址:       http://127.0.0.1:${PORT}`);
  console.log(`================================================================`);
  });
}

module.exports = server;


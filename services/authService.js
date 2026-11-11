'use strict';

// Server-side credentials and sessions. Never trust client-submitted role headers.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');

const CREDENTIAL_FILE = process.env.AUTH_CREDENTIALS_FILE ||
  path.join(__dirname, '..', 'data', 'auth-credentials.json');
const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;
const SESSION_COOKIE = 'edu_session';
const sessions = new Map();
const failedLogins = new Map();

function loadCredentials() {
  try {
    const store = JSON.parse(fs.readFileSync(CREDENTIAL_FILE, 'utf8'));
    return store && typeof store === 'object' && !Array.isArray(store) ? store : {};
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error('无法读取认证配置，请检查凭证文件格式和权限');
  }
}

function passwordHash(password, salt) {
  return crypto.scryptSync(password, salt, 64, { maxmem: 64 * 1024 * 1024 }).toString('hex');
}

function saveCredential(userId, password) {
  if (typeof userId !== 'string' || !/^[A-Za-z0-9_-]{2,80}$/.test(userId)) {
    throw new Error('必须指定有效的用户ID');
  }
  if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 256) {
    throw new Error('密码长度至少12个字符，不得超过256字节');
  }
  const user = db.getById(db.TABLES.USERS, userId);
  if (!user || user.status !== 'active') throw new Error('用户不存在或已禁用');
  const salt = crypto.randomBytes(24).toString('hex');
  const store = loadCredentials();
  store[userId] = { algorithm: 'scrypt', salt, hash: passwordHash(password, salt) };
  const parent = path.dirname(CREDENTIAL_FILE);
  fs.mkdirSync(parent, { recursive: true });
  const temp = path.join(parent, '.auth-credentials-' + crypto.randomBytes(8).toString('hex') + '.tmp');
  try {
    fs.writeFileSync(temp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, CREDENTIAL_FILE);
    fs.chmodSync(CREDENTIAL_FILE, 0o600);
  } finally {
    try { fs.unlinkSync(temp); } catch (_err) { /* already moved */ }
  }
  for (const [token, session] of sessions) {
    if (session.userId === userId) sessions.delete(token);
  }
}

function verifyPassword(userId, password) {
  const store = loadCredentials();
  const stored = Object.prototype.hasOwnProperty.call(store, userId) ? store[userId] : null;
  if (!stored || stored.algorithm !== 'scrypt' ||
      typeof stored.salt !== 'string' || !/^[a-f0-9]{48}$/.test(stored.salt) ||
      typeof stored.hash !== 'string' || !/^[a-f0-9]{128}$/.test(stored.hash)) {
    return false;
  }
  const given = Buffer.from(passwordHash(password, stored.salt), 'hex');
  const expected = Buffer.from(stored.hash, 'hex');
  return crypto.timingSafeEqual(given, expected);
}

function login(userId, password, peerAddress) {
  const key = String(peerAddress || 'unknown');
  const now = Date.now();
  const attempt = failedLogins.get(key);
  if (attempt && now - attempt.started < 10 * 60 * 1000 && attempt.count >= 5) {
    return { status: 429, message: '登录尝试过多，请稍后再试' };
  }
  if (!attempt || now - attempt.started >= 10 * 60 * 1000) {
    failedLogins.set(key, { started: now, count: 0 });
  }
  const credentials = loadCredentials();
  if (Object.keys(credentials).length === 0) {
    return { status: 503, message: '尚未配置管理员登录凭证，请先运行初始化命令' };
  }
  const user = typeof userId === 'string' ? db.getById(db.TABLES.USERS, userId) : null;
  let valid = false;
  if (user && user.status === 'active' && typeof password === 'string' && password.length <= 256) {
    valid = verifyPassword(userId, password);
  }
  if (!valid) {
    failedLogins.get(key).count++;
    return { status: 401, message: '账号或密码错误' };
  }
  failedLogins.delete(key);
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { userId, expiresAt: now + SESSION_LIFETIME_MS });
  return { status: 200, token, user: publicUser(user) };
}

function publicUser(user) {
  return { id: user.id, name: user.name, role: user.role };
}

function tokenFromRequest(req) {
  const authorization = req.headers.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    return authorization.slice(7).trim();
  }
  const cookies = String(req.headers.cookie || '').split(';');
  const part = cookies.find(c => c.trim().startsWith(SESSION_COOKIE + '='));
  if (!part) return null;
  return part.trim().slice(SESSION_COOKIE.length + 1);
}

function authenticate(req) {
  const token = tokenFromRequest(req);
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() >= session.expiresAt) {
    sessions.delete(token);
    return null;
  }
  const user = db.getById(db.TABLES.USERS, session.userId);
  if (!user || user.status !== 'active' ||
      !Object.prototype.hasOwnProperty.call(loadCredentials(), user.id)) {
    sessions.delete(token);
    return null;
  }
  return { token, user };
}

function logout(req) {
  const token = tokenFromRequest(req);
  if (token) sessions.delete(token);
}

function sessionCookie(token, secure = false) {
  return SESSION_COOKIE + '=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800' +
    (secure ? '; Secure' : '');
}

function clearCookie(secure = false) {
  return SESSION_COOKIE + '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' +
    (secure ? '; Secure' : '');
}

function authorize(pathname, method, role, req) {
  if (role !== 'super_admin' && role !== 'admin') {
    // Teacher and parent scopes must be implemented explicitly, never inherit admin access.
    return false;
  }
  if (pathname === '/api/events') return true;
  if (pathname === '/api/db/all') return true; // Admin export is redacted by server.js.
  if (pathname === '/api/logs' ||
      pathname.startsWith('/api/salary/') || pathname.startsWith('/api/debug/')) {
    return role === 'super_admin';
  }
  if (pathname.startsWith('/api/db/')) {
    if (pathname === '/api/db/mutate') {
      // Legacy arbitrary table writes are too powerful for ordinary admins.
      const peer = req.socket && req.socket.remoteAddress;
      return role === 'super_admin' &&
        process.env.ALLOW_LEGACY_MUTATION_SYNC === '1' &&
        (peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1');
    }
    const table = pathname.slice('/api/db/'.length);
    if (!Object.values(db.TABLES).includes(table)) return false;
    return role === 'super_admin' ||
      !['users', 'teacher_lesson_fees', 'salary_settlements', 'salary_adjustments',
        'audit_logs', 'teacher_tiers', 'partner_teacher_rate_config', 'approval_requests'].includes(table);
  }
  if (pathname === '/api/approvals/approve' || pathname === '/api/approvals/reject') {
    return role === 'super_admin';
  }
  if (pathname.startsWith('/api/approvals') || pathname.startsWith('/api/academic/') ||
      pathname.startsWith('/api/finance/') || pathname.startsWith('/api/inspector/') ||
      pathname.startsWith('/api/anomaly/')) {
    return true;
  }
  return false;
}

module.exports = {
  login, logout, authenticate, authorize, saveCredential, publicUser,
  sessionCookie, clearCookie, CREDENTIAL_FILE
};

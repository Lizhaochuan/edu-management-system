'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'edu-command-'));
  fs.cpSync(path.resolve(__dirname, '../services'), path.join(root, 'services'), { recursive: true });
  const file = path.join(root, 'data/db.json');
  process.env.AUTH_CREDENTIALS_FILE = path.join(root, 'credentials.json');
  let db, auth, commands;
  function reload() {
    for (const name of ['db', 'authService', 'businessCommandService']) {
      delete require.cache[require.resolve(path.join(root, 'services', name + '.js'))];
    }
    db = require(path.join(root, 'services/db'));
    auth = require(path.join(root, 'services/authService'));
    commands = require(path.join(root, 'services/businessCommandService'));
  }
  reload();
  db.initDatabase(true);
  for (const id of ['u_sa1', 'u_sa2', 'u_adm1', 'u_par1']) auth.saveCredential(id, 'Command-Test-Password-2026!');
  return {
    get db() { return db; }, get auth() { return auth; }, get commands() { return commands; },
    root, file, reload,
    req(id = 'u_sa1') {
      const session = auth.login(id, 'Command-Test-Password-2026!', id);
      assert.equal(session.status, 200);
      return { headers: { authorization: 'Bearer ' + session.token } };
    },
    envelope(key = 'test-key-00000001') {
      return { command: 'system.writeProbe', params: { label: 'probe' },
        idempotencyKey: key, expectedVersion: db.getWriteState().version };
    },
    close() { delete process.env.AUTH_CREDENTIALS_FILE; fs.rmSync(root, { recursive: true, force: true }); }
  };
}
function checkError(fn, status, code) {
  assert.throws(fn, e => e.status === status && e.code === code);
}
function run(fn) { const f = fixture(); try { fn(f); } finally { f.close(); } }

test('command authentication ignores forged role, operator and req.auth; credentials can be revoked', () => run(f => {
  const p = f.envelope();
  checkError(() => f.commands.execute({ headers: { 'x-user-role': 'super_admin' },
    auth: { user: { id: 'u_sa1', role: 'super_admin' } } }, p), 401, 'UNAUTHENTICATED');
  const req = f.req('u_adm1');
  req.headers['x-user-role'] = 'super_admin';
  checkError(() => f.commands.execute(req, p), 403, 'FORBIDDEN');
  checkError(() => f.commands.execute(f.req('u_par1'), p), 403, 'FORBIDDEN');
  const sa = f.req();
  f.db.update(f.db.TABLES.USERS, 'u_sa1', { role: 'admin' });
  checkError(() => f.commands.execute(sa, p), 403, 'FORBIDDEN');
  f.db.update(f.db.TABLES.USERS, 'u_sa1', { status: 'disabled' });
  checkError(() => f.commands.execute(sa, p), 401, 'UNAUTHENTICATED');
}));

test('strict whitelist and parameters reject arbitrary table writes and malformed envelopes without persistence', () => run(f => {
  const req = f.req();
  const p = f.envelope();
  const before = fs.readFileSync(f.file, 'utf8');
  const bad = [null, [], {}, { ...p, role: 'super_admin' }, { ...p, operator: { id: 'u_sa1' } },
    { ...p, command: '__proto__' }, { ...p, command: 'db.update' },
    { ...p, params: { label: 'okay', table: 'users' } }, { ...p, params: null },
    { ...p, params: { label: 'x'.repeat(41) } }, { ...p, expectedVersion: -1 },
    { ...p, expectedVersion: 1.2 }, { ...p, expectedVersion: '1' },
    { ...p, idempotencyKey: 'short' }];
  for (const value of bad) assert.throws(() => f.commands.execute(req, value), e => e.status === 400);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
}));

test('exact retry returns durable original result before checking stale version; changed payload conflicts', () => run(f => {
  const req = f.req();
  const p = f.envelope();
  const business = JSON.stringify(f.db.dumpAll());
  const first = f.commands.execute(req, p);
  assert.equal(first.version, p.expectedVersion + 1);
  assert.equal(first.replayed, false);
  assert.equal(JSON.stringify(f.db.dumpAll()), business);
  const bytes = fs.readFileSync(f.file, 'utf8');
  assert.deepEqual(f.commands.execute(req, p), { ...first, replayed: true });
  checkError(() => f.commands.execute(req, { ...p, params: { label: 'different' } }), 409, 'IDEMPOTENCY_CONFLICT');
  assert.equal(fs.readFileSync(f.file, 'utf8'), bytes);
  assert.equal(f.db.dumpAll().__server_write_state, undefined);
  f.reload();
  assert.deepEqual(f.commands.execute(f.req(), p), { ...first, replayed: true });
  // Authorization is rechecked even when an authorized user's old receipt exists.
  const revoked = f.req();
  f.db.update(f.db.TABLES.USERS, 'u_sa1', { role: 'admin' });
  checkError(() => f.commands.execute(revoked, p), 403, 'FORBIDDEN');
}));

test('idempotency namespace is per server-authenticated user', () => run(f => {
  const p = f.envelope();
  f.commands.execute(f.req(), p);
  const next = { ...p, expectedVersion: f.db.getWriteState().version };
  assert.equal(f.commands.execute(f.req('u_sa2'), next).replayed, false);
  assert.equal(f.db.getWriteState().receipts.length, 2);
}));

test('legacy writes advance the global version and cannot erase receipts on business snapshot restore', () => run(f => {
  const req = f.req();
  const p = f.envelope();
  f.commands.execute(req, p);
  const stale = f.envelope('test-key-00000002');
  f.db.update(f.db.TABLES.STUDENTS, 'stu_1', { name: 'test update' });
  checkError(() => f.commands.execute(req, stale), 409, 'VERSION_CONFLICT');
  f.db.replaceAll(f.db.dumpAll());
  assert.equal(f.commands.execute(req, p).replayed, true);
}));

test('partial business failure restores rows, audits, version, receipts and disk; same key can retry', () => run(f => {
  const req = f.req();
  let shouldFail = true;
  const execute = f.commands.createExecutor({ 'test.change': {
    authorize: u => u.role === 'super_admin', validate: p => Object.keys(p).length === 0,
    handle: ({ operator }) => {
      f.db.update(f.db.TABLES.STUDENTS, 'stu_1', { name: 'new' });
      f.db.update(f.db.TABLES.STUDENTS, 'stu_2', { name: 'second' });
      assert.equal(operator.id, 'u_sa1');
      if (shouldFail) throw new Error('INJECTED partial failure');
      return { changed: 2 };
    }
  } });
  const p = { ...f.envelope(), command: 'test.change', params: {} };
  const bytes = fs.readFileSync(f.file, 'utf8');
  const before = JSON.stringify(f.db.dumpAll());
  assert.throws(() => execute(req, p), /INJECTED/);
  assert.equal(JSON.stringify(f.db.dumpAll()), before);
  assert.equal(fs.readFileSync(f.file, 'utf8'), bytes);
  assert.equal(f.db.getWriteState().version, p.expectedVersion);
  assert.equal(f.db.getWriteState().receipts.length, 0);
  shouldFail = false;
  execute(req, p);
  assert.equal(f.db.getWriteState().version, p.expectedVersion + 1);
  const logs = f.db.getTable(f.db.TABLES.AUDIT_LOGS).slice(-2);
  assert.ok(logs.every(l => l.operator_id === 'u_sa1'));
  f.reload();
  assert.equal(f.db.getById(f.db.TABLES.STUDENTS, 'stu_2').name, 'second');
  assert.equal(f.db.getWriteState().receipts.length, 1);
}));

test('write, fsync and rename failures leave original disk and memory intact without rollback writes', () => run(f => {
  const req = f.req();
  const p = f.envelope();
  const bytes = fs.readFileSync(f.file, 'utf8');
  const before = JSON.stringify(f.db.dumpAll());
  const execute = f.commands.createExecutor({ 'test.change': {
    authorize: () => true, validate: () => true,
    handle: () => f.db.update(f.db.TABLES.STUDENTS, 'stu_1', { name: 'staged' })
  } });
  const write = { ...p, command: 'test.change' };
  for (const method of ['writeFileSync', 'fsyncSync', 'renameSync']) {
    const original = fs[method];
    let attempts = 0;
    fs[method] = () => { attempts++; throw new Error('INJECTED ' + method); };
    try { assert.throws(() => execute(req, write), /INJECTED/); }
    finally { fs[method] = original; }
    assert.equal(attempts, 1);
    assert.equal(fs.readFileSync(f.file, 'utf8'), bytes);
    assert.equal(JSON.stringify(f.db.dumpAll()), before);
    assert.equal(f.db.getWriteState().version, p.expectedVersion);
    assert.equal(f.db.getWriteState().receipts.length, 0);
    assert.deepEqual(fs.readdirSync(path.dirname(f.file)), ['db.json']);
  }
  assert.equal(execute(req, write).replayed, false);
  f.reload();
  assert.equal(f.db.getById(f.db.TABLES.STUDENTS, 'stu_1').name, 'staged');
}));

test('audit serialization failure aborts staged write instead of being silently ignored', () => run(f => {
  const bytes = fs.readFileSync(f.file, 'utf8');
  assert.throws(() => f.db.transaction(() => f.db.insert(f.db.TABLES.STUDENTS,
    { id: 'bad_audit', unsupported: 1n }), { id: 'u_sa1' }), /BigInt/);
  assert.equal(f.db.getById(f.db.TABLES.STUDENTS, 'bad_audit'), null);
  assert.equal(fs.readFileSync(f.file, 'utf8'), bytes);
}));

test('async handlers and reentrant transactions are rejected without writes', () => run(f => {
  const before = fs.readFileSync(f.file, 'utf8');
  assert.throws(() => f.db.transaction(async () => {}), /synchronous/);
  assert.throws(() => f.db.transaction(() => f.db.transaction(() => {})), /Nested/);
  assert.throws(() => f.commands.createExecutor({ bad: { authorize: () => true,
    validate: () => true, handle: async () => {} } }), /registration/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
}));

test('historical JSON without metadata loads unchanged and is upgraded only by a successful command', () => run(f => {
  const historical = f.db.dumpAll();
  fs.writeFileSync(f.file, JSON.stringify(historical));
  f.reload();
  assert.equal(f.db.getWriteState().version, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), historical);
  f.commands.execute(f.req(), f.envelope());
  assert.equal(f.db.getWriteState().version, 1);
  assert.deepEqual(f.db.dumpAll(), historical);
}));

test('receipt capacity fails closed rather than evicting keys and reapplying old requests', () => run(f => {
  const raw = JSON.parse(fs.readFileSync(f.file));
  raw.__server_write_state.receipts = Array.from({ length: 10000 }, (_, i) => ({ key: String(i) }));
  fs.writeFileSync(f.file, JSON.stringify(raw));
  f.reload();
  checkError(() => f.commands.execute(f.req(), f.envelope()), 503, 'RECEIPT_CAPACITY');
}));

test('corrupted historical database is refused without replacing it with seed data', () => run(f => {
  for (const corrupt of ['{bad database', 'null', '[]']) {
    fs.writeFileSync(f.file, corrupt);
    f.reload();
    assert.throws(() => f.db.initDatabase(), /refusing to overwrite historical data/);
    assert.equal(fs.readFileSync(f.file, 'utf8'), corrupt);
  }
}));

test('explicit development reset keeps command receipts and never reuses a version', () => run(f => {
  const p = f.envelope();
  const req = f.req();
  const response = f.commands.execute(req, p);
  f.db.initDatabase(true);
  assert.equal(f.db.getWriteState().version, response.version + 1);
  assert.equal(f.commands.execute(req, p).replayed, true);
}));

test('failed legacy writes cannot leak into a later successful command commit', () => run(f => {
  const req = f.req();
  const operations = [
    () => f.db.insert(f.db.TABLES.STUDENTS, { id: 'failed_insert' }),
    () => f.db.update(f.db.TABLES.STUDENTS, 'stu_1', { name: 'failed_update' }),
    () => f.db.remove(f.db.TABLES.STUDENTS, 'stu_1'),
    () => f.db.replaceAll({ ...f.db.dumpAll(), students: [] }),
    () => f.db.initDatabase(true)
  ];
  // Make reset observably different from the fixture's initial business state.
  f.db.update(f.db.TABLES.STUDENTS, 'stu_2', { name: 'keep_after_failed_reset' });
  const stable = JSON.stringify(f.db.dumpAll());
  const stableVersion = f.db.getWriteState().version;
  const stableBytes = fs.readFileSync(f.file, 'utf8');
  for (const operation of operations) {
    const rename = fs.renameSync;
    fs.renameSync = () => { throw new Error('INJECTED legacy commit failure'); };
    try { assert.throws(operation, /INJECTED legacy commit failure/); }
    finally { fs.renameSync = rename; }
    assert.equal(JSON.stringify(f.db.dumpAll()), stable);
    assert.equal(f.db.getWriteState().version, stableVersion);
    assert.equal(fs.readFileSync(f.file, 'utf8'), stableBytes);
  }
  f.commands.execute(req, f.envelope());
  f.reload();
  assert.equal(JSON.stringify(f.db.dumpAll()), stable);
}));

test('legacy single-row writes roll back when their audit cannot be serialized', () => run(f => {
  const before = fs.readFileSync(f.file, 'utf8');
  const version = f.db.getWriteState().version;
  assert.throws(() => f.db.insert(f.db.TABLES.STUDENTS,
    { id: 'bad_legacy_audit', unsupported: 1n }), /BigInt/);
  assert.equal(f.db.getById(f.db.TABLES.STUDENTS, 'bad_legacy_audit'), null);
  assert.equal(f.db.getWriteState().version, version);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
}));

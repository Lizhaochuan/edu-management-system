'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');

const SCRIPT = path.resolve(__dirname, '../scripts/db-encrypted-backup.js');
const ROOT = path.resolve(__dirname, '..');
function scenario(handler) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edu-encrypted-test-'));
  const db = path.join(dir, 'source.json');
  const key = path.join(dir, 'recovery.key');
  const backup = path.join(dir, 'encrypted.snapshot');
  const restore = path.join(dir, 'isolated.json');
  const document = {
    users: [{ id: 'secret-user', name: 'Sensitive Customer Name' }],
    course_packages: [{ id: 'pkg', paid_hours_left: 21.25 }],
    audit_logs: [{ id: 'log-1', operator_id: 'secret-user' }],
    __server_write_state: { version: 74, receipts: [
      { key: 'original-write-key', result: { accepted: true } }
    ] }
  };
  const original = Buffer.from(JSON.stringify(document, null, 2));
  fs.writeFileSync(db, original);
  function run(args, env = {}) {
    return spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8', timeout: 12000, env: { ...process.env, ...env, DB_FILE: db }
    });
  }
  const gen = () => run(['generate-key', '--out', key]);
  const encrypt = (out = backup) => run(['backup-encrypted','--key-file',key,'--out',out]);
  const verify = (file = backup, withKey = key) =>
    run(['verify-encrypted','--file',file,'--key-file',withKey]);
  const recover = (out = restore, withKey = key) =>
    run(['restore-encrypted-isolated','--file',backup,'--key-file',withKey,'--out',out]);
  try { handler({ dir, db, key, backup, restore, document, original, run, gen, encrypt, verify, recover }); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('AES-GCM encrypted snapshot verifies and restores original exact bytes, receipts and version', () => scenario(f => {
  assert.equal(f.gen().status, 0);
  assert.equal(fs.readFileSync(f.key).length, 32);
  const result = f.encrypt();
  assert.equal(result.status, 0, result.stderr);
  const snap = fs.readFileSync(f.backup, 'utf8');
  assert.doesNotMatch(snap, /Sensitive Customer Name|original-write-key|secret-user|paid_hours_left/);
  const metadata = JSON.parse(snap);
  assert.equal(metadata.format, 'edu-db-aes256gcm-v1');
  assert.equal(Object.hasOwn(metadata, 'version'), false);
  assert.equal(f.verify().status, 0);
  const recovered = f.recover();
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.deepEqual(fs.readFileSync(f.restore), f.original);
  assert.deepEqual(fs.readFileSync(f.db), f.original);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.restore)).__server_write_state, f.document.__server_write_state);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(f.key).mode & 0o777, 0o600);
    assert.equal(fs.statSync(f.backup).mode & 0o777, 0o600);
    assert.equal(fs.statSync(f.restore).mode & 0o777, 0o600);
  }
}));

test('new ciphertext and nonce are random for identical database contents', () => scenario(f => {
  assert.equal(f.gen().status, 0);
  assert.equal(f.encrypt().status, 0);
  const next = path.join(f.dir, 'second.snapshot');
  assert.equal(f.encrypt(next).status, 0);
  const first = JSON.parse(fs.readFileSync(f.backup));
  const second = JSON.parse(fs.readFileSync(next));
  assert.notEqual(first.nonce, second.nonce);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.equal(f.verify(next).status, 0);
}));

test('wrong key fails authentication and cannot create restored database', () => scenario(f => {
  assert.equal(f.gen().status, 0);
  assert.equal(f.encrypt().status, 0);
  const wrong = path.join(f.dir, 'other.key');
  const made = f.run(['generate-key', '--out', wrong]);
  assert.equal(made.status, 0);
  assert.notEqual(f.verify(f.backup, wrong).status, 0);
  assert.notEqual(f.recover(f.restore, wrong).status, 0);
  assert.equal(fs.existsSync(f.restore), false);
  assert.deepEqual(fs.readFileSync(f.db), f.original);
}));

test('tampering with ciphertext or authentication tag is detected before any restore', () => scenario(f => {
  assert.equal(f.gen().status, 0);
  assert.equal(f.encrypt().status, 0);
  const original = JSON.parse(fs.readFileSync(f.backup));
  for (const field of ['ciphertext','tag','nonce']) {
    const altered = { ...original };
    const b = Buffer.from(altered[field], 'base64');
    b[0] ^= 1;
    altered[field] = b.toString('base64');
    fs.writeFileSync(f.backup, JSON.stringify(altered));
    assert.notEqual(f.verify().status, 0, field);
    assert.notEqual(f.recover().status, 0, field);
    assert.equal(fs.existsSync(f.restore), false);
  }
  assert.deepEqual(fs.readFileSync(f.db), f.original);
}));

test('key symlinks, hardlinks, wrong key length and broad permissions are rejected', () => scenario(f => {
  assert.equal(f.gen().status, 0);
  const link = path.join(f.dir, 'linked-key');
  fs.symlinkSync(f.key, link);
  assert.notEqual(f.run(['backup-encrypted','--key-file',link,'--out',f.backup]).status, 0);
  const hardlink = path.join(f.dir, 'hardlinked-key');
  fs.linkSync(f.key, hardlink);
  assert.notEqual(f.encrypt().status, 0);
  fs.unlinkSync(hardlink);
  const short = path.join(f.dir, 'bad.key');
  fs.writeFileSync(short, crypto.randomBytes(16), { mode: 0o600 });
  assert.notEqual(f.run(['backup-encrypted','--key-file',short,'--out',f.backup]).status, 0);
  if (process.platform !== 'win32') {
    fs.chmodSync(f.key, 0o644);
    assert.notEqual(f.encrypt().status, 0);
  }
  assert.equal(fs.existsSync(f.backup), false);
}));

test('new-only output guards prevent overwriting keys, backups, recoveries or repository files', () => scenario(f => {
  assert.equal(f.gen().status, 0);
  assert.notEqual(f.gen().status, 0);
  const savedKey = fs.readFileSync(f.key);
  assert.equal(f.encrypt().status, 0);
  const savedSnapshot = fs.readFileSync(f.backup);
  assert.notEqual(f.encrypt().status, 0);
  assert.deepEqual(fs.readFileSync(f.backup), savedSnapshot);
  assert.equal(f.recover().status, 0);
  assert.notEqual(f.recover().status, 0);
  assert.deepEqual(fs.readFileSync(f.restore), f.original);
  const inRepo = path.join(ROOT, 'forbidden-encrypted-test.snapshot');
  assert.notEqual(f.run(['backup-encrypted','--key-file',f.key,'--out',inRepo]).status, 0);
  assert.equal(fs.existsSync(inRepo), false);
  assert.notEqual(f.run(['generate-key','--out',inRepo]).status, 0);
  assert.deepEqual(fs.readFileSync(f.key), savedKey);
}));

test('missing source or corrupt database aborts without creating encrypted snapshot', () => scenario(f => {
  assert.equal(f.gen().status, 0);
  fs.unlinkSync(f.db);
  assert.notEqual(f.encrypt().status, 0);
  assert.equal(fs.existsSync(f.backup), false);
  fs.writeFileSync(f.db, '{invalid JSON');
  assert.notEqual(f.encrypt().status, 0);
  assert.equal(fs.existsSync(f.backup), false);
  fs.writeFileSync(f.db, '{"users":[],"__server_write_state":{"version":-1,"receipts":[]}}');
  assert.notEqual(f.encrypt().status, 0);
  assert.equal(fs.existsSync(f.backup), false);
}));

test('plaintext v1 snapshots are not accepted by authenticated decrypt/restore commands', () => scenario(f => {
  assert.equal(f.gen().status, 0);
  fs.writeFileSync(f.backup, JSON.stringify({ format:'edu-db-snapshot-v1',
    version:74, database_base64:f.original.toString('base64'),
    sha256:crypto.createHash('sha256').update(f.original).digest('hex') }));
  assert.notEqual(f.verify().status, 0);
  assert.notEqual(f.recover().status, 0);
  assert.equal(fs.existsSync(f.restore), false);
}));

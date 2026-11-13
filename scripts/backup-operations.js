#!/usr/bin/env node
'use strict';

// Scheduler-ready offline backup runner. This module is inert until explicitly invoked.
// It never loads db.js, initializes a database, starts the server, or installs a timer.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CRYPTO_TOOL = path.join(__dirname, 'db-encrypted-backup.js');

function fail(message) { throw new Error(message); }
function insideRepo(file) {
  const rel = path.relative(ROOT, file);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}
function parseFlags(args, accepted) {
  if (args.length % 2 !== 0) fail('Expected --option value pairs');
  const parsed = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!accepted.includes(args[i]) || Object.hasOwn(parsed, args[i])) fail('Unexpected or repeated option');
    parsed[args[i]] = args[i + 1];
  }
  return parsed;
}
function absolute(filename, label) {
  if (!filename || !path.isAbsolute(filename)) fail(label + ' must be an absolute path');
  return path.resolve(filename);
}
function privateDirectory(filename, label) {
  const dir = absolute(filename, label);
  const info = fs.lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) fail(label + ' must be a real directory');
  const real = fs.realpathSync(dir);
  if (insideRepo(real)) fail(label + ' must be outside the repository');
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    fail(label + ' must be private (chmod 700)');
  }
  return real;
}
function keyPath(filename) {
  const key = absolute(filename, 'Key path');
  const info = fs.lstatSync(key);
  if (!info.isFile() || info.isSymbolicLink()) fail('Key must be a regular file');
  if (insideRepo(fs.realpathSync(key))) fail('Key must be outside the repository');
  // The encrypted tool also checks length, hard links, and key permissions.
  return key;
}
function runCrypto(args) {
  const proc = spawnSync(process.execPath, [CRYPTO_TOOL, ...args], {
    encoding: 'utf8', timeout: 600000, maxBuffer: 1024 * 1024
  });
  if (proc.error || proc.status !== 0) fail('Encrypted backup tool rejected the operation');
  const match = (proc.stdout || '').match(/Version=(\d+)/);
  return match ? Number(match[1]) : null;
}
function writeStatus(dir, filename, status) {
  const dest = path.join(dir, filename);
  const temp = path.join(dir, '.' + filename + '-' + crypto.randomBytes(8).toString('hex') + '.tmp');
  let created = false;
  try {
    fs.writeFileSync(temp, JSON.stringify(status) + '\n', { flag: 'wx', mode: 0o600 });
    created = true;
    const fd = fs.openSync(temp, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, dest);
    created = false;
  } finally {
    if (created) { try { fs.unlinkSync(temp); } catch (_) {} }
  }
}
function withLock(dir, operation) {
  const lock = path.join(dir, 'backup-ops.lock');
  let fd;
  try {
    fd = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT |
      fs.constants.O_EXCL, 0o600);
    fs.writeSync(fd, String(process.pid) + '\n');
  } catch (_) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
    fail('Backup job lock exists or cannot be created; check for an active job');
  }
  try { return operation(); }
  finally {
    fs.closeSync(fd);
    // Only this process created the lock. A crashed process may leave a stale lock,
    // which must be inspected manually rather than automatically bypassed.
    fs.unlinkSync(lock);
  }
}
function incident(dir, action, stage) {
  const alert = { status: 'attention-required', action, stage, at: new Date().toISOString() };
  writeStatus(dir, 'attention-required.json', alert);
}
function backup(opts) {
  let statusDir = null;
  let pending = null;
  let stage = 'preflight';
  try {
    const db = absolute(opts['--db'], 'Database');
    const key = keyPath(opts['--key-file']);
    const backupDir = privateDirectory(opts['--backup-dir'], 'Backup directory');
    statusDir = privateDirectory(opts['--status-dir'], 'Status directory');
    if (backupDir === statusDir) fail('Backup and status directories must be different');
    return withLock(statusDir, () => {
      const suffix = new Date().toISOString().replace(/[:.]/g, '-') +
        '-' + crypto.randomBytes(8).toString('hex');
      const basename = 'edu-db-' + suffix + '.enc';
      const completed = path.join(backupDir, basename);
      pending = completed + '.pending';
      stage = 'encrypt';
      try {
        runCrypto(['backup-encrypted', '--db', db, '--key-file', key, '--out', pending]);
        stage = 'verify';
        const version = runCrypto(['verify-encrypted', '--file', pending, '--key-file', key]);
        stage = 'publish';
        // linkSync fails if the final name already exists, preventing overwrite races.
        fs.linkSync(pending, completed);
        fs.unlinkSync(pending);
        pending = null;
        stage = 'status';
        writeStatus(statusDir, 'last-backup.json', {
          status: 'success', action: 'backup', at: new Date().toISOString(),
          backup: basename, version
        });
        process.stdout.write('Encrypted backup verified: ' + basename + '\n');
      } finally {
        // A failed/unverified candidate must never be mistaken for a valid .enc file.
        if (pending) { try { fs.unlinkSync(pending); } catch (_) {} }
      }
    });
  } catch (_) {
    if (statusDir) {
      try { incident(statusDir, 'backup', stage); }
      catch (_) { process.stderr.write('CRITICAL: could not write backup alert status\n'); }
    }
    process.stderr.write('BACKUP FAILURE at ' + stage + '\n');
    process.exitCode = 1;
  }
}
function drill(opts) {
  let statusDir = null;
  let temporary = null;
  let stage = 'preflight';
  try {
    const encrypted = absolute(opts['--file'], 'Backup');
    const key = keyPath(opts['--key-file']);
    const dir = privateDirectory(opts['--drill-dir'], 'Drill directory');
    statusDir = privateDirectory(opts['--status-dir'], 'Status directory');
    if (dir === statusDir) fail('Drill and status directories must be different');
    return withLock(statusDir, () => {
      temporary = path.join(dir, '.isolated-restore-' + crypto.randomBytes(12).toString('hex') + '.json');
      try {
        stage = 'authenticate';
        runCrypto(['verify-encrypted', '--file', encrypted, '--key-file', key]);
        stage = 'restore';
        const version = runCrypto(['restore-encrypted-isolated', '--file', encrypted,
          '--key-file', key, '--out', temporary]);
        stage = 'inspect';
        const raw = fs.readFileSync(temporary, 'utf8');
        const db = JSON.parse(raw);
        if (!db || Array.isArray(db) || typeof db !== 'object') fail('Restored root invalid');
        if (!Array.isArray(db.users) || !Array.isArray(db.audit_logs) ||
            !Array.isArray(db.course_packages)) fail('Restored key tables missing');
        if (db.__server_write_state &&
            !Array.isArray(db.__server_write_state.receipts)) fail('Restored receipts invalid');
        stage = 'cleanup';
        fs.unlinkSync(temporary);
        temporary = null;
        stage = 'status';
        writeStatus(statusDir, 'last-drill.json', {
          status: 'success', action: 'drill', at: new Date().toISOString(), version
        });
        process.stdout.write('Isolated encrypted recovery drill passed\n');
      } finally {
        // On filesystems without secure deletion, the drill directory MUST
        // be an encrypted, owner-only volume. No decrypted output is retained.
        if (temporary) { try { fs.unlinkSync(temporary); } catch (_) {} }
      }
    });
  } catch (_) {
    if (statusDir) {
      try { incident(statusDir, 'drill', stage); }
      catch (_) { process.stderr.write('CRITICAL: could not write recovery alert status\n'); }
    }
    process.stderr.write('RECOVERY DRILL FAILURE at ' + stage + '\n');
    process.exitCode = 1;
  }
}
function maxHours(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 8760) fail(label + ' must be 1..8760 hours');
  return number;
}
function check(opts) {
  try {
    const dir = privateDirectory(opts['--status-dir'], 'Status directory');
    // Persistent incidents require an operator to inspect and acknowledge them.
    if (fs.existsSync(path.join(dir, 'attention-required.json'))) fail('An unacknowledged incident exists');
    const now = Date.now();
    for (const [file, limit] of [
      ['last-backup.json', maxHours(opts['--max-age-hours'], 'Backup age')],
      ...(opts['--max-drill-age-hours'] === undefined ? [] :
        [['last-drill.json', maxHours(opts['--max-drill-age-hours'], 'Drill age')]])
    ]) {
      const item = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      const elapsed = now - Date.parse(item.at);
      if (item.status !== 'success' || !Number.isFinite(elapsed) ||
          elapsed < 0 || elapsed > limit * 3600000) fail('Backup or drill status is stale or invalid');
    }
    process.stdout.write('Backup monitoring check passed\n');
  } catch (_) {
    process.stderr.write('BACKUP MONITOR ALERT: status missing, stale or unresolved incident\n');
    process.exitCode = 1;
  }
}
const [command, ...argv] = process.argv.slice(2);
try {
  if (command === 'run') backup(parseFlags(argv,
    ['--db', '--key-file', '--backup-dir', '--status-dir']));
  else if (command === 'drill') drill(parseFlags(argv,
    ['--file', '--key-file', '--drill-dir', '--status-dir']));
  else if (command === 'check') check(parseFlags(argv,
    ['--status-dir', '--max-age-hours', '--max-drill-age-hours']));
  else fail('Usage: run --db ABS --key-file ABS --backup-dir ABS --status-dir ABS | drill --file ABS --key-file ABS --drill-dir ABS --status-dir ABS | check --status-dir ABS --max-age-hours NUMBER [--max-drill-age-hours NUMBER]');
} catch (_) {
  process.stderr.write('Invalid backup job arguments\n');
  process.exitCode = 1;
}

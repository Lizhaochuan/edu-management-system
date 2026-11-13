#!/usr/bin/env node
'use strict';

// Offline disaster-recovery helper. Never starts the server or initializes a database.
// A backup is a complete, checksummed snapshot of ONE atomic JSON database file.
// Credentials and external payment evidence are NOT part of this snapshot.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const FORMAT = 'edu-db-snapshot-v1';
const DEFAULT_DB = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(ROOT, 'data', 'db.json');

function fail(message) { throw new Error(message); }
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function withinRepo(filename) {
  const rel = path.relative(ROOT, filename);
  return !rel || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

function options(args, permitted) {
  const flags = {};
  if (args.length % 2) fail('Use pairs of --flag /absolute/path arguments');
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    if (!permitted.includes(flag) || flags[flag] !== undefined) fail('Invalid or repeated argument: ' + flag);
    if (!path.isAbsolute(args[i + 1])) fail(flag + ' must be an absolute path');
    flags[flag] = args[i + 1];
  }
  return flags;
}

function validateDatabase(bytes) {
  let data;
  try { data = JSON.parse(bytes.toString('utf8')); }
  catch (_) { fail('Database is not valid JSON; backup/restore refused'); }
  if (!data || Array.isArray(data) || typeof data !== 'object') fail('Database root must be an object');
  const state = data.__server_write_state;
  if (state !== undefined &&
      (!state || !Number.isSafeInteger(state.version) || state.version < 0 ||
       !Array.isArray(state.receipts))) fail('Invalid server write metadata; refused');
  return state ? state.version : 0;
}

function readRegularFile(filename) {
  const stat = fs.lstatSync(filename); // Symlinks are not allowed as source files.
  if (!stat.isFile() || stat.isSymbolicLink()) fail('Input must be a regular file, not a symlink');
  return fs.readFileSync(filename);
}

function targetPath(filename) {
  if (!path.isAbsolute(filename)) fail('Output must be an absolute path');
  const resolved = path.resolve(filename);
  // All output is deliberately outside this checkout, including untracked files.
  const parent = fs.realpathSync(path.dirname(resolved));
  if (withinRepo(parent)) fail('Output must be outside the Git repository');
  const finalPath = path.join(parent, path.basename(resolved));
  if (finalPath === DEFAULT_DB) fail('Never overwrite the current DB_FILE');
  return finalPath;
}

function writeNew(filename, bytes) {
  let fd;
  let created = false;
  try {
    fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    created = true;
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
  } catch (error) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
    if (created) { try { fs.unlinkSync(filename); } catch (_) {} }
    throw error;
  }
}

function decodeSnapshot(filename) {
  const bytes = readRegularFile(filename);
  let envelope;
  try { envelope = JSON.parse(bytes.toString('utf8')); }
  catch (_) { fail('Invalid backup envelope JSON'); }
  if (!envelope || envelope.format !== FORMAT ||
      typeof envelope.database_base64 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(envelope.sha256 || '')) fail('Unknown or incomplete backup envelope');
  const raw = Buffer.from(envelope.database_base64, 'base64');
  if (raw.toString('base64') !== envelope.database_base64 || sha256(raw) !== envelope.sha256) {
    fail('Backup checksum mismatch; refusing recovery');
  }
  const version = validateDatabase(raw);
  if (envelope.version !== version) fail('Backup metadata version mismatch');
  return { raw, version, sha256: envelope.sha256 };
}

function main() {
  const [operation, ...args] = process.argv.slice(2);
  if (operation === 'backup') {
    const flags = options(args, ['--db', '--out']);
    if (!flags['--out']) fail('backup requires --out');
    const source = flags['--db'] ? path.resolve(flags['--db']) : DEFAULT_DB;
    const raw = readRegularFile(source);
    const version = validateDatabase(raw);
    const envelope = {
      format: FORMAT,
      created_at: new Date().toISOString(),
      version,
      sha256: sha256(raw),
      database_base64: raw.toString('base64')
    };
    writeNew(targetPath(flags['--out']), Buffer.from(JSON.stringify(envelope) + '\n'));
    console.log('Backup created; version=' + version + ', sha256=' + envelope.sha256);
  } else if (operation === 'verify') {
    const flags = options(args, ['--file']);
    if (!flags['--file']) fail('verify requires --file');
    const snapshot = decodeSnapshot(flags['--file']);
    console.log('Backup verified; version=' + snapshot.version + ', sha256=' + snapshot.sha256);
  } else if (operation === 'restore-isolated') {
    const flags = options(args, ['--file', '--out']);
    if (!flags['--file'] || !flags['--out']) fail('restore-isolated requires --file and --out');
    const snapshot = decodeSnapshot(flags['--file']);
    // Never replace an existing database. Restore to a NEW separate path for validation.
    writeNew(targetPath(flags['--out']), snapshot.raw);
    console.log('Isolated restore written and verified; version=' + snapshot.version);
  } else {
    fail('Usage: backup --out /absolute/backup.json [--db /absolute/db.json] | verify --file /absolute/backup.json | restore-isolated --file /absolute/backup.json --out /absolute/new-db.json');
  }
}

try { main(); }
catch (error) { console.error('Recovery operation refused: ' + error.message); process.exitCode = 1; }

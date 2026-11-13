#!/usr/bin/env node
'use strict';

// Standalone, fail-closed encrypted snapshot tool. Does not import db.js,
// start a server, initialize seed data, or alter an existing database.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const FORMAT = 'edu-db-aes256gcm-v1';
const AAD = Buffer.from(FORMAT, 'utf8');
const DEFAULT_DB = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(ROOT, 'data', 'db.json');

function fail(message) { throw new Error(message); }
function inRepo(filename) {
  const relative = path.relative(ROOT, filename);
  return relative === '' || (relative !== '..' &&
    !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
function flags(args, allowed) {
  if (args.length % 2) fail('Arguments must be --flag /absolute/path pairs');
  const found = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i], value = args[i + 1];
    if (!allowed.includes(name) || Object.hasOwn(found, name)) fail('Unsupported or duplicate argument');
    if (!value || !path.isAbsolute(value)) fail(name + ' requires an absolute path');
    found[name] = value;
  }
  return found;
}
function readRegular(filename, label) {
  // A symlink could redirect a supposedly private key or backup unexpectedly.
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(label + ' must be a regular file, not a link');
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try { return { bytes: fs.readFileSync(fd), stat: fs.fstatSync(fd) }; }
  finally { fs.closeSync(fd); }
}
function readKey(filename) {
  const { bytes, stat } = readRegular(filename, 'Key');
  if (bytes.length !== 32) fail('Key must contain exactly 32 random bytes');
  if (stat.nlink !== 1) fail('Key must not have hard links');
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    fail('Key permissions are too broad; require mode 0600');
  }
  return bytes;
}
function validateDb(bytes) {
  let data;
  try { data = JSON.parse(bytes.toString('utf8')); }
  catch (_) { fail('Database is not valid JSON'); }
  if (!data || Array.isArray(data) || typeof data !== 'object') fail('Database must have an object root');
  const state = data.__server_write_state;
  if (state !== undefined && (!state || !Number.isSafeInteger(state.version) ||
    state.version < 0 || !Array.isArray(state.receipts))) fail('Invalid write version or receipts');
  return state ? state.version : 0;
}
function outputPath(filename) {
  const resolved = path.resolve(filename);
  const parent = fs.realpathSync(path.dirname(resolved));
  if (inRepo(parent)) fail('Output must be outside the repository');
  return path.join(parent, path.basename(resolved));
}
function writeNew(filename, bytes) {
  const dest = outputPath(filename);
  let fd, created = false;
  try {
    fd = fs.openSync(dest, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW || 0), 0o600);
    created = true;
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
  } catch (error) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
    if (created) { try { fs.unlinkSync(dest); } catch (_) {} }
    throw error;
  }
}
function decode64(value, length, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    fail('Invalid encrypted ' + name);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (length && bytes.length !== length)) {
    fail('Invalid encrypted ' + name);
  }
  return bytes;
}
function decrypt(filename, key) {
  const { bytes } = readRegular(filename, 'Encrypted backup');
  let envelope;
  try { envelope = JSON.parse(bytes.toString('utf8')); }
  catch (_) { fail('Backup envelope is invalid JSON'); }
  if (!envelope || envelope.format !== FORMAT ||
    Object.keys(envelope).sort().join(',') !== 'ciphertext,format,nonce,tag') {
    fail('Unknown encrypted backup format');
  }
  const iv = decode64(envelope.nonce, 12, 'nonce');
  const tag = decode64(envelope.tag, 16, 'tag');
  const ciphertext = decode64(envelope.ciphertext, undefined, 'payload');
  let clear;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    clear = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (_) { fail('Authentication failed: wrong key or modified backup'); }
  return { raw: clear, version: validateDb(clear) };
}
function main() {
  const [op, ...args] = process.argv.slice(2);
  if (op === 'generate-key') {
    const f = flags(args, ['--out']);
    if (!f['--out']) fail('generate-key requires --out');
    writeNew(f['--out'], crypto.randomBytes(32));
    console.log('Private recovery key created. Store a separate offline copy securely.');
  } else if (op === 'backup-encrypted') {
    const f = flags(args, ['--db', '--key-file', '--out']);
    if (!f['--key-file'] || !f['--out']) fail('backup-encrypted requires --key-file and --out');
    const key = readKey(f['--key-file']);
    const { bytes: raw } = readRegular(f['--db'] || DEFAULT_DB, 'Database');
    const version = validateDb(raw);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(raw), cipher.final()]);
    const snapshot = { format: FORMAT, nonce: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
    writeNew(f['--out'], Buffer.from(JSON.stringify(snapshot) + '\n'));
    console.log('Encrypted backup created. Version=' + version);
  } else if (op === 'verify-encrypted') {
    const f = flags(args, ['--file', '--key-file']);
    if (!f['--file'] || !f['--key-file']) fail('verify-encrypted requires --file and --key-file');
    const recovered = decrypt(f['--file'], readKey(f['--key-file']));
    console.log('Authenticated encrypted backup verified. Version=' + recovered.version);
  } else if (op === 'restore-encrypted-isolated') {
    const f = flags(args, ['--file', '--key-file', '--out']);
    if (!f['--file'] || !f['--key-file'] || !f['--out']) {
      fail('restore-encrypted-isolated requires --file, --key-file and --out');
    }
    const recovered = decrypt(f['--file'], readKey(f['--key-file']));
    // Exclusive new-file creation: never replace a live database or a previous recovery.
    writeNew(f['--out'], recovered.raw);
    console.log('Authenticated isolated restore created. Version=' + recovered.version);
  } else {
    fail('Usage: generate-key --out /outside/key.bin | backup-encrypted --key-file /outside/key.bin --out /outside/backup.enc [--db /absolute/db.json] | verify-encrypted --file /outside/backup.enc --key-file /outside/key.bin | restore-encrypted-isolated --file /outside/backup.enc --key-file /outside/key.bin --out /outside/new-db.json');
  }
}
try { main(); }
catch (error) { console.error('Encrypted backup refused: ' + error.message); process.exitCode = 1; }

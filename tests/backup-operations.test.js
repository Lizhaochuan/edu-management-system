'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const OPS = path.resolve(__dirname, '../scripts/backup-operations.js');
const ENCRYPT = path.resolve(__dirname, '../scripts/db-encrypted-backup.js');

function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'edu-backup-ops-test-'));
  const backups = path.join(root, 'backups');
  const status = path.join(root, 'status');
  const drills = path.join(root, 'drills');
  for (const dir of [backups, status, drills]) fs.mkdirSync(dir, { mode: 0o700 });
  const key = path.join(root, 'secret.key');
  const db = path.join(root, 'data.json');
  const records = {
    users: [{ id:'test-user', name:'Sensitive Test Student' }],
    course_packages: [{ id:'pkg-1', paid_hours_left:23 }],
    audit_logs: [{ id:'audit-test' }],
    __server_write_state: { version:88, receipts: [{ idempotencyKey:'already-completed' }] }
  };
  const raw = Buffer.from(JSON.stringify(records));
  fs.writeFileSync(db, raw);
  function exec(script, args) {
    return spawnSync(process.execPath, [script, ...args], {
      encoding:'utf8', timeout:20000, env:{...process.env,DB_FILE:db}
    });
  }
  function cmd(...args) { return exec(OPS, args); }
  function run(dbFile = db, privateKey = key) {
    return cmd('run', '--db', dbFile, '--key-file', privateKey,
      '--backup-dir', backups, '--status-dir', status);
  }
  function snapshotFile() {
    const snapshots = fs.readdirSync(backups).filter(name => name.endsWith('.enc'));
    assert.equal(snapshots.length, 1);
    return path.join(backups, snapshots[0]);
  }
  function drill(file = snapshotFile(), privateKey = key) {
    return cmd('drill', '--file', file, '--key-file', privateKey,
      '--drill-dir', drills, '--status-dir', status);
  }
  function check(more = []) {
    return cmd('check', '--status-dir', status, '--max-age-hours', '24', ...more);
  }
  try {
    const generated = exec(ENCRYPT, ['generate-key', '--out', key]);
    assert.equal(generated.status,0,generated.stderr);
    fn({root,backups,status,drills,key,db,records,raw,cmd,run,snapshotFile,drill,check,exec});
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
}

test('scheduled run produces one authenticated encrypted backup and a fresh success status',()=>fixture(f=>{
  const result=f.run();
  assert.equal(result.status,0,result.stderr);
  const file=f.snapshotFile();
  const envelope=JSON.parse(fs.readFileSync(file));
  assert.equal(envelope.format,'edu-db-aes256gcm-v1');
  assert.doesNotMatch(fs.readFileSync(file,'utf8'),/Sensitive Test Student|already-completed/);
  const report=JSON.parse(fs.readFileSync(path.join(f.status,'last-backup.json')));
  assert.equal(report.status,'success');
  assert.equal(report.version,88);
  assert.equal(report.backup,path.basename(file));
  assert.equal(f.check().status,0);
  assert.deepEqual(fs.readFileSync(f.db),f.raw);
  assert.deepEqual(fs.readdirSync(f.backups),[path.basename(file)]);
}));

test('repeated runs use independent filenames and never overwrite earlier backups',()=>fixture(f=>{
  assert.equal(f.run().status,0);
  const first=f.snapshotFile();
  const original=fs.readFileSync(first);
  assert.equal(f.run().status,0);
  const files=fs.readdirSync(f.backups).filter(x=>x.endsWith('.enc'));
  assert.equal(files.length,2);
  assert.deepEqual(fs.readFileSync(first),original);
  assert.notEqual(files[0],files[1]);
  assert.equal(f.check().status,0);
}));

test('failed backup produces a persistent incident and does not publish incomplete encrypted files',()=>fixture(f=>{
  const missing=path.join(f.root,'nonexistent-db.json');
  const failed=f.run(missing);
  assert.notEqual(failed.status,0);
  assert.equal(fs.readdirSync(f.backups).length,0);
  const incident=JSON.parse(fs.readFileSync(path.join(f.status,'attention-required.json')));
  assert.equal(incident.status,'attention-required');
  assert.equal(incident.action,'backup');
  assert.equal(f.check().status,1);
  assert.deepEqual(fs.readFileSync(f.db),f.raw);
  assert.equal(f.run().status,0);
  assert.equal(f.check().status,1,'successful retry must not silently dismiss incident');
  fs.unlinkSync(path.join(f.status,'attention-required.json')); // Simulated operator acknowledgment.
  assert.equal(f.check().status,0);
}));

test('isolated recovery drill authenticates, inspects and removes temporary plaintext',()=>fixture(f=>{
  assert.equal(f.run().status,0);
  const original=fs.readFileSync(f.db);
  const result=f.drill();
  assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(fs.readFileSync(path.join(f.status,'last-drill.json')));
  assert.equal(report.status,'success');
  assert.equal(report.version,88);
  assert.deepEqual(fs.readdirSync(f.drills),[]);
  assert.deepEqual(fs.readFileSync(f.db),original);
  assert.equal(f.check(['--max-drill-age-hours','720']).status,0);
}));

test('wrong key aborts drill and leaves no restored plaintext file',()=>fixture(f=>{
  assert.equal(f.run().status,0);
  const wrong=path.join(f.root,'incorrect.key');
  assert.equal(f.exec(ENCRYPT,['generate-key','--out',wrong]).status,0);
  const fail=f.drill(f.snapshotFile(),wrong);
  assert.notEqual(fail.status,0);
  assert.deepEqual(fs.readdirSync(f.drills),[]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.status,'attention-required.json'))).action,'drill');
  assert.equal(f.check().status,1);
}));

test('stale or missing status and missing drill reports fail monitoring checks',()=>fixture(f=>{
  assert.equal(f.check().status,1);
  assert.equal(f.run().status,0);
  assert.equal(f.check(['--max-drill-age-hours','720']).status,1);
  const reportPath=path.join(f.status,'last-backup.json');
  const report=JSON.parse(fs.readFileSync(reportPath));
  report.at='2020-01-01T00:00:00.000Z';
  fs.writeFileSync(reportPath,JSON.stringify(report));
  assert.equal(f.check().status,1);
  assert.equal(f.check(['--max-age-hours','0']).status,1);
}));

test('existing job lock forbids concurrent runs without changing source database',()=>fixture(f=>{
  const lock=path.join(f.status,'backup-ops.lock');
  fs.writeFileSync(lock,'existing-operation\n',{flag:'wx',mode:0o600});
  const result=f.run();
  assert.notEqual(result.status,0);
  assert.deepEqual(fs.readFileSync(f.db),f.raw);
  assert.equal(fs.readdirSync(f.backups).length,0);
  assert.equal(fs.readFileSync(lock,'utf8'),'existing-operation\n');
  assert.equal(f.check().status,1);
}));

test('insecure backup directory and output in Git checkout are rejected',()=>fixture(f=>{
  if (process.platform !== 'win32') {
    fs.chmodSync(f.backups,0o755);
    assert.notEqual(f.run().status,0);
    assert.deepEqual(fs.readdirSync(f.backups),[]);
  }
  const inRepo=path.resolve(__dirname,'..');
  assert.notEqual(f.cmd('run','--db',f.db,'--key-file',f.key,
    '--backup-dir',inRepo,'--status-dir',f.status).status,0);
  assert.deepEqual(fs.readFileSync(f.db),f.raw);
}));

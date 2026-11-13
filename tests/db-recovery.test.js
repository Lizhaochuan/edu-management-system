'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const script = path.resolve(__dirname, '../scripts/db-recovery.js');
const repoRoot = path.resolve(__dirname, '..');

function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'edu-recovery-test-'));
  const db = path.join(root, 'active-db.json');
  const backup = path.join(root, 'snapshot.json');
  const restored = path.join(root, 'recovered.json');
  const records = { users: [{id:'test-user',role:'super_admin',status:'active'}],
    course_packages: [{id:'pkg_test', paid_hours_left:17.5}],
    approval_requests: [{id:'approval_test',status:'pending'}],
    audit_logs: [{id:'audit_test',action:'UPDATE'}],
    __server_write_state: {version:42,receipts:[{key:'original-key',result:{accepted:true}}]} };
  const original = Buffer.from(JSON.stringify(records, null, 2));
  fs.writeFileSync(db, original);
  const invoke = (args, extraEnv = {}) => spawnSync(process.execPath,[script,...args], {
    encoding:'utf8', timeout:10000, env:{...process.env,DB_FILE:db,...extraEnv}
  });
  try { fn({root,db,backup,restored,records,original,invoke}); }
  finally { fs.rmSync(root,{recursive:true,force:true}); }
}

test('offline snapshot, checksum verification, and isolated restoration preserve bytes and write receipts',()=>{
  fixture(f=>{
    const before = fs.readFileSync(f.db);
    const backup = f.invoke(['backup','--out',f.backup]);
    assert.equal(backup.status,0,backup.stderr);
    const envelope = JSON.parse(fs.readFileSync(f.backup,'utf8'));
    assert.equal(envelope.format,'edu-db-snapshot-v1');
    assert.equal(envelope.version,42);
    assert.ok(/^[a-f0-9]{64}$/.test(envelope.sha256));
    assert.equal(f.invoke(['verify','--file',f.backup]).status,0);
    const recover = f.invoke(['restore-isolated','--file',f.backup,'--out',f.restored]);
    assert.equal(recover.status,0,recover.stderr);
    assert.deepEqual(fs.readFileSync(f.restored),before);
    assert.deepEqual(fs.readFileSync(f.db),before);
    const loaded = JSON.parse(fs.readFileSync(f.restored,'utf8'));
    assert.deepEqual(loaded.__server_write_state.receipts,f.records.__server_write_state.receipts);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(f.backup).mode & 0o777,0o600);
      assert.equal(fs.statSync(f.restored).mode & 0o777,0o600);
    }
  });
});

test('backup never overwrites existing files or initializes absent source database',()=>{
  fixture(f=>{
    assert.equal(f.invoke(['backup','--out',f.backup]).status,0);
    const originalBackup=fs.readFileSync(f.backup);
    assert.notEqual(f.invoke(['backup','--out',f.backup]).status,0);
    assert.deepEqual(fs.readFileSync(f.backup),originalBackup);
    fs.writeFileSync(f.restored,'do not change');
    assert.notEqual(f.invoke(['restore-isolated','--file',f.backup,'--out',f.restored]).status,0);
    assert.equal(fs.readFileSync(f.restored,'utf8'),'do not change');
    const missing=path.join(f.root,'missing-db.json');
    assert.notEqual(f.invoke(['backup','--db',missing,'--out',path.join(f.root,'absent.json')]).status,0);
    assert.equal(fs.existsSync(missing),false);
  });
});

test('corrupt or modified snapshots fail checksum verification and cannot be restored',()=>{
  fixture(f=>{
    assert.equal(f.invoke(['backup','--out',f.backup]).status,0);
    const snap = JSON.parse(fs.readFileSync(f.backup,'utf8'));
    snap.database_base64 = Buffer.from('{"users":[]}').toString('base64');
    fs.writeFileSync(f.backup,JSON.stringify(snap));
    assert.notEqual(f.invoke(['verify','--file',f.backup]).status,0);
    assert.notEqual(f.invoke(['restore-isolated','--file',f.backup,'--out',f.restored]).status,0);
    assert.equal(fs.existsSync(f.restored),false);
    assert.deepEqual(fs.readFileSync(f.db),f.original);
  });
});

test('malformed source metadata is refused without writing a backup',()=>{
  fixture(f=>{
    fs.writeFileSync(f.db,'{"users":[],"__server_write_state":{"version":-1,"receipts":[]}}');
    const result=f.invoke(['backup','--out',f.backup]);
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/metadata/);
    assert.equal(fs.existsSync(f.backup),false);
  });
});

test('older JSON database without version metadata can still be backed up intact',()=>{
  fixture(f=>{
    const legacy=Buffer.from('{"users":[{"id":"old"}],"audit_logs":[]}');
    fs.writeFileSync(f.db,legacy);
    assert.equal(f.invoke(['backup','--out',f.backup]).status,0);
    assert.equal(JSON.parse(fs.readFileSync(f.backup)).version,0);
    assert.equal(f.invoke(['restore-isolated','--file',f.backup,'--out',f.restored]).status,0);
    assert.deepEqual(fs.readFileSync(f.restored),legacy);
  });
});

test('backup outputs cannot be created inside source repository or via relative path',()=>{
  fixture(f=>{
    const inside=path.join(repoRoot,'should-never-create-backup.json');
    const r1=f.invoke(['backup','--out',inside]);
    assert.notEqual(r1.status,0);
    assert.match(r1.stderr,/outside the Git repository/);
    assert.equal(fs.existsSync(inside),false);
    const r2=f.invoke(['backup','--out','relative.json']);
    assert.notEqual(r2.status,0);
    assert.equal(fs.existsSync(path.join(repoRoot,'relative.json')),false);
    assert.deepEqual(fs.readFileSync(f.db),f.original);
  });
});

test('symlink database source is refused; no snapshot created',()=>{
  fixture(f=>{
    const link=path.join(f.root,'linked-db.json');
    fs.symlinkSync(f.db,link);
    const result=f.invoke(['backup','--db',link,'--out',f.backup]);
    assert.notEqual(result.status,0);
    assert.equal(fs.existsSync(f.backup),false);
  });
});

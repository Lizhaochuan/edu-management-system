'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const vm=require('node:vm');
const repo=path.resolve(__dirname,'..');

test('DB_FILE routes persisted writes outside the watched project and leaves the default database unchanged',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'edu-db-path-'));
 try {
  fs.cpSync(path.join(repo,'services'),path.join(root,'services'),{recursive:true});
  fs.mkdirSync(path.join(root,'data'));
  const original='{"users":[],"sentinel":[{"id":"keep"}]}';
  const defaultFile=path.join(root,'data/db.json');fs.writeFileSync(defaultFile,original);
  const externalFile=path.join(root,'external-test-data/db.json');
  const env={...process.env,DB_FILE:externalFile};delete env.AUTH_CREDENTIALS_FILE;
  const child=code=>{const r=spawnSync(process.execPath,['-e',code],{cwd:root,env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim()};
  child("const db=require('./services/db');db.initDatabase();db.update(db.TABLES.STUDENTS,'stu_1',{name:'External test name'});");
  assert.equal(fs.readFileSync(defaultFile,'utf8'),original);
  assert.equal(JSON.parse(fs.readFileSync(externalFile)).students[0].name,'External test name');
  assert.equal(child("const db=require('./services/db');db.initDatabase();console.log(db.getById(db.TABLES.STUDENTS,'stu_1').name)"),'External test name');
  delete env.DB_FILE;
  assert.equal(child("const db=require('./services/db');db.initDatabase();console.log(db.dumpAll().sentinel[0].id)"),'keep');
 } finally {fs.rmSync(root,{recursive:true,force:true})}
});

test('WXML expressions contain operators rather than escaped HTML entities that break the compiler',()=>{
 function inspect(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
  const file=path.join(dir,entry.name);
  if(entry.isDirectory())inspect(file);
  else if(file.endsWith('.wxml')) {
   for(const match of fs.readFileSync(file,'utf8').matchAll(/\{\{([\s\S]*?)\}\}/g)) assert.doesNotMatch(match[1],/&(?:amp|lt|gt);/,file);
  }
 }}
 inspect(path.join(repo,'pages'));inspect(path.join(repo,'components'));
});

test('configuration modal taps resolve to an existing harmless handler',()=>{
 let page;
 vm.runInNewContext(fs.readFileSync(path.join(repo,'pages/config-settings/index.js'),'utf8'),{require:()=>({}),Page:value=>{page=value}});
 const markup=fs.readFileSync(path.join(repo,'pages/config-settings/index.wxml'),'utf8');
 const handlers=[...markup.matchAll(/class="modal-box"\s+catchtap="([^"]+)"/g)];
 assert.ok(handlers.length>0);
 for(const match of handlers){assert.equal(typeof page[match[1]],'function');assert.equal(page[match[1]](),undefined)}
});

test('all modal event handlers resolve on their page instead of referring to a boolean name',()=>{
 for(const dir of fs.readdirSync(path.join(repo,'pages'))){
  const pageRoot=path.join(repo,'pages',dir);const markupFile=path.join(pageRoot,'index.wxml');
  if(!fs.existsSync(markupFile))continue;
  const markup=fs.readFileSync(markupFile,'utf8');const handlers=[...markup.matchAll(/catchtap="(true|noOp)"/g)];
  if(!handlers.length)continue;
  let page;
  vm.runInNewContext(fs.readFileSync(path.join(pageRoot,'index.js'),'utf8'),{require:()=>({}),Page:value=>{page=value}});
  for(const match of handlers){assert.equal(typeof page[match[1]],'function',dir);assert.equal(page[match[1]](),undefined)}
 }
});

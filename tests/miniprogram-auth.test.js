'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname,'..');

test('WeChat app starts on authenticated login, not demo workbench', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root,'app.json'),'utf8'));
  assert.equal(manifest.pages[0],'pages/login/index');
  const launch = fs.readFileSync(path.join(root,'app.js'),'utf8');
  assert.ok(!launch.includes("users.find(u => u.role === 'super_admin')"));
  assert.match(launch, /auth_token/);
  assert.match(launch, /\/api\/auth\/me/);
});

test('mock role switcher is not rendered on any business page', () => {
  const pages = path.join(root,'pages');
  for (const dir of fs.readdirSync(pages)) {
    const file = path.join(pages,dir,'index.wxml');
    if (!fs.existsSync(file)) continue;
    assert.doesNotMatch(fs.readFileSync(file,'utf8'),
      /<role-switcher\b/, 'role impersonation widget in '+dir);
  }
});

test('mini-program database API requests require Bearer and cannot auto-sync by default', () => {
  const source = fs.readFileSync(path.join(root,'services','db.js'),'utf8');
  assert.match(source,/Authorization: 'Bearer ' \+ token/);
  assert.match(source,/Authorization: 'Bearer ' \+ _getBearerToken\(\)/);
  assert.match(source,/sync_mode.*legacy_dev/);
  assert.doesNotMatch(source,/return \{ id: 'u_sa1', name: '系统管理员'/);
});

test('phone claim cannot grant new role without actual credentials', () => {
  const index = fs.readFileSync(path.join(root,'pages','index','index.js'),'utf8');
  assert.doesNotMatch(index,/wx\.setStorageSync\('current_user', matched\)/);
  assert.doesNotMatch(index,/currentUser = firstAdmin/);
});

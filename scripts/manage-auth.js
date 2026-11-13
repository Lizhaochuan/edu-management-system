#!/usr/bin/env node
'use strict';
// Usage: node scripts/manage-auth.js set <user_id>
// Credentials are written outside the Git repository's tracked paths.
const readline = require('node:readline');
const db = require('../services/db');
const auth = require('../services/authService');

function readSecret(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || !process.stdin.setRawMode) {
      reject(new Error('需要交互式终端以安全输入密码'));
      return;
    }
    process.stdout.write(prompt);
    let input = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    function onData(key) {
      if (key === '\u0003') {
        finish(new Error('已取消'));
      } else if (key === '\r' || key === '\n') {
        finish(null, input);
      } else if (key === '\u007f' || key === '\b') {
        input = input.slice(0, -1);
      } else if (key.length === 1 && key >= ' ') {
        input += key;
      }
    }
    function finish(error, result) {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(result);
    }
    process.stdin.on('data', onData);
  });
}

async function main() {
  const [command, userId] = process.argv.slice(2);
  if (command !== 'set' || !userId) {
    console.error('用法: node scripts/manage-auth.js set <用户ID>');
    process.exitCode = 2;
    return;
  }
  db.initDatabase();
  const user = db.getById(db.TABLES.USERS, userId);
  if (!user || user.status !== 'active') throw new Error('数据库中不存在此有效用户');
  const password = await readSecret('为 ' + user.name + ' 设置登录密码（至少12字符）：');
  const repeated = await readSecret('请再次输入确认：');
  if (password !== repeated) throw new Error('两次密码不一致，未保存');
  auth.saveCredential(userId, password);
  console.log('凭证已保存：' + auth.CREDENTIAL_FILE + '（权限仅当前用户）');
}

main().catch(err => {
  console.error('操作失败：' + err.message);
  process.exitCode = 1;
});

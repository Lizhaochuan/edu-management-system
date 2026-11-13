'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../services/superAdminPolicy');
const one = {id:'one',role:'super_admin',status:'active'};
const two = {id:'two',role:'super_admin',status:'active'};
test('only the sole active super administrator can approve their own request', () => {
  assert.equal(policy.mayApproveOwnRequest([one], one), true);
  assert.equal(policy.mayApproveOwnRequest([one,two], one), false);
  assert.equal(policy.mayApproveOwnRequest([one,{...two,status:'disabled'}], one), true);
  assert.equal(policy.mayApproveOwnRequest([two], one), false);
  assert.equal(policy.mayApproveOwnRequest([{...one,status:'disabled'}], one), false);
  assert.equal(policy.mayApproveOwnRequest([one], {id:'one',role:'super_admin'}), true);
});

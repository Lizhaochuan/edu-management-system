'use strict';

// Counts only active server-side accounts; callers must supply a fresh snapshot.
function activeSuperAdmins(users) {
  if (!Array.isArray(users)) throw new TypeError('users must be an array');
  return users.filter(user => user && user.role === 'super_admin' && user.status === 'active');
}
function mayApproveOwnRequest(users, operator) {
  const admins = activeSuperAdmins(users);
  return Boolean(operator && operator.role === 'super_admin' &&
    admins.length === 1 && admins[0].id === operator.id);
}
module.exports = { activeSuperAdmins, mayApproveOwnRequest };

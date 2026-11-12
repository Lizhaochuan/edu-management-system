'use strict';

// Node-only entry point. The HTTP client can select a registered command, never
// a table, handler, role or operator. No mini-program storage is consulted.
const crypto = require('node:crypto');
const db = require('./db');
const auth = require('./authService');
const MAX_RECEIPTS = 10000;

class CommandError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
function fail(status, code, message) { throw new CommandError(status, code, message); }
function exactObject(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function identity(req) {
  const session = auth.authenticate(req);
  if (!session) fail(401, 'UNAUTHENTICATED', '请先登录');
  return session.user;
}

// Apply on EVERY response, including receipts written before redaction changed.
function projectResponse(response, operator) {
  if (operator.role !== 'teacher' || !response.result) return response;
  const pick = (value, keys) => Object.fromEntries(keys.filter(k => Object.hasOwn(value,k)).map(k => [k,value[k]]));
  const result=pick(response.result,['success','schedule_id','class_id','class_name','lesson_date','hours_per_lesson','initial_present_headcount','present_formal_headcount','present_trial_count','absent_count','submitted_at','modified_at','approval_id','status']);
  if (Array.isArray(response.result.attendees)) result.attendees=response.result.attendees.map(a=>pick(a,['student_id','student_name','is_trial','status','is_late','is_early_leave','deducted_hours']));
  return {...response,result};
}

// Server-owned registry. New operations must supply their own permission check,
// strict parameter validator and synchronous database-only handler.
const commands = Object.freeze({
  ...require('./businessOperations')({ fail }),
  'system.writeProbe': Object.freeze({
    authorize: user => user.role === 'super_admin',
    validate: params => exactObject(params, ['label']) &&
      typeof params.label === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(params.label),
    handle: ({ params }) => ({ accepted: true, label: params.label })
  })
});

// Registry injection is for isolated tests/server composition only, never HTTP.
function createExecutor(registry) {
  const allowlist = new Map(Object.entries(registry).map(([name, spec]) => {
    if (!spec || !['authorize', 'validate', 'handle'].every(k => typeof spec[k] === 'function') ||
        spec.handle.constructor.name === 'AsyncFunction') throw new Error('Invalid command registration');
    return [name, Object.freeze({ ...spec })];
  }));
  return function execute(req, envelope) {
    // No await between authentication, authorization, version check and commit.
    // This is the single-process serialization boundary, shared by all executors.
    const operator = identity(req);
    if (!exactObject(envelope, ['command', 'params', 'idempotencyKey', 'expectedVersion']) ||
        typeof envelope.command !== 'string' ||
        typeof envelope.idempotencyKey !== 'string' ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(envelope.idempotencyKey) ||
        !Number.isSafeInteger(envelope.expectedVersion) || envelope.expectedVersion < 0) {
      fail(400, 'INVALID_COMMAND', '命令格式、幂等键或版本号无效');
    }
    const spec = allowlist.get(envelope.command);
    if (!spec) fail(400, 'UNKNOWN_COMMAND', '未注册的业务命令');
    if (spec.authorize(operator, envelope.params) !== true) fail(403, 'FORBIDDEN', '无权执行此业务命令');
    if (spec.validate(envelope.params) !== true) fail(400, 'INVALID_PARAMS', '业务参数无效');
    // Include original expectedVersion: an exact retry must reuse its envelope.
    const fingerprint = hash(canonical(envelope));
    const key = hash(JSON.stringify([operator.id, envelope.idempotencyKey]));
    const state = db.getWriteState();
    const previous = state.receipts.find(r => r.key === key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail(409, 'IDEMPOTENCY_CONFLICT', '幂等键已用于其他请求');
      return projectResponse({ ...previous.response, replayed: true }, operator);
    }
    if (state.version !== envelope.expectedVersion) fail(409, 'VERSION_CONFLICT', '数据已变更，请刷新后重试');
    // Never silently evict a receipt and permit an old financial request to rerun.
    if (state.receipts.length >= MAX_RECEIPTS) fail(503, 'RECEIPT_CAPACITY', '幂等记录已满，需要服务端维护');
    const response = db.transaction(() => {
      const result = spec.handle({ params: envelope.params, operator: Object.freeze({ ...operator }) });
      if (result && typeof result.then === 'function') throw new Error('Command handlers must be synchronous');
      // Clone before commit so non-serializable results cannot commit and then fail
      // to produce a response. Return values must contain JSON-compatible data.
      const response = JSON.parse(JSON.stringify({ result, version: state.version + 1 }));
      db.saveCommandReceipt({ key, fingerprint, operatorId: operator.id,
        command: envelope.command, response });
      return { ...response, replayed: false };
    }, operator);
    return projectResponse(response, operator);
  };
}

module.exports = { execute: createExecutor(commands), createExecutor, CommandError };

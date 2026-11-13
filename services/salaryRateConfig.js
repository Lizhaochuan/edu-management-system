// Eight independently entered salary brackets. No fixed increment formula.
'use strict';
const HEADCOUNTS = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8]);
function normalizeManualRates(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('教师课时费必须填写1～8人八档独立金额');
  }
  const keys = Object.keys(raw);
  if (keys.length !== HEADCOUNTS.length ||
      keys.some(key => !HEADCOUNTS.some(n => String(n) === key))) {
    throw new Error('教师课时费必须恰好填写1～8人八档金额；多人档尚未启用');
  }
  const normalized = {};
  for (const count of HEADCOUNTS) {
    const original = raw[count];
    if (typeof original !== 'number' && typeof original !== 'string') {
      throw new Error(`第${count}人档位金额不是合法数字`);
    }
    // Native form input values are strings; accept strict numeric format only.
    const validString = typeof original !== 'string' || /^(0|[1-9]\d*)(\.\d{1,2})?$/.test(original);
    const amount = Number(original);
    if (!validString || !Number.isFinite(amount) || amount < 0 ||
        Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7) {
      throw new Error(`第${count}人档位金额必须是非负数字，最多两位小数`);
    }
    normalized[count] = amount;
  }
  return normalized;
}
module.exports = { HEADCOUNTS, normalizeManualRates };

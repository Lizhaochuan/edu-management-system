// Native client transport. Only server responses populate the display cache.
// Pending envelopes are retry records, never authoritative business balances.
const db = require('./db')
let context = null
let contextToken = null
const running = new Map()
function key() { return 'cmd_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) }
function request(route, method = 'GET', data) {
  return new Promise((resolve, reject) => wx.request({
    url: db.SERVER_API_BASE + route, method, data,
    header: { Authorization: 'Bearer ' + wx.getStorageSync('auth_token'), 'Content-Type':'application/json' },
    success(res) {
      if (res.statusCode >= 200 && res.statusCode < 300 && res.data.code === 0) return resolve(res.data.data)
      const error = new Error((res.data && res.data.message) || '服务端拒绝请求')
      error.status = res.statusCode; reject(error)
    },
    fail() { reject(new Error('网络未确认结果，请保持原操作参数重试')) }
  }))
}
async function refresh() {
  context = await request('/api/commands/context')
  contextToken = String(wx.getStorageSync('auth_token'))
  for (const [table, rows] of Object.entries(context.snapshot)) if (Array.isArray(rows)) wx.setStorageSync(table, rows)
  return context
}
function run(command, params) {
  const scope = String(wx.getStorageSync('auth_token'))
  const signature = JSON.stringify([command, params])
  const flightKey=JSON.stringify([scope,signature])
  if (running.has(flightKey)) return running.get(flightKey)
  const task = (async () => {
    if (!context || contextToken !== scope) await refresh()
    const storageKey='pending_business_command_'+context.user_id
    const saved=wx.getStorageSync(storageKey)
    if (saved && saved.signature !== signature) throw new Error('有未确认操作，请先使用原参数重试')
    const envelope=saved ? saved.envelope : {command,params,idempotencyKey:key(),expectedVersion:context.version}
    // Save before sending. This is an exact retry envelope, not a balance source.
    wx.setStorageSync(storageKey,{scope:context.user_id,signature,envelope})
    let response
    try { response = await request('/api/commands/execute','POST',envelope) }
    catch (error) {
      if (error.status >= 400 && error.status < 500) {
        wx.removeStorageSync(storageKey)
        try { await refresh() } catch (_e) {}
      }
      throw error
    }
    wx.removeStorageSync(storageKey)
    try { await refresh() } catch (_e) { context = null; wx.showToast({title:'操作成功，请刷新查看',icon:'none'}) }
    return response.result
  })().finally(() => running.delete(flightKey))
  running.set(flightKey,task)
  return task
}
async function recoverPending() {
  const saved = context && wx.getStorageSync('pending_business_command_'+context.user_id)
  if (!saved || !context || saved.scope !== context.user_id) return
  const answer = await new Promise(resolve => wx.showModal({title:'有待确认操作',content:'上次提交未收到确认。是否使用原请求查询并重试？',confirmText:'确认重试',success:resolve,fail:()=>resolve({confirm:false})}))
  if (answer.confirm) {
    try { await run(saved.envelope.command,saved.envelope.params) }
    catch (error) { wx.showModal({title:'操作未确认',content:error.message,showCancel:false}) }
  }
}
module.exports = { run, refresh, recoverPending, key }

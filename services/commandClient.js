// Native client transport. Only server responses populate the display cache.
// Pending envelopes are retry records, never authoritative business balances.
const db = require('./db')
let context = null
let contextToken = null
const running = new Map()
function key() { return 'cmd_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) }
function request(route, method = 'GET', data, token = wx.getStorageSync('auth_token')) {
  return new Promise((resolve, reject) => wx.request({
    url: db.SERVER_API_BASE + route, method, data, timeout:10000,
    header: { Authorization: 'Bearer ' + token, 'Content-Type':'application/json' },
    success(res) {
      if (res.statusCode >= 200 && res.statusCode < 300 && res.data.code === 0) return resolve(res.data.data)
      const error = new Error((res.data && res.data.message) || '服务端拒绝请求')
      error.status = res.statusCode; reject(error)
    },
    fail() { reject(new Error('网络未确认结果，请保持原操作参数重试')) }
  }))
}
async function refresh() {
  const token=String(wx.getStorageSync('auth_token'))
  const next=await request('/api/commands/context')
  // Late responses from a prior login must never replace the new user's cache.
  if (token !== String(wx.getStorageSync('auth_token'))) throw new Error('登录身份已变化，请重新读取')
  if (contextToken === token && context && next.version < context.version) return context
  context=next; contextToken=token
  for (const [table,rows] of Object.entries(context.snapshot)) if(Array.isArray(rows)) wx.setStorageSync(table,rows)
  return context
}
let syncTimer=null
let syncGeneration=0
function stopSync() { syncGeneration++; if(syncTimer!==null) clearTimeout(syncTimer); syncTimer=null }
function startSync(onUpdate, interval=5000) {
  stopSync()
  const generation=syncGeneration
  let reported=null
  async function poll() {
    const token=String(wx.getStorageSync('auth_token') || '')
    try {
      if(token && context && contextToken===token && running.size===0) {
        const latest=await request('/api/commands/version')
        if(generation===syncGeneration && token===String(wx.getStorageSync('auth_token')) && latest.version!==context.version && reported!==latest.version) {
          reported=latest.version
          if(onUpdate) onUpdate(latest.version)
        }
      }
    } catch(_e) { /* A later foreground poll retries; never overwrite cache offline. */ }
    if(generation===syncGeneration) syncTimer=setTimeout(poll,interval)
  }
  poll()
}

function run(command, params) {
  const scope = String(wx.getStorageSync('auth_token'))
  const signature = JSON.stringify([command, params])
  const flightKey=JSON.stringify([scope,signature])
  if (running.has(flightKey)) return running.get(flightKey)
  const task = (async () => {
    if (!context || contextToken !== scope) await refresh()
    if (scope !== String(wx.getStorageSync('auth_token'))) throw new Error('登录身份已变化，请重新读取')
    const storageKey='pending_business_command_'+context.user_id
    const saved=wx.getStorageSync(storageKey)
    if (saved && saved.signature !== signature) throw new Error('有未确认操作，请先使用原参数重试')
    const envelope=saved ? saved.envelope : {command,params,idempotencyKey:key(),expectedVersion:context.version}
    // Save before sending. This is an exact retry envelope, not a balance source.
    wx.setStorageSync(storageKey,{scope:context.user_id,signature,envelope})
    let response
    try { response = await request('/api/commands/execute','POST',envelope,scope) }
    catch (error) {
      if ([400,404,409,413,428].includes(error.status)) {
        wx.removeStorageSync(storageKey)
        try { await refresh() } catch (_e) {}
      }
      throw error
    }
    if (scope !== String(wx.getStorageSync('auth_token'))) throw new Error('登录身份已变化，原操作请重新登录后确认')
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
module.exports = { run, refresh, recoverPending, key, startSync, stopSync }

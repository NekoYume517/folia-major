// 运行 LX 混淆音源脚本，mock globalThis.lx，提取真实接口规则
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'

const dir = path.dirname(fileURLToPath(import.meta.url))
const files = process.argv.slice(2).length ? process.argv.slice(2) : ['野草.js', '野花.js']

const EVENT_NAMES = {
  request: 'request',
  inited: 'inited',
  sources: 'sources',
  updateAlert: 'updateAlert',
}

function runScript(file) {
  const code = readFileSync(path.join(dir, file), 'utf-8')
  const calls = [] // 记录 on/send/request 调用

  const utils = {
    buffer: {
      from: (...a) => Buffer.from(...a),
      bufToString: (buf, format) => {
        if (format === 'hex') return Buffer.from(buf).toString('hex')
        if (format === 'base64') return Buffer.from(buf).toString('base64')
        return Buffer.from(buf).toString('utf-8')
      },
    },
    crypto: {
      md5: (...parts) => {
        const bufs = parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(String(p)))
        return createHash('md5').update(Buffer.concat(bufs)).digest('hex')
      },
      randomBytes: n => require$randomBytes(n),
      aesEn: null,
      rsaEncrypt: null,
    },
    zlib: {},
  }
  function require$randomBytes(n) {
    return Array.from({ length: n }, (_, i) => (i * 7 + 13) % 256)
  }

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    Buffer,
    globalThis: {},
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)

  sandbox.lx = {
    EVENT_NAMES,
    version: '2.1.0',
    env: 'desktop',
    currentScriptInfo: { version: '1.0.0', name: file, description: '', homepage: '', rawScript: 'RAW' },
    utils,
    on: (event, handler) => { calls.push({ kind: 'on', event, handler }) },
    send: (event, data) => { calls.push({ kind: 'send', event, data }) },
    request: (url, options, callback) => {
      calls.push({ kind: 'request', url, options })
      // 不真正发请求，回调返回模拟失败信息
      if (callback) setTimeout(() => callback(new Error('MOCK-NO-NETWORK')), 0)
      return
    },
  }

  try {
    vm.runInContext(code, sandbox, { filename: file, timeout: 5000 })
  } catch (e) {
    calls.push({ kind: 'error', message: String(e && e.stack || e) })
  }
  return calls
}

for (const file of files) {
  console.log('='.repeat(20), file, '='.repeat(20))
  const calls = runScript(file)
  let onRequest = null
  for (const c of calls) {
    if (c.kind === 'error') { console.log('[VM ERROR]', c.message.split('\n').slice(0, 4).join('\n')); continue }
    if (c.kind === 'on') console.log(`[on] event=${c.event}`)
    if (c.kind === 'send') console.log(`[send] event=${c.event} data=`, JSON.stringify(c.data, null, 2))
    if (c.kind === 'on' && c.event === EVENT_NAMES.request) onRequest = c.handler
  }
  if (!onRequest) { console.log('(no request handler registered)'); continue }

  // 依次触发各 source 的 musicUrl 请求，捕获脚本发出的真实 HTTP 请求
  const probe = [
    { source: 'wy', id: { songmid: 'WYID123' } },
    { source: 'tx', id: { songmid: 'TXID456' } },
    { source: 'kw', id: { songmid: 'KWID789' } },
    { source: 'kg', id: { hash: 'KGHASHABC' } },
    { source: 'mg', id: { copyrightId: 'MGID000' } },
  ]
  for (const p of probe) {
    const before = calls.length
    try {
      const promise = onRequest({ source: p.source, action: 'musicUrl', info: { musicInfo: p.id, type: '320k' } })
      promise.catch(e => console.log(`  [${p.source}] promise rejected: ${e.message}`))
      // request 的 mock 回调是异步的，等一轮 microtask/macrotask
      await new Promise(r => setTimeout(r, 30))
    } catch (e) {
      console.log(`  [${p.source}] handler threw: ${e.message}`)
    }
    for (const c of calls.slice(before)) {
      if (c.kind === 'request') {
        console.log(`  [${p.source}] -> ${c.options && c.options.method} ${c.url}`)
        console.log(`       headers=`, JSON.stringify(c.options && c.options.headers))
      }
    }
  }
}

/**
 * cdp-shot.mjs —— 真实浏览器里的可视验证：等到指定条件后截图 + 取回 JSON
 * ---------------------------------------------------------------------------
 * 无头浏览器的 stdout 取不回来，`--screenshot` 又会在 load 后立刻拍，
 * 所以这里开 --remote-debugging-port，用 Node 内置 WebSocket 客户端：
 *   1. 轮询直到页面里的 `expr` 返回真值（或超时）；
 *   2. 用 Page.captureScreenshot 截一张 PNG；
 *   3. 把 `window.__result`（如果页面设置了）一并打印出来。
 *
 * 用法： node cdp-shot.mjs <url> <out.png> [waitExpr] [timeoutSeconds] [settleMs]
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { tmpdir } from 'node:os'

const [URL_ARG, OUT_PNG] = process.argv.slice(2)
const WAIT_EXPR = process.argv[4] || 'true'
const TIMEOUT_S = Number(process.argv[5] || 60)
const SETTLE_MS = Number(process.argv[6] || 900)
const WINDOW_SIZE = process.env.DSH_SHOT_WINDOW || '1100,780'
// Chromium's window size includes chrome, so the captured viewport comes out
// smaller; pass an explicit viewport to keep the screenshot dimensions exact.
const VIEWPORT = process.env.DSH_SHOT_VIEWPORT || ''
const PROFILE = process.env.DSH_SHOT_PROFILE || path.join(tmpdir(), 'dshca-probe', 'edge-shot-profile')
const BROWSER =
  process.env.DSH_PROBE_BROWSER || String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`
const PORT = Number(process.env.DSH_SHOT_PORT || 9334)

if (!URL_ARG || !OUT_PNG) {
  console.error('usage: node cdp-shot.mjs <url> <out.png> [waitExpr] [timeoutSeconds] [settleMs]')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const child = spawn(
  BROWSER,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    `--window-size=${WINDOW_SIZE}`,
    URL_ARG,
  ],
  { stdio: 'ignore' },
)

try {
  let page = null
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) break
    } catch {
      /* not up yet */
    }
    await sleep(300)
  }
  if (!page) throw new Error('no debuggable page target')

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('websocket error')), { once: true })
  })

  let nextId = 1
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    let msg
    try {
      msg = JSON.parse(ev.data)
    } catch {
      return
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id)
      pending.delete(msg.id)
      resolve(msg)
    }
  })
  const send = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++
      pending.set(id, { resolve })
      ws.send(JSON.stringify({ id, method, params }))
    })

  const evaluate = async (expr) => {
    const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    const r = res.result || {}
    if (r.exceptionDetails) return { __error: r.exceptionDetails.text || 'exception' }
    return r.result ? r.result.value : undefined
  }

  const end = Date.now() + TIMEOUT_S * 1000
  let waited = false
  while (Date.now() < end) {
    const value = await evaluate(`(() => { try { return Boolean(${WAIT_EXPR}) } catch (e) { return false } })()`)
    if (value === true) {
      waited = true
      break
    }
    await sleep(400)
  }
  if (!waited) console.log(`[warn] wait condition never became true within ${TIMEOUT_S}s: ${WAIT_EXPR}`)

  await sleep(SETTLE_MS)

  if (VIEWPORT) {
    const [vw, vh] = VIEWPORT.split(',').map(Number)
    await send('Emulation.setDeviceMetricsOverride', {
      width: vw,
      height: vh,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await sleep(400)
  }

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const data = shot.result && shot.result.data
  if (!data) throw new Error('captureScreenshot returned nothing')
  fs.writeFileSync(OUT_PNG, Buffer.from(data, 'base64'))

  const result = await evaluate('window.__result || null')
  const report = await evaluate('window.__report || null')
  console.log(`screenshot: ${OUT_PNG}`)
  if (report) console.log('report:', typeof report === 'string' ? report : JSON.stringify(report, null, 2))
  if (result) console.log('result:', typeof result === 'string' ? result : JSON.stringify(result, null, 2))

  ws.close()
} catch (err) {
  console.error('cdp-shot failed:', err && err.message)
  process.exitCode = 1
} finally {
  try {
    child.kill()
  } catch {
    /* already gone */
  }
}

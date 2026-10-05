/**
 * cdp-eval2.mjs —— 在真实浏览器里跑一段表达式，把结果取回来（无头 CDP）
 * ---------------------------------------------------------------------------
 * `test/cdp-shot.mjs` 负责"等条件 + 截图"；这个脚本负责"等条件 + 取回 JSON"，
 * 用来验证排期器这种**随时间变化**的行为：不能只看一张截图，得看一整条时间线。
 *
 * 用法： node cdp-eval.mjs <url> <waitExpr> [timeoutSeconds] [resultExpr]
 * `resultExpr` 缺省时取 `window.__result || window.__report`。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { tmpdir } from 'node:os'

const [URL_ARG, WAIT_EXPR = 'true', TIMEOUT_S = '60', RESULT_EXPR] = process.argv.slice(2)
const PROFILE = process.env.DSH_EVAL_PROFILE || path.join(tmpdir(), 'dshca-probe', 'eval-profile')
const BROWSER =
  process.env.DSH_PROBE_BROWSER || String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`
const PORT = Number(process.env.DSH_EVAL_PORT || 9352)

if (!URL_ARG) {
  console.error('usage: node cdp-eval2.mjs <url> <waitExpr> [timeoutSeconds]')
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
    '--window-size=1000,700',
    URL_ARG,
  ],
  { stdio: 'ignore' },
)

try {
  let page = null
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
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
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  })
  const send = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expr) => {
    const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    // CDP 的外层是 { id, result: { result: RemoteObject, exceptionDetails? } } ——
    // 取值要下两层（`res.result.result.value`），少下一层永远拿到 undefined。
    const r = res.result || {}
    if (r.exceptionDetails) return { __error: r.exceptionDetails.text || 'exception' }
    return r.result ? r.result.value : undefined
  }

  const end = Date.now() + Number(TIMEOUT_S) * 1000
  let hit = false
  while (Date.now() < end) {
    const v = await evaluate(`(() => { try { return Boolean(${WAIT_EXPR}) } catch (e) { return false } })()`)
    if (v === true) {
      hit = true
      break
    }
    await sleep(400)
  }
  if (!hit) console.log(`[warn] wait condition never became true: ${WAIT_EXPR}`)

  const result = await evaluate(RESULT_EXPR || 'window.__result || window.__report || null')
  console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2))
  ws.close()
} catch (err) {
  console.error('cdp-eval2 failed:', err && err.message)
  process.exitCode = 1
} finally {
  try {
    child.kill()
  } catch {
    /* gone */
  }
}

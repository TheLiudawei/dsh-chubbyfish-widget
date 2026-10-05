/**
 * One-off probe: where is the girl's head inside her split part?
 *
 * Prints the girl crop's alpha profile from the top down, so the basin can be
 * placed on the head with measured numbers instead of guesses.
 *
 * Usage: node tools/probe-head.mjs [url] [--dump out.png]
 *        `--dump` also writes her frozen-frame crop, which is what you want to
 *        composite a candidate basin placement onto offline.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

const args = process.argv.slice(2)
const DUMP = (() => {
  const i = args.indexOf('--dump')
  return i >= 0 ? args[i + 1] : null
})()
const URL_ARG = args.find((a) => a.startsWith('http')) || 'http://127.0.0.1:19431/'
const BROWSER =
  process.env.DSH_PROBE_BROWSER || String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`
const PORT = Number(process.env.DSH_HEAD_PORT || 9377)
const PROFILE = process.env.DSH_HEAD_PROFILE || path.join(tmpdir(), 'dshca-head-probe')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const EXPR = `(async () => {
  const girl = document.getElementById('dshca-part-girl')
  if (!girl) return { error: 'no girl part' }
  const crop = girl.querySelector('canvas:not(.dshca-squish)')
  if (!crop) return { error: 'no girl canvas' }
  const w = crop.width, h = crop.height
  const pw = 256, ph = Math.max(1, Math.round(pw * h / w))
  const probe = document.createElement('canvas')
  probe.width = pw; probe.height = ph
  const ctx = probe.getContext('2d')
  ctx.drawImage(crop, 0, 0, pw, ph)
  const d = ctx.getImageData(0, 0, pw, ph).data
  const rows = []
  for (let y = 0; y < ph; y += 1) {
    let minX = -1, maxX = -1
    for (let x = 0; x < pw; x += 1) {
      if (d[(y * pw + x) * 4 + 3] > 24) { if (minX < 0) minX = x; maxX = x }
    }
    rows.push({ y, minX, maxX })
  }
  const first = rows.findIndex((r) => r.minX >= 0)
  const out = []
  for (const f of [0, 0.02, 0.04, 0.06, 0.08, 0.10, 0.13, 0.16, 0.20, 0.25, 0.30, 0.35, 0.40]) {
    const y = Math.min(ph - 1, first + Math.round(f * ph))
    const r = rows[y]
    out.push({
      f: +f.toFixed(2),
      yFrac: +(y / ph).toFixed(4),
      xL: r.minX < 0 ? null : +(r.minX / pw).toFixed(4),
      xR: r.maxX < 0 ? null : +((r.maxX + 1) / pw).toFixed(4),
      wFrac: r.minX < 0 ? null : +((r.maxX + 1 - r.minX) / pw).toFixed(4),
    })
  }
  // 头顶那几行的宽度：用来判断"头的宽度"大概是多少
  const widestTop = rows.slice(first, first + Math.round(0.25 * ph)).reduce((a, r) => Math.max(a, r.maxX + 1 - r.minX), 0)
  return {
    canvas: { w, h },
    probe: { pw, ph },
    headTopRow: first,
    headTopFrac: +(first / ph).toFixed(4),
    widestInTop25: +(widestTop / pw).toFixed(4),
    profile: out,
  }
})()`

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
      /* not up */
    }
    await sleep(300)
  }
  if (!page) throw new Error('no debuggable page')

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', () => rej(new Error('ws error')), { once: true })
  })
  let id = 1
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    let m
    try {
      m = JSON.parse(ev.data)
    } catch {
      return
    }
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  })
  const send = (method, params) =>
    new Promise((res) => {
      const i = id++
      pending.set(i, res)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    const res = r.result || {}
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || 'exception')
    return res.result ? res.result.value : undefined
  }

  const end = Date.now() + 60000
  while (Date.now() < end) {
    const ready = await evaluate("(() => { try { return !!document.getElementById('dshca-part-girl') } catch (e) { return false } })()")
    if (ready) break
    await sleep(400)
  }
  console.log(JSON.stringify(await evaluate(EXPR), null, 2))

  if (DUMP) {
    const dataUrl = await evaluate(
      "(function(){var g=document.getElementById('dshca-part-girl');if(!g)return null;var c=g.querySelector('canvas:not(.dshca-squish)');return c?c.toDataURL('image/png'):null})()",
    )
    if (!dataUrl) throw new Error('no girl canvas to dump')
    fs.writeFileSync(DUMP, Buffer.from(String(dataUrl).split(',')[1], 'base64'))
    console.log(`girl crop dumped: ${DUMP}`)
  }
  ws.close()
} catch (err) {
  console.error('probe-head failed:', err && err.message)
  process.exitCode = 1
} finally {
  try {
    child.kill()
  } catch {
    /* gone */
  }
}

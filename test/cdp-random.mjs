/**
 * cdp-random.mjs —— 0.10.0 三件事的真浏览器自检
 * ---------------------------------------------------------------------------
 * 为什么必须这么验：三道随机动画都由概率触发（20% / 10%），靠"手点几下"根本
 * 复现不了；而"锅有没有真的飞过去、有没有在接触那一刻回来、倒放有没有跑完"
 * 又全是时序问题，只有在真浏览器里按真时间跑一遍才算数。
 *
 * 这个脚本直接连 CDP，用插件自己的 `window.__dshcaRandom` 手动起播每一段，
 * 按关键帧采样 `probe()`、截图，并按"有且仅有一段画面"这条不变量做断言。
 *
 * 用法：
 *   node test/cdp-random.mjs <previewUrl> <outDir> [which]
 *   which: all（默认）| roll | lid1 | lid2 | drag
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

const URL_ARG = process.argv[2] || 'http://127.0.0.1:19399/'
const OUT_DIR = process.argv[3] || 'docs/dev-checks'
const WHICH = process.argv[4] || 'all'

const BROWSER =
  process.env.DSH_PROBE_BROWSER || String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`
const PORT = Number(process.env.DSH_RANDOM_PORT || 9336)
const PROFILE = process.env.DSH_RANDOM_PROFILE || path.join(tmpdir(), 'dshca-probe', 'random-profile')
const VIEWPORT = (process.env.DSH_RANDOM_VIEWPORT || '1200,820').split(',').map(Number)

fs.mkdirSync(OUT_DIR, { recursive: true })

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
    `--window-size=${VIEWPORT[0]},${VIEWPORT[1]}`,
    URL_ARG,
  ],
  { stdio: 'ignore' },
)

const findings = []
const startedAt = Date.now()
function note(line) {
  findings.push(line)
  const secs = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log(`[t+${secs.padStart(5)}s] ${line}`)
}

try {
  let target = null
  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (target) break
    } catch {
      /* not up yet */
    }
    await sleep(300)
  }
  if (!target) throw new Error('no debuggable page target')

  const ws = new WebSocket(target.webSocketDebuggerUrl)
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
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    // CDP 外层是 { id, result: { result: RemoteObject } } —— 取值要下两层。
    const box = r.result || {}
    if (box.exceptionDetails) {
      return { __error: box.exceptionDetails.text + ' ' + JSON.stringify((box.exceptionDetails.exception || {}).description || '') }
    }
    return box.result ? box.result.value : undefined
  }
  const shot = async (name) => {
    const res = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const data = res.result && res.result.data
    if (!data) return null
    const file = path.join(OUT_DIR, name)
    fs.writeFileSync(file, Buffer.from(data, 'base64'))
    return file
  }
  const probe = () => evaluate('window.__dshcaRandom ? window.__dshcaRandom.probe() : null')

  await send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT[0],
    height: VIEWPORT[1],
    deviceScaleFactor: 1,
    mobile: false,
  })

  // Wait for the opener to finish and the split to happen.
  const t0 = Date.now()
  while (Date.now() - t0 < 60000) {
    const ready = await evaluate(
      "!!(window.__dshcaRandom && document.getElementById('dshca-part-cooker') && document.getElementById('dshca-part-girl'))",
    )
    if (ready === true) break
    await sleep(400)
  }
  const err = await evaluate('window.__dshcaRandom ? null : "no __dshcaRandom"')
  if (err) note(`[FAIL] ${err}`)
  await sleep(1500)

  const initial = await probe()
  note(`[init] stage=${initial && initial.stage} chances=${initial && initial.chanceA}/${initial && initial.chanceB} ` +
    `cooker=${JSON.stringify(initial && initial.cooker)} girl=${JSON.stringify(initial && initial.girl)} ` +
    `layers=${JSON.stringify(initial && initial.visibleLayers)}`)
  await shot('v010-initial.png')

  /* ------------------------------------------------------------------ */
  /* 1) 概率分布：真实点击路径（maybePlayRandomCooker）掷 400 次          */
  /* ------------------------------------------------------------------ */
  if (WHICH === 'all' || WHICH === 'roll') {
    const roll = await evaluate(`(function () {
      var a = 0, b = 0, none = 0, both = 0
      var seq = []
      for (var i = 0; i < 400; i += 1) {
        var r = window.__dshcaRandom.roll()
        if (!r) { none += 1; continue }
        var st = window.__dshcaRandom.probe().stage
        if (st === 'lid1') a += 1; else if (st === 'lid2') b += 1
        seq.push(st)
        window.__dshcaRandom.stop()
      }
      return { a: a, b: b, none: none, total: 400 }
    })()`)
    note(`[roll] 400 real rolls -> A=${roll.a} (${(roll.a / 4).toFixed(1)}%)  B=${roll.b} (${(roll.b / 4).toFixed(1)}%)  none=${roll.none} (${(roll.none / 4).toFixed(1)}%)`)
    const expectA = roll.a >= 50 && roll.a <= 110
    const expectB = roll.b >= 10 && roll.b <= 70
    note(`${expectA && expectB ? '[ok]' : '[FAIL]'} distribution within the expected band (A≈20%, B≈10%)`)
  }

  /* ------------------------------------------------------------------ */
  /* 2) 动画1：正常播放 -> 倒放 -> 立刻交回定格图                          */
  /* ------------------------------------------------------------------ */
  if (WHICH === 'all' || WHICH === 'lid1') {
    await evaluate('window.__dshcaRandom.play("lid1")')
    await sleep(700)
    const playing = await probe()
    note(`[lid1] playing  stage=${playing.stage} layers=${JSON.stringify(playing.visibleLayers)} ` +
      `clip=${JSON.stringify(playing.cookerClips.a)}`)
    await shot('v010-lid1-playing.png')

    // Wait for the reversal to begin (currentTime starts walking back).
    let reverseSeen = null
    const tRev = Date.now()
    while (Date.now() - tRev < 9000) {
      const p = await probe()
      if (p.stage === 'lid1') {
        const clip = p.cookerClips.a
        if (clip && clip.t < 4.6) {
          reverseSeen = clip.t
          await shot('v010-lid1-reversing.png')
          break
        }
      } else break
      await sleep(120)
    }
    note(`[lid1] reverse ${reverseSeen === null ? '[FAIL] never saw a rewind' : `[ok] rewind seen at t=${reverseSeen}s`}`)

    const tEnd = Date.now()
    while (Date.now() - tEnd < 12000) {
      const p = await probe()
      if (!p.stage) break
      await sleep(150)
    }
    await sleep(500)
    const after = await probe()
    note(`[lid1] after   stage=${after.stage} layers=${JSON.stringify(after.visibleLayers)} ` +
      `fly=${JSON.stringify(after.fly)} reversedTo=${after.cookerClips.a && after.cookerClips.a.t}`)
    note(`${after.stage === null && after.visibleLayers.indexOf('cooker-canvas') >= 0 ? '[ok]' : '[FAIL]'} cooker back to its frozen frame, nothing left flying`)
    await shot('v010-lid1-back.png')
  }

  /* ------------------------------------------------------------------ */
  /* 3) 动画2：她那段 + 锅飞过去 + 接触 + 双方复位                          */
  /* ------------------------------------------------------------------ */
  if (WHICH === 'all' || WHICH === 'lid2') {
    const before2 = await probe()
    // 0.10.1 修的漏洞2：先在她头上摞一个盆，动画2 期间它必须让位。
    await evaluate('window.__dshcaPots.drop()')
    const potBefore = await evaluate(
      "(function(){var l=document.getElementById('dshca-pots');return l?getComputedStyle(l).visibility:null})()",
    )
    note(`[lid2] pots    before=${potBefore} (a pot is stacked on her head)`)
    await evaluate('window.__dshcaRandom.play("lid2")')
    await sleep(400)
    const flying = await probe()
    note(`[lid2] start   stage=${flying.stage} plan=${JSON.stringify(flying.flight)} ` +
      `layers=${JSON.stringify(flying.visibleLayers)}`)
    await shot('v010-lid2-start.png')

    let total = null
    const tMove = Date.now()
    while (Date.now() - tMove < 4000) {
      const p = await probe()
      if (!p.stage) break
      total = p
      if (Math.abs(parseFloat(p.fly.x)) > 4) break
      await sleep(150)
    }
    const mid = total || (await probe())
    note(`[lid2] moving  fly=${JSON.stringify(mid.fly)} contact=${mid.basinContact} ` +
      `girl=${JSON.stringify(mid.girlBasin)} cooker=${JSON.stringify(mid.cooker)}`)
    // 0.10.1 修的漏洞1：位移必须真的落到**计算样式**上（早先 CSS 里没有
    // transform 声明，变量写了没人读，锅在画面上纹丝不动）。
    const tfMid = await evaluate(
      "(function(){var c=document.getElementById('dshca-part-cooker');return{t:getComputedStyle(c).transform,flying:c.classList.contains('dshca-flying')}})()",
    )
    note(`[lid2] transform mid=${JSON.stringify(tfMid)}`)
    note(`${tfMid.flying && tfMid.t && tfMid.t !== 'none' ? '[ok]' : '[FAIL]'} the cooker is really translated mid-flight`)
    const potDuring = await evaluate(
      "(function(){var l=document.getElementById('dshca-pots');return l?getComputedStyle(l).visibility:null})()",
    )
    note(`${potDuring === 'hidden' ? '[ok]' : '[FAIL]'} the pot yields while her seated clip plays (got ${potDuring})`)
    await shot('v010-lid2-moving.png')
    const layoutAttr = await evaluate(
      "(function(){var b=document.getElementById('dshca-girlbasin');return b?{layout:b.getAttribute('data-layout'),box:b.getAttribute('data-content-box'),unit:JSON.stringify(document.getElementById('dshca-part-girl').getBoundingClientRect().toJSON())}:null})()",
    )
    note(`[lid2] layout  ${JSON.stringify(layoutAttr)}`)

    const tDone = Date.now()
    let done = null
    while (Date.now() - tDone < 12000) {
      const p = await probe()
      if (!p.stage) {
        done = p
        break
      }
      done = p
      await sleep(120)
    }
    await sleep(400)
    const after2 = await probe()
    note(`[lid2] after   stage=${after2.stage} fly=${JSON.stringify(after2.fly)} ` +
      `cooker=${JSON.stringify(after2.cooker)} girl=${JSON.stringify(after2.girl)} ` +
      `layers=${JSON.stringify(after2.visibleLayers)} scheduleOn=${after2.scheduleOn}`)
    const cookerBack = before2.cooker && after2.cooker &&
      before2.cooker.left === after2.cooker.left && before2.cooker.top === after2.cooker.top
    const girlBack = before2.girl && after2.girl &&
      before2.girl.left === after2.girl.left && before2.girl.top === after2.girl.top
    note(`${cookerBack ? '[ok]' : '[FAIL]'} cooker back at its original position (before=${JSON.stringify(before2.cooker)} after=${JSON.stringify(after2.cooker)})`)
    note(`${girlBack ? '[ok]' : '[FAIL]'} girl untouched (before=${JSON.stringify(before2.girl)} after=${JSON.stringify(after2.girl)})`)
    note(`${after2.stage === null && !after2.fly.flying ? '[ok]' : '[FAIL]'} flight finished and the transform was cleared`)
    note(`${after2.scheduleOn ? '[ok]' : '[FAIL]'} the idle/act schedule is running again (was on before the animation: ${before2.scheduleOn})`)
    // 0.10.1 漏洞1 的"复位"那一半：transform 必须真的清干净。
    const tfAfter = await evaluate(
      "(function(){var c=document.getElementById('dshca-part-cooker');return{t:getComputedStyle(c).transform,flying:c.classList.contains('dshca-flying')}})()",
    )
    note(`${tfAfter.t === 'none' && !tfAfter.flying ? '[ok]' : '[FAIL]'} the transform is fully cleared after contact (${JSON.stringify(tfAfter)})`)
    // 0.10.1 漏洞2 的"恢复"那一半：盆要回来。
    const potAfter = await evaluate(
      "(function(){var l=document.getElementById('dshca-pots');return l?getComputedStyle(l).visibility:null})()",
    )
    note(`${potAfter !== 'hidden' ? '[ok]' : '[FAIL]'} the pot is back after the animation (got ${potAfter})`)
    await evaluate('window.__dshcaPots.clear()')
    void done
    await shot('v010-lid2-back.png')
  }

  /* ------------------------------------------------------------------ */
  /* 4) 拖动动画：起播 -> 循环 -> 松手立刻切回                              */
  /* ------------------------------------------------------------------ */
  if (WHICH === 'all' || WHICH === 'drag') {
    const girlBefore = await probe()
    await evaluate('window.__dshcaRandom.drag(true)')
    await sleep(900)
    const dragging = await probe()
    note(`[drag] on      drag=${JSON.stringify(dragging.drag)} layers=${JSON.stringify(dragging.visibleLayers)}`)
    const hidden = await evaluate(`(function () {
      var g = document.getElementById('dshca-part-girl')
      var c = g ? g.querySelector('canvas') : null
      return { canvas: c ? getComputedStyle(c).visibility : null, loop: (document.getElementById('dshca-drag') || {}).loop }
    })()`)
    note(`[drag] canvas during drag = ${hidden.canvas} (expected hidden), loop=${hidden.loop}`)
    await shot('v010-drag-on.png')

    await sleep(5600)
    const stillOn = await probe()
    note(`[drag] looped  t=${stillOn.drag && stillOn.drag.t}s (must not have ended: loop=${stillOn.drag && stillOn.drag.loop})`)
    await evaluate('window.__dshcaRandom.drag(false)')
    await sleep(600)
    const off = await probe()
    const hiddenAfter = await evaluate(`(function () {
      var g = document.getElementById('dshca-part-girl')
      var c = g ? g.querySelector('canvas') : null
      var d = document.getElementById('dshca-drag')
      return { canvas: c ? getComputedStyle(c).visibility : null, dragDisplay: d ? getComputedStyle(d).display : null,
               girlLeft: g ? Math.round(g.getBoundingClientRect().left) : null }
    })()`)
    note(`[drag] off     layers=${JSON.stringify(off.visibleLayers)} canvas=${hiddenAfter.canvas} dragDisplay=${hiddenAfter.dragDisplay}`)
    const ok = off.drag && off.drag.on === false && hiddenAfter.dragDisplay === 'none' &&
      off.cooker.left === girlBefore.cooker.left && hiddenAfter.girlLeft === girlBefore.girl.left
    note(`${ok ? '[ok]' : '[FAIL]'} released -> the girl is back to her own frame, position unchanged`)
    await shot('v010-drag-off.png')
  }

  /* ------------------------------------------------------------------ */
  /* 5) 不变量：整段跑完有没有出现过"同时两段画面"                          */
  /* ------------------------------------------------------------------ */
  if (WHICH === 'all' || WHICH === 'roll') {
    const violations = await evaluate('window.__violations ? window.__violations.slice(0, 12) : null')
    const count = await evaluate('window.__violations ? window.__violations.length : -1')
    const visLog = await evaluate(
      'window.__dshcaRandom && window.__dshcaRandom.debug ? window.__dshcaRandom.debug().canvasVis : null',
    )
    const firstBad = violations && violations[0] && violations[0].t
    const near = (visLog || []).filter((e) => !firstBad || Math.abs(e.t - firstBad) < 2000)
    note(`[rule] one-picture violations during the whole run: ${count}${count > 0 ? ' -> ' + JSON.stringify(violations) : ''}`)
    if (near.length) note(`[rule] visibility decisions around the first violation: ${JSON.stringify(near)}`)
    note(`${count === 0 ? '[ok]' : '[FAIL]'} "exactly one picture per subject" held for the entire run`)
  }

  ws.close()
} catch (e) {
  console.error('cdp-random failed:', e && e.message)
  process.exitCode = 1
} finally {
  try {
    child.kill()
  } catch {
    /* already gone */
  }
}

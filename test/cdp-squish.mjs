/**
 * cdp-squish.mjs —— 在真实浏览器里验证「点击 Q 弹」（0.8.0）
 * ---------------------------------------------------------------------------
 * DOM 桩（test/widget-harness.mjs）能证明状态机对不对：快照建了没有、视频被
 * 暂停又接回没有、排期有没有让路。它证明不了**渲染**这一半：
 *
 *   · 压扁的那一格 CSS 过渡真的在跑（桩里的 getComputedStyle 是假的）；
 *   · 快照真的和它所在的那一块等大、支点真的落在底部中线上；
 *   · 快照上真的画着"点击那一刻的那一帧"，而不是一张空图（桩的 drawImage 是空函数）；
 *
 * 这三条只有真实浏览器回答得了，所以这个脚本用无头 Edge 走一遍真素材、真布局。
 *
 * 用法：
 *   node test/preview-server.mjs 19421        # 另一个终端里先起预览服务
 *   node test/cdp-squish.mjs                  # 缺省连 http://127.0.0.1:19421/
 *   node test/cdp-squish.mjs http://127.0.0.1:19421/?panel=1
 *
 * 顺带把"压扁中"的两张截图落到 docs/dev-checks/（--no-shot 可跳过）。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SHOT_DIR = path.join(HERE, '..', 'docs', 'dev-checks')
const WANT_SHOTS = !process.argv.includes('--no-shot')

const URL_ARG = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'http://127.0.0.1:19421/'
const BROWSER =
  process.env.DSH_PROBE_BROWSER || String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`
const PORT = Number(process.env.DSH_SQUISH_PORT || 9363)
const PROFILE = process.env.DSH_SQUISH_PROFILE || path.join(tmpdir(), 'dshca-squish-probe')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------------------------------------------ scenario */

const SCENARIO = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const checks = []
  const notes = {}
  const pass = (what) => checks.push({ ok: true, what: what })
  const fail = (what) => checks.push({ ok: false, what: what })

  const part = (k) => document.getElementById('dshca-part-' + k)
  const layer = (k) => {
    const p = part(k)
    return p ? p.querySelector('.dshca-squish') : null
  }
  const cropOf = (k) => {
    const p = part(k)
    return p ? p.querySelector('canvas:not(.dshca-squish)') : null
  }
  const sendPointer = (el, type, id) => {
    const r = el.getBoundingClientRect()
    el.dispatchEvent(new PointerEvent(type, {
      pointerId: id,
      pointerType: 'mouse',
      isPrimary: true,
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: type === 'pointerdown' ? 1 : 0,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
    }))
  }
  const scaleOf = (el) => {
    const t = getComputedStyle(el).transform
    if (!t || t === 'none') return { sx: 1, sy: 1 }
    const m = new DOMMatrixReadOnly(t)
    return { sx: +m.a.toFixed(3), sy: +m.d.toFixed(3) }
  }
  /**
   * 把场景停在这一格上，等驱动侧拍完再继续（截图只能从驱动侧发起）。
   * 不开截图时直接返回，场景照常一口气跑完。
   */
  const waitForShot = async (name) => {
    if (!window.__shotEnabled) return
    window.__shot = name
    for (let i = 0; i < 200 && window.__shotAck !== name; i += 1) await sleep(50)
  }

  /**
   * 把快照缩到 160 宽读一遍 alpha：既然 drawImage 在桩里是空函数，
   * "上面到底有没有画出那一帧"就只能在这里问真像素。
   */
  const inkOf = (cv) => {    const w = Math.min(cv.width, 160)
    const h = Math.max(1, Math.round(cv.height * (w / cv.width)))
    const probe = document.createElement('canvas')
    probe.width = w
    probe.height = h
    const ctx = probe.getContext('2d')
    ctx.drawImage(cv, 0, 0, w, h)
    let data = null
    try {
      data = ctx.getImageData(0, 0, w, h).data
    } catch (err) {
      return null
    }
    let ink = 0
    let top = -1
    let bottom = -1
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (data[(y * w + x) * 4 + 3] > 24) {
          ink += 1
          if (top < 0) top = y
          bottom = y
        }
      }
    }
    return { ink: ink, ratio: +(ink / (w * h)).toFixed(4), top: top, bottom: bottom, h: h }
  }

  /* --- 电饭煲：按住 → 这张定格帧被压扁；松开 → 弹回 --------------------- */

  const cooker = part('cooker')
  const crop = cropOf('cooker')
  if (!cooker || !crop) {
    fail('the cooker must be split into its own part by now')
    return { checks: checks, notes: notes }
  }
  if (layer('cooker')) fail('nothing may be squashed before the press')
  else pass('nothing is squashed before the press')

  await waitForShot('cooker-before')
  sendPointer(cooker, 'pointerdown', 101)
  const snap = layer('cooker')
  if (snap) pass('pressing the cooker paints a snapshot')
  else fail('pressing the cooker must paint a snapshot')
  if (!snap) return { checks: checks, notes: notes }

  await sleep(40)
  notes.early = scaleOf(snap)
  if (notes.early.sy > 0.9) pass('the squash starts from full size (the transition really runs)')
  else fail('the squash must animate, not jump: ' + JSON.stringify(notes.early))

  await sleep(340)
  notes.held = scaleOf(snap)
  if (Math.abs(notes.held.sy - 0.88) < 0.02 && Math.abs(notes.held.sx - 1.05) < 0.02) {
    pass('held at scaleY 0.88 / scaleX 1.05 (the whale widget\\'s squish)')
  } else {
    fail('the held transform must be scaleY .88 / scaleX 1.05, got ' + JSON.stringify(notes.held))
  }
  if (getComputedStyle(crop).visibility === 'hidden') pass('the frozen crop yields to the snapshot')
  else fail('the crop must be hidden while the snapshot is stretched')

  const pr = cooker.getBoundingClientRect()
  const sr = snap.getBoundingClientRect()
  notes.geometry = {
    part: { w: +pr.width.toFixed(2), h: +pr.height.toFixed(2), bottom: +pr.bottom.toFixed(2) },
    snap: { w: +sr.width.toFixed(2), h: +sr.height.toFixed(2), bottom: +sr.bottom.toFixed(2) },
  }
  if (Math.abs(sr.bottom - pr.bottom) < 1.5) pass('the squash pivots on the bottom edge (the pot stays put)')
  else fail('the bottom edge must stay put: ' + JSON.stringify(notes.geometry))
  if (Math.abs(sr.width / pr.width - 1.05) < 0.04) pass('and widens by 1.05x around the centre')
  else fail('the width must grow by 1.05x: ' + JSON.stringify(notes.geometry))

  notes.ink = inkOf(snap)
  if (notes.ink && notes.ink.ink > 50 && notes.ink.ratio > 0.01) {
    pass('the snapshot really carries the frame (non-empty pixels)')
  } else {
    fail('the snapshot must carry the frame it was taken from: ' + JSON.stringify(notes.ink))
  }
  await waitForShot('cooker')

  sendPointer(cooker, 'pointerup', 101)
  await sleep(40)
  notes.release = scaleOf(snap)
  if (notes.release.sy > 0.9) pass('releasing starts the bounce back')
  else fail('releasing must bounce back: ' + JSON.stringify(notes.release))
  await sleep(450)
  if (!layer('cooker')) pass('the snapshot is gone once the bounce is over')
  else fail('the snapshot must be taken away after the bounce')
  if (getComputedStyle(crop).visibility !== 'hidden') pass('and the frozen crop is back on screen')
  else fail('the crop must be handed back after the bounce')

  /* --- 小女孩：等一段动画真的在播，按住必须冻住它、松开必须接着播 --------- */

  const girl = part('girl')
  if (!girl) {
    fail('the girl part must exist by now')
    return { checks: checks, notes: notes }
  }
  let clip = null
  for (let i = 0; i < 90 && !clip; i += 1) {
    clip =
      Array.prototype.slice
        .call(document.querySelectorAll('.dshca-anim'))
        .find((v) => getComputedStyle(v).visibility !== 'hidden' && !v.paused && !v.ended) || null
    if (!clip) await sleep(100)
  }
  if (!clip) {
    fail('no animation clip became playable within 9s (cannot check the resume path)')
    return { checks: checks, notes: notes }
  }
  notes.clip = { id: clip.id, time: +clip.currentTime.toFixed(3) }
  const frozenAt = clip.currentTime

  await waitForShot('girl-before')
  sendPointer(girl, 'pointerdown', 102)
  await sleep(60)
  notes.girlClip = { paused: clip.paused, time: +clip.currentTime.toFixed(3) }
  if (clip.paused) pass('THE ASK: pressing her freezes the clip on the frame it was showing')
  else fail('the clip must be paused while she is held')
  const snap2 = layer('girl')
  if (snap2) pass('and a snapshot of that frame is what gets stretched')
  else fail('a snapshot must take the screen while she is held')
  if (snap2) {
    await sleep(320)
    const held2 = scaleOf(snap2)
    notes.girlHeld = held2
    if (Math.abs(held2.sy - 0.88) < 0.02 && Math.abs(held2.sx - 1.05) < 0.02) pass('the girl squashes too')
    else fail('the girl must squash like the cooker: ' + JSON.stringify(held2))
    notes.girlInk = inkOf(snap2)
    if (notes.girlInk && notes.girlInk.ink > 50) pass('with her own frame painted into it')
    else fail('her snapshot must carry her frame: ' + JSON.stringify(notes.girlInk))
    await waitForShot('girl')
  }

  sendPointer(girl, 'pointerup', 102)
  await sleep(500)
  notes.girlResume = { paused: clip.paused, time: +clip.currentTime.toFixed(3) }
  if (!clip.paused) pass('THE ASK: playback continues after the click')
  else fail('the clip must resume after the click')
  if (clip.currentTime >= frozenAt) pass('...from where it was frozen, not from the top')
  else fail('resume must continue, not restart: ' + JSON.stringify(notes.girlResume))
  if (!layer('girl')) pass('with no snapshot left behind')
  else fail('no snapshot may be left behind')

  /* --- 按压音效：素材真的能解码 / AudioContext 真的在跑 / CD 真的挡得住 --- */

  const api = window.__dshcaPress
  if (!api) {
    fail('window.__dshcaPress must be exposed for auditioning and probing')
    return { checks: checks, notes: notes }
  }
  pass('the press-sound API is exposed')

  const ready = await api.ready()
  const first = api.probe()
  notes.sound = {
    ready: ready,
    pipeSeconds: first.pipeSeconds,
    context: first.context,
    volume: first.volume,
    pipeChance: first.pipeChance,
  }
  if (ready && first.pipeSeconds > 2 && first.pipeSeconds < 2.6) {
    pass('pipe.mp3 is served and decodes to the trimmed 2.4s clip (the byte-trim did not corrupt it)')
  } else {
    fail('the pipe asset must decode to the trimmed clip: ' + JSON.stringify(notes.sound))
  }
  if (first.context === 'running') pass('the AudioContext is running, not blocked by autoplay policy')
  else fail('the AudioContext must be running: ' + JSON.stringify(first.context))

  // 手动听一遍两路音（不受 CD 限制）—— 证明两路都能真的起播而不抛异常。
  if (api.play('synth') === true) pass('the synthesised pop starts on demand')
  else fail('the synthesised pop must start on demand')
  if (api.play('pipe') === true) pass('the pipe easter egg starts on demand')
  else fail('the pipe easter egg must start on demand')

  // 真实按压一次出声；紧接着再按一次必须被 CD 挡掉（plays 不增、skipped 增）。
  const tap = (el, id) => {
    sendPointer(el, 'pointerdown', id)
    sendPointer(el, 'pointerup', id)
  }
  api.reset()
  const p0 = api.probe()
  tap(cooker, 103)
  const p1 = api.probe()
  notes.soundTap1 = { plays: p1.plays - p0.plays, skipped: p1.skipped - p0.skipped, busyForMs: p1.busyForMs, kind: p1.lastKind }
  if (p1.plays === p0.plays + 1 && p1.busyForMs > 0) pass('a real press plays exactly one sound and opens a CD window')
  else fail('a real press must play one sound: ' + JSON.stringify(notes.soundTap1))

  tap(cooker, 104)
  const p2 = api.probe()
  notes.soundTap2 = { plays: p2.plays - p1.plays, skipped: p2.skipped - p1.skipped }
  if (p2.plays === p1.plays && p2.skipped === p1.skipped + 1) {
    pass('THE ASK: while the previous sound is still playing a second press stays silent')
  } else {
    fail('the CD must suppress the overlapping press: ' + JSON.stringify(notes.soundTap2))
  }

  // 等 CD 真的走完（掷到钢管音时它是 2.4 秒），再按一次必须重新出声。
  for (let i = 0; i < 60 && api.probe().busyForMs > 0; i += 1) await sleep(100)
  tap(cooker, 105)
  const p3 = api.probe()
  notes.soundTap3 = { plays: p3.plays - p2.plays, busyForMs: p3.busyForMs }
  if (p3.plays === p2.plays + 1) pass('once the CD is over the next press sounds again')
  else fail('the press must sound again after the CD: ' + JSON.stringify(notes.soundTap3))

  /* --- 掉盆：从天而降、扣在头上、可以摞、可以拖走 ------------------------- */

  const pots = window.__dshcaPots
  if (!pots) {
    fail('window.__dshcaPots must be exposed')
    return { checks: checks, notes: notes }
  }
  pass('the basin API is exposed')

  const girlBox = girl.getBoundingClientRect()
  // 这两张留痕用"放大局部"更看得清：盆比她那块还宽一点。
  const clipFor = (extraTop) => {
    const b = girl.getBoundingClientRect()
    const x = Math.max(0, b.left - 26)
    const y = Math.max(0, b.top - extraTop)
    const right = Math.min(window.innerWidth, b.right + 26)
    const bottom = Math.min(window.innerHeight, b.bottom + 26)
    return {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(right - x),
      height: Math.round(bottom - y),
      scale: 2,
    }
  }
  await api.ready('pot')
  const dropOne = async () => {
    const before = pots.probe().count
    pots.drop()
    await sleep(560) // 掉落 420ms + 落地那一下
    return pots.probe().count === before + 1
  }
  if (await dropOne()) pass('a basin drops and lands on her head')
  else fail('drop() must put a basin on her head: ' + JSON.stringify(pots.probe()))
  const one = pots.probe()
  notes.basin = { count: one.count, items: one.items, host: one.host, imageReady: one.imageReady }
  if (one.imageReady) pass('the basin image was preloaded (no flash of nothing while it falls)')
  else fail('basin.png must be preloaded')
  const firstItem = one.items[0]
  if (firstItem && firstItem.landed && Math.abs(firstItem.tilt) > 2) {
    pass('it lands tilted, resting on her head')
  } else {
    fail('the basin must land tilted: ' + JSON.stringify(firstItem))
  }

  // 几何：盆宽 = 块宽 × 1.08、下沿 = 块高 × 0.40。
  // 注意量的是 *布局值**（style.width / style.top），不能用 getBoundingClientRect：
  // 盆带着 rotate(9deg)，包围盒会被旋转撑大 ~9%（真实宽度 64.7 量出来是 70.7），
  // 那量到的是"转完之后的盒子"，不是它摆在哪。
  const potEl = document.querySelector('#dshca-pots .dshca-pot')
  if (potEl) {
    const layoutW = parseFloat(potEl.style.width)
    const layoutRim = parseFloat(potEl.style.top) + parseFloat(potEl.style.height)
    const wRatio = layoutW / girlBox.width
    const rimRatio = layoutRim / girlBox.height
    notes.basinGeometry = {
      girlWidth: +girlBox.width.toFixed(1),
      girlHeight: +girlBox.height.toFixed(1),
      potLayoutWidth: +layoutW.toFixed(2),
      widthRatio: +wRatio.toFixed(3),
      rimFromTop: +layoutRim.toFixed(1),
      rimRatio: +rimRatio.toFixed(3),
      rotatedBox: +potEl.getBoundingClientRect().width.toFixed(1),
    }
    if (Math.abs(wRatio - 1.08) < 0.01) pass('the basin is 1.08 of her part wide')
    else fail('basin width ratio: ' + JSON.stringify(notes.basinGeometry))
    if (Math.abs(rimRatio - 0.40) < 0.01) {
      pass('its rim lands on her head (0.40 of the part height)')
    } else {
      fail('basin rim ratio: ' + JSON.stringify(notes.basinGeometry))
    }
    if (layoutRim <= girlBox.height * 0.5) {
      pass('and it sits on the upper half of her, i.e. on the head')
    } else {
      fail('the basin must sit on her head, not her body')
    }
  }
  window.__shotClip = clipFor(70)
  await waitForShot('basin')
  window.__shotClip = null

  // 摞第二个：必须坐在第一个上面，且不动下面那个。
  const firstTop = pots.probe().items[0].top
  if (await dropOne()) pass('a second basin can be dropped')
  else fail('the second drop failed')
  const two = pots.probe()
  notes.basinStack = two.items
  if (two.count === 2 && two.items[1].top < two.items[0].top) {
    pass('THE ASK: basins stack up, the new one higher than the last')
  } else {
    fail('the second basin must sit on top: ' + JSON.stringify(two.items))
  }
  if (Math.abs(two.items[0].top - firstTop) < 0.5) pass('and the first one does not move')
  else fail('stacking must not disturb the basin below')
  window.__shotClip = clipFor(120)
  await waitForShot('basin-stack')

  // 拖到一旁 → 摘掉。
  const topPot = document.querySelectorAll('#dshca-pots .dshca-pot')[1]
  const topRect = topPot.getBoundingClientRect()
  const fromX = topRect.left + topRect.width / 2
  const fromY = topRect.top + topRect.height / 2
  const potPointer = (type, x, y, buttons) => {
    topPot.dispatchEvent(
      new PointerEvent(type, {
        pointerId: 106,
        pointerType: 'mouse',
        isPrimary: true,
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: buttons,
        clientX: x,
        clientY: y,
      }),
    )
  }
  potPointer('pointerdown', fromX, fromY, 1)
  for (const step of [40, 90, 150]) potPointer('pointermove', fromX + step, fromY + 20, 1)
  const dragged = pots.probe()
  notes.basinDrag = dragged.items
  if (dragged.items.some((i) => i.dragging)) pass('a basin can be dragged (it follows the pointer)')
  else fail('dragging a basin must move it: ' + JSON.stringify(dragged.items))
  potPointer('pointerup', fromX + 150, fromY + 20, 0)
  await sleep(150)
  const afterDrag = pots.probe()
  notes.basinAfterDrag = afterDrag
  if (afterDrag.count === 1) pass('THE ASK: dragging it aside takes it off her head')
  else fail('dragging aside must remove that basin: ' + JSON.stringify(afterDrag))
  if (afterDrag.items[0] && afterDrag.items[0].index === 0) pass('and the one below re-stacks as the bottom')
  else fail('the remaining basin must become the bottom of the stack')
  if (!layer('girl')) pass('no stray squash snapshot after all that basin dragging')
  else fail('the basin drag must not leave a squash snapshot behind')

  return { checks: checks, notes: notes }
})()`

/* --------------------------------------------------------------------- driver */

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
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    const r = res.result || {}
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'exception in page')
    return r.result ? r.result.value : undefined
  }

  // 先把开场动画放完（它播完才拆成两块）。
  const end = Date.now() + 60000
  let split = false
  while (Date.now() < end) {
    split = await evaluate(
      "(() => { try { return !!document.getElementById('dshca-part-cooker') } catch (e) { return false } })()",
    )
    if (split) break
    await sleep(400)
  }
  if (!split) console.log('[warn] the split never happened; the checks below will say so')

  const shoot = async (file) => {
    // 场景可以举一块"只看这一小片"的牌子（盆只有几十像素宽，全屏截图看不清）。
    const clip = await evaluate(
      '(function(){var c=window.__shotClip;if(!c)return null;return {x:Math.round(c.x),y:Math.round(c.y),width:Math.round(c.width),height:Math.round(c.height),scale:c.scale||1}})()',
    )
    const shot = await send(
      'Page.captureScreenshot',
      clip && clip.width > 0 && clip.height > 0
        ? { format: 'png', captureBeyondViewport: false, clip }
        : { format: 'png', captureBeyondViewport: false },
    )
    const data = shot.result && shot.result.data
    if (!data) throw new Error('captureScreenshot returned nothing')
    fs.mkdirSync(SHOT_DIR, { recursive: true })
    fs.writeFileSync(file, Buffer.from(data, 'base64'))
    console.log(`screenshot: ${file}`)
  }

  // 场景在"压扁中"的两个瞬间会停下来等一张截图，所以这里不能直接 await：
  // 一边轮询它举的牌子，一边等它跑完。
  await evaluate(`window.__shotEnabled = ${WANT_SHOTS ? 'true' : 'false'}`)
  let report = null
  let settled = false
  const scenario = evaluate(SCENARIO).then(
    (r) => {
      report = r
      settled = true
    },
    (err) => {
      report = { checks: [{ ok: false, what: 'the scenario threw: ' + (err && err.message) }], notes: {} }
      settled = true
    },
  )
  while (!settled) {
    const pendingShot = await evaluate(
      '(window.__shot && window.__shot !== window.__shotAck) ? window.__shot : null',
    )
    if (pendingShot) {
      await shoot(path.join(SHOT_DIR, 'v080-squish-' + pendingShot + '.png'))
      await evaluate('window.__shotAck = ' + JSON.stringify(pendingShot))
    } else {
      await sleep(120)
    }
  }
  await scenario

  const checks = (report && report.checks) || []
  for (const c of checks) console.log(`${c.ok ? '  ok  ' : ' FAIL '}${c.what}`)
  console.log('\nnotes:', JSON.stringify((report && report.notes) || {}, null, 2))
  const failed = checks.filter((c) => !c.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} real-browser squish checks passed.`)
  if (failed.length) process.exitCode = 1
  ws.close()
} catch (err) {
  console.error('cdp-squish failed:', err && err.message)
  process.exitCode = 1
} finally {
  try {
    child.kill()
  } catch {
    /* gone */
  }
}

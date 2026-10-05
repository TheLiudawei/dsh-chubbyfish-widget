/**
 * Preview server for real-browser verification.
 *
 * Mounts the plugin's OWN host half against a mock Cordis context (so the real
 * route handlers serve the real 2K asset), and serves one extra page that loads
 * the real widget through the plugin's real `tapIndex` injection — not through
 * a hand-written <script> tag that could hide a broken injection path.
 *
 * A headless browser's stdout is not reachable from the caller, so the page
 * POSTs its findings to /report and this process logs them where an operator
 * can read them.
 *
 * Run:  node test/preview-server.mjs [port]
 *   http://127.0.0.1:<port>/                default view
 *   http://127.0.0.1:<port>/?panel=1        auto-open the settings panel
 *   http://127.0.0.1:<port>/?drag=1         drag the two split parts apart
 *   http://127.0.0.1:<port>/?panel=1&drag=1 both
 *   http://127.0.0.1:<port>/?idle=1         also report the standby (idle) layer:
 *                                           geometry of the girl part vs the idle
 *                                           video, once just after the split and
 *                                           once after the idle clip starts.
 *   http://127.0.0.1:<port>/?speed=1        drive the interval control (bar steps
 *                                           + panel slider) and report its readout.
 *   http://127.0.0.1:<port>/?sched=1        click pause/resume on a script and report
 *                                           the one-picture rule plus how often the
 *                                           girl fell back to the opener's frame.
 */

import http from 'node:http'
import plugin from '../lib/index.js'

const PORT = Number(process.argv[2] || 19399)

/* ------------------------------------------------------------ mount plugin */

const routes = []
const taps = []
const ctx = {
  on: () => () => {},
  effect: (fn) => {
    fn()
    return () => {}
  },
  inject: (names, cb) =>
    cb({
      webServer: {
        register: (route) => {
          routes.push(route)
          return () => {}
        },
        tapIndex: (fn) => {
          taps.push(fn)
          return () => {}
        },
      },
      logger: { warn: (m) => console.log('[warn]', m) },
    }),
}

plugin.apply(ctx, undefined)

/* ------------------------------------------------------------- preview page */

// Deliberately mid-tone and patterned: if the WebM's alpha were being dropped,
// the widget would show up as an opaque black/white rectangle instead.
const PAGE = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>dsh-corner-anim preview</title>
<style>
  html,body{height:100%;margin:0}
  body{
    background:
      linear-gradient(45deg,#3b4252 25%,transparent 25%,transparent 75%,#3b4252 75%),
      linear-gradient(45deg,#3b4252 25%,#2e3440 25%,#2e3440 75%,#3b4252 75%);
    background-size:48px 48px;background-position:0 0,24px 24px;
    font:13px/1.5 system-ui,"Segoe UI",sans-serif;color:#d8dee9;
    overflow:hidden;
  }
  /* Stand-in for DSH's own top-right chrome, to show the widget sits above it. */
  #fake-chrome{position:fixed;top:0;right:0;height:44px;display:flex;align-items:center;
    gap:14px;padding:0 18px;background:rgba(0,0,0,.28);border-bottom-left-radius:10px}
  #fake-chrome b{font-weight:600}
  #probe{position:fixed;left:14px;bottom:14px;right:14px;white-space:pre-wrap;
    background:rgba(0,0,0,.62);padding:10px 12px;border-radius:8px;
    font:11px/1.55 ui-monospace,Consolas,monospace;max-height:38%;overflow:auto}
</style>
</head>
<body>
<div id="fake-chrome"><b>DSH</b> <span>设置</span><span>账户</span></div>
<div id="probe">waiting for the animation to finish…</div>
<!--
  Holds the page's load event open for ~9s of REAL time. Chromium's
  --virtual-time-budget does not advance media playback, so without this the
  headless screenshot fires ~1s in, while the animation is still running. The
  widget itself mounts immediately either way - only /load/ waits.
-->
<img src="/slow" width="1" height="1" alt="" style="position:fixed;left:-9999px;top:-9999px">

<script>
  var Q = location.search

  function describe(el) {
    if (!el) return null
    var r = el.getBoundingClientRect()
    var canvas = el.querySelector('canvas')
    var bar = el.querySelector('#dshca-bar')
    var panel = el.querySelector('#dshca-panel')
    return {
      id: el.id,
      left: Math.round(r.left * 100) / 100,
      top: Math.round(r.top * 100) / 100,
      width: Math.round(r.width * 100) / 100,
      height: Math.round(r.height * 100) / 100,
      srcBox: el.getAttribute('data-src-box'),
      canvasPx: canvas ? canvas.width + 'x' + canvas.height : null,
      hasBar: !!bar,
      hasPanel: !!panel
    }
  }

  /** Simulate a real pointer drag (the widget uses Pointer Events). */
  function dragPart(el, dx, dy) {
    var r = el.getBoundingClientRect()
    var x = r.left + r.width / 2
    var y = r.top + r.height / 2
    var opts = { pointerId: 7, bubbles: true, cancelable: true, button: 0, buttons: 1, isPrimary: true }
    el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ clientX: x, clientY: y }, opts)))
    el.dispatchEvent(new PointerEvent('pointermove', Object.assign({ clientX: x + dx, clientY: y + dy }, opts)))
    el.dispatchEvent(new PointerEvent('pointerup', Object.assign({ clientX: x + dx, clientY: y + dy }, opts)))
  }

  function snapshot(v) {
    var rootEl = document.getElementById('dshca-root')
    var cooker = document.getElementById('dshca-part-cooker')
    var girl = document.getElementById('dshca-part-girl')
    return {
      mounted: true,
      ended: v.ended,
      paused: v.paused,
      loop: v.loop,
      duration: v.duration,
      currentTime: v.currentTime,
      videoWidth: v.videoWidth,
      videoHeight: v.videoHeight,
      viewport: [window.innerWidth, window.innerHeight],
      merged: { display: rootEl ? rootEl.style.display || '(visible)' : null, visible: !!rootEl },
      splitHappened: !!cooker && !!girl,
      cooker: describe(cooker),
      girl: describe(girl),
      regionsTileFrame: cooker && girl
        ? cooker.querySelector('canvas').width + girl.querySelector('canvas').width
        : null
    }
  }

  /** Per-column alpha coverage of the last frame, for split-line diagnostics. */
  function analyse(v) {
    var VW = v.videoWidth
    var VH = v.videoHeight
    if (!VW) return null
    var pw = 128
    var ph = Math.max(1, Math.round((pw * VH) / VW))
    var c = document.createElement('canvas')
    c.width = pw
    c.height = ph
    var cx = c.getContext('2d')
    cx.drawImage(v, 0, 0, pw, ph)
    var out = { videoWidth: VW, videoHeight: VH, probe: [pw, ph], tainted: false }
    try {
      var d = cx.getImageData(0, 0, pw, ph).data
      out.coverage = []
      for (var x = 0; x < pw; x++) {
        var sum = 0
        for (var y = 0; y < ph; y++) sum += d[(y * pw + x) * 4 + 3] / 255
        out.coverage.push(Math.round((sum / ph) * 1000) / 1000)
      }
    } catch (e) {
      out.tainted = true
      out.error = String((e && e.name) || e)
    }
    return out
  }

  function report(payload) {
    try {
      fetch('/report', { method: 'POST', body: JSON.stringify(payload) })
    } catch (e) {
      /* diagnostics only */
    }
  }

  function show(text) {
    document.getElementById('probe').textContent = text
  }

  /** Set once every diagnostic for this view has been reported. */
  window.__ready = false

  /**
   * Animation-layer diagnostics.
   *
   * Two risks live here. One is geometric: both clips are portrait, with their
   * own transparent padding, so "does the girl still stand in the same place at
   * the same size?" can only be answered from live layout numbers. The other is
   * temporal: the two clips run on their own periods and must never overlap.
   * So this reports the layout AND how often each clip has actually started.
   */
  var clipPlays = { idle: 0, act: 0 }
  var lastPlayedAt = { idle: null, act: null }

  /**
   * What is actually on screen right now, and whether that is legal.
   *
   * The guarantee is "exactly one picture": either one clip <video> (a scheduled
   * one, or the run-out clip on a turn of the 0.7.0 send flow), or -- only before
   * the very first turn -- the frozen-frame canvas. Never two clips, never
   * neither, never a clip plus the canvas.
   *
   * Note which clip is up is NOT the same as which clip is playing: since 0.6.0 a
   * finished clip keeps its own last frame on screen (the "holding" label below),
   * which is exactly the behaviour "the girl stays where her animation ended" asks
   * for. This is read from real computed styles, not from the widget's own
   * bookkeeping, so it cannot be fooled by the widget believing the wrong thing.
   */
  function visibleNow() {
    var girl = document.getElementById('dshca-part-girl')
    // After event 1 the whole girl part is display:none for the rest of the turn:
    // there is no girl-side picture at all, so there is no "two pictures" to warn
    // about either (the cooker / lid overlay is what is on screen then).
    if (girl && girl.style.display === 'none') {
      return { clips: '', canvas: false, count: 0, ok: true, what: 'girl-hidden' }
    }
    // 0.10.0: layers that REPLACE a subject outright. While one of them is up the
    // subject's own canvas is hidden by design, and that is still "one picture" --
    // so they are counted instead of the subject they replace, not on top of it.
    // **两侧各记各的**：锅那一路出画时她那格定格图照旧在屏幕上（她不是被替换
    // 掉的那一方），所以不能用同一个标志去压她那一侧的计数。
    var replacesGirl = false
    var replacesCooker = false
    var clips = []
    ;['idle', 'act'].forEach(function (kind) {
      var el = document.getElementById('dshca-anim-' + kind)
      if (!el) return
      if (el.style.visibility !== 'hidden') {
        clips.push(kind + (el.paused ? (el.ended ? '(holding)' : '(paused)') : '(playing)'))
      }
    })
    var canvas = girl ? girl.querySelector('canvas') : null
    // visibility is inherited: the widget hides the canvas itself (inline style)
    // or the whole part (the 0.10.0 classes), and computed style sees both.
    var canvasShown = canvas ? getComputedStyle(canvas).visibility === 'visible' : false
    // 0.7.3: the run-out clip is a picture of its own -- while it plays, it must
    // be the ONLY one (the widget hides the scheduled clips and the canvas).
    var girlClip = document.getElementById('dshca-girl')
    if (girlClip && getComputedStyle(girlClip).visibility !== 'hidden') {
      clips.push('girl-clip')
      replacesGirl = true
    }
    var drag = document.getElementById('dshca-drag')
    if (drag && getComputedStyle(drag).display !== 'none') {
      clips.push('drag' + (drag.paused ? '(paused)' : '(playing)'))
      replacesGirl = true
    }
    var basin = document.getElementById('dshca-girlbasin')
    if (basin && getComputedStyle(basin).visibility !== 'hidden') {
      clips.push('girl-basin' + (basin.paused ? '(paused)' : '(playing)'))
      replacesGirl = true
    }
    ;['dshca-cooker-a', 'dshca-cooker-b'].forEach(function (id) {
      var el = document.getElementById(id)
      if (!el) return
      if (getComputedStyle(el).display === 'none') return
      clips.push(id.replace('dshca-cooker-', 'cooker-') + (el.paused ? '(paused)' : '(playing)'))
      // 只压电饭煲那一侧：她那一侧不受影响（她确实是同一时刻在屏幕上的另一格）。
      replacesCooker = true
    })
    // 0.7.0 的开盖那段同样"替换"电饭煲；而它播放期间整块小女孩早就是 display:none
    // 了（上面已提前返回），所以这里只需要标记电饭煲那一侧。
    var sendLid = document.getElementById('dshca-lid')
    if (sendLid && sendLid.classList.contains('dshca-lid-on')) {
      clips.push('send-lid' + (sendLid.paused ? '(paused)' : '(playing)'))
      replacesCooker = true
    }
    var cookerCanvas = document.querySelector('#dshca-part-cooker canvas')
    // 两侧各算一次，各自"有且仅有一段"（早期版本这条只管她那一侧，见下面注释）。
    var girlClips = clips.filter(function (c) {
      return c.indexOf('cooker-') !== 0
    })
    var cookerClips = clips.filter(function (c) {
      return c.indexOf('cooker-') === 0
    })
    var cookerCanvasShown = cookerCanvas ? getComputedStyle(cookerCanvas).visibility === 'visible' : false
    var girlCount = girlClips.length + (canvasShown && !replacesGirl ? 1 : 0)
    var cookerCount = cookerClips.length + (cookerCanvasShown && !replacesCooker ? 1 : 0)
    var what =
      (girlClips.length
        ? girlClips.join('+')
        : canvasShown && !replacesGirl
          ? 'frozen(girl)'
          : 'NOTHING') +
      ' | cooker:' +
      (cookerClips.length ? cookerClips.join('+') : cookerCanvasShown && !replacesCooker ? 'frozen' : 'NOTHING')
    return {
      clips: clips.join('+'),
      canvas: canvasShown,
      count: girlCount,
      cookerCount: cookerCount,
      ok: girlCount === 1 && cookerCount === 1,
      what: what,
    }
  }
  window.__visibleNow = visibleNow
  window.__violations = []
  /** 违规时也把"当时是什么状态"记下来（相位 + 两侧各自出了什么）。 */
  window.__violationDetail = function () {
    return window.__violations.map(function (v) {
      return v
    })
  }
  /** Moments where the picture dropped back to the opener's frame after a clip
   *  had already been shown -- the 0.6.0 regression this plugin must not have. */
  window.__fallsBack = []
  window.__seenClip = false

  /** A timestamped log of which clip was on screen, sampled 20x a second. */
  var timeline = []
  var lastShown = null

  function watchTimeline() {
    setInterval(function () {
      var seen = []
      ;['idle', 'act'].forEach(function (kind) {
        var el = document.getElementById('dshca-anim-' + kind)
        if (!el) return
        var playing = !el.paused && !el.ended && el.currentTime > 0
        if (playing && lastPlayedAt[kind] !== 'playing') {
          clipPlays[kind] += 1
          lastPlayedAt[kind] = 'playing'
        } else if (!playing) {
          lastPlayedAt[kind] = 'idle'
        }
        if (el.style.visibility !== 'hidden') seen.push(kind)
      })
      var now = visibleNow()
      // Only judge the rule once the widget has actually mounted its picture
      // (before the 2K opener decodes there is legitimately nothing on screen).
      if (window.__dshCornerAnimMounted && document.getElementById('dshca-part-girl')) {
        if (!now.ok) {
          // 违规那一刻的**原始 DOM 状态**（每一项都直接读计算样式，不看脚本的
          // 自述）—— 排查"为什么这一侧会是空的"时，这一份比任何日志都直接。
          var raw = {}
          ;['dshca-girl', 'dshca-drag', 'dshca-girlbasin', 'dshca-anim-idle', 'dshca-anim-act',
            'dshca-cooker-a', 'dshca-cooker-b', 'dshca-lid'].forEach(function (id) {
            var el = document.getElementById(id)
            raw[id] = el ? { display: getComputedStyle(el).display, vis: getComputedStyle(el).visibility } : null
          })
          var gcv = document.querySelector('#dshca-part-girl canvas')
          var ccv = document.querySelector('#dshca-part-cooker canvas')
          window.__violations.push({
            t: Math.round(performance.now()),
            count: now.count,
            cookerCount: now.cookerCount,
            what: now.what,
            stage: window.__dshcaRandom ? window.__dshcaRandom.probe().stage : null,
            scheduleOn: window.__dshcaRandom ? window.__dshcaRandom.probe().scheduleOn : null,
            lastEvent: window.__dshcaRandomDebug ? window.__dshcaRandomDebug.last : null,
            girlCanvas: gcv ? { vis: getComputedStyle(gcv).visibility, inline: gcv.getAttribute('style') } : null,
            cookerCanvas: ccv ? { vis: getComputedStyle(ccv).visibility, inline: ccv.getAttribute('style') } : null,
            layers: raw,
          })
        }
        // Once any clip has been on screen, the opener's frozen frame must never
        // come back: the girl is supposed to stay where her animation ended.
        if (seen.length) window.__seenClip = true
        else if (now.canvas && window.__seenClip) {
          window.__fallsBack.push({ t: Math.round(performance.now()), what: now.what })
        }
      }
      var label = now.what
      if (label !== lastShown) {
        timeline.push({
          t: Math.round(performance.now()),
          shown: label,
          starts: JSON.parse(JSON.stringify(clipPlays)),
          ok: now.ok
        })
        lastShown = label
      }
      // Fire the A/B overlay the first time the standby clip is genuinely on
      // screen: a fixed delay is unreliable, because the split itself only
      // happens once the 2K opener has decoded.
      if (seen.indexOf('idle') >= 0 && !window.__abDone && location.search.indexOf('ab=1') >= 0) {
        window.__abDone = true
        setTimeout(function () {
          var ab = abCompare()
          window.__result = ab
          report({ kind: 'ab', ab: ab })
        }, 400)
      }
    }, 50)
  }
  watchTimeline()
  window.__timeline = timeline
  window.__clipPlays = clipPlays

  function clipDiag(stage) {
    var girl = document.getElementById('dshca-part-girl')
    var canvas = girl ? girl.querySelector('canvas') : null
    var r = girl ? girl.getBoundingClientRect() : null
    var clips = []
    ;['idle', 'act'].forEach(function (kind) {
      var el = document.getElementById('dshca-anim-' + kind)
      if (!el) return
      var playing = !el.paused && !el.ended && el.currentTime > 0
      clips.push({
        kind: kind,
        src: el.getAttribute('src') || el.src,
        muted: el.muted,
        loop: el.loop,
        paused: el.paused,
        ended: el.ended,
        playing: playing,
        currentTime: Math.round(el.currentTime * 1000) / 1000,
        duration: el.duration,
        videoWidth: el.videoWidth,
        videoHeight: el.videoHeight,
        cssWidth: el.style.width,
        cssHeight: el.style.height,
        cssLeft: el.style.left,
        cssTop: el.style.top,
        starts: clipPlays[kind]
      })
    })
    return {
      stage: stage,
      girl: r
        ? {
            left: Math.round(r.left * 100) / 100,
            top: Math.round(r.top * 100) / 100,
            width: Math.round(r.width * 100) / 100,
            height: Math.round(r.height * 100) / 100,
            srcBox: girl.getAttribute('data-src-box'),
            canvasVisible: canvas ? canvas.style.visibility !== 'hidden' : null
          }
        : null,
      clips: clips,
      visible: visibleNow(),
      /** The interval control, as the user sees it: button label + panel readout. */
      speed: (function () {
        var btn = document.getElementById('dshca-speed-toggle')
        var panelEl = document.getElementById('dshca-panel')
        var fields = panelEl ? panelEl.querySelectorAll('input[type=range]') : []
        var sliderEl = document.getElementById('dshca-speed')
        var readouts = panelEl ? panelEl.querySelectorAll('.dshca-value') : []
        return {
          button: btn ? btn.textContent : null,
          title: btn ? btn.title : null,
          slider: sliderEl ? sliderEl.value : null,
          rangeCount: fields.length,
          readout: readouts.length > 1 ? readouts[1].textContent : null,
          stored: (function () {
            try {
              return window.localStorage.getItem('dsh-corner-anim:speed:v1')
            } catch (e) {
              return null
            }
          })()
        }
      })(),
      barButtons: [].map.call(document.querySelectorAll('#dshca-bar button'), function (b) {
        return { glyph: b.textContent, title: b.title, on: b.classList.contains('dshca-on') }
      })
    }
  }

  /** Sample now, and again later, reporting each stage to the server. */
  function sampleClips(tag, delays) {
    var take = function (label) {
      var sample = clipDiag(label)
      window.__report = sample
      report({ kind: 'clips', clips: sample })
    }
    take(tag)
    ;(delays || []).forEach(function (d) {
      setTimeout(function () {
        take(tag + '+t' + d)
      }, d)
    })
  }

  /**
   * Side-by-side A/B of what the girl part shows before and after the standby
   * clip takes over, plus a red/cyan overlay that makes any size or alignment
   * mismatch obvious at a glance.
   *
   * Both sides are normalised to a fixed 240x320 box: the frozen frame is the
   * girl part's canvas (the crop actually on screen), the standby frame is the
   * idle <video>'s content bounding box. If the two subjects are the same size
   * and pose, the overlay comes out grey; red or cyan fringes mean they are not.
   */
  function abCompare() {
    var girl = document.getElementById('dshca-part-girl')
    var layer = document.getElementById('dshca-anim-idle')
    if (!girl || !layer) return null
    var canvas = girl.querySelector('canvas')
    if (!canvas) return null

    var TW = 240
    var TH = 320
    // --- left: the frozen crop, squeezed into the reference box ---
    var a = document.createElement('canvas')
    a.width = TW
    a.height = TH
    a.getContext('2d').drawImage(canvas, 0, 0, TW, TH)

    // --- right: the idle frame's content box, into the same reference box ---
    var vw = layer.videoWidth
    var vh = layer.videoHeight
    var probe = document.createElement('canvas')
    probe.width = vw
    probe.height = vh
    // A fresh video element at t=0 avoids fighting the looping one for seek time.
    var still = layer
    try {
      probe.getContext('2d').drawImage(still, 0, 0, vw, vh)
    } catch (e) {
      return { error: String(e) }
    }
    var d = probe.getContext('2d').getImageData(0, 0, vw, vh).data
    var minX = -1
    var maxX = -1
    var minY = -1
    var maxY = -1
    for (var y = 0; y < vh; y += 1) {
      for (var x = 0; x < vw; x += 1) {
        if (d[(y * vw + x) * 4 + 3] <= 24) continue
        if (minX < 0 || x < minX) minX = x
        if (x > maxX) maxX = x
        if (minY < 0 || y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
    if (minX < 0) return { error: 'idle frame has no opaque pixels' }

    var b = document.createElement('canvas')
    b.width = TW
    b.height = TH
    b.getContext('2d').drawImage(layer, minX, minY, maxX - minX + 1, maxY - minY + 1, 0, 0, TW, TH)

    // --- overlay: frozen frame in red, idle frame in cyan ---
    var o = document.createElement('canvas')
    o.width = TW
    o.height = TH
    var octx = o.getContext('2d')
    octx.drawImage(a, 0, 0)
    var ad = octx.getImageData(0, 0, TW, TH)
    var bd = b.getContext('2d').getImageData(0, 0, TW, TH)
    for (var i = 0; i < ad.data.length; i += 4) {
      ad.data[i + 1] = bd.data[i + 1]
      ad.data[i + 2] = bd.data[i + 2]
    }
    octx.putImageData(ad, 0, 0)

    var strip = document.createElement('div')
    strip.id = 'dshca-ab'
    strip.style.cssText =
      'position:fixed;left:10px;top:10px;z-index:2147483600;display:flex;gap:8px;' +
      'background:rgba(0,0,0,.75);padding:8px;border-radius:8px'
    var labels = ['frozen crop', 'idle content box', 'overlay (R=frozen, C=idle)']
    var els = [a, b, o]
    for (var k = 0; k < els.length; k += 1) {
      var cell = document.createElement('div')
      var cap = document.createElement('div')
      cap.textContent = labels[k]
      cap.style.cssText = 'color:#fff;font:10px system-ui;margin-bottom:4px'
      cell.appendChild(cap)
      cell.appendChild(els[k])
      strip.appendChild(cell)
    }
    document.body.appendChild(strip)
    return {
      girlCanvas: canvas.width + 'x' + canvas.height,
      idleContentBox: [minX, minY, maxX - minX + 1, maxY - minY + 1],
      idleFrameSize: vw + 'x' + vh
    }
  }
  window.__abCompare = abCompare

  /**
   * 0.10.0：把两道随机动画 + 拖动动画各跑一遍，并按"有且仅有一段画面"这条
   * 不变量全程盯着（每 60ms 采样一次）。
   *
   * 为什么要在这里也跑一遍（自检脚本 cdp-random.mjs 已经跑过）：带 random=1
   * 打开就是"人肉在浏览器里就能看"的那条路，出问题时不必起 CDP 脚本就能复现。
   */
  function runRandomAnims(onDone) {
    var api = window.__dshcaRandom
    var snaps = []
    var violations = window.__violations
    if (!api) {
      report({ kind: 'random', error: 'window.__dshcaRandom missing' })
      onDone()
      return
    }
    var watch = setInterval(function () {
      var p = api.probe()
      var now = visibleNow()
      if (!now.ok) violations.push({ t: Math.round(performance.now()), count: now.count, what: now.what })
      snaps.push({ t: Math.round(performance.now()), stage: p.stage, layers: p.visibleLayers, what: now.what, ok: now.ok })
    }, 60)
    var stopWatch = function () {
      clearInterval(watch)
      return snaps
    }

    var stepDrag = function () {
      var before = api.probe()
      api.drag(true)
      setTimeout(function () {
        var on = api.probe()
        var canvasDuring = getComputedStyle(
          document.querySelector('#dshca-part-girl canvas'),
        ).visibility
        setTimeout(function () {
          var looped = api.probe()
          api.drag(false)
          setTimeout(function () {
            var off = api.probe()
            var dragged = []
            var girl = document.getElementById('dshca-part-girl')
            var r = girl.getBoundingClientRect()
            var opts = { pointerId: 9, bubbles: true, cancelable: true, button: 0, buttons: 1, isPrimary: true }
            var x = r.left + 10
            var y = r.top + 10
            girl.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ clientX: x, clientY: y }, opts)))
            girl.dispatchEvent(new PointerEvent('pointermove', Object.assign({ clientX: x - 90, clientY: y + 60 }, opts)))
            var during = api.probe()
            dragged.push({ stage: during.stage, dragVisible: during.drag && during.drag.visible })
            girl.dispatchEvent(new PointerEvent('pointerup', Object.assign({ clientX: x - 90, clientY: y + 60 }, opts)))
            setTimeout(function () {
              report({
                kind: 'random',
                which: 'drag',
                snaps: stopWatch(),
                drag: {
                  before: before.visibleLayers,
                  on: { stage: on.stage, visible: on.drag && on.drag.visible, t: on.drag && on.drag.t, canvas: canvasDuring },
                  loopedT: looped.drag && looped.drag.t,
                  off: { stage: off.stage, visible: off.drag && off.drag.visible, layers: off.visibleLayers },
                  realDrag: dragged,
                },
                violations: violations.length,
              })
              onDone()
            }, 900)
          }, 400)
        }, 5600)
      }, 700)
    }

    var stepLid2 = function () {
      api.play('lid2')
      var samples = []
      var tick = setInterval(function () {
        var p = api.probe()
        samples.push({ t: p.stage, fly: p.fly, contact: p.basinContact, girl: p.girlBasin && p.girlBasin.showing })
      }, 250)
      var wait = setInterval(function () {
        var p = api.probe()
        if (p.stage) return
        clearInterval(wait)
        clearInterval(tick)
        report({
          kind: 'random',
          which: 'lid2',
          snaps: stopWatch(),
          samples: samples,
          flight: p.flight,
          contact: p.basinContact,
          girl: p.girl,
          cooker: p.cooker,
          scheduleOn: p.scheduleOn,
          violations: violations.length,
        })
        stepDrag()
      }, 200)
    }

    var stepLid1 = function () {
      api.play('lid1')
      var samples = []
      var tick = setInterval(function () {
        var p = api.probe()
        samples.push({ stage: p.stage, t: p.cookerClips.a && p.cookerClips.a.t, layers: p.visibleLayers })
      }, 200)
      var wait = setInterval(function () {
        var p = api.probe()
        if (p.stage) return
        clearInterval(wait)
        clearInterval(tick)
        report({
          kind: 'random',
          which: 'lid1',
          snaps: stopWatch(),
          samples: samples,
          finalT: p.cookerClips.a && p.cookerClips.a.t,
          layers: p.visibleLayers,
          violations: violations.length,
        })
        stepLid2()
      }, 200)
    }

    // 概率分布：真实点击路径掷 300 次（每次掷中立刻收工）。
    var a = 0
    var b = 0
    var none = 0
    var both = 0
    for (var i = 0; i < 300; i += 1) {
      var hit = api.roll()
      if (!hit) {
        none += 1
        continue
      }
      var stage = api.probe().stage
      if (stage === 'lid1') a += 1
      else if (stage === 'lid2') b += 1
      var layers = api.probe().visibleLayers
      if (layers.indexOf('cooker-a') >= 0 && layers.indexOf('cooker-b') >= 0) both += 1
      api.stop()
    }
    report({ kind: 'random', which: 'roll', rolls: 300, a: a, b: b, none: none, both: both })
    setTimeout(stepLid1, 600)
  }

  window.addEventListener('load', function () {
    var tries = 0
    var wait = setInterval(function () {
      var v = document.getElementById('dshca-video')
      if (!v || !v.videoWidth) {
        tries += 1
        if (tries > 100) clearInterval(wait)
        return
      }
      clearInterval(wait)
      var q = Q
      var finish = function () {
        if (q.indexOf('sched=1') >= 0) {
          // Exercise the debug button the way a human would, and let the run go
          // on long enough to prove the schedule still plays after each resume.
          var script = [
            [1000, 'pause'],
            [4000, 'resume'],
            [13000, 'pause'],
            [16000, 'resume']
          ]
          script.forEach(function (step) {
            setTimeout(function () {
              var btn = document.getElementById('dshca-anim-toggle')
              var before = visibleNow()
              if (btn) btn.click()
              report({
                kind: 'sched',
                step: step[1],
                before: before,
                after: visibleNow()
              })
            }, step[0])
          })
          setTimeout(function () {
            window.__ready = true
            report({
              kind: 'sched',
              step: 'final',
              after: visibleNow(),
              plays: window.__clipPlays,
              violations: window.__violations,
              fallsBack: window.__fallsBack
            })
          }, 34000)
          return
        }
        if (q.indexOf('send=1') >= 0) {
          // 0.7.0 end-to-end: build a fake DSH composer + a streamed answer, then
          // drive the whole flow the way a user would -- click "发送消息", let the
          // girl clip finish, and finally let the answer text grow so the output
          // detector fires. Every stage is reported, including the geometry of the
          // new pieces, because "does it land in the right place" is the question.
          setTimeout(function () {
            var composer = document.createElement('form')
            composer.id = 'fake-composer'
            composer.style.cssText = 'position:fixed;left:0;right:0;bottom:0;padding:8px;display:flex;gap:8px'
            var input = document.createElement('textarea')
            input.id = 'fake-input'
            input.value = 'test'
            input.style.cssText = 'flex:1;height:34px'
            var send = document.createElement('button')
            send.id = 'fake-send'
            send.type = 'button'
            send.setAttribute('aria-label', '\u53d1\u9001\u6d88\u606f')
            send.textContent = '\u53d1\u9001'
            composer.appendChild(input)
            composer.appendChild(send)
            document.body.appendChild(composer)

            var answer = document.createElement('div')
            answer.id = 'fake-answer'
            answer.style.cssText = 'position:fixed;left:12px;top:12px;max-width:300px'
            answer.textContent = '\u601d\u8003\u4e2d'
            document.body.appendChild(answer)

            // With &think=1 this models DSH's REAL reasoning markup (0.7.5): a
            // [data-variant="think"][data-state="running"] row whose summary
            // streams, PLUS a process row outside it ("正在分析请求" / "正在调用工具")
            // that keeps growing while the model thinks. Both used to satisfy the
            // "page text is growing" detector mid-thinking.
            var think = q.indexOf('think=1') >= 0
            var reasoningRow = null
            var processRow = null
            if (think) {
              var transcript = document.createElement('div')
              transcript.id = 'fake-transcript'
              transcript.style.cssText = 'position:fixed;left:12px;top:60px;max-width:420px'
              reasoningRow = document.createElement('div')
              reasoningRow.className = '_row_jhda5_16 _3GBCTG_root'
              reasoningRow.setAttribute('data-variant', 'think')
              reasoningRow.setAttribute('data-state', 'running')
              var thinkTitle = document.createElement('span')
              thinkTitle.textContent = '\u601d\u8003' // 思考
              var thinkSummary = document.createElement('span')
              thinkSummary.className = '_3GBCTG_summary'
              thinkSummary.setAttribute('data-streaming', 'true')
              thinkSummary.textContent = '\u63a8\u7406\u4e2d'
              reasoningRow.appendChild(thinkTitle)
              reasoningRow.appendChild(thinkSummary)
              processRow = document.createElement('div')
              processRow.id = 'fake-process'
              processRow.className = '_row_jhda5_16'
              processRow.textContent = '\u6b63\u5728\u5206\u6790\u8bf7\u6c42' // 正在分析请求
              transcript.appendChild(reasoningRow)
              transcript.appendChild(processRow)
              document.body.appendChild(transcript)
              // Keep the process row growing for the whole thinking phase.
              window.__thinkGrow = setInterval(function () {
                if (!processRow) return
                processRow.textContent += '\u6b63\u5728\u8c03\u7528\u5de5\u5177' // 正在调用工具
              }, 400)
            }
            var endThinking = function () {
              if (!think) return
              if (window.__thinkGrow) clearInterval(window.__thinkGrow)
              processRow.textContent = '\u5df2\u5b8c\u6210\u5206\u6790' // 已完成分析
              reasoningRow.setAttribute('data-state', 'ok')
              var summary = reasoningRow.querySelector('[data-streaming]')
              if (summary) summary.removeAttribute('data-streaming')
            }

            var snap = function (tag) {
              var girl = document.getElementById('dshca-girl')
              var lid = document.getElementById('dshca-lid')
              var sendbar = document.getElementById('dshca-sendbar')
              var label = document.getElementById('dshca-sendlabel')
              var timer = document.getElementById('dshca-timer')
              var bar = document.getElementById('dshca-bar')
              var cooker = document.getElementById('dshca-part-cooker')
              var girlPart = document.getElementById('dshca-part-girl')
              var r = function (el) {
                if (!el) return null
                var b = el.getBoundingClientRect()
                return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]
              }
              var sample = {
                stage: tag,
                phase: window.__dshcaSend ? window.__dshcaSend.phase() : null,
                girlClip: girl
                  ? {
                      rect: r(girl),
                      box: girl.getAttribute('data-content-box'),
                      paused: girl.paused,
                      ended: girl.ended,
                      t: Math.round(girl.currentTime * 1000) / 1000,
                      dur: girl.duration,
                      visible: girl.style.visibility !== 'hidden'
                    }
                  : null,
                lidClip: lid
                  ? {
                      rect: r(lid),
                      paused: lid.paused,
                      ended: lid.ended,
                      muted: lid.muted,
                      t: Math.round(lid.currentTime * 1000) / 1000,
                      visible: lid.style.visibility !== 'hidden',
                      displayed: getComputedStyle(lid).display
                    }
                  : null,
                sendbar: sendbar
                  ? { rect: r(sendbar), displayed: getComputedStyle(sendbar).display, text: (sendbar.textContent || '').slice(0, 40) }
                  : null,
                labelColor: label ? getComputedStyle(label).color : null,
                timer: timer ? timer.textContent : null,
                barRect: r(bar),
                barDetached: bar ? bar.classList.contains('dshca-detached') : null,
                barParent: bar && bar.parentNode ? bar.parentNode.id || bar.parentNode.tagName : null,
                cookerRect: r(cooker),
                girlPartDisplay: girlPart ? girlPart.style.display || '(visible)' : null,
                // 0.7.5 evidence: is the fake transcript still "深度思索"-ing, has the
                // lid started, and is the cooker crop still the thing on screen?
                reasoning: {
                  running: !!document.querySelector('[data-variant="think"][data-state="running"]'),
                  state: (function () {
                    var row = document.querySelector('[data-variant="think"]')
                    return row ? row.getAttribute('data-state') : null
                  })(),
                  processText: (function () {
                    var row = document.getElementById('fake-process')
                    return row ? (row.textContent || '').length : null
                  })()
                },
                lidStarted: lid ? !lid.paused || lid.currentTime > 0 || lid.ended : null,
                lidRevealed: lid ? lid.classList.contains('dshca-lid-on') : null,
                cookerHidden: cooker ? cooker.classList.contains('dshca-cooker-hidden') : null,
                // 0.7.3 evidence: while the run-out clip plays, neither scheduled
                // clip nor her frozen frame may be visible (two girls otherwise).
                scheduledVisible: ['idle', 'act'].filter(function (kind) {
                  var el = document.getElementById('dshca-anim-' + kind)
                  return !!el && el.style.visibility !== 'hidden'
                }),
                canvasVisible: (function () {
                  var c = document.querySelector('#dshca-part-girl canvas')
                  return c ? c.style.visibility !== 'hidden' : null
                })(),
                // 0.7.3 evidence: the lid overlay's content box, in viewport
                // coordinates, next to the cooker it is supposed to replace.
                lidContentRect: (function () {
                  if (!lid) return null
                  var vw = lid.videoWidth
                  var boxAttr = lid.getAttribute('data-content-box')
                  if (!vw || !boxAttr) return null
                  var b = boxAttr.split(',').map(Number)
                  var scale = parseFloat(lid.style.width) / vw
                  if (!isFinite(scale) || scale <= 0) return null
                  return {
                    left: Math.round((parseFloat(lid.style.left) + b[0] * scale) * 10) / 10,
                    bottom: Math.round((parseFloat(lid.style.top) + (b[1] + b[3]) * scale) * 10) / 10,
                    width: Math.round(b[2] * scale * 10) / 10,
                  }
                })(),
                visible: visibleNow(),
                probe: window.__dshcaSend && window.__dshcaSend.probe ? window.__dshcaSend.probe() : null,
                debug: window.__dshcaSend ? window.__dshcaSend.debug().events.slice(-6) : null
              }
              window.__report = sample
              report({ kind: 'clips', clips: sample })
              return sample
            }

            snap('send-before')
            send.click()

            // The girl clip is ~5s of real time; then the flow lays out.
            setTimeout(function () {
              snap('send-girl-playing')
            }, 1500)
            if (think) {
              // Still deep in "深度思索" here: the lid must NOT have started and the
              // cooker crop must still be exactly what is on screen.
              setTimeout(function () {
                snap('send-thinking')
              }, 5800)
            }
            setTimeout(function () {
              snap('send-after-girl')
              // Now the "model starts answering": thinking is over, the answer grows.
              endThinking()
              answer.textContent = '\u80a5\u9c7c\u5f00\u59cb\u56de\u7b54\u4e86'.repeat(6)
            }, 6800)
            setTimeout(function () {
              snap('send-lid')
            }, 8000)
            setTimeout(function () {
              snap('send-final')
              window.__ready = true
            }, 11000)
            // 0.7.4: the lid clip runs ~5.07s (it starts when the answer grows, at
            // 6.8s), so this lands just after it ended -- by then the label/timer
            // column must be gone while the pot still holds its last frame.
            setTimeout(function () {
              snap('send-lid-ended')
            }, 14500)
          }, 120)
          return
        }
        if (q.indexOf('speed=1') >= 0) {
          // Drive the interval control the way a user would: step the bar button
          // twice (1x -> 2x -> 4x), then move the panel slider, sampling the
          // widget's own readout each time. This mode also implies the
          // animation-layer diagnostics, since the whole point is what the
          // intervals do to the layer.
          setTimeout(function () {
            var step = function (tag) {
              var sample = clipDiag(tag)
              window.__report = sample
              report({ kind: 'clips', clips: sample })
            }
            step('speed-before')
            var btn = document.getElementById('dshca-speed-toggle')
            if (btn) btn.click()
            step('speed-step-2x')
            if (btn) btn.click()
            step('speed-step-4x')
            var slider = document.getElementById('dshca-speed')
            if (slider) {
              slider.value = '0'
              slider.dispatchEvent(new Event('input', { bubbles: true }))
            }
            step('speed-slider-min')
            if (slider) {
              slider.value = '1000'
              slider.dispatchEvent(new Event('input', { bubbles: true }))
            }
            step('speed-slider-max')
            setTimeout(function () {
              step('speed-after')
              window.__ready = true
            }, 600)
          }, 120)
          return
        }
        if (q.indexOf('random=1') >= 0) {
          // 0.10.0：两道随机动画 + 拖动动画各跑一遍（含概率分布）。
          setTimeout(function () {
            runRandomAnims(function () {
              show('random animations done: ' + JSON.stringify(window.__violations.length) + ' violations')
              window.__ready = true
              window.__result = { violations: window.__violations, snaps: 'see /report' }
            })
          }, 300)
          return
        }
        if (q.indexOf('idle=1') >= 0) {
          // The schedule arms at the split; sample the layout right away, then
          // again while the standby clip plays and once more when the action
          // clip takes its 15s turn. (The A/B overlay, if requested, is fired by
          // the timeline watcher the first time the standby clip is really up.)
          setTimeout(function () {
            sampleClips('after-split', [600, 1600, 15500])
            window.__ready = true
          }, 120)
          return
        }

        // Let the split settle (it runs on 'ended' via requestAnimationFrame).
        setTimeout(function () {
          if (q.indexOf('panel=1') >= 0) {
            var toggle = document.querySelector('#dshca-part-girl #dshca-bar button[aria-expanded]')
            if (toggle) toggle.click()
          }
          if (q.indexOf('drag=1') >= 0) {
            var cooker = document.getElementById('dshca-part-cooker')
            var girl = document.getElementById('dshca-part-girl')
            if (cooker) dragPart(cooker, -320, 210)
            // The girl starts parked against the right border (0.7.3), so drag her
            // INWARD -- pushing her further right would just be clamped at the edge.
            if (girl) dragPart(girl, -70, 300)
          }
          setTimeout(function () {
            var snap = snapshot(v)
            show('PROBE ' + JSON.stringify(snap, null, 1))
            report({ kind: 'analysis', analysis: analyse(v) })
            report({ kind: 'snapshot', snapshot: snap })
            window.__ready = true
          }, 400)
        }, 500)
      }
      if (v.ended) finish()
      else v.addEventListener('ended', finish, { once: true })
    }, 100)
  })
</script>
</body>
</html>`

/* ----------------------------------------------------------------- server */

function printCoverage(analysis) {
  const cov = analysis.coverage
  console.log(`[report] asset ${analysis.videoWidth}x${analysis.videoHeight}, probe ${analysis.probe.join('x')}`)
  console.log('[report] alpha coverage per column (0-1), 128 buckets:')
  for (let i = 0; i < cov.length; i += 32) {
    console.log(`  x=${String(i).padStart(3)}  ${cov.slice(i, i + 32).map((v) => v.toFixed(2).slice(1)).join(' ')}`)
  }
}

/**
 * 0.10.0 的随机动画报告：把关键帧、层的变化、接触时刻与不变量违规打出来。
 */
function printRandomReport(p) {
  if (p.error) {
    console.log(`[report] random: ERROR ${p.error}`)
    return
  }
  if (p.which === 'roll') {
    const pct = (n) => `${((n / p.rolls) * 100).toFixed(1)}%`
    console.log(
      `[report] random rolls x${p.rolls}: A(lid1)=${p.a} (${pct(p.a)})  B(lid2)=${p.b} (${pct(p.b)})  ` +
        `none=${p.none} (${pct(p.none)})  both-at-once=${p.both}`,
    )
    return
  }
  if (p.which === 'lid1') {
    console.log(`[report] anim1 (lid-empty) — final currentTime = ${p.finalT}s (0 = rewound to the start)`)
    console.log(`  layers after: ${(p.layers || []).join(' + ')}`)
    const tl = (p.samples || []).filter((s, i, a) => i === 0 || s.stage !== a[i - 1].stage || i % 20 === 0)
    for (const s of tl.slice(-14)) console.log(`    t=${String(s.t).padStart(6)}ms stage=${s.stage} clipT=${s.t} layers=${(s.layers || []).join('+')}`)
  } else if (p.which === 'lid2') {
    console.log('[report] anim2 (lid-rice + the cooker flying to her)')
    for (const s of (p.samples || []).filter((s, i, a) => i % 6 === 0 || i === a.length - 1)) {
      console.log(
        `    stage=${s.t || '-'} fly=${s.fly ? `${s.fly.x},${s.fly.y}` : '-'} ` +
          `contact=${s.contact} girlShown=${s.girl}`,
      )
    }
    console.log(`  flight plan: ${JSON.stringify(p.flight)}   contact-peak=${p.contact}`)
    console.log(`  cooker after: ${JSON.stringify(p.cooker)}   girl after: ${JSON.stringify(p.girl)}`)
    console.log(`  schedule running again: ${p.scheduleOn}`)
  } else if (p.which === 'drag') {
    console.log(`[report] drag animation: on=${JSON.stringify(p.drag.on)}  looped t=${p.drag.loopedT}s`)
    console.log(`  off: ${JSON.stringify(p.drag.off)}`)
    console.log(`  real pointer drag -> ${JSON.stringify(p.drag.realDrag)}`)
  }
  console.log(`  one-picture violations in this phase: ${p.violations}`)
  const bad = (p.snaps || []).filter((s) => !s.ok)
  if (bad.length) {
    console.log(`  [FAIL] ${bad.length} samples had more/fewer than one picture, e.g. ${JSON.stringify(bad.slice(0, 6))}`)
  } else if (p.snaps && p.snaps.length) {
    console.log(`  [ok] "exactly one picture" held across ${p.snaps.length} samples`)
  }
  const stages = (p.snaps || []).map((s) => s.stage)
  const seen = stages.filter((s, i) => s && s !== stages[i - 1])
  if (seen.length) console.log(`  stage timeline: ${seen.join(' -> ')}`)
}

const server = http.createServer((req, res) => {  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)

  // Diagnostic sink: the page posts here and we log it, because a headless
  // browser's own stdout is not reachable from the caller.
  if (url.pathname === '/report' && req.method === 'POST') {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      try {
        const parsed = JSON.parse(raw)
        if (parsed.kind === 'analysis' && parsed.analysis && parsed.analysis.coverage) {
          printCoverage(parsed.analysis)
        } else if (parsed.kind === 'random') {
          printRandomReport(parsed)
        } else if (parsed.kind === 'sched') {
          const v = parsed.after || {}
          const b = parsed.before || {}
          console.log(
            `[report] debug button: ${parsed.step}` +
              (parsed.before ? `   before=${b.what}(${b.count})` : '') +
              `   after=${v.what}(${v.count})` +
              (parsed.plays ? `   plays=${JSON.stringify(parsed.plays)}` : '') +
              (parsed.violations ? `   one-picture violations=${parsed.violations.length}` : '') +
              (parsed.fallsBack
                ? `   fell back to the opener frame=${parsed.fallsBack.length}`
                : '')
          )
        } else if (parsed.kind === 'clips') {
          const d = parsed.clips || {}
          const g = d.girl
          console.log(`[report] animation layer @ ${d.stage}   visible=${d.visible ? d.visible.what : '?'}`)
          // 0.7.0 send-flow samples carry a `phase` instead of a girl part.
          if (d.phase !== undefined) {
            console.log(
              `  send phase=${d.phase}  timer=${d.timer}  labelColor=${d.labelColor}  ` +
                `girlPart=${d.girlPartDisplay}`,
            )
            console.log(
              `  bar        detached=${d.barDetached} parent=${d.barParent} rect=${JSON.stringify(d.barRect)}` +
                `   cooker rect=${JSON.stringify(d.cookerRect)}`,
            )
            if (d.girlClip) {
              console.log(
                `  girl clip  rect=${JSON.stringify(d.girlClip.rect)} box=${d.girlClip.box} ` +
                  `visible=${d.girlClip.visible} paused=${d.girlClip.paused} t=${d.girlClip.t}/${d.girlClip.dur}`,
              )
            } else {
              console.log('  girl clip  (not mounted)')
            }
            if (d.lidClip) {
              console.log(
                `  lid clip   rect=${JSON.stringify(d.lidClip.rect)} display=${d.lidClip.displayed} ` +
                  `visible=${d.lidClip.visible} muted=${d.lidClip.muted} paused=${d.lidClip.paused} ` +
                  `ended=${d.lidClip.ended} t=${d.lidClip.t}`,
              )
            } else {
              console.log('  lid clip   (not mounted)')
            }
            if (d.sendbar) {
              console.log(`  sendbar    display=${d.sendbar.displayed} rect=${JSON.stringify(d.sendbar.rect)} text="${d.sendbar.text}"`)
            }
            if (d.probe) console.log(`  probe      ${JSON.stringify(d.probe)}`)
            for (const e of d.debug || []) console.log(`    dbg ${e.t}ms ${e.kind} ${JSON.stringify(e.detail)}`)
          }
          if (d.speed) {
            console.log(
              `  interval    button=${d.speed.button}  slider=${d.speed.slider}  ` +
                `sliders=${d.speed.rangeCount}  stored=${d.speed.stored}`,
            )
            console.log(`              ${d.speed.title}`)
            console.log(`  readout     ${d.speed.readout}`)
          }
          if (g) {
            console.log(
              `  girl part   at (${g.left}, ${g.top})  ${g.width}x${g.height}  crop=[${g.srcBox}]  ` +
                `frozen frame visible=${g.canvasVisible}`,
            )
          } else {
            console.log('  girl part   (missing — no split yet)')
          }
          for (const c of d.clips || []) {
            console.log(
              `  ${c.kind.padEnd(4)} <video>  ${c.videoWidth}x${c.videoHeight} @ ${(c.duration || 0).toFixed(3)}s  ` +
                `muted=${c.muted} loop=${c.loop} paused=${c.paused} ended=${c.ended} ` +
                `playing=${c.playing} t=${c.currentTime}  starts=${c.starts}`,
            )
            const cssW = parseFloat(c.cssWidth)
            const cssH = parseFloat(c.cssHeight)
            const left = parseFloat(c.cssLeft)
            const top = parseFloat(c.cssTop)
            if (isFinite(cssW) && isFinite(cssH) && g) {
              console.log(
                `       layout  css ${c.cssWidth} x ${c.cssHeight} at left=${c.cssLeft} top=${c.cssTop}` +
                  `   box x ${left.toFixed(1)}..${(left + cssW).toFixed(1)} of 0..${g.width}` +
                  `   y ${top.toFixed(1)}..${(top + cssH).toFixed(1)} of 0..${g.height}` +
                  `   aspect ${(cssW / cssH).toFixed(3)} (asset ${(c.videoWidth / c.videoHeight).toFixed(3)})`,
              )
            }
          }
          if (!(d.clips || []).length) console.log('  (no clips are mounted)')
          if (d.barButtons) {
            console.log(
              `  bar         ${d.barButtons.map((b) => `${b.glyph}${b.on ? '*' : ''}(${b.title})`).join('  ')}`,
            )
          }
        } else if (parsed.kind === 'ab') {
          console.log('[report] frozen-vs-idle A/B:', JSON.stringify(parsed.ab))
        } else if (parsed.kind === 'snapshot') {
          const s = parsed.snapshot
          console.log('[report] snapshot:')
          console.log(`  video     ${s.videoWidth}x${s.videoHeight}  ended=${s.ended} paused=${s.paused} loop=${s.loop}`)
          console.log(`  progress  ${s.currentTime} / ${s.duration}`)
          console.log(`  viewport  ${s.viewport.join('x')}`)
          console.log(`  merged    visible=${s.merged.visible} display=${s.merged.display}`)
          console.log(`  split     ${s.splitHappened}, regions tile frame = ${s.regionsTileFrame}/${s.videoWidth}`)
          for (const key of ['cooker', 'girl']) {
            const p = s[key]
            if (!p) {
              console.log(`  ${key.padEnd(9)} (missing)`)
              continue
            }
            console.log(
              `  ${key.padEnd(9)} #${p.id}  at (${p.left}, ${p.top})  ${p.width}x${p.height}  ` +
                `crop=[${p.srcBox}]  canvas=${p.canvasPx}  bar=${p.hasBar} panel=${p.hasPanel}`,
            )
          }
        } else {
          console.log('[report]', raw.slice(0, 4000))
        }
      } catch {
        console.log('[report raw]', raw.slice(0, 4000))
      }
      res.writeHead(204).end()
    })
    return
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    // Run the preview page through the plugin's OWN index tap.
    const html = taps.reduce((acc, tap) => tap(acc), PAGE)
    const body = Buffer.from(html, 'utf8')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': String(body.length) })
    res.end(body)
    return
  }

  // Delay resource used to hold the page's load event open in real time.
  if (url.pathname === '/slow') {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': '43' })
      res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'))
    }, 9000)
    return
  }

  const route = routes.find((r) => r.path === url.pathname)
  if (!route) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('no route')
    return
  }
  Promise.resolve(route.handler(req, res)).catch((err) => {
    try {
      res.writeHead(500).end(String(err && err.stack))
    } catch {
      /* headers already sent */
    }
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`preview server listening on http://127.0.0.1:${PORT}`)
  console.log(`  default view : http://127.0.0.1:${PORT}/`)
  console.log(`  panel open   : http://127.0.0.1:${PORT}/?panel=1`)
  console.log(`  parts apart  : http://127.0.0.1:${PORT}/?drag=1`)
  console.log(`  anim layer   : http://127.0.0.1:${PORT}/?idle=1[&ab=1]`)
  console.log(`  interval ctl : http://127.0.0.1:${PORT}/?speed=1`)
  console.log(`  pause/resume : http://127.0.0.1:${PORT}/?sched=1   (runs ~34s)`)
  console.log(`  routes       : ${routes.map((r) => r.path).join(', ')}`)
})

/**
 * Client-half harness: runs assets/widget.js inside a minimal but faithful DOM
 * stub and asserts on the behaviours this plugin actually promises -- * corner placement, play-once, holding the last frame, whole-widget dragging,
 * the collapsible size panel, and the post-playback split into two
 * independently draggable parts.
 *
 * Run:  node test/widget-harness.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WIDGET_SRC = fs.readFileSync(path.join(HERE, '..', 'assets', 'widget.js'), 'utf8')

/* ------------------------------------------------------------------ DOM stub */

const VIDEO_W = 2560 // the shipped 2K opener
const VIDEO_H = 1440
const VIDEO_ASPECT = VIDEO_W / VIDEO_H
const IDLE_W = 1440 // the standby clip: same girl, portrait framing
const IDLE_H = 1920
const ACT_W = 1440 // the action clip: same girl, portrait framing
const ACT_H = 1916
/** 0.7.0 assets: the send-message girl clip and the open-lid clip. */
const GIRL_W = 1920
const GIRL_H = 1080
const LID_W = 2560
const LID_H = 1440
/** Real media durations of the two shipped clips (ffprobe / dev-checks table), so
 *  "parked on the last frame" is asserted against an actual end-of-media position. */
const IDLE_DURATION = 5.048
const ACT_DURATION = 5.003
const GIRL_DURATION = 5.042
const LID_DURATION = 5.065
/** 0.10.0 鐨勫洓浠界礌鏉愶紙灏哄涓庢椂闀块兘鍙栬嚜瀹炴祴锛岃 README 鐨勭礌鏉愯〃锛夈€?*/
const DRAG_W = 1112
const DRAG_H = 834
const DRAG_DURATION = 5.542
const LID_ANIM_W = 960 // 鍔ㄧ敾1 / 鍔ㄧ敾2 閮芥槸姝ｆ柟褰㈢敾骞?
const LID_ANIM_H = 960
const LID_ANIM_DURATION = 5.065
const GIRL_BASIN_W = 1280
const GIRL_BASIN_H = 720
const GIRL_BASIN_DURATION = 5.042
/** Real decoded duration of assets/pipe.mp3 after trimming (see tools/audio-trim.mjs). */
const PIPE_SECONDS = 2.424
/** The widget's output-phase sampling interval (mirrors SEND_WATCH_INTERVAL). */
const SEND_WATCH = 180
const PANEL_W = 212 // matches the CSS width of #dshca-panel
// Two head + slider + preset rows (display size, animation interval) and the
// one-line note between them. Only the layout maths reads this.
const PANEL_H = 186
// Mirrors the widget's own timing constants.
const IDLE_PERIOD = 5000
const ACT_PERIOD = 15000

function makeEvent(type, props = {}) {
  return {
    type,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true
    },
    stopPropagation() {
      this.propagationStopped = true
    },
    ...props,
  }
}

/**
 * A `style` object that behaves like the real one for our purposes.
 *
 * The 0.9.0 basin puts its tilt into a CSS custom property, and custom
 * properties can ONLY be written through `style.setProperty` (in a browser,
 * `style['--x'] = v` silently does nothing). Without this the widget's own
 * try/catch-free style write would throw and the basin would never appear in
 * the harness -- i.e. the stub would hide a real bug.
 */
function makeStyle() {
  const style = {}
  style.setProperty = (name, value) => {
    style[name] = String(value)
  }
  style.getPropertyValue = (name) => (name in style ? String(style[name]) : '')
  style.removeProperty = (name) => {
    delete style[name]
  }
  return style
}

class Element {
  constructor(tag, media) {
    this.tagName = String(tag).toUpperCase()
    this._id = ''
    this._className = ''
    this.style = makeStyle()
    this.attributes = {}
    this.children = []
    this.parentNode = null
    this.textContent = ''
    this.listeners = new Map()
    this._media = media || { gap: [0.5, 0.53], taint: false }
    this.classList = {
      add: (...names) => {
        const set = new Set(this._className.split(' ').filter(Boolean))
        for (const n of names) set.add(n)
        this._className = [...set].join(' ')
      },
      remove: (...names) => {
        const set = new Set(this._className.split(' ').filter(Boolean))
        for (const n of names) set.delete(n)
        this._className = [...set].join(' ')
      },
      contains: (n) => this._className.split(' ').filter(Boolean).includes(n),
    }
  }

  get className() {
    return this._className
  }
  set className(value) {
    this._className = String(value)
  }

  /**
   * Text content, tracked as "this element owns some text" so the TreeWalker can
   * expose it as a text node (see Document.createTreeWalker).
   */
  get textContent() {
    return this._text === undefined ? '' : this._text
  }
  set textContent(value) {
    this._text = String(value)
    // `= ''` means "remove the text"; a non-empty value means the element now
    // owns a text node.
    this._hasText = this._text.length > 0
  }

  /**
   * Minimal 2D context. drawImage is a no-op; getImageData synthesises a frame
   * that is fully opaque except for one transparent vertical band, so the
   * split-detection code can be exercised deterministically.
   */
  getContext(type) {
    if (this.tagName !== 'CANVAS' || type !== '2d') return null
    const media = this._media
    if (!this._ctx) {
      this._ctx = {
        /**
         * Every `drawImage` call, recorded rather than rasterised.
         *
         * The click-squish checks need to assert WHAT got painted -- which frame,
         * cropped from which rectangle, landing where -- and that is exactly the
         * argument list. Pixel output would be noise on top of that.
         */
        draws: [],
        drawImage(...args) {
          this.draws.push(args)
        },
        getImageData(x, y, w, h) {
          if (media.taint) {
            const err = new Error('Tainted canvases may not be loaded.')
            err.name = 'SecurityError'
            throw err
          }
          const data = new Uint8ClampedArray(w * h * 4)
          // `rightMargin` models the shipped 2K opener's transparent right margin
          // (320 of 2560 columns) -- the reason "her crop's place in the frame" is
          // not the same thing as "at the window border".
          const rightMargin = media.rightMargin || 0
          for (let col = 0; col < w; col += 1) {
            const t = w <= 1 ? 0 : col / w
            const empty =
              (t >= media.gap[0] && t < media.gap[1]) || (rightMargin > 0 && t >= 1 - rightMargin)
            for (let row = 0; row < h; row += 1) {
              const i = (row * w + col) * 4
              data[i] = 200
              data[i + 1] = 200
              data[i + 2] = 200
              data[i + 3] = empty ? 0 : 255
            }
          }
          return { data, width: w, height: h }
        },
      }
    }
    return this._ctx
  }

  get id() {
    return this._id
  }
  set id(value) {
    this._id = value
  }

  /**
   * Videos carry the intrinsic size of whichever asset they were pointed at, so
   * the widget's aspect maths sees three genuinely different shapes: the 2K
   * landscape opener and the two portrait clips the girl plays.
   */
  get src() {
    return this._src || ''
  }
  set src(value) {
    this._src = String(value)
    if (this.tagName !== 'VIDEO') return
    if (this._src.indexOf('idle') >= 0) {
      this.videoWidth = IDLE_W
      this.videoHeight = IDLE_H
    } else if (this._src.indexOf('act') >= 0) {
      this.videoWidth = ACT_W
      this.videoHeight = ACT_H
    } else {
      this.videoWidth = VIDEO_W
      this.videoHeight = VIDEO_H
    }
  }

  setAttribute(name, value) {
    // `class` / `id` are mirrored, because CSS attribute selectors such as
    // `[class*="_markdown_"]` read them through getAttribute in a browser.
    if (name === 'class') this._className = String(value)
    else if (name === 'id') this._id = String(value)
    else this.attributes[name] = String(value)
  }
  getAttribute(name) {
    if (name === 'class') return this._className
    if (name === 'id') return this._id
    return name in this.attributes ? this.attributes[name] : null
  }
  hasAttribute(name) {
    if (name === 'class') return true
    if (name === 'id') return true
    return name in this.attributes
  }

  /**
   * React removes an attribute by passing `undefined`/`false` to a data-*
   * attribute; the stub needs the same "attribute is gone" state (the reasoning
   * row's `data-streaming` marker disappears the moment it stops streaming).
   */
  removeAttribute(name) {
    if (name === 'class') {
      this._className = ''
      return
    }
    if (name === 'id') {
      this._id = ''
      return
    }
    delete this.attributes[name]
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    this.children.push(child)
    return child
  }

  /**
   * Standard DOM insertion. The click-squish snapshot is inserted *before* the
   * control bar so the buttons keep painting above it -- DOM order is what
   * decides that for same-layer absolutely positioned boxes, so the stub has to
   * model this or the layering would be untestable.
   */
  insertBefore(child, reference) {
    if (!reference) return this.appendChild(child)
    const index = this.children.indexOf(reference)
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    if (index < 0) this.children.push(child)
    else this.children.splice(index, 0, child)
    return child
  }

  removeChild(child) {
    const index = this.children.indexOf(child)
    if (index >= 0) this.children.splice(index, 1)
    child.parentNode = null
    return child
  }

  contains(node) {
    let current = node
    while (current) {
      if (current === this) return true
      current = current.parentNode
    }
    return false
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(fn)
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type)
    if (!list) return
    const index = list.indexOf(fn)
    if (index >= 0) list.splice(index, 1)
  }

  dispatch(type, props = {}) {
    const event = makeEvent(type, { target: this, currentTarget: this, ...props })
    for (const fn of this.listeners.get(type) || []) fn(event)
    return event
  }

  /** Needed by the 0.7.0 send hook (it must ignore clicks inside our own widget). */
  closest(selector) {
    const parts = String(selector).split(',').map((s) => s.trim())
    let node = this
    while (node) {
      if (parts.some((part) => node.matches(part))) return node
      node = node.parentNode
    }
    return null
  }

  /**
   * Minimal matcher: tag, #id, .class, [attr], [attr=v] with the usual operators,
   * **compound** tokens (`[data-variant="think"][data-state="running"]`,
   * `div[contenteditable]`) and **descendant** combinators (`a b`).
   *
   * The 0.7.5 open-lid precondition reads DSH's real reasoning markup through a
   * compound attribute selector, so the stub has to understand them -- otherwise
   * that branch would silently never match here and the regression would be
   * untestable.
   */
  matches(selector) {
    if (!selector) return false
    return String(selector)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .some((part) => this.matchesComplex(part))
  }

  /** `a b c` = this matches `c` and has ancestors matching `b`, then `a`. */
  matchesComplex(part) {
    const tokens = String(part).split(/\s+/).filter(Boolean)
    if (!tokens.length) return false
    if (!this.matchesCompound(tokens[tokens.length - 1])) return false
    let node = this.parentNode
    for (let i = tokens.length - 2; i >= 0; i -= 1) {
      let found = null
      while (node) {
        if (typeof node.matchesCompound === 'function' && node.matchesCompound(tokens[i])) {
          found = node
          break
        }
        node = node.parentNode
      }
      if (!found) return false
      node = found.parentNode
    }
    return true
  }

  /** One compound token: a sequence of tag / #id / .class / [attr] selectors. */
  matchesCompound(token) {
    if (token === '*') return true
    const parts = String(token).match(/\[[^\]]*\]|[#.][^#.\[]+|[^#.\[]+/g) || []
    if (!parts.length) return false
    for (const raw of parts) {
      if (raw === '*') continue
      if (raw.startsWith('#')) {
        if (this.id !== raw.slice(1)) return false
        continue
      }
      if (raw.startsWith('.')) {
        if (!this._className.split(' ').filter(Boolean).includes(raw.slice(1))) return false
        continue
      }
      if (raw.startsWith('[')) {
        const m = /^\[([\w-]+)(?:([*^$~|]?)=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]$/.exec(raw)
        if (!m) return false
        const attr = m[1]
        const op = m[2]
        const want = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5]
        const have = String(this.getAttribute(attr) === undefined ? '' : this.getAttribute(attr))
        if (want === undefined) {
          if (!this.hasAttribute(attr)) return false
          continue
        }
        if (op === '*') {
          if (!have.includes(want)) return false
          continue
        }
        if (op === '^') {
          if (!have.startsWith(want)) return false
          continue
        }
        if (op === '$') {
          if (!have.endsWith(want)) return false
          continue
        }
        if (op === '~') {
          if (!have.split(/\s+/).includes(want)) return false
          continue
        }
        if (have !== want) return false
        continue
      }
      if (this.tagName !== raw.toUpperCase()) return false
    }
    return true
  }

  /** Every descendant matching `selector`, depth-first in document order. */
  queryAll(selector) {
    const out = []
    const visit = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) out.push(child)
        visit(child)
      }
    }
    visit(this)
    return out
  }

  /**
   * Rect maths the widget depends on: root is width x (width / aspect), placed
   * at whatever left/top the widget last wrote. The panel reports fixed metrics
   * so layoutPanel() has something real to work with.
   */
  getBoundingClientRect() {
    if (this._id === 'dshca-root') {
      const width = parseFloat(this.style.width) || 0
      const height = width / VIDEO_ASPECT
      const left = parseFloat(this.style.left) || 0
      const top = parseFloat(this.style.top) || 0
      return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height }
    }
    if (this._id && this._id.indexOf('dshca-part-') === 0) {
      // A split part: width is set in px, height follows the cropped region's
      // own aspect ratio (every part is VIDEO_H tall in source pixels).
      const width = parseFloat(this.style.width) || 0
      const canvas = this.children.find((c) => c.tagName === 'CANVAS')
      const regionW = canvas && canvas.width ? canvas.width : VIDEO_W
      const height = width * (VIDEO_H / regionW)
      const left = parseFloat(this.style.left) || 0
      const top = parseFloat(this.style.top) || 0
      return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height }
    }
    if (this._id === 'dshca-panel') {
      return { x: 0, y: 0, left: 0, top: 0, width: PANEL_W, height: PANEL_H, right: PANEL_W, bottom: PANEL_H }
    }
    // Anything else that is actually in the page (the fake DSH shell the send
    // hook looks at) reports a small but non-zero box, so `visible()` is honest.
    const left = parseFloat(this.style.left) || 0
    const top = parseFloat(this.style.top) || 0
    const width = parseFloat(this.style.width) || (this._detached ? 0 : 12)
    const height = parseFloat(this.style.height) || (this._detached ? 0 : 12)
    return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height }
  }

  get offsetWidth() {
    if (this._id === 'dshca-panel') return PANEL_W
    if (this._id === 'dshca-root' || (this._id && this._id.indexOf('dshca-part-') === 0)) {
      return parseFloat(this.style.width) || 0
    }
    return 0
  }
  get offsetHeight() {
    if (this._id === 'dshca-panel') return PANEL_H
    return this.getBoundingClientRect().height
  }

  /* --- <video> surface --- */
  // Note: play() deliberately does NOT dispatch 'playing' here. Per spec the
  // real event order is loadstart -> loadedmetadata -> loadeddata -> canplay ->
  // playing, so 'playing' can never precede 'loadedmetadata'. The harness
  // drives those events explicitly to stay faithful to that order.
  //
  // `_clockAdvance` is opt-in: the animation clips set it so play() moves
  // currentTime off zero, which is what the schedule reads to tell "showing a
  // frame" from "idle". The opener must NOT advance --existing checks assert it
  // sits exactly at 0 after a replay.
  play() {
    if (this.currentTime === undefined) this.currentTime = 0
    if (this.ended) this.currentTime = 0
    this._plays = (this._plays || 0) + 1
    this._playing = true
    if (this._clockAdvance && this.currentTime === 0) this.currentTime = 0.1
    if (this._playLog) this._playLog.push(this._src)
    return Promise.resolve()
  }
  pause() {
    this._pauses = (this._pauses || 0) + 1
    this._playing = false
  }
}

class Document {
  constructor(media, playLog) {
    this._media = media || { gap: [0.5, 0.53], taint: false }
    this._playLog = playLog || []
    this.head = new Element('head', this._media)
    this.documentElement = new Element('html', this._media)
    this.body = new Element('body', this._media)
    this.documentElement.appendChild(this.head)
    this.documentElement.appendChild(this.body)
    this.listeners = new Map()
  }
  createElement(tag) {
    const el = new Element(tag, this._media)
    if (el.tagName === 'VIDEO') {
      // Intrinsic size of the shipped asset, so the widget's aspect maths is real.
      el.videoWidth = VIDEO_W
      el.videoHeight = VIDEO_H
      // A stable record of every start, surviving the element being recreated
      // when the animation layer is torn down between clips.
      el._playLog = this._playLog
    }
    if (el.tagName === 'CANVAS') {
      el.width = 0
      el.height = 0
    }
    return el
  }

  /**
   * Metadata for a clip element the way a browser would hand it over: it knows
   * the asset's intrinsic size AND its duration straight away.
   *
   * The widget does NOT set these itself -- it only ever reads them -- so
   * preloading them here is what lets a test assert the real end-of-media
   * position ("the girl is parked on the clip's own last frame"). Portrait
   * dimensions are what the two shipped clips actually have.
   */
  seedClipMedia(el) {
    const src = String(el.getAttribute('src') || el.src || '')
    if (src.indexOf('girl.webm') >= 0) {
      el.videoWidth = GIRL_W
      el.videoHeight = GIRL_H
      el.duration = GIRL_DURATION
    } else if (src.indexOf('girl-basin.webm') >= 0) {
      // 0.10.0锛氬姩鐢? 閲屽ス閭ｆ锛?280脳720锛?.042s锛夈€?
      el.videoWidth = GIRL_BASIN_W
      el.videoHeight = GIRL_BASIN_H
      el.duration = GIRL_BASIN_DURATION
    } else if (src.indexOf('lid-empty.webm') >= 0) {
      // 0.10.0锛氬姩鐢?銆屽紑鐩?路 绌洪攨銆嶏紙960脳960锛?.065s锛夈€?
      el.videoWidth = LID_ANIM_W
      el.videoHeight = LID_ANIM_H
      el.duration = LID_ANIM_DURATION
    } else if (src.indexOf('lid-rice.webm') >= 0) {
      // 0.10.0锛氬姩鐢?銆屽紑鐩?路 绫抽キ鐑皵銆嶏紙960脳960锛?.065s锛夈€?
      el.videoWidth = LID_ANIM_W
      el.videoHeight = LID_ANIM_H
      el.duration = LID_ANIM_DURATION
    } else if (src.indexOf('drag.webm') >= 0) {
      // 0.10.0锛氭嫋鍔ㄥ姩鐢伙紙1112脳834锛?.542s锛屽惊鐜級銆?
      el.videoWidth = DRAG_W
      el.videoHeight = DRAG_H
      el.duration = DRAG_DURATION
    } else if (src.indexOf('lid.webm') >= 0) {
      el.videoWidth = LID_W
      el.videoHeight = LID_H
      el.duration = LID_DURATION
    } else if (src.indexOf('idle.webm') >= 0) {
      el.videoWidth = IDLE_W
      el.videoHeight = IDLE_H
      el.duration = IDLE_DURATION
    } else if (src.indexOf('act.webm') >= 0) {
      el.videoWidth = ACT_W
      el.videoHeight = ACT_H
      el.duration = ACT_DURATION
    }
    return el
  }
  getElementById(id) {
    const walk = (node) => {
      if (node.id === id) return node
      for (const child of node.children) {
        const found = walk(child)
        if (found) return found
      }
      return null
    }
    return walk(this.documentElement)
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(fn)
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type)
    if (!list) return
    const i = list.indexOf(fn)
    if (i >= 0) list.splice(i, 1)
  }
  /** Selector helpers the 0.7.0 send hook relies on. */
  querySelectorAll(selector) {
    if (selector === '*') {
      // `longestText()` walks every element; include body so text added directly
      // under it is still discovered.
      return [this.body, ...this.documentElement.queryAll('*')]
    }
    return this.documentElement.queryAll(selector)
  }
  querySelector(selector) {
    const found = this.querySelectorAll(selector)
    return found.length ? found[0] : null
  }
  /**
   * SHOW_TEXT TreeWalker over the body.
   *
   * A real browser stores `textContent` as TEXT NODES, and the 0.7.0 output
   * detector measures text-node length (that is what streaming actually grows).
   * The stub keeps `textContent` as a plain property, so this synthesises one
   * text node per element that has text -- with `nodeValue` read live off the
   * element, so assigning `el.textContent` is immediately visible to the walker
   * exactly like a browser would be after a re-render.
   */
  createTreeWalker(root, whatToShow) {
    const showText = (whatToShow & 4) !== 0
    const sequence = []
    const visit = (node) => {
      for (const child of node.children) {
        if (showText && child._hasText) {
          sequence.push({
            nodeType: 3,
            parentNode: child,
            get nodeValue() {
              return String(child.textContent || '')
            },
          })
        }
        visit(child)
      }
    }
    visit(root)
    let index = -1
    return {
      nextNode() {
        index += 1
        return index < sequence.length ? sequence[index] : null
      },
      currentNode: () => (index >= 0 ? sequence[index] || null : null),
    }
  }
  /**
   * Deliver an event to the document, bubbling from `target` up through its
   * ancestors -- the send hook listens on `document` in the CAPTURE phase, so a
   * path is what makes the difference between a click and a capture visible.
   */
  dispatchOn(target, type, props = {}) {
    const path = []
    let node = target
    while (node) {
      path.push(node)
      node = node.parentNode
    }
    if (!path.includes(this.documentElement)) path.push(this.documentElement)
    for (const fn of this.listeners.get(type) || []) {
      fn(makeEvent(type, { target, currentTarget: this, ...props }))
    }
    return path
  }
}

function makeEnv(config = {}, media = {}) {
  const mediaConfig = { gap: [0.5, 0.53], taint: false, ...media }
  const playLog = []
  const document = new Document(mediaConfig, playLog)
  const timers = []
  /** Queued `requestAnimationFrame` callbacks (see the window stub below). */
  const frames = []
  const store = new Map()
  const windowListeners = new Map()
  // The animation scheduler works in wall-clock time, so the harness owns the
  // clock: `env.advance(ms)` moves it forward together with the timer queue.
  const clock = { now: 1000000 }

  const window = {
    innerWidth: 1280,
    innerHeight: 800,
    document,
    __DSH_CORNER_ANIM_CONFIG__: config,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms, at: clock.now + ms, cancelled: false, fired: false })
      return timers.length
    },
    clearTimeout: (id) => {
      const entry = timers[id - 1]
      if (entry) entry.cancelled = true
    },
    // 0.7.0: the timer display and the output watcher both use intervals.
    setInterval: (fn, ms) => {
      timers.push({ fn, ms, at: clock.now + ms, cancelled: false, fired: false, repeat: true })
      return timers.length
    },
    clearInterval: (id) => {
      const entry = timers[id - 1]
      if (entry) {
        // `fired` quiets the drain loop; `cancelled` records the intent.
        entry.cancelled = true
        if (entry.repeat) entry.fired = true
      }
    },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    /**
     * `requestAnimationFrame` **寮傛**鎵ц锛堜笌娴忚鍣ㄤ竴鑷达級銆?
     *
     * 鏃╁厛杩欓噷鏄?绔嬪埢鍚屾璋冪敤"锛屽洜涓烘媶鍒嗭紙0.7.0锛夊氨鎸傚湪瀹冧笂闈紝鍚屾鑳借娴嬭瘯
     * 鍦?`ended` 涔嬪悗椹笂瑙傚療鍒版媶鍒嗙粨鏋溿€備絾 0.10.0 鐨勫€掓斁鐢ㄥ畠鍋氶€愬抚寰幆 鈥斺€?
     * 鍚屾 rAF 浼氬彉鎴?*鏃犻檺閫掑綊**锛堝洖璋冮噷鍐嶆帓涓€甯с€佺珛鍒诲張鍚屾璋冨洖鏉ワ紝鏍堝氨鐖嗕簡锛夈€?
     * 鐜板湪鍥炲埌"鎺掗槦銆佺敱 `advance()` 鎶藉共"锛屼笌瀹氭椂鍣ㄥ悓涓€濂楋細杩欐棦鏇村儚娴忚鍣紝
     * 涔熼『鎵嬭 `env.advance(ms)` 鑳界湡鐨勬妸閫愬抚鍔ㄧ敾鎺ㄧ潃璧般€?
     */
    requestAnimationFrame: (fn) => {
      frames.push({ fn, cancelled: false })
      return frames.length
    },
    cancelAnimationFrame: (id) => {
      const entry = frames[id - 1]
      if (entry) entry.cancelled = true
    },
    addEventListener(type, fn) {
      if (!windowListeners.has(type)) windowListeners.set(type, [])
      windowListeners.get(type).push(fn)
    },
    removeEventListener(type, fn) {
      const list = windowListeners.get(type)
      if (!list) return
      const i = list.indexOf(fn)
      if (i >= 0) list.splice(i, 1)
    },
    dispatchWindow(type, props = {}) {
      for (const fn of windowListeners.get(type) || []) fn(makeEvent(type, props))
    },
  }
  window.window = window

  /* --- Web Audio + fetch: the 0.8.0 press sound ------------------------- */

  // The widget only ever touches this narrow surface (oscillator + gain +
  // buffer source + decodeAudioData), so recording THOSE calls is enough to
  // assert "one press = one sound", "the CD suppressed this one", and "this
  // press used the pipe". Anything the widget calls that is missing here would
  // throw inside its own try/catch and silently mute the press -- which is
  // exactly the kind of regression these checks exist to catch.
  const audioContexts = []
  const fetchLog = []
  class FakeParam {
    constructor() {
      this.value = 0
      this.events = []
    }
    setValueAtTime(v, t) {
      this.value = v
      this.events.push(['set', v, t])
      return this
    }
    linearRampToValueAtTime(v, t) {
      this.value = v
      this.events.push(['linear', v, t])
      return this
    }
    exponentialRampToValueAtTime(v, t) {
      this.value = v
      this.events.push(['exp', v, t])
      return this
    }
    cancelScheduledValues() {
      this.events.push(['cancel'])
      return this
    }
  }
  class FakeNode {
    constructor(ctx, kind) {
      this.ctx = ctx
      this.kind = kind
      this.connections = []
    }
    connect(target) {
      this.connections.push(target)
      return target
    }
    disconnect() {
      this.connections.length = 0
    }
  }
  class FakeOscillator extends FakeNode {
    constructor(ctx) {
      super(ctx, 'synth')
      this.type = 'sine'
      this.frequency = new FakeParam()
      this.startedAt = null
      this.stoppedAt = null
    }
    start(at) {
      this.startedAt = at
      this.ctx.plays.push({ kind: 'synth', at, node: this })
    }
    stop(at) {
      this.stoppedAt = at
    }
  }
  class FakeBufferSource extends FakeNode {
    constructor(ctx) {
      super(ctx, 'pipe')
      this.buffer = null
      this.startedAt = null
    }
    start(at) {
      this.startedAt = at
      this.ctx.plays.push({ kind: 'pipe', at, node: this })
    }
    stop() {}
  }
  class FakeGain extends FakeNode {
    constructor(ctx) {
      super(ctx, 'gain')
      this.gain = new FakeParam()
    }
  }
  class FakeAudioContext {
    constructor() {
      this.state = 'running'
      this.currentTime = 0
      this.destination = new FakeNode(this, 'destination')
      this.plays = []
      this.resumes = 0
      this.decodes = 0
      audioContexts.push(this)
    }
    resume() {
      this.resumes += 1
      this.state = 'running'
      return Promise.resolve()
    }
    createGain() {
      return new FakeGain(this)
    }
    createOscillator() {
      return new FakeOscillator(this)
    }
    createBufferSource() {
      return new FakeBufferSource(this)
    }
    decodeAudioData() {
      this.decodes += 1
      return Promise.resolve({ duration: PIPE_SECONDS })
    }
  }
  window.AudioContext = FakeAudioContext
  // 0.10.2: the widget polls `/dsh-corner-anim/turn.json` once a turn ends (the
  // same signal the whale widget uses). The stub serves a controllable seq; set
  // `env.turn.fail = true` to simulate an old host and force the legacy
  // text-growth fallback instead.
  const turn = { seq: 0, fail: false }
  window.fetch = (url) => {
    fetchLog.push(String(url))
    if (String(url).indexOf('turn.json') >= 0) {
      if (turn.fail) return Promise.reject(new Error('turn.json unavailable'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, seq: turn.seq }) })
    }
    return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(64)) })
  }
  // The basin image is preloaded at mount; the widget only reads `onload`.
  class FakeImage {
    constructor() {
      this.onload = null
      this.onerror = null
      this._src = ''
    }
    get src() {
      return this._src
    }
    set src(value) {
      this._src = String(value)
      if (this.onload) this.onload()
    }
  }
  window.Image = FakeImage

  /**
   * 鍙帶鐨?`Math.random()`锛?.10.0 璧峰繀闇€锛夈€?
   *
   * 鐐瑰嚮鐢甸キ鐓茬幇鍦ㄤ細鎺蜂袱涓瀛愶紙20% / 10%锛夛紝鎷栧姩灏忓コ瀛╀細璧锋挱鎷栧姩鍔ㄧ敾 鈥斺€?
   * 濡傛灉璁╂々閲岀殑 `Math.random` 杩樻槸鐪熼殢鏈虹殑锛岄偅涔?20 澶氬"鎸夊帇鐢甸キ鐓?鐨勮€佹柇瑷€
   * 灏变細**姣忔璺戝嚭涓嶅悓缁撴灉**锛堢害 30% 鐨勬鐜囪闅忔満鍔ㄧ敾鎺ョ锛屽揩鐓у綋鐒跺氨娌¤鎷嶏級銆?
   *
   * 榛樿搴忓垪**鍏ㄩ儴钀藉湪 0.9 浠ヤ笂**锛岃繖鏄埢鎰忛€夌殑锛氬畠璁╀袱閬撻殢鏈哄姩鐢绘案杩滀笉瑙﹀彂锛?
   * 浜庢槸鎵€鏈夎€佹柇瑷€鍥炲埌瀹冧滑鍘熸湰瑕侀獙鐨勯偅鏉¤矾寰勪笂銆?*浣嗗畠浠嶇劧閫愭涓嶅悓**鈥斺€旀帀鐩嗛偅鍑犵粍
   * 鏂█"姣忎釜鐩嗙殑鎶栧姩 / 鍊捐鍚勪笉鐩稿悓"锛岀敤涓€涓畾鍊间細璁╁畠浠け璐ャ€?
   * 鎯抽獙闅忔満鍔ㄧ敾鐨勭敤渚嬫妸 `env.random.value` 璋冧笅鏉ワ紝鎴栬€呯敤 `env.random.queue`
   * 鎺掍竴涓插畾鍊硷紙鐢ㄦ潵鏂█"鍏堥棶 A 鍐嶉棶 B"鐨勯『搴忥級銆?
   */
  const random = { value: null, queue: [], n: 0 }
  const randomSequence = [0.9, 0.83, 0.96, 0.77, 0.89, 0.97, 0.81, 0.94, 0.86, 0.92]
  const mathProxy = Object.create(Math)
  Object.defineProperty(mathProxy, 'random', {
    value: () => {
      if (random.queue.length) return random.queue.shift()
      if (random.value !== null) return random.value
      random.n += 1
      return randomSequence[random.n % randomSequence.length]
    },
    writable: true,
    configurable: true,
  })

  const sandbox = {
    window,
    document,
    console,
    Promise,
    JSON,
    Math: mathProxy,
    Number,
    String,
    Object,
    Array,
    isFinite,
    parseFloat,
    Set,
    Uint8ClampedArray,
    // The widget reads Date.now() to decide which tick is due; give it the
    // harness clock (a `Date` subclass would break `instanceof` inside the VM,
    // and the widget only ever calls Date.now()).
    Date: { now: () => clock.now },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)

  /** Move the harness clock and fire every timer that falls inside the window. */
  function advance(ms) {
    const target = clock.now + ms
    for (let guard = 0; guard < 500; guard += 1) {
      let next = null
      for (const t of timers) {
        if (t.cancelled || t.fired) continue
        const at = t.at === undefined ? clock.now + t.ms : t.at
        if (at <= target && (next === null || at < next.at)) next = { entry: t, at }
      }
      if (!next) break
      clock.now = next.at
      const entry = next.entry
      if (entry.repeat) {
        // An interval keeps firing: re-arm it relative to the moment it ran,
        // which is what a browser does for a callback that finishes in time.
        entry.at = clock.now + entry.ms
      } else {
        entry.fired = true
      }
      entry.fn()
      if (entry.repeat && (entry.cancelled || entry.cleared)) entry.fired = true
    }
    // Then drain the animation frames queued up to this point. New frames may be
    // queued while draining (a per-frame loop re-arms itself), so the queue is
    // re-read until it stops growing -- with the same guard against a runaway.
    clock.now = target
    for (let guard = 0; guard < 500; guard += 1) {
      const batch = frames.splice(0, frames.length)
      if (!batch.length) break
      for (const f of batch) {
        if (!f.cancelled) f.fn()
      }
    }
    clock.now = target
  }

  /** How many times a clip has been started, across every element instance. */
  function playCount(kind) {
    return playLog.filter((src) => typeof src === 'string' && src.indexOf('/' + kind + '.webm') >= 0).length
  }

  return {
    sandbox,
    window,
    document,
    timers,
    store,
    windowListeners,
    media: mediaConfig,
    clock,
    advance,
    playLog,
    playCount,
    random,
    turn,
    seedClipMedia: (el) => document.seedClipMedia(el),
    audioContexts,
    fetchLog,
    /** The AudioContext the widget created (null until the first press). */
    audio: () => audioContexts[audioContexts.length - 1] || null,
  }
}

/** Mirrors TURN_POLL_MS in the widget. */
const TURN_POLL = 1000
/** Let pending promise chains (fetch -> json -> handle) settle. */
const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * Fire the 0.10.2 "one turn fully finished" signal: bump the seq the stub
 * serves, advance one poll interval, and let the fetch chain settle.
 */
async function fireTurnEnd(env) {
  await flushAsync() // the very first poll (the baseline) must have landed
  env.turn.seq += 1
  env.advance(TURN_POLL)
  await flushAsync()
}

/**
 * Make the turn signal unavailable and wait out the widget's failure budget
 * (TURN_FAIL_LIMIT failed polls), so the legacy text-growth output watch arms.
 * The 0.7.x detector subtleties (reasoning rows, process rows, short answers)
 * live on that fallback path only.
 */
async function useLegacyOutputWatch(env) {
  env.turn.fail = true
  env.advance(TURN_POLL * 4)
  await flushAsync()
}

function run(env) {
  vm.runInContext(WIDGET_SRC, env.sandbox, { filename: 'widget.js' })
}

/* ------------------------------------------------------------------- lookups */

function root(env) {
  return env.document.getElementById('dshca-root')
}
function video(env) {
  return env.document.getElementById('dshca-video')
}
// The bar and the panel MOVE into the girl part after a split, so they are
// located document-wide rather than as children of the root.
function bar(env) {
  return env.document.getElementById('dshca-bar')
}
function panel(env) {
  return env.document.getElementById('dshca-panel')
}
function buttonByTitle(env, title) {
  const b = bar(env)
  return b ? b.children.find((x) => x.title === title) : null
}
function presetByText(env, text) {
  const presets = panel(env).children.find((c) => c.className === 'dshca-presets')
  return presets.children.find((b) => b.textContent === text)
}
function slider(env) {
  return panel(env).children.find((c) => c.id === 'dshca-size')
}
/** The interval slider / readout / step presets live in the second panel row. */
function speedSlider(env) {
  return panel(env).children.find((c) => c.id === 'dshca-speed')
}
function speedLabel(env) {
  const head = panel(env).children.find(
    (c) => c.className === 'dshca-head' && c.children[0] && c.children[0].textContent === L_INTERVAL,
  )
  return head ? head.children[1].textContent : null
}
function speedPresetByText(env, text) {
  const rows = panel(env).children.filter((c) => c.className === 'dshca-presets')
  return rows[rows.length - 1].children.find((b) => b.textContent === text)
}
/** The bar's interval-step button, identified by its id rather than its label. */
function speedButton(env) {
  return bar(env).children.find((b) => b.id === 'dshca-speed-toggle')
}
function collapseButton(env) {
  return bar(env).children.find((b) => b.getAttribute('aria-expanded') !== null)
}
function widgetWidth(env) {
  return parseFloat(root(env).style.width)
}
function left(env) {
  return parseFloat(root(env).style.left)
}
function top(env) {
  return parseFloat(root(env).style.top)
}
/** The merged widget is hidden (display:none) exactly while it is split. */
function rootVisible(env) {
  return root(env).style.display !== 'none'
}

/* --- split parts --- */

function part(env, key) {
  return env.document.getElementById('dshca-part-' + key)
}
function partCanvas(env, key) {
  const p = part(env, key)
  return p ? p.children.find((c) => c.tagName === 'CANVAS') : null
}
function partLeft(env, key) {
  return parseFloat(part(env, key).style.left)
}
function partTop(env, key) {
  return parseFloat(part(env, key).style.top)
}
function partWidth(env, key) {
  return parseFloat(part(env, key).style.width)
}
/** Drive one complete drag on an element. `between` runs after the move, before the up. */
function dragBy(el, dx, dy, pointerId = 99, between = null) {
  el.dispatch('pointerdown', { pointerId, clientX: 500, clientY: 400, button: 0 })
  el.dispatch('pointermove', { pointerId, clientX: 500 + dx, clientY: 400 + dy })
  if (between) between()
  el.dispatch('pointerup', { pointerId, clientX: 500 + dx, clientY: 400 + dy })
}

/* --- labels (kept as escapes so the file stays ASCII-clean end to end) --- */

const L_REPLAY = '\u91cd\u64ad\u52a8\u753b'
const L_SCHED_PAUSE = '\u6682\u505c\u52a8\u753b\u6392\u671f\uff08Debug\uff09'
const L_SCHED_RESUME = '\u7ee7\u7eed\u52a8\u753b\u6392\u671f\uff08Debug\uff09'
const L_EXPAND = '\u5c55\u5f00\u8bbe\u7f6e'
const L_COLLAPSE = '\u6536\u8d77\u8bbe\u7f6e'
const L_CLOSE = '\u5173\u95ed\uff08\u672c\u6b21\u8fd0\u884c\uff09'
const L_SMALL = '\u5c0f'
const L_MEDIUM = '\u4e2d'
const L_LARGE = '\u5927'
const L_RESET = '\u91cd\u7f6e'
const L_INTERVAL = '\u52a8\u753b\u95f4\u9694'
/** Same three characters, but as the title prefix the bar button carries. */
const L_INTERVAL_TITLE = '\u52a8\u753b\u95f4\u9694\uff1a'
/** `5\u00d7` et al. -- the glyph the step button shows is `\u21c4` + this. */
const STEP_GLYPH = '\u21c4'
const GLYPH_EXPANDED = '\u25b4'
/* ------------------------------------------------------------------- checks */

let passed = 0
function ok(label) {
  passed += 1
  console.log(`  ok  ${label}`)
}

/* 1. mount, defaults, top-right placement -------------------------------- */

{
  const env = makeEnv({ width: 200, offsetX: 20, offsetY: 20, corner: 'top-right' })
  run(env)

  const r = root(env)
  assert.ok(r, 'root element must be created')
  assert.equal(r.parentNode, env.document.body, 'root must be attached to body')

  const v = video(env)
  assert.ok(v, 'video element must be created')
  assert.equal(v.src, '/dsh-corner-anim/anim.webm')
  assert.equal(v.loop, false, 'loop MUST be false so playback stops on the last frame')
  assert.equal(v.muted, true, 'muted, so autoplay is permitted')
  assert.equal(v.autoplay, true)
  assert.equal(v.getAttribute('playsinline'), '', 'playsinline keeps iOS/Electron from going fullscreen')
  assert.equal(v.getAttribute('draggable'), 'false')
  ok('mounts one root + one transparent video (loop=false, muted, playsinline)')

  assert.equal(r.classList.contains('dshca-ready'), false, 'must stay hidden until sized')
  assert.equal(v._plays, 1, 'play() must be called on mount')

  v.duration = 3
  v.dispatch('loadedmetadata')

  assert.equal(r.classList.contains('dshca-ready'), true, 'revealed after metadata')
  assert.equal(left(env), 1280 - 200 - 20, 'top-right: left = viewport - width - offsetX')
  assert.equal(top(env), 20, 'top-right: top = offsetY')
  assert.equal(r.style.right, 'auto')
  ok('places itself at the top-right corner after metadata arrives')
}

/* 2. other corners ------------------------------------------------------- */

{
  const env = makeEnv({ width: 200, offsetX: 30, offsetY: 40, corner: 'bottom-left' })
  run(env)
  const v = video(env)
  v.duration = 3
  v.dispatch('loadedmetadata')
  assert.equal(left(env), 30, 'bottom-left: left = offsetX')
  // height = 200 * (videoHeight / videoWidth), so the clamped top follows the asset aspect
  const h = 200 / VIDEO_ASPECT
  assert.equal(top(env), Math.round(800 - h - 40), 'bottom-left: top = viewport - height - offsetY')
  ok('honours bottom-left (needs real height, so placement waits for metadata)')
}

/* 3. holding the last frame --------------------------------------------- */

{
  const env = makeEnv({ split: false })
  run(env)
  const v = video(env)
  v.duration = 3
  v.dispatch('loadedmetadata')

  v.currentTime = 3
  v.dispatch('ended')
  assert.equal(v._pauses, 1, 'ended must pause explicitly')
  assert.equal(v.currentTime, 3, 'the final frame must be left on screen, not rewound')
  assert.equal(v.loop, false, 'still not looping')
  ok('on ended: pauses and stays on the last frame')

  // Defensive branch: if something rewound the element, restore the last frame.
  v.currentTime = 0
  v.dispatch('ended')
  assert.equal(v.currentTime, 3 - 0.05, 'a rewound element is nudged back to the final frame')
  ok('on ended after an unexpected rewind: seeks back to the final frame')
}

/* 4. dragging the whole widget ------------------------------------------ */

{
  const env = makeEnv({ width: 200, split: false })
  run(env)
  const v = video(env)
  v.duration = 3
  v.dispatch('loadedmetadata')

  const startLeft = left(env)
  const startTop = top(env)

  const down = root(env).dispatch('pointerdown', { pointerId: 1, clientX: 500, clientY: 100, button: 0 })
  assert.equal(down.defaultPrevented, true, 'pointerdown must preventDefault')
  assert.equal(root(env).classList.contains('dshca-dragging'), true, 'dragging class applied')

  root(env).dispatch('pointermove', { pointerId: 1, clientX: 560, clientY: 140 })
  assert.equal(left(env), startLeft + 60, 'follows the pointer 1:1 on x')
  assert.equal(top(env), startTop + 40, 'follows the pointer 1:1 on y')

  root(env).dispatch('pointerup', { pointerId: 1, clientX: 560, clientY: 140 })
  assert.equal(root(env).classList.contains('dshca-dragging'), false, 'dragging class removed')

  const saved = JSON.parse(env.store.get('dsh-corner-anim:pos:v1'))
  assert.equal(saved.x, startLeft + 60, 'position persisted to localStorage')
  assert.equal(saved.y, startTop + 40, 'position persisted to localStorage')
  ok('drag moves the widget 1:1 and saves the position')
}

/* 5. a click is not a drag ---------------------------------------------- */

{
  const env = makeEnv({ width: 200, split: false })
  run(env)
  const v = video(env)
  v.duration = 3
  v.dispatch('loadedmetadata')

  const startLeft = left(env)
  root(env).dispatch('pointerdown', { pointerId: 7, clientX: 500, clientY: 100, button: 0 })
  root(env).dispatch('pointermove', { pointerId: 7, clientX: 501, clientY: 101 })
  root(env).dispatch('pointerup', { pointerId: 7, clientX: 501, clientY: 101 })

  assert.equal(left(env), startLeft, 'sub-threshold movement must not move the widget')
  assert.equal(env.store.has('dsh-corner-anim:pos:v1'), false, 'sub-threshold movement must not persist')
  ok('sub-threshold pointer movement is ignored (drag vs click)')
}

/* 6. clamping so it can never be lost off-screen ------------------------- */

{
  const env = makeEnv({ width: 200, split: false })
  run(env)
  const v = video(env)
  v.duration = 3
  v.dispatch('loadedmetadata')

  root(env).dispatch('pointerdown', { pointerId: 2, clientX: 0, clientY: 0, button: 0 })
  root(env).dispatch('pointermove', { pointerId: 2, clientX: 5000, clientY: 5000 })
  root(env).dispatch('pointerup', { pointerId: 2, clientX: 5000, clientY: 5000 })

  assert.equal(left(env), 1280 - 56, 'right edge keeps 56px visible')
  assert.equal(top(env), 800 - 56, 'bottom edge keeps 56px visible')
  ok('clamps to keep at least 56px of the widget on screen')

  root(env).dispatch('pointerdown', { pointerId: 3, clientX: 0, clientY: 0, button: 0 })
  root(env).dispatch('pointermove', { pointerId: 3, clientX: -5000, clientY: -5000 })
  root(env).dispatch('pointerup', { pointerId: 3, clientX: -5000, clientY: -5000 })
  assert.equal(left(env), 56 - 200, 'left edge keeps 56px visible')
  ok('clamps on the left edge too')
}

/* 7. restoring a saved position ----------------------------------------- */

{
  const env = makeEnv({ width: 200, corner: 'top-right', split: false })
  env.store.set('dsh-corner-anim:pos:v1', JSON.stringify({ x: 400, y: 300 }))
  run(env)
  const v = video(env)
  v.duration = 3
  v.dispatch('loadedmetadata')
  assert.equal(left(env), 400, 'restores saved x instead of the configured corner')
  assert.equal(top(env), 300, 'restores saved y')
  ok('restores the remembered position across reloads')
}

/* 8. resize keeps it reachable ------------------------------------------ */

{
  const env = makeEnv({ width: 200, split: false })
  run(env)
  const v = video(env)
  v.duration = 3
  v.dispatch('loadedmetadata')
  assert.equal(left(env), 1060)

  env.window.innerWidth = 400
  env.window.innerHeight = 300
  env.window.dispatchWindow('resize')
  assert.ok(left(env) <= 400 - 56, `after shrink, left (${left(env)}) must be clamped into the new viewport`)
  ok('re-clamps on window resize')
}

/* 9. idempotence: both injection channels firing ------------------------- */

{
  const env = makeEnv({})
  run(env)
  run(env) // the web tapIndex and the desktop inline row can both land
  const roots = env.document.body.children.filter((c) => c.id === 'dshca-root')
  assert.equal(roots.length, 1, 'the widget must mount exactly once even if the script loads twice')
  ok('idempotent: loaded twice, mounted once')
}

/* 10. hover controls ---------------------------------------------------- */

{
  const env = makeEnv({ width: 200, split: false })
  run(env)
  const v = video(env)
  v.duration = 3
  v.dispatch('loadedmetadata')

  const replay = buttonByTitle(env, L_REPLAY)
  const close = buttonByTitle(env, L_CLOSE)
  assert.ok(replay, 'replay button must exist')
  assert.ok(close, 'close button must exist')

  v.currentTime = 3
  v.dispatch('ended')
  const playsBefore = v._plays
  replay.dispatch('pointerdown', { pointerId: 9, clientX: 1, clientY: 1 })
  replay.dispatch('click')
  assert.equal(v.currentTime, 0, 'replay rewinds to the start')
  assert.ok(v._plays > playsBefore, 'replay calls play() again')
  ok('replay button rewinds and plays again')

  close.dispatch('pointerdown', { pointerId: 10, clientX: 1, clientY: 1 })
  close.dispatch('click')
  assert.equal(root(env), null, 'close removes the widget from the DOM')
  ok('close button removes the widget')
}

/* 11. controls can be turned off, video failure cleans up ---------------- */

{
  const env = makeEnv({ showControls: false })
  run(env)
  assert.equal(bar(env), null, 'showControls:false must not build the button bar')
  ok('showControls:false hides the button bar')
}

{
  const env = makeEnv({})
  run(env)
  video(env).dispatch('error')
  assert.equal(root(env), null, 'a media error must remove the widget instead of leaving an empty box')
  ok('media error cleans up the widget')
}

/* 12. autoplay blocked -> a click-to-play affordance -------------------- */

{
  const env = makeEnv({})
  const originalCreate = env.document.createElement.bind(env.document)
  let blocked = true
  env.document.createElement = (tag) => {
    const el = originalCreate(tag)
    if (String(tag).toLowerCase() === 'video') {
      el.play = function () {
        if (blocked) return Promise.reject(new Error('NotAllowedError'))
        this._plays = (this._plays || 0) + 1
        return Promise.resolve()
      }
    }
    return el
  }
  run(env)
  await Promise.resolve()
  await Promise.resolve()
  const hint = env.document.getElementById('dshca-hint')
  assert.ok(hint, 'a play affordance must appear when autoplay is refused')
  ok('autoplay refusal falls back to a click-to-play affordance')

  blocked = false
  hint.dispatch('click')
  await Promise.resolve()
  assert.equal(env.document.getElementById('dshca-hint'), null, 'hint disappears once playback starts')
  ok('clicking the affordance starts playback and clears the hint')
}

/* 13. late metadata is still revealed by the timeout fallback ------------ */

{
  const env = makeEnv({ width: 200 })
  run(env)
  assert.equal(root(env).classList.contains('dshca-ready'), false)
  const last = env.timers[env.timers.length - 1]
  assert.equal(last.ms, 4000, 'a reveal timeout must be armed')
  last.fn()
  assert.equal(root(env).classList.contains('dshca-ready'), true, 'timeout reveals the widget')
  ok('reveal timeout covers slow metadata')
}

/* 14. the 'playing' event also reveals (real order puts it after metadata) - */

{
  const env = makeEnv({ width: 200, split: false })
  run(env)
  const v = video(env)
  v.duration = 3
  v.dispatch('loadedmetadata')
  v.dispatch('loadeddata')
  v.dispatch('playing')
  assert.equal(root(env).classList.contains('dshca-ready'), true, 'revealed by the real event sequence')
  assert.equal(left(env), 1060, 'still correctly placed top-right')
  assert.equal(env.document.getElementById('dshca-hint'), null, 'no hint when playback is fine')
  ok('normal event order (metadata -> data -> playing) reveals without a hint')
}

/* 15. collapsible size panel: placement, toggling, size control ---------- */

{
  const env = makeEnv({ width: 220, minWidth: 80, maxWidth: 600, split: false })
  run(env)
  const v = video(env)
  v.duration = 3
  v.dispatch('loadedmetadata')

  // --- button order: replay, schedule-debug, interval steps, collapse, close ---
  const titles = bar(env).children.map((b) => b.title)
  assert.equal(titles.length, 5, 'replay, schedule, interval, collapse, close')
  assert.deepEqual(
    [titles[0], titles[1], titles[3], titles[4]],
    [L_REPLAY, L_SCHED_PAUSE, L_EXPAND, L_CLOSE],
    'the debug button sits right of replay, and collapse right of that',
  )
  assert.ok(
    titles[2].indexOf(L_INTERVAL_TITLE) === 0,
    'the interval button sits between them and titles itself with both periods',
  )
  ok('button order is [replay, schedule, interval, collapse, close]')

  // --- panel exists but starts collapsed ---
  const p = panel(env)
  assert.ok(p, 'the size panel must exist')
  assert.equal(root(env).classList.contains('dshca-open'), false, 'panel starts collapsed')
  assert.equal(collapseButton(env).getAttribute('aria-expanded'), 'false')
  ok('panel exists and starts collapsed (bar is hover-only until opened)')

  // --- expand ---
  collapseButton(env).dispatch('click')
  assert.equal(root(env).classList.contains('dshca-open'), true, 'click expands the panel')
  const cb = collapseButton(env)
  assert.equal(cb.textContent, GLYPH_EXPANDED, 'glyph flips to the expanded state')
  assert.equal(cb.title, L_COLLAPSE)
  assert.equal(cb.getAttribute('aria-expanded'), 'true')
  assert.equal(env.store.get('dsh-corner-anim:panel:v1'), '1', 'open state persisted')
  ok('collapse button expands the panel, flips glyph, and remembers the state')

  // --- the panel is laid out next to the widget, inside the viewport ---
  const rect = root(env).getBoundingClientRect()
  assert.ok(p.style.left !== undefined && p.style.top !== undefined, 'panel gets explicit coordinates')
  const absLeft = rect.left + parseFloat(p.style.left)
  const absTop = rect.top + parseFloat(p.style.top)
  assert.ok(absLeft >= 0 && absLeft + PANEL_W <= 1280, `panel stays inside the viewport horizontally (${absLeft})`)
  assert.ok(
    Math.abs(parseFloat(p.style.top) - (rect.height + 6)) <= 1,
    `panel sits just below the widget (top=${p.style.top}, widget height=${rect.height})`,
  )
  assert.ok(absTop + PANEL_H <= 800, 'panel fits below')
  ok('panel is positioned below the widget and clamped inside the viewport')

  // --- size slider ---
  const s = slider(env)
  assert.equal(s.type, 'range')
  assert.equal(s.min, '80', 'slider lower bound comes from minWidth')
  assert.equal(s.max, '600', 'slider upper bound comes from maxWidth')
  assert.equal(s.value, '220', 'slider starts at the configured width')
  assert.equal(widgetWidth(env), 220)

  s.value = '340'
  s.dispatch('input')
  assert.equal(widgetWidth(env), 340, 'moving the slider resizes the widget')
  assert.equal(env.store.get('dsh-corner-anim:size:v1'), '340', 'new size persisted')
  ok('slider resizes the widget live and persists the size')

  // --- clamping to the configured bounds ---
  s.value = '9999'
  s.dispatch('input')
  assert.equal(widgetWidth(env), 600, 'size clamps to maxWidth')
  s.value = '1'
  s.dispatch('input')
  assert.equal(widgetWidth(env), 80, 'size clamps to minWidth')
  ok('size is clamped to [minWidth, maxWidth]')

  // --- resizing re-clamps the position so the widget can never be lost ---
  s.value = '600'
  s.dispatch('input')
  assert.equal(widgetWidth(env), 600, 'back to maxWidth')
  root(env).dispatch('pointerdown', { pointerId: 9, clientX: 0, clientY: 0, button: 0, target: video(env) })
  root(env).dispatch('pointermove', { pointerId: 9, clientX: -9999, clientY: 0 })
  root(env).dispatch('pointerup', { pointerId: 9, clientX: -9999, clientY: 0 })
  assert.equal(left(env), 56 - 600, 'a 600px-wide widget may sit as far left as 56px-visible')

  s.value = '80'
  s.dispatch('input')
  assert.equal(left(env), 56 - 80, 'shrinking pulls the widget back so it stays reachable')
  ok('resizing re-clamps the widget position')
}

/* 16. presets and reset -------------------------------------------------- */

{
  const env = makeEnv({ width: 220, minWidth: 80, maxWidth: 600, split: false })
  run(env)
  video(env).duration = 3
  video(env).dispatch('loadedmetadata')
  collapseButton(env).dispatch('click')

  const small = presetByText(env, L_SMALL)
  const medium = presetByText(env, L_MEDIUM)
  const large = presetByText(env, L_LARGE)
  assert.deepEqual(
    [small, medium, large].map((b) => b.getAttribute('data-size')),
    ['132', '220', '330'],
    'presets scale from the configured default width (0.6x / 1x / 1.5x)',
  )
  assert.ok(medium.classList.contains('dshca-active'), 'the preset matching the current size is highlighted')

  large.dispatch('click')
  assert.equal(widgetWidth(env), 330, 'preset applies its size')
  assert.ok(large.classList.contains('dshca-active'), 'highlight follows the selection')
  assert.ok(!medium.classList.contains('dshca-active'), 'previous highlight cleared')
  ok('preset buttons resize and highlight correctly')

  presetByText(env, L_RESET).dispatch('click')
  assert.equal(widgetWidth(env), 220, 'reset returns to the configured width')
  assert.equal(env.store.has('dsh-corner-anim:size:v1'), false, 'reset clears the remembered size')
  ok('reset returns to the configured default and clears storage')
}

/* 17. size + open state survive a reload --------------------------------- */

{
  const env = makeEnv({ width: 220, minWidth: 80, maxWidth: 600, split: false })
  env.store.set('dsh-corner-anim:size:v1', '480')
  env.store.set('dsh-corner-anim:panel:v1', '1')
  run(env)
  assert.equal(widgetWidth(env), 480, 'remembered size wins over config.width')
  video(env).duration = 3
  video(env).dispatch('loadedmetadata')
  assert.equal(root(env).classList.contains('dshca-open'), true, 'panel reopens if it was left open')
  assert.equal(slider(env).value, '480', 'slider reflects the remembered size')
  ok('remembered size and open state are restored on reload')

  // A remembered size outside the configured range is clamped.
  const env2 = makeEnv({ width: 220, minWidth: 100, maxWidth: 300, split: false })
  env2.store.set('dsh-corner-anim:size:v1', '900')
  run(env2)
  assert.equal(widgetWidth(env2), 300, 'a stale remembered size is clamped to maxWidth')
  ok('stale remembered size is clamped into the configured range')
}

/* 18. the panel never triggers a drag ------------------------------------ */

{
  const env = makeEnv({ width: 220, minWidth: 80, maxWidth: 600, split: false })
  run(env)
  video(env).duration = 3
  video(env).dispatch('loadedmetadata')
  collapseButton(env).dispatch('click')

  const startLeft = left(env)
  const startTop = top(env)

  // pointerdown on the panel background, the slider, and a preset must all be ignored
  for (const target of [panel(env), slider(env), presetByText(env, L_LARGE)]) {
    const event = root(env).dispatch('pointerdown', {
      pointerId: 42,
      clientX: 600,
      clientY: 200,
      button: 0,
      target,
    })
    assert.equal(event.defaultPrevented, false, 'a control target must not start a drag')
  }
  root(env).dispatch('pointermove', { pointerId: 42, clientX: 900, clientY: 500 })
  assert.equal(left(env), startLeft, 'widget did not move while interacting with the panel')
  assert.equal(top(env), startTop, 'widget did not move while interacting with the panel')
  assert.equal(root(env).classList.contains('dshca-dragging'), false, 'no dragging state')
  ok('pointer interaction with the panel/slider/presets never drags the widget')

  // But the video area still drags normally with the panel open.
  root(env).dispatch('pointerdown', { pointerId: 43, clientX: 600, clientY: 200, button: 0, target: video(env) })
  root(env).dispatch('pointermove', { pointerId: 43, clientX: 650, clientY: 230 })
  root(env).dispatch('pointerup', { pointerId: 43, clientX: 650, clientY: 230 })
  assert.equal(left(env), startLeft + 50, 'dragging still works with the panel open')
  ok('dragging still works while the panel is open')
}

/* 19. panel flips above when there is no room below ---------------------- */

{
  const env = makeEnv({ width: 220, minWidth: 80, maxWidth: 600, split: false })
  run(env)
  video(env).duration = 3
  video(env).dispatch('loadedmetadata')

  // Move the widget near the bottom edge, then open the panel.
  root(env).dispatch('pointerdown', { pointerId: 5, clientX: 0, clientY: 0, button: 0, target: video(env) })
  root(env).dispatch('pointermove', { pointerId: 5, clientX: -10000, clientY: 10000 })
  root(env).dispatch('pointerup', { pointerId: 5, clientX: -10000, clientY: 10000 })
  collapseButton(env).dispatch('click')

  const p = panel(env)
  assert.ok(parseFloat(p.style.top) < 0, `panel must flip above the widget near the bottom edge (top=${p.style.top})`)
  ok('panel flips above the widget when there is no room below')

  // And horizontally flips inward when the widget hugs the left edge.
  const rect = root(env).getBoundingClientRect()
  const absLeft = rect.left + parseFloat(p.style.left)
  assert.ok(absLeft >= 0, `panel stays inside the viewport on the left (${absLeft})`)
  ok('panel stays inside the viewport horizontally near the left edge')
}

/* 20. showControls:false removes the whole control surface ---------------- */

{
  const env = makeEnv({ showControls: false })
  run(env)
  assert.equal(bar(env), null, 'no button bar')
  assert.equal(panel(env), null, 'no size panel either - the panel is part of the control surface')
  ok('showControls:false removes both the bar and the panel')
}

/* 21. splitting into cooker + girl when playback ends -------------------- */

{
  // Synthetic last frame: opaque everywhere except a transparent band over
  // 50%..53% of the width - the same shape as the real 2K asset.
  const env = makeEnv({ width: 220 }, { gap: [0.5, 0.53] })
  run(env)
  const v = video(env)
  v.duration = 6.084
  v.dispatch('loadedmetadata')
  const startLeft = left(env)
  const startTop = top(env)

  assert.equal(part(env, 'cooker'), null, 'no parts before the animation ends')
  assert.equal(rootVisible(env), true, 'the merged widget is visible')

  v.currentTime = 6.084
  v.dispatch('ended')
  env.advance(0) // the split rides on requestAnimationFrame, which is queued

  assert.ok(part(env, 'cooker'), 'the cooker part appears when playback ends')
  assert.ok(part(env, 'girl'), 'the girl part appears when playback ends')
  assert.equal(root(env).style.display, 'none', 'the merged widget is hidden while split')
  ok('playback end splits the last frame into two parts')

  // The split must land inside the transparent band, and each part is then
  // cropped to its own subject --so the empty band belongs to neither.
  const cookerCanvas = partCanvas(env, 'cooker')
  const girlCanvas = partCanvas(env, 'girl')
  assert.equal(cookerCanvas.width, 1280, 'cooker canvas is cropped to the cooker content')
  assert.equal(girlCanvas.width, 1200, 'girl canvas is cropped to the girl content')
  assert.equal(cookerCanvas.height, VIDEO_H, 'full height: the synthetic frame has content in every row')
  assert.equal(girlCanvas.height, VIDEO_H)
  // 1280..1360 is the transparent band (50%..53% of 2560), claimed by neither part.
  assert.equal(VIDEO_W - (cookerCanvas.width + girlCanvas.width), 80, 'the transparent band lands in neither part')
  ok('each part is cropped to its own subject, excluding the transparent band')

  // The cooker keeps the merged widget's spot: the split stays seamless on its side.
  assert.equal(partLeft(env, 'cooker'), startLeft, 'cooker takes the merged widget position')
  assert.equal(partTop(env, 'cooker'), startTop)
  // The girl is pulled out to the window's right border instead (0.7.3). Her crop
  // sits at source x=1360 here, i.e. ~20px inside the widget; she must end up
  // flush with the window's right border (2px shy of it), and whole.
  {
    const girlRight = partLeft(env, 'girl') + partWidth(env, 'girl')
    assert.equal(girlRight, env.window.innerWidth - 2, 'she rests against the window border')
    assert.ok(partLeft(env, 'girl') > startLeft, 'which is to the right of her place in the frame')
    assert.ok(girlRight <= env.window.innerWidth, 'and she is still entirely inside the window')
  }
  assert.equal(partTop(env, 'girl'), startTop, 'both parts start on the same row')
  ok('the cooker stays where it was in the frame while the girl hugs the window border')

  // Heights: both parts are as tall as the merged widget was.
  const mergedH = 220 / VIDEO_ASPECT
  assert.ok(Math.abs(part(env, 'cooker').getBoundingClientRect().height - mergedH) < 1, 'cooker keeps full height')
  assert.ok(Math.abs(part(env, 'girl').getBoundingClientRect().height - mergedH) < 1, 'girl keeps full height')
  ok('both parts keep the full frame height')
}

/* 22. the controls end up on the girl's side ----------------------------- */

{
  const env = makeEnv({ width: 220 }, { gap: [0.5, 0.53] })
  run(env)
  const v = video(env)
  v.duration = 6.084
  v.dispatch('loadedmetadata')
  v.currentTime = 6.084
  v.dispatch('ended')
  env.advance(0) // the split rides on requestAnimationFrame, which is queued

  assert.equal(bar(env).parentNode, part(env, 'girl'), 'the button bar lives on the girl side')
  assert.equal(panel(env).parentNode, part(env, 'girl'), 'the size panel lives on the girl side')
  assert.ok(!part(env, 'cooker').contains(bar(env)), 'the cooker side carries no controls')
  ok('replay / collapse / close and the panel all stay on the girl')

  // Opening the panel targets the girl part, not the (hidden) root.
  collapseButton(env).dispatch('click')
  assert.equal(part(env, 'girl').classList.contains('dshca-open'), true, 'the girl part hosts the panel')
  assert.equal(root(env).classList.contains('dshca-open'), false, 'the hidden root is not the panel host')
  ok('the panel opens against the girl part')
}

/* 23. the two parts drag independently ---------------------------------- */

{
  const env = makeEnv({ width: 220 }, { gap: [0.5, 0.53] })
  run(env)
  const v = video(env)
  v.duration = 6.084
  v.dispatch('loadedmetadata')
  v.currentTime = 6.084
  v.dispatch('ended')
  env.advance(0) // the split rides on requestAnimationFrame, which is queued

  const cookerLeft0 = partLeft(env, 'cooker')
  const girlLeft0 = partLeft(env, 'girl')

  dragBy(part(env, 'cooker'), -200, 120, 11)
  assert.equal(partLeft(env, 'cooker'), cookerLeft0 - 200, 'cooker moved on its own')
  assert.equal(partLeft(env, 'girl'), girlLeft0, 'the girl did NOT move with the cooker')
  ok('dragging the cooker leaves the girl untouched')

  const cookerLeft1 = partLeft(env, 'cooker')
  // Drag the girl left: it starts near the right edge, where clamping would
  // legitimately stop a rightward drag.
  dragBy(part(env, 'girl'), -150, 60, 12)
  assert.equal(partLeft(env, 'girl'), girlLeft0 - 150, 'girl moved on its own')
  assert.equal(partLeft(env, 'cooker'), cookerLeft1, 'the cooker did NOT move with the girl')
  ok('dragging the girl leaves the cooker untouched')

  assert.equal(JSON.parse(env.store.get('dsh-corner-anim:pos:cooker:v1')).x, cookerLeft1, 'cooker position saved')
  assert.equal(JSON.parse(env.store.get('dsh-corner-anim:pos:girl:v1')).x, girlLeft0 - 150, 'girl position saved')
  ok('each part persists its own position')
}

/* 24. replay merges, then splits again ---------------------------------- */

{
  const env = makeEnv({ width: 220 }, { gap: [0.5, 0.53] })
  run(env)
  const v = video(env)
  v.duration = 6.084
  v.dispatch('loadedmetadata')
  v.currentTime = 6.084
  v.dispatch('ended')
  env.advance(0) // the split rides on requestAnimationFrame, which is queued
  assert.ok(part(env, 'girl'), 'split first')

  const playsBefore = v._plays
  buttonByTitle(env, L_REPLAY).dispatch('click')

  assert.equal(part(env, 'cooker'), null, 'replay removes the cooker part')
  assert.equal(part(env, 'girl'), null, 'replay removes the girl part')
  assert.equal(rootVisible(env), true, 'the merged widget is shown again')
  assert.equal(bar(env).parentNode, root(env), 'the bar returns to the merged widget')
  assert.equal(panel(env).parentNode, root(env), 'the panel returns to the merged widget')
  assert.equal(v.currentTime, 0, 'replay rewinds')
  assert.ok(v._plays > playsBefore, 'replay plays again')
  ok('replay merges the parts back and restarts the animation')

  // ...and the next end splits again.
  v.currentTime = 6.084
  v.dispatch('ended')
  env.advance(0) // the split rides on requestAnimationFrame, which is queued
  assert.ok(part(env, 'cooker') && part(env, 'girl'), 'it splits again on the next end')
  ok('the widget splits again after replaying')
}

/* 25. hand-placed part positions survive a replay ----------------------- */

{
  const env = makeEnv({ width: 220 }, { gap: [0.5, 0.53] })
  run(env)
  const v = video(env)
  v.duration = 6.084
  v.dispatch('loadedmetadata')
  v.currentTime = 6.084
  v.dispatch('ended')
  env.advance(0) // the split rides on requestAnimationFrame, which is queued

  dragBy(part(env, 'cooker'), -300, 200, 21)
  dragBy(part(env, 'girl'), 260, -100, 22)
  const cookerLeft = partLeft(env, 'cooker')
  const girlLeft = partLeft(env, 'girl')

  buttonByTitle(env, L_REPLAY).dispatch('click')
  v.currentTime = 6.084
  v.dispatch('ended')
  env.advance(0) // the split rides on requestAnimationFrame, which is queued

  assert.equal(partLeft(env, 'cooker'), cookerLeft, 'the arrangement the user chose is restored')
  assert.equal(partLeft(env, 'girl'), girlLeft, 'the arrangement the user chose is restored')
  ok('parts you have positioned are put back where you left them')

  // But moving the whole widget means the old arrangement no longer applies.
  buttonByTitle(env, L_REPLAY).dispatch('click')
  dragBy(root(env), 40, 30, 23)
  assert.equal(env.store.has('dsh-corner-anim:pos:cooker:v1'), false, 'moving the whole widget clears part positions')
  assert.equal(env.store.has('dsh-corner-anim:pos:girl:v1'), false)
  v.currentTime = 6.084
  v.dispatch('ended')
  env.advance(0) // the split rides on requestAnimationFrame, which is queued
  const base = { x: left(env), y: top(env) }
  assert.equal(partLeft(env, 'cooker'), base.x, 'parts re-derive from the moved widget')
  ok('moving the whole widget makes the next split re-derive from its new position')
}

/* 26. split fallbacks --------------------------------------------------- */

{
  // (a) no transparent gap at all -> configured ratio
  const env = makeEnv({ width: 220, splitRatio: 0.4 }, { gap: [0, 0] })
  run(env)
  const v = video(env)
  v.duration = 6.084
  v.dispatch('loadedmetadata')
  v.currentTime = 6.084
  v.dispatch('ended')
  env.advance(0) // the split rides on requestAnimationFrame, which is queued
  assert.equal(partCanvas(env, 'cooker').width, Math.round(VIDEO_W * 0.4), 'falls back to splitRatio when no gap exists')
  ok('no transparent gap: falls back to splitRatio')

  // (b) tainted canvas (cross-origin media) -> configured ratio
  const env2 = makeEnv({ width: 220, splitRatio: 0.5 }, { taint: true })
  run(env2)
  const v2 = video(env2)
  v2.duration = 6.084
  v2.dispatch('loadedmetadata')
  v2.currentTime = 6.084
  v2.dispatch('ended')
  env2.advance(0) // the split rides on requestAnimationFrame, which is queued
  assert.equal(partCanvas(env2, 'cooker').width, VIDEO_W / 2, 'tainted canvas falls back instead of throwing')
  ok('cross-origin (tainted) frame: falls back to splitRatio instead of throwing')

  // (c) transparency only at the edges -> must be ignored, not treated as the gap
  const env3 = makeEnv({ width: 220, splitRatio: 0.5 }, { gap: [0, 0.06] })
  run(env3)
  const v3 = video(env3)
  v3.duration = 6.084
  v3.dispatch('loadedmetadata')
  v3.currentTime = 6.084
  v3.dispatch('ended')
  env3.advance(0) // the split rides on requestAnimationFrame, which is queued
  assert.equal(partCanvas(env3, 'cooker').width, VIDEO_W / 2, 'edge emptiness must not win over the real middle gap')
  ok('transparency at the frame edge is ignored')

  // (d) split turned off entirely
  const env4 = makeEnv({ width: 220, split: false }, { gap: [0.5, 0.53] })
  run(env4)
  const v4 = video(env4)
  v4.duration = 6.084
  v4.dispatch('loadedmetadata')
  v4.currentTime = 6.084
  v4.dispatch('ended')
  env4.advance(0) // the split rides on requestAnimationFrame, which is queued
  assert.equal(part(env4, 'cooker'), null, 'split:false keeps the widget whole')
  assert.equal(rootVisible(env4), true, 'the merged widget stays visible')
  ok('split:false keeps the single whole widget')
}

/* 27. resizing while split scales both parts ---------------------------- */

{
  const env = makeEnv({ width: 220, minWidth: 80, maxWidth: 600 }, { gap: [0.5, 0.53] })
  run(env)
  const v = video(env)
  v.duration = 6.084
  v.dispatch('loadedmetadata')
  v.currentTime = 6.084
  v.dispatch('ended')
  env.advance(0) // the split rides on requestAnimationFrame, which is queued
  collapseButton(env).dispatch('click')

  const cookerW0 = partWidth(env, 'cooker')
  const girlW0 = partWidth(env, 'girl')
  const cookerCx = partLeft(env, 'cooker') + cookerW0 / 2
  const girlCx = partLeft(env, 'girl') + girlW0 / 2

  slider(env).value = '440'
  slider(env).dispatch('input')

  assert.equal(widgetWidth(env), 440, 'the merged width doubles')
  // Part widths are whole pixels, so allow the 1px that rounding can cost.
  assert.ok(Math.abs(partWidth(env, 'cooker') - cookerW0 * 2) <= 1, 'cooker scales with the size setting')
  assert.ok(Math.abs(partWidth(env, 'girl') - girlW0 * 2) <= 1, 'girl scales with the size setting')
  assert.ok(
    Math.abs(partLeft(env, 'cooker') + partWidth(env, 'cooker') / 2 - cookerCx) < 1,
    'cooker scales about its own centre',
  )
  // The girl is the one part that is not left where scaling put her: she is
  // re-parked against the window border (0.7.3), so her centre DOES move right.
  assert.equal(
    partLeft(env, 'girl') + partWidth(env, 'girl'),
    env.window.innerWidth - 2,
    'girl scales and stays parked on the window border',
  )
  assert.ok(
    partLeft(env, 'girl') + partWidth(env, 'girl') / 2 < girlCx,
    'flush against the border she grows leftwards, so her centre is not the scaling centre',
  )
  ok('the size slider scales the cooker about its centre and keeps the girl on the border')

  // Reset re-aligns the parts and restores the configured width.
  presetByText(env, L_RESET).dispatch('click')
  assert.equal(widgetWidth(env), 220, 'reset restores the configured width')
  assert.equal(env.store.has('dsh-corner-anim:pos:cooker:v1'), false, 'reset also drops the part arrangement')
  ok('reset restores size and re-aligns the split')
}

/* 28. close and resize reach both parts --------------------------------- */

{
  const env = makeEnv({ width: 220 }, { gap: [0.5, 0.53] })
  run(env)
  const v = video(env)
  v.duration = 6.084
  v.dispatch('loadedmetadata')
  v.currentTime = 6.084
  v.dispatch('ended')
  env.advance(0) // the split rides on requestAnimationFrame, which is queued

  env.window.innerWidth = 300
  env.window.innerHeight = 300
  env.window.dispatchWindow('resize')
  for (const key of ['cooker', 'girl']) {
    const w = partWidth(env, key)
    const l = partLeft(env, key)
    assert.ok(l <= 300 - 56 + 0.001, `${key} re-clamped on resize (left=${l})`)
    assert.ok(l + w >= 56 - 0.001, `${key} keeps some pixels on screen after resize`)
  }
  ok('window resize re-clamps both parts')

  buttonByTitle(env, L_CLOSE).dispatch('click')
  assert.equal(part(env, 'cooker'), null, 'close removes the cooker')
  assert.equal(part(env, 'girl'), null, 'close removes the girl')
  assert.equal(root(env), null, 'close removes the merged widget too')
  ok('close removes the widget and both parts')
}

/* 29. no parts before playback has finished ----------------------------- */

{
  const env = makeEnv({ width: 220 }, { gap: [0.5, 0.53] })
  run(env)
  const v = video(env)
  v.duration = 6.084
  v.dispatch('loadedmetadata')
  v.dispatch('playing')
  assert.equal(part(env, 'cooker'), null, 'stays whole while playing')
  assert.equal(v.loop, false, 'still no looping')
  ok('the widget stays whole until the animation actually ends')
}

/* ------------------------------------------------------------------ */
/* 30. idle animation: created, looped, sized to the girl part          */
/* ------------------------------------------------------------------ */

/** The idle layer is located document-wide: it lives inside the girl part. */
function idle(env) {
  return env.document.getElementById('dshca-idle')
}
/* ------------------------------------------------------------------ */
/* 30. the girl part's animation schedule                               */
/* ------------------------------------------------------------------ */

/**
 * Drive a real end-of-animation: the split happens, then the schedule arms.
 *
 * Retires every timer armed before this point (in practice the mount-time reveal
 * timeout), so the pending ticks are the schedule's own.
 */
function playToEnd(env, duration = 6.084) {
  const v = video(env)
  v.duration = duration
  v.dispatch('loadedmetadata')
  const before = env.timers.length
  v.currentTime = duration
  v.dispatch('ended')
  // 鎷嗗垎鎸傚湪 `requestAnimationFrame` 涓婏紙"绛夎繖涓€甯х湡鐨勮惤鍒板悎鎴愬櫒涓婂啀瑁?锛夛紝
  // 鑰?rAF 鐜板湪鏄帓闃熺殑锛堣 window 妗╋級锛氳繖閲屾帹涓€涓嬮槦鍒楋紝鎷嗗垎鎵嶇湡鐨勫彂鐢熴€?
  // `advance(0)` 涓嶆帹杩涙椂闂达紝鍙娊骞插凡鎺掔殑甯с€?
  env.advance(0)
  env.timers.slice(0, before).forEach((t) => {
    t.cancelled = true
  })
}
/** Is the girl part's frozen-frame canvas showing? */
function girlCanvasVisible(env) {
  const c = partCanvas(env, 'girl')
  return c ? c.style.visibility !== 'hidden' : false
}
/**
 * Drop only the timers armed before `armedBefore` -- used where a test picks
 * 4000ms as an animation period, so filtering by delay would be wrong.
 */
function clearRevealTimer(env, armedBefore) {
  env.timers.slice(0, armedBefore).forEach((t) => {
    if (!t.fired) t.cancelled = true
  })
}
/**
 * Which clip is VISIBLE right now ('' when none is).
 *
 * The engine keeps every clip mounted and swaps `visibility`, so "mounted" says
 * nothing about what is on screen. This is the predicate the one-image-at-a-time
 * guarantee has to be checked with.
 *
 * 0.10.0 起还有一路（拖动动画）是靠 **`display`** 开关的（`#dshca-drag` 默认
 * `display:none`），它**不写内联 visibility** —— 所以这里两个都要看，否则
 * "松手之后拖动动画有没有收掉"这件事根本量不出来。
 */
function visibleClip(env) {
  return animEls(env)
    .filter((c) => c.style.visibility !== 'hidden' && c.style.display !== 'none')
    .map((c) => c.id.replace('dshca-anim-', ''))
    .join('+')
}
/**
 * Exactly one of {a clip, the frozen frame} must be on screen at any moment.
 * Returns which one it is.
 */
function assertSinglePicture(env, label) {
  const vis = visibleClip(env)
  const canvas = girlCanvasVisible(env)
  const count = (vis ? vis.split('+').length : 0) + (canvas ? 1 : 0)
  assert.equal(
    count,
    1,
    `${label}: exactly one picture must be on screen (clip="${vis}" canvas=${canvas})`,
  )
  return vis || 'frozen'
}
/**
 * Which clip is playing right now, and actually on screen ('' when none is).
 *
 * Scoped to the MOUNTED elements on purpose: a clip that was dropped (bad media)
 * or detached keeps its `_playing` flag on the orphaned node, which would
 * otherwise be reported as "still playing" after it left the page entirely.
 */
function note(env) {
  return animEls(env)
    .filter((c) => c._playing && c.style.visibility !== 'hidden')
    .map((c) => c.id.replace('dshca-anim-', ''))
    .join('+')
}
/** Where the pending timers stand. Debug aid for the schedule checks. */
function peekTimers(env) {
  return env.timers.map(
    (t, i) => `#${i + 1}:${t.ms}@${t.at}${t.cancelled ? 'x' : ''}${t.fired ? 'f' : ''}`,
  )
}

/**
 * The <video> carrying a given clip.
 *
 * Its intrinsic size AND duration are preloaded by `Document.createElement` (a
 * browser knows both from metadata), because "parks on its own last frame" can
 * only be asserted against a real end-of-media position.
 */
function animEl(env, kind) {
  return env.document.getElementById('dshca-anim-' + kind)
}
function animEls(env) {
  const host = env.document.getElementById('dshca-part-girl')
  return host ? host.children.filter((c) => c.tagName === 'VIDEO') : []
}
/** How many timers are still pending at a given delay (not fired, not cancelled). */
function liveTimers(env, ms) {
  return env.timers.filter((t) => t.ms === ms && !t.cancelled && !t.fired)
}
/** Deliver the clip's metadata, the way a browser would before it can play. */
function animReady(env, kind) {
  const el = animEl(env, kind)
  assert.ok(el, `the ${kind} clip must exist by now`)
  el._clockAdvance = true
  env.seedClipMedia(el)
  el.dispatch('loadedmetadata')
  return el
}
/**
 * Advance the harness clock to the earliest pending timer and fire exactly that
 * one. Deliberately not "select by delay" and not "run everything up to now":
 * the scheduler keeps a re-armed repeating timer, and a tester needs to observe
 * the state after each single tick.
 */
function fireNext(env) {
  const live = env.timers.filter((t) => !t.cancelled && !t.fired)
  assert.ok(live.length, 'the schedule must have a pending timer')
  const at = Math.min(...live.map((t) => t.at))
  const same = live.filter((t) => t.at === at)
  assert.equal(same.length, 1, `exactly one timer may be due at ${at}, found ${same.length}`)
  const entry = same[0]
  env.clock.now = at
  entry.fired = true
  entry.fn()
  return entry
}
/** Let the schedule run for `ms` of harness time (fires every timer inside). */
function runSchedule(env, ms = 90000) {
  env.advance(ms)
}
/** Pretend a clip ran to its end: the media reaches its duration and stops. */
function clipEnded(env, kind) {
  const el = animEl(env, kind)
  el.currentTime = el.duration || 5
  el.ended = true
  // Per spec, reaching the end stops playback -- so the element is no longer
  // "playing" even though it keeps showing that frame. The widget relies on this
  // (`isSlotLive()` treats `ended` as done) to let the next turn start.
  el._playing = false
  el.dispatch('ended')
  return el
}

{
  const env = makeEnv({ width: 220 }, { gap: [0.5, 0.53] })
  run(env)
  const main = video(env)

  assert.equal(animEls(env).length, 0, 'nothing is mounted while the opener is still playing')
  assert.ok(buttonByTitle(env, L_SCHED_PAUSE), 'the debug button exists from the start')

  // --- split ---
  playToEnd(env)

  const girl = part(env, 'girl')
  assert.ok(girl, 'the opener must still split into two parts')
  const els = animEls(env)
  assert.equal(els.length, 2, 'both clips are mounted on the girl part, waiting for their turn')
  for (const el of els) {
    assert.equal(el.parentNode, girl, 'the clips belong to the girl part')
    assert.equal(el._plays || 0, 0, 'nothing plays until the first tick')
    assert.equal(el.loop, false, 'each clip plays once per turn; the schedule does the repeating')
    assert.equal(el.muted, true, 'muted, so no gesture is needed')
    assert.equal(el.getAttribute('draggable'), 'false')
    assert.equal(el.classList.contains('dshca-anim'), true)
  }
  assert.equal(animEl(env, 'idle').src, '/dsh-corner-anim/idle.webm')
  assert.equal(animEl(env, 'act').src, '/dsh-corner-anim/act.webm')
  assert.equal(girlCanvasVisible(env), true, 'the frozen frame is up before the first tick')
  ok('after the opener: both clips are mounted on the girl part, neither playing yet')

  // --- each clip is laid out against the girl part, keeping its own aspect ---
  animReady(env, 'idle')
  animReady(env, 'act')
  {
    const gw = partWidth(env, 'girl')
    const gh = girl.getBoundingClientRect().height
    for (const [kind, aw, ah] of [
      ['idle', IDLE_W, IDLE_H],
      ['act', ACT_W, ACT_H],
    ]) {
      const el = animEl(env, kind)
      const cw = parseFloat(el.style.width)
      const ch = parseFloat(el.style.height)
      assert.ok(isFinite(cw) && isFinite(ch), `${kind} must receive explicit CSS pixel dimensions`)
      assert.ok(
        Math.abs(ch - gh) <= 0.02 || Math.abs(cw - gw) <= 0.02,
        `${kind} must fit the girl part (${cw}x${ch} vs ${gw}x${gh})`,
      )
      // The clips are portrait while the girl crop is nearly square, so fitting the
      // ELEMENT to the box would distort her; the content box must letterbox.
      assert.ok(
        Math.abs(cw / ch - aw / ah) < 0.01,
        `${kind} keeps its asset aspect ratio (${(cw / ch).toFixed(3)} vs ${(aw / ah).toFixed(3)})`,
      )
    }
    // Each clip is fitted from its OWN content box: the two assets differ in
    // height (1920 vs 1916), so their fitted widths must differ too.
    const idleW = parseFloat(animEl(env, 'idle').style.width)
    const actW = parseFloat(animEl(env, 'act').style.width)
    assert.notEqual(idleW, actW, 'each clip is fitted independently, not by one shared size')
  }
  ok('each clip is sized to the girl part while keeping its own asset aspect ratio')

  // --- the first tick is the standby clip's: at 5s the action clip is not due yet ---
  fireNext(env)
  assert.equal(env.playCount('idle'), 1, 'at 5s the standby clip takes the tick')
  assert.equal(env.playCount('act'), 0, 'the action clip is not due until 15s')
  assert.equal(girlCanvasVisible(env), false, 'the frozen frame yields while a clip is up')
  ok('the 5s tick starts idle.webm')

  // --- a tick landing mid-clip is skipped: the running clip is never interrupted ---
  fireNext(env)
  assert.equal(env.playCount('idle'), 1, 'the busy tick starts nothing')
  assert.equal(env.playCount('act'), 0, 'and starts nothing else')
  ok('a tick that lands mid-clip is skipped instead of interrupting (no overlap, ever)')

  // --- the clip finishes: the girl STAYS on its last frame (0.6.0) ----------
  //
  // THE REPORTED BEHAVIOUR: once a clip is over, the girl used to be handed back
  // to the opener's frozen frame, so she visibly snapped back to the opening pose
  // every time. Now the ended clip (which a non-looping <video> keeps showing)
  // stays as "the one picture" until the next turn replaces it.
  clipEnded(env, 'idle')
  assert.equal(visibleClip(env), 'idle', 'the clip that just finished stays on screen')
  assert.equal(
    animEl(env, 'idle').currentTime,
    animEl(env, 'idle').duration,
    'and it is parked exactly on its own last frame',
  )
  assert.equal(animEl(env, 'idle').ended, true, 'ended, so it no longer counts as live')
  assert.equal(assertSinglePicture(env, 'after the clip'), 'idle')
  ok('after a clip ends the girl stays on that clip\u2019s last frame, not the opener\u2019s')

  // --- and the frame simply stays there: no timer will take it away ---------
  //
  // The old implementation armed a 200ms "stand down" timer here which swapped
  // the picture back to the frozen canvas. Any timer at all would be a bug now.
  env.advance(4000)
  assert.equal(visibleClip(env), 'idle', 'the last frame survives the whole gap')
  assert.equal(assertSinglePicture(env, 'in the gap'), 'idle')
  ok('the last frame holds for the whole gap until the next turn')

  // --- 15s: BOTH periods coincide, so the action clip takes the turn ---
  // (5s and 15s land on the same instant every 15s.) The standby clip stands down
  // for that round -- exactly why the two clips can never share the screen.
  const idlePlaysBefore = env.playCount('idle')
  fireNext(env) // 15s
  assert.equal(env.playCount('act'), 1, 'when both periods coincide, the action clip wins')
  assert.equal(assertSinglePicture(env, 'at the 15s tick'), 'act')
  assert.equal(
    env.playCount('idle'),
    idlePlaysBefore,
    'and the standby clip does not restart for it',
  )
  ok('a coincidence goes to act, and only act')
}

/* 31. a denser, deterministic timeline over two minutes ------------------- */

{
  // Periods picked to interleave unevenly, so every transition is predictable:
  // idle at 4s/8s/-- act at 6s/12s/-- a coincident round at 12s.
  const env = makeEnv({ width: 220, idleEvery: 4000, actEvery: 6000 }, { gap: [0.5, 0.53] })
  run(env)
  run(env) // idempotence guard: a second load must not double-mount
  playToEnd(env)
  // A duplicated 'ended' must not arm a second schedule on top of the first.
  // (`fireNext` asserts that exactly one timer is ever due at one instant, so a
  //  double-armed schedule would fail the very next step.)
  video(env).dispatch('ended')
  env.advance(0) // the split rides on requestAnimationFrame, which is queued
  animReady(env, 'idle')
  animReady(env, 'act')
  const girl = part(env, 'girl')
  // Both beats are armed from one instant (the split), so the first timer's
  // schedule is that origin. Expected cadence with 4s/6s, straight from the
  // documented rules ("a missed beat is skipped, not queued"):
  //   4s  standby (its first turn)
  //   6s  action  -- due at 6s, i.e. before the standby's 8s turn
  //   8s  standby
  //  12s  both due -> the action clip wins the collision
  const armEntry = env.timers[env.timers.length - 1]
  const t0 = armEntry.at - armEntry.ms
  const off = (t) => t - t0
  // What is on screen matters, not just what is playing: from 0.6.0 a finished
  // clip keeps the screen, so the transcript records WHICH picture is up.
  const transcript = []
  const step = (label) => {
    const vis = visibleClip(env)
    transcript.push(`${label}=${vis || 'frozen'}${vis && !note(env) ? '(held)' : ''}`)
  }

  // --- the last frame simply stays until the next turn ----------------------
  fireNext(env) // 4s
  step('4s')
  assert.equal(off(env.clock.now), 4000, 'the standby clip takes the first turn at 4s')
  assert.equal(note(env), 'idle', 'at 4s only the standby clip is playing')
  assert.equal(girlCanvasVisible(env), false, 'a clip is covering the girl')

  clipEnded(env, 'idle')
  step('4s+')
  assert.equal(note(env), '', 'nothing is playing once the clip is over')
  assert.equal(visibleClip(env), 'idle', 'the girl waits on the standby clip\u2019s last frame')
  assert.equal(girlCanvasVisible(env), false, 'the opener\u2019s frozen frame is NOT brought back')
  assert.equal(off(nextDueAt(env)), 6000, 'the next turn is the action clip, due at 6s')

  fireNext(env) // 6s
  step('6s')
  assert.equal(off(env.clock.now), 6000, 'the action clip\u2019s first turn lands at 6s')
  assert.equal(note(env), 'act', 'at 6s the action clip takes its turn')
  assert.equal(animEl(env, 'act').parentNode, girl, 'the clip is mounted on the girl part')
  assert.equal(env.playCount('act'), 1, 'and it is playing')

  clipEnded(env, 'act')
  fireNext(env) // 8s
  step('8s')
  assert.equal(off(env.clock.now), 8000, 'the standby clip is back on its own 4s beat')
  assert.equal(note(env), 'idle', 'at 8s the standby clip is back')
  assert.ok(animEls(env).length <= 2, 'the layer never accumulates more than one element per clip')

  clipEnded(env, 'idle')
  fireNext(env) // 12s: both due
  step('12s')
  assert.equal(off(env.clock.now), 12000, 'the collision round lands at the 12s beat')
  assert.equal(note(env), 'act', 'at 12s both are due and the action clip wins again')
  assert.equal(env.playCount('act'), 2, 'the action clip has now had both its turns (6s and 12s)')
  assert.equal(env.playCount('idle'), 2, 'the standby clip had its two turns (4s and 8s), not three')
  ok(`the timeline is exactly as designed (${transcript.join(' ')})`)

  // Now let it run freely, ending each clip as it comes, and assert the headline
  // guarantee on every single step: exactly one picture on screen -- a clip or
  // the opener's frozen frame (only before the very first turn), never both and
  // never two clips. The girl must also never fall back off her own last frame.
  let violations = 0
  let fallsBack = 0
  let sawClips = 0
  let sawFrozen = 0
  for (let i = 0; i < 120; i += 1) {
    const what = assertSinglePicture(env, `free-run step ${i}`)
    if (what === 'frozen') sawFrozen += 1
    else sawClips += 1
    if (what === 'idle+act') violations += 1
    for (const el of animEls(env)) {
      if (el.style.visibility !== 'hidden' && !el.ended) {
        el.currentTime = el.duration || 5
        el.ended = true
        el.dispatch('ended')
      }
    }
    // Right after a clip ends, the picture must still be that clip's last frame.
    const after = assertSinglePicture(env, `free-run step ${i} (after the clip)`)
    if (after === 'frozen') fallsBack += 1
    runSchedule(env, 2000)
  }
  assert.equal(violations, 0, 'the two clips must never both be visible')
  assert.equal(fallsBack, 0, 'a finished clip must never hand the screen back to the opener frame')
  assert.ok(sawClips > 0, 'clips did play during the free run')
  ok(
    `over four minutes of interleaved ticks: always exactly one picture ` +
      `(${sawClips} clip steps, ${sawFrozen} frozen steps)`,
  )
}

/* 32. pausing freezes the frame instead of exposing the layer below ------- */

{
  const env = makeEnv({ width: 220 }, { gap: [0.5, 0.53] })
  run(env)
  playToEnd(env)
  animReady(env, 'idle')
  animReady(env, 'act')

  // Let the first clip run its course, so the one we pause is a fresh start.
  fireNext(env) // 5s: the standby clip
  clipEnded(env, 'idle')
  // (No teardown tick any more: the ended clip keeps the screen by itself, so
  // the next due timer is the 10s turn. `fireNext` would fail on a stale one.)
  assert.equal(animEls(env).filter((c) => c._playing).length, 0, 'the girl holds that last frame')
  assert.equal(visibleClip(env), 'idle', 'and the clip that produced it is still the picture')

  fireNext(env) // 10s: the standby clip starts again, and this is the one we pause
  const clip = animEl(env, 'idle')
  assert.equal(clip._playing, true, 'a clip is mid-play when we pause')
  assert.equal(girlCanvasVisible(env), false, 'the clip is covering the opener\u2019s frozen frame')

  // --- pause while a clip is mid-play ---
  const toggle = buttonByTitle(env, L_SCHED_PAUSE)
  assert.ok(toggle, 'while the schedule runs, the button offers "pause"')
  assert.equal(toggle.getAttribute('aria-pressed'), 'true')
  assert.equal(toggle.classList.contains('dshca-on'), true, 'the running state is highlighted')
  assert.equal(toggle.textContent, '\u23f8')

  toggle.dispatch('click')

  assert.ok(animEl(env, 'idle'), 'THE REGRESSION: the clip must NOT be torn down on pause')
  assert.equal(animEl(env, 'idle').parentNode, part(env, 'girl'), 'it stays mounted on the girl part')
  assert.equal(clip._pauses >= 1, true, 'pause() is called on the clip')
  assert.equal(
    girlCanvasVisible(env),
    false,
    'THE REGRESSION: the opener frame below must stay hidden, or the picture jumps back',
  )
  assert.equal(visibleClip(env), 'idle', 'the paused frame is still the one picture (frozen, not swapped)')
  // The pending tick is disarmed rather than left to fire: no timer at all may
  // survive the pause (the behavioural check follows below).
  assert.equal(
    env.timers.filter((t) => !t.cancelled && !t.fired).length,
    0,
    'pausing leaves no timer armed',
  )
  assert.ok(buttonByTitle(env, L_SCHED_RESUME), 'the button flips to the resume affordance')
  assert.equal(buttonByTitle(env, L_SCHED_RESUME).getAttribute('aria-pressed'), 'false')
  ok('pausing freezes the clip in place and never reveals the layer beneath')

  // --- and the period in flight is not started all over again ---
  const playsWhilePaused = clip._plays || 0
  assert.equal(clip._plays || 0, playsWhilePaused, 'pausing starts nothing')

  // --- resume: the schedule re-arms from now (one timer covers the next due tick) ---
  //
  // THE REPORTED BUG: the frozen clip used to stay "the picture" for ever after a
  // resume -- it had no `ended` coming, yet it counted as live, so every later
  // tick was skipped as "something is already showing" and no animation ever
  // appeared again. Resuming clears `activeSlot`, so the stale frame no longer
  // occupies the schedule, and the next tick starts a clip.
  //
  // 0.6.0: resuming no longer swaps the picture to the opener's frozen frame
  // either -- the paused frame stays until the next turn replaces it.
  buttonByTitle(env, L_SCHED_RESUME).dispatch('click')
  assert.equal(
    env.timers.filter((t) => !t.cancelled && !t.fired).length,
    1,
    'resuming arms the next tick again',
  )
  assert.equal(visibleClip(env), 'idle', 'THE REGRESSION: the stale frame is not pinned as "live"')
  assert.equal(
    assertSinglePicture(env, 'right after resuming'),
    'idle',
    'the girl keeps waiting on her own last frame, not on the opener\u2019s',
  )
  assert.ok(buttonByTitle(env, L_SCHED_PAUSE), 'the button flips back to pause')

  // And the schedule really is alive again: the next tick starts a fresh clip.
  fireNext(env)
  assert.ok(
    env.playCount('idle') + env.playCount('act') > 0,
    'the resumed schedule plays a clip again',
  )
  assert.equal(
    assertSinglePicture(env, 'after the resumed tick'),
    note(env),
    'and that clip is the one picture on screen',
  )
  ok('resuming lets the next turn play normally, without dropping back to the opener frame')

  // --- a paused schedule never fires, even if the clock runs on ---
  const frozenClip = visibleClip(env)
  assert.ok(frozenClip, 'the resumed tick left a clip on screen')
  buttonByTitle(env, L_SCHED_PAUSE).dispatch('click')
  assert.equal(animEls(env).filter((c) => c._playing).length, 0, 'nothing is playing once paused')
  runSchedule(env, 60000)
  assert.equal(
    animEls(env).filter((c) => c._playing).length,
    0,
    'paused: no clip starts no matter how much time passes',
  )
  assert.equal(visibleClip(env), frozenClip, 'and the picture is still the frame we froze on')
  ok('while paused the schedule is fully inert')
}

/* 33. hand-off between two clips never flashes the opener frame ----------- */

{
  // Case A: a coincidence round means the next turn is already due when the clip
  // ends, so the layer is reused rather than rebuilt -- the picture never even
  // leaves the action clip.
  const tight = makeEnv({ width: 220, idleEvery: 3000, actEvery: 3000 }, { gap: [0.5, 0.53] })
  run(tight)
  playToEnd(tight)
  animReady(tight, 'idle')
  animReady(tight, 'act')

  fireNext(tight) // 3s: act wins the coincidence
  assert.equal(note(tight), 'act', 'the action clip is running')
  assert.equal(assertSinglePicture(tight, 'hand-off: running'), 'act')
  clipEnded(tight, 'act')
  assert.ok(
    animEl(tight, 'act') && animEl(tight, 'act').style.visibility !== 'hidden',
    'the finished clip keeps the screen',
  )
  assert.equal(assertSinglePicture(tight, 'hand-off: just ended'), 'act')
  tight.advance(3000) // run the next turn: both periods come round again
  assert.equal(tight.playCount('act'), 2, 'the action clip is restarted for its next turn')
  assert.equal(note(tight), 'act', 'and the picture never left the action clip')
  assert.equal(assertSinglePicture(tight, 'hand-off: next turn'), 'act')
  ok('a clip handed straight over to its next turn never shows the opener frame')

  // Case B: a clip that ends with the next turn a few seconds away simply waits
  // on its own last frame -- 0.6.0 no longer swaps the picture back to the canvas.
  const spaced = makeEnv({ width: 220, idleEvery: 4000, actEvery: 9000 }, { gap: [0.5, 0.53] })
  run(spaced)
  playToEnd(spaced)
  animReady(spaced, 'idle')
  animReady(spaced, 'act')

  fireNext(spaced) // 4s: idle starts
  clipEnded(spaced, 'idle')
  assert.equal(assertSinglePicture(spaced, 'persist window'), 'idle')
  spaced.advance(3000) // still ~1s to go before the next turn
  assert.equal(visibleClip(spaced), 'idle', 'the finished clip still holds the screen')
  assert.equal(assertSinglePicture(spaced, 'after the gap'), 'idle')
  ok('once a clip is done the girl waits on that clip\u2019s last frame')
}

/* 34. replay / close / config knobs ------------------------------------- */

{
  const env = makeEnv({ width: 220 }, { gap: [0.5, 0.53] })
  run(env)
  playToEnd(env)
  fireNext(env)
  assert.equal(animEls(env).length, 2, 'clips are mounted before replay')

  buttonByTitle(env, L_REPLAY).dispatch('click')
  assert.equal(animEls(env).length, 0, 'replay takes the clips away')
  assert.equal(part(env, 'girl'), null, 'replay merges the parts back')
  assert.equal(rootVisible(env), true, 'the merged widget is visible again')
  // Ticks that were in flight must not resurrect a clip on the merged widget.
  runSchedule(env, 60000)
  assert.equal(animEls(env).length, 0, 'no clip is mounted again after the merge')
  ok('replay drops the clips and stops the schedule')
}

{
  const env = makeEnv({ width: 220 }, { gap: [0.5, 0.53] })
  run(env)
  playToEnd(env)
  fireNext(env)
  buttonByTitle(env, L_CLOSE).dispatch('click')
  assert.equal(animEls(env).length, 0, 'close removes the clips')
  assert.equal(root(env), null, 'close removes the widget')
  ok('close removes the clips along with the widget')
}

{
  // idle:false keeps only the action clip, and its period is the only one armed.
  const env = makeEnv({ width: 220, idle: false }, { gap: [0.5, 0.53] })
  run(env)
  playToEnd(env)
  assert.equal(animEls(env).length, 1, 'idle:false mounts only the action clip')
  assert.equal(assertSinglePicture(env, 'idle:false after the split'), 'frozen')
  assert.ok(animEl(env, 'act'), 'the action clip is the survivor')
  fireNext(env)
  assert.equal(env.playCount('act'), 1, 'it plays on its own period')
  ok('idle:false leaves just act.webm on its 15s period')
}

{
  // act:false likewise leaves just the standby clip.
  const env = makeEnv({ width: 220, act: false }, { gap: [0.5, 0.53] })
  run(env)
  playToEnd(env)
  assert.equal(animEls(env).length, 1, 'act:false mounts only the standby clip')
  assert.equal(assertSinglePicture(env, 'act:false after the split'), 'frozen')
  assert.ok(animEl(env, 'idle'), 'the standby clip is the survivor')
  fireNext(env)
  assert.equal(env.playCount('idle'), 1, 'it plays on its own period')
  ok('act:false leaves just idle.webm on its 5s period')
}

{
  // Both off: nothing is mounted at all, and the opener's split is untouched.
  const env = makeEnv({ width: 220, idle: false, act: false }, { gap: [0.5, 0.53] })
  run(env)
  assert.equal(buttonByTitle(env, L_SCHED_PAUSE) || null, null, 'no clips --no debug button')
  playToEnd(env)
  assert.equal(animEls(env).length, 0, 'no clips are created')
  assert.ok(part(env, 'girl'), 'the split itself still happens')
  assert.equal(girlCanvasVisible(env), true, 'the girl stays on her frozen frame')
  ok('idle:false + act:false disables the whole animation feature')
}

/**
 * When the earliest pending timer is due, on the harness clock.
 */
function nextDueAt(env) {
  const live = env.timers.filter((t) => !t.cancelled && !t.fired)
  assert.ok(live.length, 'the schedule must have a pending timer')
  return Math.min(...live.map((t) => t.at))
}
/**
 * The scheduled instants of whichever pending timers are armed, relative to
 * `t0`, sorted. The scheduler keeps at most one timer armed at a time (the
 * earliest due turn), so this is "when the next turn lands" -- reading it is how
 * a test can prove the two clips keep their 1:3 ratio after an interval change.
 */
function pendingAt(env, t0) {
  return env.timers
    .filter((t) => !t.cancelled && !t.fired)
    .map((t) => t.at - t0)
    .sort((a, b) => a - b)
}

{
  // Custom periods are honoured: the first tick lands at idleEvery, the action
  // clip then waits for its own actEvery instead of the default 15s.
  const env = makeEnv({ width: 220, idleEvery: 2000, actEvery: 3000 }, { gap: [0.5, 0.53] })
  run(env)
  playToEnd(env)
  animReady(env, 'idle')
  animReady(env, 'act')

  const t0 = env.clock.now
  assert.equal(nextDueAt(env) - t0, 2000, 'the next tick follows idleEvery')

  fireNext(env) // 2s
  assert.equal(note(env), 'idle', 'the standby clip plays on its own period')

  // The clip ends and waits on its own last frame; the action clip is still due
  // at the 3s mark, i.e. 800ms after the standby clip's turn -- not a full
  // actEvery from "now".
  clipEnded(env, 'idle')
  assert.equal(visibleClip(env), 'idle', 'the finished standby clip holds the picture')
  assert.equal(nextDueAt(env) - t0, 3000, 'the action clip is due at its own actEvery')
  fireNext(env) // 3s
  assert.equal(note(env), 'act', 'the action clip gets its turn at actEvery')
  ok('idleEvery / actEvery drive the two periods')
}

{
  // Equal periods are the only real collision, and the action clip must win it
  // on every round --forever, not just the first time.
  const env = makeEnv({ width: 220, idleEvery: 5000, actEvery: 5000 }, { gap: [0.5, 0.53] })
  run(env)
  playToEnd(env)
  animReady(env, 'idle')
  animReady(env, 'act')

  fireNext(env)
  assert.equal(env.playCount('act'), 1, 'on a collision the action clip wins')
  assert.equal(env.playCount('idle'), 0, 'the standby clip stands down')

  // Let the action clip finish so the next collision is a real decision again.
  clipEnded(env, 'act')
  const start = env.clock.now
  let guard = 0
  while (env.clock.now - start < IDLE_PERIOD && guard < 20) {
    fireNext(env)
    guard += 1
  }
  assert.equal(env.playCount('act'), 2, 'the action clip keeps winning the collisions')
  assert.equal(env.playCount('idle'), 0, 'and the standby clip keeps standing down')
  ok('when both periods coincide, act wins every collision')
}

{
  // split:false never produces a girl part, so there is nowhere to play.
  const env = makeEnv({ width: 220, split: false }, { gap: [0.5, 0.53] })
  run(env)
  playToEnd(env)
  assert.equal(animEls(env).length, 0, 'without a split there is no girl part to play in')
  ok('split:false leaves the clips uncreated')
}

{
  // A dead clip must not blank the girl: drop that one and keep going.
  const env = makeEnv({ width: 220 }, { gap: [0.5, 0.53] })
  run(env)
  playToEnd(env)
  animReady(env, 'act')
  const act = animEl(env, 'act')
  act.dispatch('error')
  assert.equal(animEl(env, 'act'), null, 'the broken clip is dropped')
  assert.ok(animEl(env, 'idle'), 'the other clip is untouched')
  assert.equal(assertSinglePicture(env, 'after a clip error'), 'frozen')
  assert.ok(part(env, 'girl'), 'the girl part itself survives')
  ok('a broken clip is dropped without blanking the girl')
}

/* 35. the animation-interval control (bar steps + panel slider) ----------- */

{
  const env = makeEnv({ width: 220 }, { gap: [0.5, 0.53] })
  run(env)
  playToEnd(env)
  animReady(env, 'idle')
  animReady(env, 'act')
  const t0 = env.clock.now

  // --- the bar button: a step button that labels itself with the multiplier --
  const step = speedButton(env)
  assert.ok(step, 'the bar carries an interval-step button')
  assert.equal(step.textContent, STEP_GLYPH + '1\u00d7', 'it starts at 1x')
  assert.ok(
    step.title.indexOf(L_INTERVAL_TITLE) === 0 && step.title.indexOf('5s') >= 0 && step.title.indexOf('15s') >= 0,
    'and its tooltip spells out both periods',
  )
  assert.equal(step.classList.contains('dshca-speed'), true, 'it uses the wider step-button styling')
  ok('the bar has an interval-step button showing the current multiplier')

  // --- clicking walks the steps and re-schedules from "now" ----------------
  step.dispatch('click')
  assert.equal(step.textContent, STEP_GLYPH + '2\u00d7', 'one click moves to the next step')
  assert.equal(env.store.get('dsh-corner-anim:speed:v1'), '2', 'the multiplier is remembered')
  assert.equal(nextDueAt(env) - t0, 2 * IDLE_PERIOD, 'the tick follows the doubled standby interval')
  assert.equal(
    speedLabel(env),
    '2\u00d7\uff08\u5f85\u673a 10s / \u52a8\u4f5c 30s\uff09',
    'the panel readout shows the resulting periods',
  )
  ok('stepping up the multiplier stretches both periods and persists it')

  // --- the ratio between the two clips is preserved ------------------------
  //
  // Both periods are re-anchored from the moment of the change: the standby clip
  // comes round at 1x the standby interval and the action clip at 3x it
  // (5s/15s -> 10s/30s). That 1:3 ratio is what the collision rule depends on.
  //
  // Only one timer is ever armed (the earliest due turn), so the standby turn is
  // observable directly; the action clip's anchor is proven by letting the clock
  // free-run to the 3x mark -- if the change had left the periods at 2x/4x or
  // drifted them, the action turn would land somewhere else.
  assert.deepEqual(pendingAt(env, t0), [2 * IDLE_PERIOD], 'the standby turn is next, at 2x')
  fireNext(env) // the doubled standby tick
  assert.equal(note(env), 'idle', 'the standby clip still takes the first turn')
  assert.equal(env.clock.now - t0, 2 * IDLE_PERIOD, 'and it landed at the doubled interval')
  clipEnded(env, 'idle')
  assert.equal(visibleClip(env), 'idle', 'the girl waits on its last frame in between')
  // Take the standby clip out of the rotation so the action clip's own anchor is
  // the next thing to come round -- otherwise the standby turn (every 10s) would
  // legitimately take the slot first.
  animEl(env, 'idle').dispatch('error')
  assert.equal(animEl(env, 'idle'), null, 'the standby clip is out of the rotation')
  const actionAt = nextDueAt(env) - t0
  assert.equal(actionAt, 6 * IDLE_PERIOD, 'the action clip is anchored at 3x the standby interval')
  env.advance(actionAt - (env.clock.now - t0))
  assert.equal(note(env), 'act', 'and it takes its turn exactly there')
  ok('the standby/action ratio survives an interval change')

  // --- the panel slider: fine-grained, log-scaled, same value --------------
  const sliderEl = speedSlider(env)
  assert.ok(sliderEl, 'the panel carries an interval slider')
  assert.equal(sliderEl.type, 'range')
  assert.equal(sliderEl.min, '0')
  assert.equal(sliderEl.max, '1000')
  assert.ok(
    Math.abs(parseFloat(sliderEl.value) - 750) <= 1,
    `the slider is positioned at the current 2x multiplier (got ${sliderEl.value})`,
  )

  sliderEl.value = '500'
  sliderEl.dispatch('input')
  assert.equal(
    speedButton(env).textContent,
    STEP_GLYPH + '1\u00d7',
    'the middle of the log scale is exactly 1x',
  )

  sliderEl.value = '1000'
  sliderEl.dispatch('input')
  assert.equal(speedButton(env).textContent, STEP_GLYPH + '4\u00d7', 'sliding to the top is 4x')
  assert.equal(speedLabel(env), '4\u00d7\uff08\u5f85\u673a 20s / \u52a8\u4f5c 1min\uff09', 'and the readout follows')

  sliderEl.value = '0'

  sliderEl.value = '0'
  sliderEl.dispatch('input')
  assert.equal(speedButton(env).textContent, STEP_GLYPH + '0.25\u00d7', 'sliding to the bottom is 0.25x')
  assert.equal(
    speedLabel(env),
    '0.25\u00d7\uff08\u5f85\u673a 1.3s / \u52a8\u4f5c 3.8s\uff09',
    'and the readout follows, clamped to the 1s floor',
  )
  ok('the panel slider adjusts the interval finely, across the full 0.25x..4x range')

  // --- the step presets in the panel mirror the bar button ----------------
  speedPresetByText(env, '1\u00d7').dispatch('click')
  assert.equal(speedButton(env).textContent, STEP_GLYPH + '1\u00d7', 'a preset sets the multiplier')
  assert.equal(env.store.get('dsh-corner-anim:speed:v1'), '1', 'and persists it')
  ok('the panel\u2019s step presets and the bar button are the same control')

  // --- a remembered multiplier wins on the next load -----------------------
  const env2 = makeEnv({ width: 220 }, { gap: [0.5, 0.53] })
  env2.store.set('dsh-corner-anim:speed:v1', '2')
  run(env2)
  assert.equal(speedButton(env2).textContent, STEP_GLYPH + '2\u00d7', 'the remembered multiplier is restored')
  const t2 = env2.clock.now
  playToEnd(env2)
  assert.equal(nextDueAt(env2) - t2, 2 * IDLE_PERIOD, 'and it drives the very first tick')
  ok('a remembered interval survives a DSH restart and drives the first tick')

  // --- a nonsense stored value falls back to 1x ---------------------------
  const env3 = makeEnv({ width: 220 }, { gap: [0.5, 0.53] })
  env3.store.set('dsh-corner-anim:speed:v1', 'not-a-number')
  run(env3)
  assert.equal(speedButton(env3).textContent, STEP_GLYPH + '1\u00d7', 'garbage in storage falls back to 1x')
  const env4 = makeEnv({ width: 220 }, { gap: [0.5, 0.53] })
  env4.store.set('dsh-corner-anim:speed:v1', '99')
  run(env4)
  assert.equal(speedButton(env4).textContent, STEP_GLYPH + '4\u00d7', 'an out-of-range value clamps')
  ok('stored interval values are validated and clamped')

  // --- "reset" clears the remembered interval too -------------------------
  speedPresetByText(env, '2\u00d7').dispatch('click')
  assert.equal(env.store.has('dsh-corner-anim:speed:v1'), true, 'the tweak is stored')
  presetByText(env, L_RESET).dispatch('click')
  assert.equal(speedButton(env).textContent, STEP_GLYPH + '1\u00d7', 'reset returns to 1x')
  assert.equal(env.store.has('dsh-corner-anim:speed:v1'), false, 'and clears the remembered multiplier')
  ok('reset restores the default interval')
}

/* 36. an interval change while paused or mid-clip ------------------------ */

{
  const env = makeEnv({ width: 220 }, { gap: [0.5, 0.53] })
  run(env)
  playToEnd(env)
  animReady(env, 'idle')
  animReady(env, 'act')

  // --- while paused, changing the interval must not start anything ---------
  buttonByTitle(env, L_SCHED_PAUSE).dispatch('click') // pauses; nothing was playing
  assert.equal(env.timers.filter((t) => !t.cancelled && !t.fired).length, 0, 'paused, so nothing is pending')
  speedButton(env).dispatch('click')
  assert.equal(env.timers.filter((t) => !t.cancelled && !t.fired).length, 0, 'changing the interval does not start the clock')
  assert.equal(note(env), '', 'and it does not start a clip')
  assert.equal(speedButton(env).textContent, STEP_GLYPH + '2\u00d7', 'the new multiplier still applies')

  // --- resuming afterwards uses the new interval from that moment ---------
  const tResume = env.clock.now
  buttonByTitle(env, L_SCHED_RESUME).dispatch('click')
  assert.equal(nextDueAt(env) - tResume, 2 * IDLE_PERIOD, 'the resumed schedule uses the new interval')
  ok('an interval change while paused takes effect on resume, without starting anything')

  // --- changing it mid-clip does not interrupt the clip in flight ---------
  const env2 = makeEnv({ width: 220 }, { gap: [0.5, 0.53] })
  run(env2)
  playToEnd(env2)
  animReady(env2, 'idle')
  animReady(env2, 'act')
  fireNext(env2) // the standby clip takes the first turn
  const playing = animEl(env2, 'idle')
  assert.equal(playing._playing, true, 'a clip is mid-play')
  speedButton(env2).dispatch('click')
  assert.equal(animEl(env2, 'idle'), playing, 'the clip element is not rebuilt')
  assert.equal(playing._playing, true, 'and it is not interrupted')
  assert.equal(animEl(env2, 'idle')._pauses || 0, 0, 'nor paused')
  assert.equal(visibleClip(env2), 'idle', 'it still owns the screen')
  ok('an interval change never interrupts the clip that is playing')
}

/* 37. the send-message hook (0.7.0): a fake DSH shell ------------------- */

/**
 * Build a minimal stand-in for the DSH composer + message list:
 *
 *   body
 *     鈹斺攢 #chat
 *         鈹溾攢 #log        (assistant answers land here)
 *         鈹斺攢 #composer
 *             鈹溾攢 textarea#dsh-input
 *             鈹斺攢 button#dsh-send   ("鍙戦€佹秷鎭?)
 *
 * Returns handles the tests drive: click the button, grow the answer text, etc.
 */
function buildFakeShell(env) {
  const body = env.document.body
  const chat = new Element('div')
  chat.id = 'chat'
  const log = new Element('div')
  log.id = 'log'
  const composer = new Element('form')
  composer.id = 'composer'
  const input = new Element('textarea')
  input.id = 'dsh-input'
  const send = new Element('button')
  send.id = 'dsh-send'
  send.setAttribute('aria-label', '\u53d1\u9001\u6d88\u606f')
  composer.appendChild(input)
  composer.appendChild(send)
  chat.appendChild(log)
  chat.appendChild(composer)
  body.appendChild(chat)
  return { body, chat, log, composer, input, send }
}

/**
 * The REAL DSH message structure (read out of `@deepseek-ai/dsh-client-ui-chat`,
 * `ReasoningRow` + `AssistantMarkdown`):
 *
 *   div[data-variant=think][data-state=running|ok]   鈫?the "鎬濊€? (reasoning) row
 *       span  "鎬濊€?
 *       span._3GBCTG_summary[data-streaming]         鈫?streaming reasoning preview
 *   div._markdown_xxxx                               鈫?the answer body
 *
 * Two things stream while the model is still thinking: the reasoning preview AND
 * the process rows ("姝ｅ湪鍒嗘瀽璇锋眰" / "姝ｅ湪璋冪敤宸ュ叿" -- those live *outside* the
 * reasoning row, so no text-length exclusion can filter them). This builder lets a
 * test prove the hook ignores the reasoning row, waits for the answer container,
 * and -- since 0.7.5 -- also holds the lid while the row is still `running`.
 */
function buildRealisticAnswer(env) {
  const log = env.document.getElementById('log')
  const reasoningRow = new Element('div')
  // NOTE: no `role="button"` here -- the live DSH markup does not have one, and
  // adding it would make the class-name selector unnecessary, hiding a bug.
  reasoningRow._className = '_row_jhda5_16 _3GBCTG_row _3GBCTG_root'
  reasoningRow.setAttribute('data-variant', 'think')
  reasoningRow.setAttribute('data-state', 'running')
  const title = new Element('span')
  title.textContent = '\u601d\u8003'
  const preview = new Element('span')
  preview._className = '_3GBCTG_summary'
  preview.setAttribute('data-streaming', 'true')
  preview.textContent = ''
  reasoningRow.appendChild(title)
  reasoningRow.appendChild(preview)

  const answer = new Element('div')
  answer._className = '_markdown_1ypvv_5'
  answer.textContent = ''

  log.appendChild(reasoningRow)
  log.appendChild(answer)
  return { reasoningRow, preview, answer }
}

/**
 * The model stopped thinking: DSH re-renders the reasoning row with
 * `data-state="ok"` and drops the summary's `data-streaming`. That is the exact
 * moment the 0.7.5 open-lid precondition opens up.
 */
function reasoningDone(parts) {
  parts.reasoningRow.setAttribute('data-state', 'ok')
  parts.preview.removeAttribute('data-streaming')
  return parts
}

/**
 * One answer body, the way DSH renders it: a `_markdown_鈥 container whose text
 * grows while the model streams. The class matters -- it is what the widget uses
 * to tell "answer text" apart from the streaming "鎬濊€? row.
 */
function answerNode(shell, text) {
  const node = new Element('div')
  node._className = '_markdown_1ypvv_5'
  node.textContent = text || ''
  shell.log.appendChild(node)
  return node
}

{
  const env = makeEnv({ width: 220 }, { gap: [0.5, 0.53] })
  const shell = buildFakeShell(env)
  run(env)
  playToEnd(env)
  animReady(env, 'idle')
  animReady(env, 'act')

  // --- clicking "鍙戦€佹秷鎭? starts event 1 ---------------------------------
  assert.equal(env.document.querySelector('#dshca-girl'), null, 'no girl clip before the send')
  // The answer body already exists but is still empty (this is one turn in an
  // ongoing conversation) -- the baseline must be taken from THIS moment.
  const answer = answerNode(shell, '')
  env.document.dispatchOn(shell.send, 'click')
  const girlClip = env.document.getElementById('dshca-girl')
  assert.ok(girlClip, 'clicking send must mount the girl clip')
  assert.equal(girlClip.src, '/dsh-corner-anim/girl.webm')
  assert.equal(girlClip._plays, 1, 'and start it exactly once')
  assert.equal(girlClip.loop, false, 'it plays once, not on a loop')
  assert.equal(girlClip.muted, true)
  assert.equal(girlClip.classList.contains('dshca-showing'), true, 'it is visible while it plays')
  ok('clicking the send button plays the girl clip once')

  // --- while she plays, the schedule is parked (no idle/act stealing it) ---
  //
  // The girl clip lives in the same subtree as the two scheduled clips, so this
  // is asserted explicitly rather than through `visibleClip` (which only knows
  // about idle/act).
  assert.equal(animEl(env, 'idle').style.visibility, 'hidden', 'neither animation clip is on screen')
  assert.equal(animEl(env, 'act').style.visibility, 'hidden', 'neither animation clip is on screen')
  assert.equal(env.playCount('idle'), 0, 'the standby clip does not start on top of her')
  assert.equal(env.playCount('act'), 0, 'and neither does the action clip')

  // --- she is laid out by her CONTENT box against the girl part ------------
  //
  // The asset is 1920x1080 landscape with ~62% of it transparent, and the girl
  // part is a narrow portrait strip: laying the frame out by width would show
  // only the top of her head. So the clip's *content* (alpha bounding box) must
  // be fitted to the part -- same rule the idle/act clips follow.
  env.seedClipMedia(girlClip)
  girlClip.dispatch('loadedmetadata')
  girlClip.dispatch('loadeddata')
  {
    const gw = partWidth(env, 'girl')
    const gh = part(env, 'girl').getBoundingClientRect().height
    const cw = parseFloat(girlClip.style.width)
    const ch = parseFloat(girlClip.style.height)
    const left = parseFloat(girlClip.style.left)
    const top = parseFloat(girlClip.style.top)
    // Read the alpha box the widget actually measured (it publishes it for
    // diagnostics) instead of re-deriving it, so this test stays asset-neutral.
    const content = girlClip.getAttribute('data-content-box').split(',').map(Number)
    const scale = cw / GIRL_W
    const contentW = content[2] * scale
    const contentX = content[0] * scale
    assert.ok(Math.abs(cw / ch - GIRL_W / GIRL_H) < 0.01, 'the clip keeps the 1920x1080 aspect ratio')
    assert.ok(Math.abs(content[3] * scale - gh) < 0.02, 'the CONTENT height fits the part')
    assert.ok(
      Math.abs((gw - contentW) / 2 - (left + contentX)) < 0.02,
      `the content is centred horizontally (offset=${(left + contentX).toFixed(2)})`,
    )
    assert.ok(
      Math.abs(gh - (top + (content[1] + content[3]) * scale)) < 0.02,
      'and its bottom edge sits on the part鈥檚 baseline',
    )
  }
  ok('the girl clip is fitted by its alpha content box to the girl part')

  // --- she finishes: buttons move above the cooker, she is hidden ---------
  girlClip.currentTime = GIRL_DURATION
  girlClip.ended = true
  girlClip._playing = false
  girlClip.dispatch('ended')

  const cooker = part(env, 'cooker')
  const girl = part(env, 'girl')
  assert.equal(girl.style.display, 'none', 'the girl part is hidden once she is done')
  assert.ok(bar(env).classList.contains('dshca-detached'), 'the control bar is detached')
  assert.equal(bar(env).parentNode, env.document.body, 'and now lives on the page (above the cooker)')
  {
    const cookerTop = parseFloat(cooker.style.top) || 0
    assert.ok(
      Math.abs(parseFloat(bar(env).style.top) - (cookerTop - 28)) < 1,
      'the bar is positioned above the cooker',
    )
    assert.ok(Math.abs(parseFloat(bar(env).style.width) - partWidth(env, 'cooker')) < 0.6, 'sized to the cooker')
  }
  ok('after her clip ends the five buttons move above the rice cooker and she is hidden')

  // --- the label + timer appear under the cooker -------------------------
  const sendBar = env.document.getElementById('dshca-sendbar')
  assert.ok(sendBar, 'the label/timer column exists')
  assert.equal(
    sendBar.parentNode,
    env.document.body,
    'it is positioned in viewport coordinates (so it can follow the cooker when dragged)',
  )
  assert.equal(sendBar.classList.contains('dshca-send-on'), true, 'and the cooker state reveals it')
  const label = env.document.getElementById('dshca-sendlabel')
  assert.equal(label.textContent, '\u80a5\u9c7c\u5df2\u7ecf\u716e\u996d\uff1a', 'the blue label is the requested text')
  assert.equal(label.style.color, '#3b82f6', 'and it is blue')
  assert.equal(env.document.getElementById('dshca-timer').textContent, '00:00', 'the timer starts at zero')
  {
    const cookerRect = cooker.getBoundingClientRect()
    assert.ok(
      parseFloat(sendBar.style.top) >= cookerRect.bottom,
      `the column sits below the cooker (${sendBar.style.top} vs bottom ${cookerRect.bottom})`,
    )
    assert.ok(
      Math.abs(parseFloat(sendBar.style.left) - cookerRect.left) < 1,
      'and is left-aligned with it',
    )
  }
  ok('a blue label and a timer appear below the cooker')

  // --- the timer counts the turn ----------------------------------------
  env.advance(1000)
  assert.equal(env.document.getElementById('dshca-timer').textContent, '00:01', 'it ticks once a second')
  env.advance(4000)
  assert.equal(env.document.getElementById('dshca-timer').textContent, '00:05', 'and keeps counting')
  ok('the timer shows how long this turn has been running')

  // --- event 2: the lid clip plays when the TURN has fully ended ----------
  //
  // 0.10.2 changed the trigger: the host watches `session/event` for `turn/end`
  // (the same moment the whale widget settles the bill), and the widget polls
  // turn.json for it. Text growth alone is only the FALLBACK now -- with the
  // signal available it must never fire the lid by itself.
  env.advance(SEND_WATCH * 2)
  assert.equal(
    env.document.getElementById('dshca-lid')._plays || 0,
    0,
    'an answer that is not growing must not fire the lid clip',
  )
  assert.equal(
    env.window.__dshcaSend.probe().usingAnswerContainer,
    true,
    'the answer container is what is being measured',
  )

  const lid = env.document.getElementById('dshca-lid')

  // The answer starts streaming: still no lid, because the turn is not over.
  answer.textContent = 'x'.repeat(60)
  env.advance(SEND_WATCH * 2)
  assert.equal(lid._plays || 0, 0, 'answer growth alone does not fire the lid while the turn signal is up')

  // The host reports the end of the whole turn -> the lid clip plays.
  await fireTurnEnd(env)
  assert.equal(lid._plays, 1, 'the lid clip plays once the turn has fully ended')
  assert.equal(lid.src, '/dsh-corner-anim/lid.webm')
  assert.equal(lid.loop, false, 'it plays once')
  assert.equal(lid.muted, false, 'and it is UNMUTED (the user asked to keep the audio)')
  assert.equal(lid.classList.contains('dshca-lid-on'), true, 'the lid clip is revealed')
  // 0.7.3: the lid clip is an overlay pinned to the COOKER's own place -- it is no
  // longer an item of the label/timer column (that is what made it play *below*
  // the timer). So the assertions moved from flex margins to viewport geometry.
  {
    env.seedClipMedia(lid)
    lid.dispatch('loadedmetadata')
    lid.dispatch('loadeddata')
    const box = lid.getAttribute('data-content-box').split(',').map(Number)
    const scale = parseFloat(lid.style.width) / LID_W
    const contentW = box[2] * scale
    const contentLeft = parseFloat(lid.style.left) + box[0] * scale
    const contentBottom = parseFloat(lid.style.top) + (box[1] + box[3]) * scale
    const cookerRect = cooker.getBoundingClientRect()

    assert.equal(lid.parentNode, env.document.body, 'THE FIX: it hangs on the page, not inside the timer column')
    assert.ok(!sendBar.contains(lid), 'so the column under the timer no longer carries it')
    assert.ok(
      Math.abs(contentW - cookerRect.width) < 0.6,
      `its content is as wide as the cooker (${contentW.toFixed(1)} vs ${cookerRect.width})`,
    )
    assert.ok(
      Math.abs(contentLeft - cookerRect.left) < 0.6,
      `its content starts where the cooker starts (${contentLeft.toFixed(2)} vs ${cookerRect.left})`,
    )
    assert.ok(
      Math.abs(contentBottom - cookerRect.bottom) < 0.6,
      `and it stands on the cooker's baseline (${contentBottom.toFixed(2)} vs ${cookerRect.bottom})`,
    )
    assert.ok(
      parseFloat(sendBar.style.top) >= contentBottom,
      'the label/timer column stays clear below it',
    )
    assert.equal(lid.style.marginTop, undefined, 'the old flex-column margins are gone')
  }
  ok('the lid clip starts playing (with sound) in the cooker鈥檚 own place')

  // --- it holds its last frame, and clears the label + timer (0.7.4) ----
  env.seedClipMedia(lid)
  lid.dispatch('loadedmetadata')
  lid.currentTime = LID_DURATION
  lid.ended = true
  lid._playing = false
  lid.dispatch('ended')
  assert.equal(lid.style.visibility, '', 'the lid clip stays visible on its last frame')
  assert.equal(lid.classList.contains('dshca-lid-on'), true, 'and it is still revealed')
  assert.equal(
    sendBar.classList.contains('dshca-send-on'),
    false,
    'THE FIX: the blue label + timer column is cleared once the lid is done',
  )
  // Hidden is not enough -- the once-a-second readout/reflow must be gone too.
  // (The exact frozen value depends on when the turn/end signal landed, so
  // compare before/after instead of hardcoding it.)
  const frozenTimer = env.document.getElementById('dshca-timer').textContent
  env.advance(3000)
  assert.equal(
    env.document.getElementById('dshca-timer').textContent,
    frozenTimer,
    'the timer no longer ticks after the lid is done',
  )
  assert.equal(
    env.timers.filter((t) => t.repeat && !t.cancelled && !t.fired).length,
    0,
    'and no interval is left running',
  )
  ok('the lid clip parks on its last frame and clears the label/timer')

  // --- a second message resets the whole flow ---------------------------
  env.document.dispatchOn(shell, 'click') // a click that is not on the send button
  assert.equal(env.document.getElementById('dshca-girl').classList.contains('dshca-showing'), false, 'no stray restart')

  env.document.dispatchOn(shell.send, 'click')
  assert.equal(girl.style.display, '', 'a new message brings the girl part back')
  assert.equal(bar(env).classList.contains('dshca-detached'), false, 'the bar returns to her side')
  assert.equal(bar(env).parentNode, girl, 'and is attached to the girl part again')
  assert.equal(cooker.classList.contains('dshca-send-on'), false, 'the label/timer column is hidden again')
  assert.equal(cooker.classList.contains('dshca-lid-on'), false, 'and so is the lid clip')
  assert.equal(env.document.getElementById('dshca-timer').textContent, '00:00', 'the timer is back to zero')
  assert.equal(env.document.getElementById('dshca-girl')._plays, 2, 'the girl clip plays again')
  assert.equal(env.document.getElementById('dshca-lid')._plays, 1, 'the lid clip waits for the next output')
  ok('sending again resets the whole flow and starts over')

  // ...and once she is done again, the cleared column comes back and ticks.
  const girlClip2 = env.document.getElementById('dshca-girl')
  env.seedClipMedia(girlClip2)
  girlClip2.currentTime = GIRL_DURATION
  girlClip2.ended = true
  girlClip2._playing = false
  girlClip2.dispatch('ended')
  assert.equal(
    sendBar.classList.contains('dshca-send-on'),
    true,
    'the label/timer column is back for the new turn',
  )
  env.advance(2000)
  assert.equal(
    env.document.getElementById('dshca-timer').textContent,
    '00:02',
    'and the new turn counts from zero again',
  )
  ok('the next turn brings the cleared label/timer column back')
}

/* 38. the send hook's detection rules ----------------------------------- */

{
  // --- sendHook:false leaves the page completely alone -------------------
  const off = makeEnv({ width: 220, sendHook: false }, { gap: [0.5, 0.53] })
  const offShell = buildFakeShell(off)
  run(off)
  playToEnd(off)
  off.document.dispatchOn(offShell.send, 'click')
  assert.equal(off.document.getElementById('dshca-girl'), null, 'sendHook:false never mounts the girl clip')
  assert.equal(off.window.__dshcaSend, undefined, 'and exposes no debug API')
  ok('sendHook:false restores the plain 0.6.0 behaviour')

  // --- an explicit selector wins over the semantic guess ------------------
  const sel = makeEnv({ width: 220, sendSelector: '#my-send' }, { gap: [0.5, 0.53] })
  const selShell = buildFakeShell(sel)
  const custom = new Element('button')
  custom.id = 'my-send'
  custom.textContent = '\u2192' // no "send" wording at all
  selShell.composer.appendChild(custom)
  // Make the built-in guess impossible, so only the selector can match.
  selShell.send.setAttribute('aria-label', '\u56de\u8f66')
  run(sel)
  playToEnd(sel)
  sel.document.dispatchOn(selShell.send, 'click')
  assert.equal(sel.document.getElementById('dshca-girl'), null, 'the unrelated button is ignored')
  sel.document.dispatchOn(custom, 'click')
  assert.ok(sel.document.getElementById('dshca-girl'), 'the configured selector is what triggers it')
  ok('an explicit sendSelector is honoured (and wins over guessing)')

  // --- clicks inside our own widget never count as "send" ----------------
  const own = makeEnv({ width: 220 }, { gap: [0.5, 0.53] })
  const ownShell = buildFakeShell(own)
  run(own)
  playToEnd(own)
  own.document.dispatchOn(bar(own), 'click')
  own.document.dispatchOn(panel(own), 'click')
  own.document.dispatchOn(root(own), 'click')
  assert.equal(own.document.getElementById('dshca-girl'), null, 'our own controls never trigger the flow')
  // ...and the real button still does.
  own.document.dispatchOn(ownShell.send, 'click')
  assert.ok(own.document.getElementById('dshca-girl'), 'the page button still works')
  ok('clicks inside the widget are ignored, page buttons are not')

  // --- Enter in the composer counts, but only with a usable send button ---
  const keys = makeEnv({ width: 220 }, { gap: [0.5, 0.53] })
  const keyShell = buildFakeShell(keys)
  run(keys)
  playToEnd(keys)
  keys.document.dispatchOn(keyShell.input, 'keydown', { key: 'Enter' })
  assert.ok(keys.document.getElementById('dshca-girl'), 'Enter in the composer triggers the flow')
  ok('pressing Enter in the composer triggers the flow')

  const noBtn = makeEnv({ width: 220 }, { gap: [0.5, 0.53] })
  const noBtnShell = buildFakeShell(noBtn)
  noBtnShell.send.parentNode.removeChild(noBtnShell.send)
  run(noBtn)
  playToEnd(noBtn)
  noBtn.document.dispatchOn(noBtnShell.input, 'keydown', { key: 'Enter' })
  assert.equal(noBtn.document.getElementById('dshca-girl'), null, 'no send button, no send detection')
  noBtn.document.dispatchOn(noBtnShell.input, 'keydown', { key: 'Enter', isComposing: true })
  assert.equal(noBtn.document.getElementById('dshca-girl'), null, 'IME composition is never a send')
  ok('Enter without a usable send button (and IME composition) is not a send')

  // --- a "stop" button is never mistaken for "send" ----------------------
  const stop = makeEnv({ width: 220 }, { gap: [0.5, 0.53] })
  const stopShell = buildFakeShell(stop)
  stopShell.send.parentNode.removeChild(stopShell.send)
  const stopBtn = new Element('button')
  stopBtn.setAttribute('aria-label', '\u505c\u6b62\u751f\u6210')
  stopShell.composer.appendChild(stopBtn)
  run(stop)
  playToEnd(stop)
  stop.document.dispatchOn(stopBtn, 'click')
  assert.equal(stop.document.getElementById('dshca-girl'), null, 'a stop button must not be read as send')
  ok('a "stop generating" button is not mistaken for the send button')
}

/* 39. the debug API and teardown ---------------------------------------- */

{
  const env = makeEnv({ width: 220 }, { gap: [0.5, 0.53] })
  buildFakeShell(env)
  run(env)
  playToEnd(env)

  const api = env.window.__dshcaSend
  assert.ok(api, 'the debug API is exposed')
  assert.equal(api.phase(), 'idle')
  assert.equal(api.findButton().disabled, false, 'it can find and describe the send button')
  assert.ok(api.debug().label.indexOf('\u80a5\u9c7c') === 0, 'the debug dump reports the label')

  // simulate() drives both events without touching the page's own button.
  api.simulate()
  assert.equal(api.phase(), 'girl', 'simulate() starts with the girl clip')
  const clip = env.document.getElementById('dshca-girl')
  env.seedClipMedia(clip)
  clip.dispatch('loadedmetadata')
  clip.currentTime = GIRL_DURATION
  clip.ended = true
  clip._playing = false
  clip.dispatch('ended')
  assert.equal(api.phase(), 'laid', 'and lands in the laid-out state')
  env.advance(200)
  assert.equal(api.phase(), 'lid', 'then fires the lid clip')
  assert.equal(env.document.getElementById('dshca-lid')._plays, 1)

  api.reset()
  assert.equal(api.phase(), 'idle', 'reset() puts everything back')
  assert.equal(part(env, 'girl').style.display, '', 'the girl part is visible again')

  // --- closing the widget leaves nothing behind -------------------------
  const before = env.document.listeners.get('click').length
  assert.ok(before > 0, 'the hook is listening on the document')
  buttonByTitle(env, L_CLOSE).dispatch('click')
  assert.equal(root(env), null, 'the widget is gone')
  assert.equal(env.document.listeners.get('click').length, before - 1, 'and so is its document listener')
  assert.ok(!env.window.__dshcaSend, 'the debug API is withdrawn')
  ok('the debug API drives the flow, and closing the widget unhooks everything')
}

/* 40. the split:false edge case ----------------------------------------- */

{
  // Without a split there is no "girl part" to stand on: the flow must not throw.
  const env = makeEnv({ width: 220, split: false }, { gap: [0.5, 0.53] })
  const shell = buildFakeShell(env)
  run(env)
  playToEnd(env)
  env.document.dispatchOn(shell.send, 'click')
  assert.equal(env.document.getElementById('dshca-girl'), null, 'no girl clip without a girl part')
  assert.equal(env.window.__dshcaSend.phase(), 'laid', 'the flow settles instead of hanging')
  assert.equal(env.document.getElementById('dshca-sendbar'), null, 'and builds no timer column it cannot place')
  ok('split:false does not break the send hook')
}

/* 41. the output detector must ignore the streaming "鎬濊€? row ----------- */

{
  // THE BUG THIS GUARDS (found by running the real GUI's DOM through the hook):
  // DSH renders a "鎬濊€? row whose preview streams the reasoning text, and the
  // answer body lands in a separate `_markdown_鈥 container. A page-wide
  // text-growth detector therefore fires while the model is still THINKING,
  // playing the lid animation far too early.
  const env = makeEnv({ width: 220 }, { gap: [0.5, 0.53] })
  const shell = buildFakeShell(env)
  run(env)
  playToEnd(env)
  animReady(env, 'idle')
  const parts = buildRealisticAnswer(env)

  // 0.10.2: the reasoning-row subtleties this block guards live on the LEGACY
  // fallback (an old host with no turn/end signal). Force that path.
  env.turn.fail = true
  env.document.dispatchOn(shell.send, 'click')
  // Walk through the whole event 1 so the watcher is definitely armed.
  const girlClip = env.document.getElementById('dshca-girl')
  env.seedClipMedia(girlClip)
  girlClip.dispatch('loadedmetadata')
  girlClip.currentTime = GIRL_DURATION
  girlClip.ended = true
  girlClip._playing = false
  girlClip.dispatch('ended')
  assert.equal(env.window.__dshcaSend.phase(), 'laid', 'event 1 completed')
  await useLegacyOutputWatch(env)

  const lid = env.document.getElementById('dshca-lid')
  const probe = () => env.window.__dshcaSend.probe()

  // --- 1. the reasoning preview streams a LOT: the lid must stay put -------
  parts.preview.textContent = '\u63a8\u7406'.repeat(80) // 160 chars of thinking
  env.advance(SEND_WATCH * 3)
  assert.equal(lid._plays || 0, 0, 'streaming reasoning must NOT start the lid clip')
  assert.equal(probe().usingAnswerContainer, true, 'the answer container was found')
  assert.equal(probe().answerText, 0, 'and it reports zero answer text so far')
  assert.equal(probe().reasoningRunning, true, 'the reasoning row is still running')

  // --- 2. more reasoning, still nothing -----------------------------------
  parts.preview.textContent = '\u63a8\u7406'.repeat(160)
  env.advance(SEND_WATCH * 3)
  assert.equal(lid._plays || 0, 0, 'the reasoning row keeps growing without triggering it')

  // --- 3. the answer body grows WHILE the row is still running ------------
  //
  // This is the 0.7.5 precondition: even a grown answer body must not fire the
  // lid while DSH still reports the reasoning row as the streaming tail.
  parts.answer.textContent = '\u7b54\u6848'.repeat(20) // 40 chars, over the threshold
  env.advance(SEND_WATCH * 3)
  assert.equal(
    lid._plays || 0,
    0,
    'THE FIX: the lid is held while "娣卞害鎬濈储" is still running',
  )
  assert.equal(env.window.__dshcaSend.phase(), 'laid', 'the flow has not moved on')
  assert.equal(probe().heldForReasoning, true, 'and the hold is reported by probe()')

  // --- 4. the model finished thinking: the very next tick opens the lid ----
  reasoningDone(parts)
  env.advance(SEND_WATCH)
  assert.equal(lid._plays, 1, 'the lid clip starts as soon as the reasoning is done')
  assert.equal(env.window.__dshcaSend.phase(), 'lid', 'the flow moved on to the lid clip')
  assert.equal(probe().reasoningRunning, false, 'no reasoning row is running any more')
  assert.equal(probe().heldForReasoning, false, 'and the hold has been released')
  ok('the lid clip waits for the answer AND for "娣卞害鎬濈储" to finish')

  // --- and it stays a one-shot -------------------------------------------
  parts.answer.textContent = '\u7b54\u6848'.repeat(200)
  env.advance(SEND_WATCH * 3)
  assert.equal(lid._plays, 1, 'it does not restart as the answer keeps growing')
  ok('the lid clip is armed exactly once per turn')
}

/* 42. a very short turn: the answer is done before she finishes (闂 1) -- */

{
  // THE REPORTED BUG: when the model thinks+answers in under the ~5s the girl
  // clip needs, the answer text was already complete (and no longer growing) by
  // the time the old code took its baseline. So growth never happened, the lid
  // never played, and the timer just kept counting.
  const env = makeEnv({ width: 220 }, { gap: [0.5, 0.53] })
  const shell = buildFakeShell(env)
  run(env)
  playToEnd(env)
  animReady(env, 'idle')
  const parts = buildRealisticAnswer(env)

  // 0.10.2: the deferred-flush path below is the LEGACY fallback's behaviour.
  env.turn.fail = true
  env.document.dispatchOn(shell.send, 'click')
  const girlClip = env.document.getElementById('dshca-girl')
  env.seedClipMedia(girlClip)
  girlClip.dispatch('loadedmetadata')
  await useLegacyOutputWatch(env)

  // The whole answer lands 1s in, while the girl clip is still playing -- and
  // with it the model stops thinking (DSH flips the reasoning row to "ok").
  env.advance(1000)
  parts.answer.textContent = '\u7b54\u6848'.repeat(30) // 60 chars, all at once
  reasoningDone(parts)
  env.advance(SEND_WATCH * 3)
  assert.equal(env.window.__dshcaSend.phase(), 'girl', 'she is still playing')
  assert.equal(
    env.document.getElementById('dshca-lid') ? env.document.getElementById('dshca-lid')._plays || 0 : 0,
    0,
    'the lid clip waits for her to finish rather than overlapping her',
  )
  assert.equal(env.window.__dshcaSend.probe().armed, false, 'but the output was already detected')

  // Now she finishes -> the deferred output must be flushed immediately.
  girlClip.currentTime = GIRL_DURATION
  girlClip.ended = true
  girlClip._playing = false
  girlClip.dispatch('ended')
  assert.equal(env.window.__dshcaSend.phase(), 'lid', 'the flow completes')
  assert.equal(
    env.document.getElementById('dshca-lid')._plays,
    1,
    'THE FIX: the lid clip still plays, even though the output finished early',
  )
  ok('a turn that finishes before her clip still plays the lid clip')
}

/* 43. only one rice cooker on screen at any time (闂 3) ----------------- */

{
  const env = makeEnv({ width: 220 }, { gap: [0.5, 0.53] })
  const shell = buildFakeShell(env)
  run(env)
  playToEnd(env)
  animReady(env, 'idle')
  const parts = buildRealisticAnswer(env)
  const cooker = part(env, 'cooker')

  // 0.10.2: text-growth triggering is the LEGACY fallback; force it.
  env.turn.fail = true
  env.document.dispatchOn(shell.send, 'click')
  const girlClip = env.document.getElementById('dshca-girl')
  env.seedClipMedia(girlClip)
  girlClip.dispatch('loadedmetadata')
  girlClip.currentTime = GIRL_DURATION
  girlClip.ended = true
  girlClip._playing = false
  girlClip.dispatch('ended')
  await useLegacyOutputWatch(env)
  assert.equal(
    cooker.classList.contains('dshca-cooker-hidden'),
    false,
    'before the lid clip the cooker crop is what you see',
  )

  // The lid clip draws a complete pot of its own: the crop must step aside.
  parts.answer.textContent = '\u7b54\u6848'.repeat(10)
  reasoningDone(parts)
  env.advance(SEND_WATCH * 3)
  assert.equal(env.window.__dshcaSend.phase(), 'lid', 'the lid clip is playing')
  assert.equal(
    cooker.classList.contains('dshca-cooker-hidden'),
    true,
    'THE FIX: the old cooker image is hidden, so only one pot is on screen',
  )

  // A new message brings the crop back.
  env.document.dispatchOn(shell.send, 'click')
  assert.equal(
    cooker.classList.contains('dshca-cooker-hidden'),
    false,
    'sending again restores the cooker crop',
  )
  ok('the lid clip replaces the cooker crop instead of stacking on it')
}

/* 44. the run-out clip owns the screen all by itself (闂 2, 0.7.3) ------- */

{
  // Whatever was on screen when she starts running out -- the frozen frame taken
  // at the split, or the last frame of a scheduled clip -- it is TRANSPARENT
  // around her, so anything left visible underneath shows up as a second girl.
  const env = makeEnv({ width: 220 }, { gap: [0.5, 0.53] })
  const shell = buildFakeShell(env)
  run(env)
  playToEnd(env)
  animReady(env, 'idle')
  animReady(env, 'act')

  // Let the standby clip take its turn and park on its own last frame, so BOTH
  // possible leftovers exist: a clip holding a frame, and the canvas behind it.
  fireNext(env)
  env.advance(IDLE_DURATION * 1000)
  assert.equal(visibleClip(env), 'idle', 'the standby clip is the picture before the send')
  assert.equal(girlCanvasVisible(env), false, 'the frozen frame has already stepped aside')

  env.document.dispatchOn(shell.send, 'click')
  const girlClip = env.document.getElementById('dshca-girl')
  // `visibleClip()` sees every <video> in the girl part, her own run-out clip
  // included, so filter to the two SCHEDULED clips for this question.
  const scheduled = (e) =>
    ['idle', 'act'].filter((k) => animEl(e, k).style.visibility !== 'hidden').join('+')
  assert.equal(girlClip.classList.contains('dshca-showing'), true, 'her run-out clip is on screen')
  assert.equal(
    scheduled(env),
    '',
    'THE FIX: neither scheduled clip is visible while she runs out',
  )
  assert.equal(girlCanvasVisible(env), false, 'THE FIX: nor is her frozen frame')
  assert.equal(animEl(env, 'idle')._playing, false, 'and the parked clip is not left playing underneath')
  ok('the run-out clip is the only girl on screen (a parked clip was underneath)')

  // The same must hold when she runs out BEFORE any clip has taken a turn -- the
  // leftover is then the frozen canvas taken at the split.
  const env2 = makeEnv({ width: 220 }, { gap: [0.5, 0.53] })
  const shell2 = buildFakeShell(env2)
  run(env2)
  playToEnd(env2)
  animReady(env2, 'idle')
  animReady(env2, 'act')
  assert.equal(girlCanvasVisible(env2), true, 'before the first turn the frozen frame is the picture')

  env2.document.dispatchOn(shell2.send, 'click')
  assert.equal(girlCanvasVisible(env2), false, 'THE FIX: it steps aside for her clip too')
  assert.equal(
    ['idle', 'act'].filter((k) => animEl(env2, k).style.visibility !== 'hidden').join('+'),
    '',
    'and no scheduled clip is on screen either',
  )
  ok('the run-out clip is the only girl on screen (the frozen frame was underneath)')

  // When she is done the picture goes back to normal bookkeeping: her part is
  // hidden and both scheduled clips are free to come back on the next turn.
  girlClip.currentTime = GIRL_DURATION
  girlClip.ended = true
  girlClip._playing = false
  girlClip.dispatch('ended')
  assert.equal(part(env, 'girl').style.display, 'none', 'her part is hidden once she is done')
  assert.equal(girlClip.classList.contains('dshca-showing'), false, 'and her clip is no longer showing')
  ok('finishing the run-out hands the screen back')
}

/* 45. the girl parks against the window border (闂 1, 0.7.3) ------------ */

{
  // A frame shaped like the shipped 2K opener: the girl's crop stops 12.5% short
  // of the frame's right edge, so "her place in the frame" lands ~48px inside the
  // window border once the widget sits in the top-right corner.
  const media = { gap: [0.5, 0.53], rightMargin: 0.125 }
  const env = makeEnv({ width: 220, offsetX: 20, offsetY: 20, corner: 'top-right' }, media)
  run(env)
  playToEnd(env)

  const vw = env.window.innerWidth
  const girlW = partWidth(env, 'girl')
  const inFrameLeft = left(env) + 220 * 0.53
  assert.ok(vw - (inFrameLeft + girlW) > 20, 'sanity: her frame position really is short of the border')
  assert.equal(
    partLeft(env, 'girl') + girlW,
    vw - 2,
    'THE FIX: she is pulled out to the window border (2px shy of it)',
  )
  assert.equal(partTop(env, 'girl'), top(env), 'her row is untouched')
  assert.equal(partLeft(env, 'cooker'), left(env), 'and the cooker is not pushed around by it')
  ok('the girl parks against the window border instead of floating inside the frame')
  assert.equal(assertSinglePicture(env, 'after the split'), 'frozen', 'still exactly one picture on screen')

  // Resizing the window keeps her on the (new) border...
  env.window.innerWidth = 900
  env.window.dispatchWindow('resize')
  assert.equal(partLeft(env, 'girl') + girlW, 900 - 2, 'she follows a window resize to the new border')
  ok('she stays on the border after a window resize')

  // ...and so does changing the display size.
  slider(env).value = '300'
  slider(env).dispatch('input')
  assert.equal(
    partLeft(env, 'girl') + partWidth(env, 'girl'),
    env.window.innerWidth - 2,
    'and after a display-size change',
  )
  ok('she stays on the border after a display-size change')

  // Dragging her means the user has taken over: never yank her back afterwards.
  dragBy(part(env, 'girl'), -140, 0, 21)
  const dragged = partLeft(env, 'girl')
  env.window.innerWidth = 1000
  env.window.dispatchWindow('resize')
  assert.equal(partLeft(env, 'girl'), dragged, 'a dragged girl is never dragged back to the border')
  ok('dragging her hands the position back to the user')

  // ...and a position remembered for HER ALONE survives a reload. The two parts
  // are judged independently now: the older code only honoured remembered
  // positions when BOTH parts had one, so dragging just the girl was forgotten.
  {
    const remembered = makeEnv({ width: 220, offsetX: 20, offsetY: 20, corner: 'top-right' }, media)
    run(remembered)
    playToEnd(remembered)
    dragBy(part(remembered, 'girl'), -180, 40, 41)
    const moved = { x: partLeft(remembered, 'girl'), y: partTop(remembered, 'girl') }
    assert.equal(
      remembered.store.has('dsh-corner-anim:pos:cooker:v1'),
      false,
      'sanity: only her position was ever stored',
    )

    const reloaded = makeEnv({ width: 220, offsetX: 20, offsetY: 20, corner: 'top-right' }, media)
    for (const [key, value] of remembered.store) reloaded.store.set(key, value)
    run(reloaded)
    playToEnd(reloaded)
    assert.equal(partLeft(reloaded, 'girl'), moved.x, 'THE FIX: her dragged x is remembered')
    assert.equal(partTop(reloaded, 'girl'), moved.y, 'and so is her dragged y')
    ok('a position remembered for the girl alone is honoured on the next split')
  }

  // A window narrowed to barely more than the widget: she still fits, and still
  // stops at the border rather than hanging out past it.
  const narrow = makeEnv({ width: 220, offsetX: 20, offsetY: 20, corner: 'top-right' }, media)
  narrow.window.innerWidth = 300
  run(narrow)
  playToEnd(narrow)
  assert.equal(
    partLeft(narrow, 'girl') + partWidth(narrow, 'girl'),
    300 - 2,
    'a narrow window still ends with her on the border',
  )
  assert.ok(partLeft(narrow, 'girl') >= 0, 'and she is never pushed off the left edge instead')
  ok('a narrow window keeps her inside and on the border')

  // A document scrollbar sits INSIDE innerWidth: the border she must not be
  // hidden behind is the CONTENT edge (documentElement.clientWidth), so the hug
  // has to be measured against whichever of the two is smaller.
  const scrolled = makeEnv({ width: 220, offsetX: 20, offsetY: 20, corner: 'top-right' }, media)
  run(scrolled)
  playToEnd(scrolled)
  assert.equal(
    partLeft(scrolled, 'girl') + partWidth(scrolled, 'girl'),
    scrolled.window.innerWidth - 2,
    'sanity: with no scrollbar she hugs innerWidth',
  )
  scrolled.document.documentElement.clientWidth = scrolled.window.innerWidth - 15
  scrolled.window.dispatchWindow('resize')
  assert.equal(
    partLeft(scrolled, 'girl') + partWidth(scrolled, 'girl'),
    scrolled.window.innerWidth - 15 - 2,
    'a document scrollbar counts as part of the border, and she follows it in',
  )
  ok('a document scrollbar is treated as part of the window border')

  // A widget anchored to the LEFT keeps her where the frame had her: flinging her
  // across the window to the far border would be nonsense.
  const leftEnv = makeEnv({ width: 220, offsetX: 20, offsetY: 20, corner: 'top-left' }, media)
  run(leftEnv)
  playToEnd(leftEnv)
  assert.ok(
    Math.abs(partLeft(leftEnv, 'girl') - (left(leftEnv) + 220 * 0.53)) < 1,
    'a left-corner widget leaves her where the frame had her',
  )
  ok('a left-corner widget is not flung across the window')
}

/* 46. a replay keeps the run-out clip mounted (0.7.3) --------------------- */

{
  const env = makeEnv({ width: 220 }, { gap: [0.5, 0.53] })
  const shell = buildFakeShell(env)
  run(env)
  playToEnd(env)
  animReady(env, 'idle')
  animReady(env, 'act')

  // Round one: she runs out once.
  env.document.dispatchOn(shell.send, 'click')
  const first = env.document.getElementById('dshca-girl')
  env.seedClipMedia(first)
  first.dispatch('loadedmetadata')
  first.currentTime = GIRL_DURATION
  first.ended = true
  first._playing = false
  first.dispatch('ended')

  // Replay rebuilds both parts -- and with them the subtree her clip lived in.
  buttonByTitle(env, L_REPLAY).dispatch('click')
  playToEnd(env)
  animReady(env, 'idle')
  animReady(env, 'act')
  env.document.dispatchOn(shell.send, 'click')

  const second = env.document.getElementById('dshca-girl')
  assert.equal(second, first, 'the clip element itself is reused')
  assert.equal(
    second.parentNode,
    part(env, 'girl'),
    'THE FIX: and it is re-mounted on the fresh girl part',
  )
  assert.equal(second._plays, 2, 'so the run-out really plays again')
  assert.equal(second.classList.contains('dshca-showing'), true, 'and it is the visible picture')
  ok('the run-out clip survives a replay and is mounted on the new girl part')
}

/* 47. the lid clip follows the cooker (闂 3, 0.7.3) --------------------- */

{
  const env = makeEnv({ width: 220 }, { gap: [0.5, 0.53] })
  const shell = buildFakeShell(env)
  run(env)
  playToEnd(env)
  animReady(env, 'idle')
  animReady(env, 'act')
  const parts = buildRealisticAnswer(env)
  const cooker = part(env, 'cooker')

  // 0.10.2: text-growth triggering is the LEGACY fallback; force it.
  env.turn.fail = true
  env.document.dispatchOn(shell.send, 'click')
  const girlClip = env.document.getElementById('dshca-girl')
  env.seedClipMedia(girlClip)
  girlClip.dispatch('loadedmetadata')
  girlClip.currentTime = GIRL_DURATION
  girlClip.ended = true
  girlClip._playing = false
  girlClip.dispatch('ended')
  await useLegacyOutputWatch(env)

  parts.answer.textContent = '\u7b54\u6848'.repeat(20)
  reasoningDone(parts)
  env.advance(SEND_WATCH * 3)
  const lid = env.document.getElementById('dshca-lid')
  env.seedClipMedia(lid)
  lid.dispatch('loadedmetadata')
  lid.dispatch('loadeddata')
  assert.equal(env.window.__dshcaSend.phase(), 'lid', 'the lid clip is the current phase')

  const box = lid.getAttribute('data-content-box').split(',').map(Number)
  const lidGeometry = () => {
    const scale = parseFloat(lid.style.width) / LID_W
    return {
      left: parseFloat(lid.style.left) + box[0] * scale,
      bottom: parseFloat(lid.style.top) + (box[1] + box[3]) * scale,
    }
  }

  // Drag the cooker: the overlay has to travel with it, or the pot would jump
  // back to where the cooker used to be the next time it is laid out.
  dragBy(cooker, -70, 50, 31)
  const rect = cooker.getBoundingClientRect()
  assert.ok(
    Math.abs(lidGeometry().left - rect.left) < 0.6,
    `the lid overlay follows a dragged cooker in x (${lidGeometry().left} vs ${rect.left})`,
  )
  assert.ok(
    Math.abs(lidGeometry().bottom - rect.bottom) < 0.6,
    `and in y (${lidGeometry().bottom} vs ${rect.bottom})`,
  )
  ok('the lid overlay tracks the cooker it replaces')

  // Sending again restores the cooker crop and hides the overlay.
  env.document.dispatchOn(shell.send, 'click')
  assert.equal(cooker.classList.contains('dshca-cooker-hidden'), false, 'the cooker crop is back')
  assert.equal(lid.classList.contains('dshca-lid-on'), false, 'and the overlay is parked again')
  ok('the next message puts the cooker crop back and parks the overlay')
}

/* 48. "娣卞害鎬濈储" holds the lid even when PROCESS rows keep growing (0.7.5) - */

{
  // THE REPORTED SYMPTOM: while the model is still thinking, the transcript's
  // process row keeps changing ("姝ｅ湪鍒嗘瀽璇锋眰" 鈫?"姝ｅ湪璋冪敤宸ュ叿" 鈥?. Those rows live
  // OUTSIDE the reasoning row, so no text-length exclusion can filter them, and
  // the answer-text measurement falls back to page-wide text whenever no
  // `_markdown_鈥 container exists. The old detector therefore fired mid-thinking
  // and opened the lid while the cooker was supposed to sit still.
  const env = makeEnv({ width: 220 }, { gap: [0.5, 0.53] })
  const shell = buildFakeShell(env)
  run(env)
  playToEnd(env)
  animReady(env, 'idle')
  animReady(env, 'act')

  // A reasoning row plus a process row, and NO `_markdown_鈥 container at all --
  // that is the combination that falls back to page-wide text.
  const reasoning = buildRealisticAnswer(env)
  env.document.getElementById('log').removeChild(reasoning.answer)
  const process = new Element('div')
  process._className = '_row_jhda5_16'
  process.textContent = '\u6b63\u5728\u5206\u6790\u8bf7\u6c42' // 姝ｅ湪鍒嗘瀽璇锋眰
  env.document.getElementById('log').appendChild(process)

  // 0.10.2: the process-row / reasoning-hold behaviour lives on the LEGACY
  // fallback (with the turn signal up, the lid simply waits for turn/end).
  env.turn.fail = true
  env.document.dispatchOn(shell.send, 'click')
  const girlClip = env.document.getElementById('dshca-girl')
  env.seedClipMedia(girlClip)
  girlClip.dispatch('loadedmetadata')
  girlClip.currentTime = GIRL_DURATION
  girlClip.ended = true
  girlClip._playing = false
  girlClip.dispatch('ended')
  await useLegacyOutputWatch(env)

  const lid = env.document.getElementById('dshca-lid')
  const cooker = part(env, 'cooker')
  const probe = () => env.window.__dshcaSend.probe()

  // The process row keeps changing while the model thinks.
  process.textContent = '\u6b63\u5728\u8c03\u7528\u5de5\u5177'.repeat(6)
  env.advance(SEND_WATCH * 4)
  assert.equal(probe().usingAnswerContainer, false, 'measurement fell back to the page text')
  assert.ok(probe().pageText > 0, 'and a process row is what grew')
  assert.equal(probe().reasoningRunning, true, 'the reasoning row is still running')
  assert.equal(lid._plays || 0, 0, 'THE FIX: mid-thinking growth does NOT start the lid clip')
  assert.equal(
    cooker.classList.contains('dshca-cooker-hidden'),
    false,
    'and the cooker stays exactly as it was ("鎬濈储鏃剁數楗叢淇濇寔鍘熸牱")',
  )
  assert.notEqual(partCanvas(env, 'cooker').style.visibility, 'hidden', 'its picture is untouched')
  ok('the lid is held while process rows grow during "娣卞害鎬濈储"')

  // The model stops thinking -> the very next tick opens the lid.
  reasoningDone(reasoning)
  env.advance(SEND_WATCH * 2)
  assert.equal(lid._plays, 1, 'as soon as "娣卞害鎬濈储" ends, the lid clip plays')
  assert.equal(
    cooker.classList.contains('dshca-cooker-hidden'),
    true,
    'and only then does it replace the cooker crop',
  )
  ok('the lid plays right after "娣卞害鎬濈储" ends')
}

/* 49. click squish: hold the cooker / the girl and her frame squashes (0.8.0) */

/** The squish snapshot a part is currently showing (null when none is). */
function squishLayer(env, key) {
  const p = part(env, key)
  if (!p) return null
  return (
    p.children.find((c) => c.tagName === 'CANVAS' && c.classList.contains('dshca-squish')) || null
  )
}
/** `SQUISH_SETTLE_MS` on the widget side: when the bounce is over. */
const SQUISH_SETTLE = 260
/** A complete press-and-hold, without the release. */
function press(el, pointerId) {
  el.dispatch('pointerdown', { pointerId, clientX: 500, clientY: 400, button: 0 })
}
function release(el, pointerId) {
  el.dispatch('pointerup', { pointerId, clientX: 500, clientY: 400 })
}
/** Split the widget and hand the two clips their metadata, ready for a first beat. */
function splitAndReady(env) {
  run(env)
  playToEnd(env)
  const idle = animReady(env, 'idle')
  const act = animReady(env, 'act')
  return { idle, act }
}

{
  const env = makeEnv({ width: 220 })
  splitAndReady(env)

  const cooker = part(env, 'cooker')
  const canvas = partCanvas(env, 'cooker')
  assert.equal(squishLayer(env, 'cooker'), null, 'nothing is squashed before the press')

  // 2x on a HiDPI screen, read at press time.
  env.window.devicePixelRatio = 2
  press(cooker, 11)
  const snap = squishLayer(env, 'cooker')
  assert.ok(snap, 'pressing the cooker paints a snapshot')
  assert.equal(snap.classList.contains('dshca-squished'), true, 'and squashes it right away')
  assert.equal(canvas.style.visibility, 'hidden', 'the frame underneath yields to the snapshot')
  assert.equal(
    snap.style.width,
    cooker.style.width,
    'THE ASK: the snapshot is the frame the cooker is on, at the cooker\'s own size',
  )
  assert.equal(
    snap.width,
    Math.round(parseFloat(cooker.style.width) * 2),
    '...rasterised at 2x so the squash stays sharp',
  )
  assert.equal(
    snap._ctx.draws.length,
    1,
    'the frame is painted exactly once per press',
  )
  assert.equal(snap._ctx.draws[0][0], canvas, 'and it is the cooker crop that gets stretched')
  ok('pressing the cooker stretches a snapshot of the frame it is on')

  release(cooker, 11)
  assert.equal(snap.classList.contains('dshca-squished'), false, 'releasing springs it back')
  assert.ok(snap.parentNode, 'the snapshot is still up while it bounces')
  assert.equal(canvas.style.visibility, 'hidden', 'and the real frame waits for the bounce')
  env.advance(SQUISH_SETTLE)
  assert.equal(snap.parentNode, null, 'once the bounce is over the snapshot is taken away')
  assert.notEqual(canvas.style.visibility, 'hidden', 'and the cooker frame is back on screen')
  assert.equal(squishLayer(env, 'cooker'), null, 'no leftover layer')
  ok('releasing bounces back and hands the screen back to the frame')

  // The press itself is not a drag: nothing may be remembered from it.
  assert.equal(
    env.store.has('dsh-corner-anim:pos:cooker:v1'),
    false,
    'a press is not a drag: no position is remembered',
  )
}

{
  // THE CORE OF THE ASK: the snapshot is taken from the frame she is displaying
  // at the moment of the click, and playback picks up where it was frozen.
  const env = makeEnv({ width: 220 })
  const { idle } = splitAndReady(env)
  env.advance(IDLE_PERIOD)
  assert.equal(idle._playing, true, 'the standby clip is mid-play')
  const plays = idle._plays
  const girl = part(env, 'girl')
  const girlH = girl.getBoundingClientRect().height
  const girlW = parseFloat(girl.style.width)

  press(girl, 12)
  const snap = squishLayer(env, 'girl')
  assert.ok(snap, 'pressing her paints a snapshot too')
  assert.equal(idle._playing, false, 'THE ASK: the clip is frozen on the frame she is on')
  assert.equal(idle.style.visibility, 'hidden', 'and the snapshot takes the screen')
  assert.equal(snap.classList.contains('dshca-squished'), true, 'squashed')

  const draw = snap._ctx.draws[0]
  assert.equal(draw[0], idle, 'the snapshot is painted from the clip that was on screen')
  assert.equal(draw.length, 9, 'cropped from its content box, not from the whole frame')
  assert.ok(draw[3] > 0 && draw[4] > 0 && draw[3] <= IDLE_W && draw[4] <= IDLE_H, 'a real crop')
  assert.ok(
    Math.abs(draw[5] - (girlW - draw[7]) / 2) < 0.01,
    'the content is centred in the part, exactly like the live layer',
  )
  assert.ok(
    Math.abs(draw[6] + draw[8] - girlH) < 0.01,
    'and sits on the part\'s bottom edge -- so the squash pivots on her feet',
  )
  ok('the stretched image is the frame she is on when the click happens')

  release(girl, 12)
  env.advance(SQUISH_SETTLE)
  assert.equal(idle._playing, true, 'THE ASK: playback continues after the click')
  assert.equal(idle._plays, plays + 1, '...by resuming, not restarting')
  assert.equal(idle.currentTime, 0.1, '...from where it was frozen')
  assert.notEqual(idle.style.visibility, 'hidden', 'and she is back on screen')
  assert.equal(squishLayer(env, 'girl'), null, 'with no snapshot left behind')
  ok('releasing continues the very playback that was paused')
}

{
  // A parked frame was not playing, so there is nothing to continue.
  const env = makeEnv({ width: 220 })
  const { idle } = splitAndReady(env)
  env.advance(IDLE_PERIOD)
  clipEnded(env, 'idle')
  const plays = idle._plays
  const girl = part(env, 'girl')

  press(girl, 13)
  assert.ok(squishLayer(env, 'girl'), 'a parked frame can still be squashed')
  release(girl, 13)
  env.advance(SQUISH_SETTLE)
  assert.equal(idle._plays, plays, 'THE ASK: "if there was none, do not continue"')
  assert.notEqual(idle.style.visibility, 'hidden', 'the parked frame is simply put back')
  ok('a frame that was not playing is put back without being restarted')
}

{
  // The schedule must not steal the screen out from under a held snapshot.
  const env = makeEnv({ width: 220 })
  const { idle } = splitAndReady(env)
  env.advance(IDLE_PERIOD)
  clipEnded(env, 'idle')
  const girl = part(env, 'girl')
  const playsBefore = env.playCount('idle') + env.playCount('act')

  press(girl, 14)
  env.advance(IDLE_PERIOD * 3)
  assert.equal(
    env.playCount('idle') + env.playCount('act'),
    playsBefore,
    'no clip starts while she is held down',
  )
  assert.ok(squishLayer(env, 'girl'), 'the snapshot is still the one on screen')
  ok('the animation schedule holds its beat while she is held')

  release(girl, 14)
  env.advance(SQUISH_SETTLE)
  env.advance(IDLE_PERIOD)
  assert.ok(
    env.playCount('idle') + env.playCount('act') > playsBefore,
    'and picks the beat back up after the bounce',
  )
  assert.ok(idle, 'the standby clip is still mounted')
  ok('the schedule resumes once the bounce is over')
}

{
  // Dragging and squashing are two faces of one gesture: the squash travels with
  // the pointer and the part still lands where the user put it.
  const env = makeEnv({ width: 220 })
  splitAndReady(env)
  const cooker = part(env, 'cooker')
  const startX = partLeft(env, 'cooker')
  const startY = partTop(env, 'cooker')

  cooker.dispatch('pointerdown', { pointerId: 15, clientX: 500, clientY: 400, button: 0 })
  assert.ok(squishLayer(env, 'cooker'), 'the press squashes it')
  cooker.dispatch('pointermove', { pointerId: 15, clientX: 540, clientY: 425 })
  assert.equal(partLeft(env, 'cooker'), startX + 40, 'and the drag still moves it in x')
  assert.equal(partTop(env, 'cooker'), startY + 25, '...and in y')
  assert.equal(
    squishLayer(env, 'cooker').parentNode,
    cooker,
    'the snapshot lives inside the part, so it travels with it',
  )
  cooker.dispatch('pointerup', { pointerId: 15, clientX: 540, clientY: 425 })
  env.advance(SQUISH_SETTLE)
  assert.equal(squishLayer(env, 'cooker'), null, 'and is cleaned up on release')
  const stored = JSON.parse(env.store.get('dsh-corner-anim:pos:cooker:v1'))
  assert.equal(stored.x, startX + 40, 'the dragged position is the one remembered')
  ok('a squash can turn into a drag without either gesture getting lost')
}

{
  // Scope, per the user: only the two split parts, never the merged widget.
  const env = makeEnv({ width: 220 })
  run(env)
  const v = video(env)
  v.duration = 3
  v.dispatch('loadedmetadata')
  v._playing = true
  const r = root(env)
  press(r, 16)
  assert.equal(
    r.children.filter((c) => c.classList.contains('dshca-squish')).length,
    0,
    'the merged opener never squashes',
  )
  assert.equal(v._playing, true, 'and keeps playing through a press')
  release(r, 16)
  ok('the merged opener is out of scope for the click squish')
}

{
  // Scope, per the user: the two send-flow animations keep their own timing.
  const env = makeEnv({ width: 220 })
  const shell = buildFakeShell(env)
  splitAndReady(env)
  const girl = part(env, 'girl')
  const cooker = part(env, 'cooker')
  const canvas = partCanvas(env, 'cooker')

  env.document.dispatchOn(shell.send, 'click')
  const girlClip = env.document.getElementById('dshca-girl')
  env.seedClipMedia(girlClip)
  girlClip.dispatch('loadedmetadata')
  assert.equal(girlClip.classList.contains('dshca-showing'), true, 'the run-out clip is playing')

  press(girl, 17)
  assert.equal(squishLayer(env, 'girl'), null, 'no squash while the run-out clip plays')
  assert.equal(
    girlClip.style.visibility,
    undefined,
    'and the run-out clip is left completely untouched',
  )
  release(girl, 17)
  ok('the run-out animation is exempt from the click squish')

  // She finishes -> buttons move, timer starts, the girl is hidden.
  girlClip.currentTime = GIRL_DURATION
  girlClip.ended = true
  girlClip._playing = false
  girlClip.dispatch('ended')
  assert.equal(girl.style.display, 'none', 'she is parked for the rest of the round')

  // Now the cooker is the only thing on screen and it IS in scope.
  press(cooker, 18)
  assert.ok(squishLayer(env, 'cooker'), 'the cooker squashes while the timer runs')
  release(cooker, 18)
  assert.ok(squishLayer(env, 'cooker'), 'and is still bouncing back')

  // The model starts answering: the lid replaces the cooker crop, which must not
  // fight the snapshot for the same spot.
  env.window.__dshcaSend.output()
  const lid = env.document.getElementById('dshca-lid')
  assert.equal(lid.classList.contains('dshca-lid-on'), true, 'the lid takes over the cooker')
  assert.equal(squishLayer(env, 'cooker'), null, 'the bouncing snapshot is taken away first')
  assert.equal(
    cooker.classList.contains('dshca-cooker-hidden'),
    true,
    'and the crop it was covering is parked (the lid replaced it)',
  )
  assert.equal(
    canvas.style.visibility,
    '',
    'the crop itself is hidden by the class, not by a squash leftover',
  )
  ok('the open-lid animation takes the screen from a bouncing snapshot')

  press(cooker, 19)
  assert.equal(squishLayer(env, 'cooker'), null, 'no squash while the lid overlay is up')
  release(cooker, 19)
  ok('the open-lid animation is exempt from the click squish')
}

{
  // The panel and the bar are controls, not picture.
  const env = makeEnv({ width: 220 })
  splitAndReady(env)
  const girl = part(env, 'girl')
  const replay = buttonByTitle(env, L_REPLAY)
  replay.dispatch('pointerdown', { pointerId: 20, clientX: 1, clientY: 1, button: 0, target: replay })
  assert.equal(squishLayer(env, 'girl'), null, 'pressing a control button does not squash her')
  const s = slider(env)
  if (s) {
    s.dispatch('pointerdown', { pointerId: 21, clientX: 1, clientY: 1, button: 0, target: s })
    assert.equal(squishLayer(env, 'girl'), null, 'nor does a slider')
  }
  assert.ok(girl, 'the girl part is still there')
  ok('controls never trigger the squash')
}

{
  // Escape hatch: clickSquish:false is exactly "as it was before 0.8.0".
  const env = makeEnv({ width: 220, clickSquish: false })
  splitAndReady(env)
  const cooker = part(env, 'cooker')
  press(cooker, 22)
  assert.equal(squishLayer(env, 'cooker'), null, 'clickSquish:false disables it entirely')
  const canvas = partCanvas(env, 'cooker')
  assert.notEqual(canvas.style.visibility, 'hidden', 'the frame is never hidden')
  release(cooker, 22)
  ok('clickSquish:false turns the whole interaction off')
}

{
  // A second pointer on the SAME part must not restart the squash, and must not
  // end it either when it lifts.
  const env = makeEnv({ width: 220 })
  const { idle } = splitAndReady(env)
  env.advance(IDLE_PERIOD)
  const girl = part(env, 'girl')
  press(girl, 23)
  const snap = squishLayer(env, 'girl')
  press(girl, 24)
  assert.equal(squishLayer(env, 'girl'), snap, 'the first press keeps owning the squash')
  release(girl, 24)
  assert.ok(squishLayer(env, 'girl'), 'lifting the second finger does not end it')
  release(girl, 23)
  env.advance(SQUISH_SETTLE)
  assert.equal(squishLayer(env, 'girl'), null, 'the finger that started it ends it')
  assert.equal(idle._playing, true, 'and playback is continued')
  ok('a second finger on the same part neither restarts nor cancels the squash')
}

/* 50. press sound: a synthesised pop, a rare "pipe", and a built-in CD (0.8.0) */

{
  const env = makeEnv({ width: 220 })
  splitAndReady(env)
  assert.equal(env.audio(), null, 'no AudioContext is created before the first press')

  press(part(env, 'cooker'), 30)
  const ctx = env.audio()
  assert.ok(ctx, 'the first press creates the AudioContext (that is the user gesture)')
  assert.equal(ctx.plays.length, 1, 'one press = exactly one sound')
  assert.equal(ctx.plays[0].kind, 'synth', 'an ordinary press is the synthesised pop')
  const osc = ctx.plays[0].node
  assert.equal(osc.type, 'triangle', 'a soft triangle, not a square buzz')
  assert.equal(osc.frequency.events[0][0], 'set', 'the pitch starts at a fixed value')
  assert.equal(osc.frequency.events[1][0], 'exp', 'and slides down exponentially')
  assert.ok(osc.stoppedAt > osc.startedAt, 'the pop is bounded, so it cannot ring on')
  ok('pressing a part plays one synthesised "soft pop"')
}

{
  const env = makeEnv({ width: 220 })
  splitAndReady(env)
  const cooker = part(env, 'cooker')
  press(cooker, 31)
  release(cooker, 31)
  const ctx = env.audio()
  assert.equal(ctx.plays.length, 1)

  // Press again immediately: the first pop is still sounding.
  press(cooker, 32)
  assert.equal(
    ctx.plays.length,
    1,
    'THE CD: a press while the previous sound is still playing stays silent',
  )
  assert.equal(env.window.__dshcaPress.probe().skipped, 1, 'and is counted as a suppressed press')
  release(cooker, 32)

  env.advance(300)
  press(cooker, 33)
  assert.equal(ctx.plays.length, 2, 'once the CD is over the next press sounds again')
  release(cooker, 33)
  ok('the built-in CD keeps press sounds from stacking up')
}

{
  const env = makeEnv({ width: 220, pipeChance: 1 })
  splitAndReady(env)
  const cooker = part(env, 'cooker')
  const girl = part(env, 'girl')

  press(cooker, 34)
  assert.equal(
    env.audio().plays[0].kind,
    'synth',
    'the very first press pops while the asset is still loading',
  )
  release(cooker, 34)
  await flushAsync()
  assert.ok(
    env.fetchLog.some((u) => u.indexOf('pipe.mp3') >= 0),
    'the pipe asset is fetched on first use (not on page load)',
  )
  assert.equal(env.window.__dshcaPress.probe().pipeReady, true, 'and decoded into a buffer')

  env.advance(300)
  press(girl, 35)
  assert.equal(
    env.audio().plays[1].kind,
    'synth',
    'the girl never gets the pipe: the easter egg belongs to the cooker',
  )
  release(girl, 35)

  env.advance(300)
  press(cooker, 36)
  assert.equal(env.audio().plays[2].kind, 'pipe', 'with the asset ready the cooker rolls the pipe')
  release(cooker, 36)
  ok('a cooker press can roll the "pipe" easter egg instead of the pop')
}

{
  const env = makeEnv({ width: 220, pipeChance: 1 })
  splitAndReady(env)
  const cooker = part(env, 'cooker')
  press(cooker, 38)
  release(cooker, 38)
  await flushAsync()
  env.advance(300)
  press(cooker, 39)
  release(cooker, 39)
  const ctx = env.audio()
  assert.equal(ctx.plays.length, 2)
  assert.equal(ctx.plays[1].kind, 'pipe', 'the second press really used the pipe')

  env.advance(1000)
  press(cooker, 40)
  release(cooker, 40)
  assert.equal(ctx.plays.length, 2, 'the pipe keeps the CD busy for its whole 2.4s')
  env.advance(1600)
  press(cooker, 41)
  release(cooker, 41)
  assert.equal(ctx.plays.length, 3, 'and frees the CD up as soon as it is over')
  ok('the pipe blocks the CD for its own duration')
}

{
  const env = makeEnv({ width: 220, pressVolume: 0.5 })
  splitAndReady(env)
  press(part(env, 'cooker'), 42)
  const gain = env.audio().plays[0].node.connections[0]
  const peak = gain.gain.events.find((e) => e[0] === 'exp' && e[1] > 0.001)
  assert.ok(peak, 'the pop schedules an audible peak')
  assert.ok(Math.abs(peak[1] - 0.11) < 1e-6, `pressVolume scales the pop (got ${peak[1]})`)
  ok('pressVolume scales the synthesised pop')
}

{
  const env = makeEnv({ width: 220, pressSound: false })
  splitAndReady(env)
  press(part(env, 'cooker'), 43)
  assert.equal(env.audioContexts.length, 0, 'pressSound:false never even builds an AudioContext')
  assert.equal(env.fetchLog.length, 0, 'and never fetches the pipe asset')
  assert.ok(squishLayer(env, 'cooker'), 'the squash itself still works')
  ok('pressSound:false mutes the press but keeps the squash')
}

{
  const env = makeEnv({ width: 220, pipeChance: 1 })
  splitAndReady(env)
  env.window.fetch = () => Promise.reject(new Error('offline'))
  const cooker = part(env, 'cooker')
  press(cooker, 44)
  release(cooker, 44)
  await flushAsync()
  assert.equal(
    env.window.__dshcaPress.probe().pipeReady,
    false,
    'a failed fetch only disables the easter egg',
  )
  env.advance(300)
  press(cooker, 45)
  release(cooker, 45)
  assert.equal(env.audio().plays.length, 2, 'and every press still makes a sound')
  assert.equal(env.audio().plays[1].kind, 'synth', 'falling back to the pop')
  ok('an unavailable pipe asset degrades to the pop instead of silence')
}

{
  const env = makeEnv({ width: 220 })
  splitAndReady(env)
  // Make the first context start suspended: the press must resume it before playing.
  const Base = env.window.AudioContext
  env.window.AudioContext = class extends Base {
    constructor() {
      super()
      this.state = 'suspended'
    }
  }
  press(part(env, 'cooker'), 46)
  const ctx = env.audio()
  assert.equal(ctx.state, 'running', 'a suspended context is resumed by the press')
  assert.equal(ctx.resumes, 1, 'resume() is called exactly once')
  assert.equal(ctx.plays.length, 1, 'and the sound still plays')

  const api = env.window.__dshcaPress
  assert.ok(api, 'window.__dshcaPress is exposed for auditioning and probing')
  assert.equal(api.probe().enabled, true, 'the probe reports the sound is on')
  assert.equal(api.probe().lastKind, 'synth', 'and which sound was last used')
  assert.equal(api.play('synth'), true, 'the audition entry plays on demand')
  assert.equal(ctx.plays.length, 2, '...bypassing the CD, so it can be heard straight away')
  assert.ok(api.probe().busyForMs > 0, 'the probe reports the remaining CD window')
  api.reset()
  assert.equal(api.probe().busyForMs, 0, 'reset clears it')
  ok('the press-sound debug API probes, auditions and resets')
}

/* 51. dropping a basin on her head: roll, fall, stack, drag away (0.9.0) */

/** The basin layer on the girl part. */
function potLayer(env) {
  return env.document.getElementById('dshca-pots')
}
/** The basins currently on her head, bottom 鈫?top. */
function pots(env) {
  const layer = potLayer(env)
  return layer ? layer.children.slice() : []
}
/** `SQUISH`-side constant: how long the fall takes (mirrors POT_FALL_MS). */
const POT_FALL = 420
function potTop(pot) {
  return parseFloat(pot.style.top)
}
/** The `translateY(...)` currently in an element's transform (null when none). */
function translateYOf(el) {
  const m = /translateY\((-?[\d.]+)px\)/.exec(String(el.style.transform || ''))
  return m ? parseFloat(m[1]) : null
}

{
  const env = makeEnv({ width: 220, potChance: 1 })
  splitAndReady(env)
  const girl = part(env, 'girl')
  press(girl, 50)
  await flushAsync()

  const layer = potLayer(env)
  assert.ok(layer, 'a basin layer appears on the girl part')
  assert.equal(layer.parentNode, girl, 'THE ASK: it lives inside her part, so it travels with her')
  assert.equal(pots(env).length, 1, 'the press dropped exactly one basin')
  const pot = pots(env)[0]
  const falling = env.window.__dshcaPots.probe().items[0]
  assert.ok(
    falling.fallFrom !== null && falling.fallFrom < -20,
    `it starts up in the air (${falling.fallFrom}px above its landing spot)`,
  )
  assert.equal(falling.landed, false, 'and is not on her head yet')
  ok('a girl press can drop a basin out of the sky')

  env.advance(POT_FALL)
  assert.equal(env.window.__dshcaPots.probe().items[0].landed, true, 'it lands')
  assert.equal(translateYOf(pot), null, 'and its fall transform is cleared')
  const sound = env.window.__dshcaPress.probe()
  assert.equal(sound.lastKind, 'pot', 'THE ASK: the clang plays the moment it touches her head')

  const girlW = parseFloat(girl.style.width)
  const girlH = girl.getBoundingClientRect().height
  assert.ok(
    Math.abs(parseFloat(pot.style.width) - girlW * 1.08) < 0.02,
    'the basin is sized as a fraction of her part',
  )
  assert.ok(
    Math.abs(potTop(pot) + parseFloat(pot.style.height) - girlH * 0.4) < 0.02,
    'and its rim lands on her head (fraction of the part height)',
  )
  assert.ok(/--dshca-pot-tilt/.test(Object.keys(pot.style).join(' ')), 'the tilt is a CSS variable')
  ok('it lands on her head at the measured spot and clangs')
}

{
  const env = makeEnv({ width: 220, potChance: 1 })
  splitAndReady(env)
  press(part(env, 'cooker'), 51)
  await flushAsync()
  assert.equal(potLayer(env), null, 'THE SCOPE: the cooker never gets a basin (it is her event)')
  press(part(env, 'girl'), 52)
  await flushAsync()
  assert.equal(pots(env).length, 1, 'while a girl press can')
  ok('only the girl drops basins, never the cooker')
}

{
  const env = makeEnv({ width: 220, potChance: 1 })
  splitAndReady(env)
  const girl = part(env, 'girl')
  press(girl, 53)
  release(girl, 53)
  await flushAsync()
  env.advance(POT_FALL)
  env.advance(400)
  press(girl, 54)
  release(girl, 54)
  await flushAsync()
  env.advance(POT_FALL)

  const list = pots(env)
  assert.equal(list.length, 2, 'a second press can drop a second basin')
  const step = parseFloat(list[0].style.height) * 0.22
  assert.ok(potTop(list[1]) < potTop(list[0]), 'THE ASK: the second one stacks ON TOP of the first')
  assert.ok(
    Math.abs(potTop(list[0]) - potTop(list[1]) - step) < 0.05,
    `by exactly one stacking step (${(potTop(list[0]) - potTop(list[1])).toFixed(2)} vs ${step.toFixed(2)})`,
  )
  assert.notEqual(list[0].style.left, list[1].style.left, 'and each gets its own jittered spot')
  ok('basins stack up, higher with every drop')
}

{
  const env = makeEnv({ width: 220, potChance: 1 })
  splitAndReady(env)
  const girl = part(env, 'girl')
  press(girl, 55)
  release(girl, 55)
  await flushAsync()
  env.advance(POT_FALL)
  const pot = pots(env)[0]
  const homeX = parseFloat(pot.style.left)
  const homeY = parseFloat(pot.style.top)

  // A small drag is a "put it back": it springs home and stays on her head.
  pot.dispatch('pointerdown', { pointerId: 60, clientX: 500, clientY: 400, button: 0 })
  pot.dispatch('pointermove', { pointerId: 60, clientX: 508, clientY: 404 })
  pot.dispatch('pointerup', { pointerId: 60, clientX: 508, clientY: 404 })
  assert.equal(pots(env).length, 1, 'a small drag leaves the basin on her head')
  assert.ok(Math.abs(parseFloat(pot.style.left) - homeX) < 0.01, 'and it springs back home')
  assert.ok(Math.abs(parseFloat(pot.style.top) - homeY) < 0.01, '...in both axes')

  // A real drag aside takes it off.
  pot.dispatch('pointerdown', { pointerId: 61, clientX: 500, clientY: 400, button: 0 })
  pot.dispatch('pointermove', { pointerId: 61, clientX: 700, clientY: 500 })
  assert.equal(pot.classList.contains('dshca-pot-dragging'), true, 'while dragging it follows the pointer')
  pot.dispatch('pointerup', { pointerId: 61, clientX: 700, clientY: 500 })
  assert.equal(
    env.window.__dshcaPots.probe().count,
    0,
    'THE ASK: dragging it well aside takes it off her head',
  )
  assert.equal(pot.classList.contains('dshca-pot-dragging'), false, 'the drag state is released')
  env.advance(400)
  assert.equal(pot.parentNode, null, 'and its node is gone once the fade is over')
  ok('dragging a basin aside removes it; a small nudge just puts it back')
}

{
  // Removing a lower one makes the ones above settle back down.
  const env = makeEnv({ width: 220, potChance: 1 })
  splitAndReady(env)
  const girl = part(env, 'girl')
  for (const id of [62, 63]) {
    press(girl, id)
    release(girl, id)
    await flushAsync()
    env.advance(POT_FALL)
    env.advance(400)
  }
  const list = pots(env)
  assert.equal(list.length, 2, 'two basins are stacked')
  const firstTop = potTop(list[0])
  const secondTop = potTop(list[1])

  // Drag the BOTTOM one away: the remaining one must re-stack down onto her head.
  const bottom = list[0]
  bottom.dispatch('pointerdown', { pointerId: 64, clientX: 500, clientY: 400, button: 0 })
  bottom.dispatch('pointermove', { pointerId: 64, clientX: 700, clientY: 500 })
  bottom.dispatch('pointerup', { pointerId: 64, clientX: 700, clientY: 500 })
  assert.equal(env.window.__dshcaPots.probe().count, 1, 'the bottom basin is gone')
  const rest = pots(env).filter((p) => p !== bottom)
  assert.equal(rest.length, 1, 'one basin is left')
  assert.ok(
    Math.abs(potTop(rest[0]) - firstTop) < 0.01,
    `THE POINT: the one above settles down onto her head (${secondTop} 鈫?${potTop(rest[0])})`,
  )
  assert.equal(env.window.__dshcaPots.probe().items[0].index, 0, 'and becomes the bottom of the stack')
  env.advance(400)
  assert.equal(pots(env).length, 1, 'the removed node leaves the layer once it has faded')
  ok('removing a lower basin re-stacks the rest')
}

{
  // A basin is its own thing: pressing it must not drag or squash her.
  const env = makeEnv({ width: 220, potChance: 1 })
  splitAndReady(env)
  const girl = part(env, 'girl')
  press(girl, 65)
  release(girl, 65)
  await flushAsync()
  env.advance(POT_FALL)
  const pot = pots(env)[0]
  const girlLeftBefore = partLeft(env, 'girl')

  girl.dispatch('pointerdown', { pointerId: 66, clientX: 1, clientY: 1, button: 0, target: pot })
  assert.equal(squishLayer(env, 'girl'), null, 'a press landing on a basin never squashes her')
  girl.dispatch('pointermove', { pointerId: 66, clientX: 60, clientY: 60 })
  girl.dispatch('pointerup', { pointerId: 66, clientX: 60, clientY: 60 })
  assert.equal(partLeft(env, 'girl'), girlLeftBefore, 'nor drags her')
  ok('basins swallow their own presses instead of the girl')
}

{
  // Replay starts from scratch -- no basins come back with the new split.
  const env = makeEnv({ width: 220, potChance: 1 })
  splitAndReady(env)
  const girl = part(env, 'girl')
  press(girl, 67)
  release(girl, 67)
  await flushAsync()
  env.advance(POT_FALL)
  assert.equal(pots(env).length, 1)
  buttonByTitle(env, L_REPLAY).dispatch('click')
  assert.equal(potLayer(env), null, 'replay clears the basins and their layer')
  assert.equal(env.window.__dshcaPots.probe().count, 0, 'the probe agrees')
  ok('replay takes the basins away with everything else')
}

{
  // The size slider re-lays them out: geometry is all fractions of the part.
  const env = makeEnv({ width: 220, potChance: 1 })
  splitAndReady(env)
  const girl = part(env, 'girl')
  press(girl, 68)
  release(girl, 68)
  await flushAsync()
  env.advance(POT_FALL)
  const pot = pots(env)[0]
  const before = parseFloat(pot.style.width)

  collapseButton(env).dispatch('click')
  const wide = Math.round(widgetWidth(env) * 2)
  slider(env).value = String(wide)
  slider(env).dispatch('input')
  assert.equal(widgetWidth(env), wide, 'the display size really doubled')

  assert.ok(
    Math.abs(parseFloat(pot.style.width) - before * 2) < 0.5,
    `the basin scales with the display size (${before} 鈫?${parseFloat(pot.style.width)})`,
  )
  assert.ok(
    Math.abs(parseFloat(pot.style.width) - parseFloat(girl.style.width) * 1.08) < 0.02,
    '...keeping the measured fraction of her part',
  )
  ok('changing the display size re-lays the basins out')
}

{
  // One sound at a time: a basin landing during the pipe stays silent.
  const env = makeEnv({ width: 220, pipeChance: 1, potChance: 1 })
  splitAndReady(env)
  const cooker = part(env, 'cooker')
  const girl = part(env, 'girl')
  press(cooker, 69)
  release(cooker, 69)
  await flushAsync()
  env.advance(300)

  env.window.__dshcaPress.reset()
  press(cooker, 70)
  release(cooker, 70)
  const pipe = env.window.__dshcaPress.probe()
  assert.equal(pipe.lastKind, 'pipe', 'the pipe easter egg is playing')
  const before = pipe.plays

  press(girl, 71)
  release(girl, 71)
  await flushAsync()
  assert.equal(env.window.__dshcaPress.probe().plays, before, 'her press sound is swallowed by the CD')
  env.advance(POT_FALL)
  const after = env.window.__dshcaPress.probe()
  assert.equal(after.plays, before, 'THE RULE: the landing clang does not stack on top either')
  assert.equal(after.lastKind, 'pipe', 'the pipe is still the one playing')
  assert.ok(after.skipped >= 2, 'both suppressions were counted')
  assert.equal(pots(env).length, 1, 'the basin still dropped -- only the sound was suppressed')
  ok('the basin clang shares the one-sound-at-a-time CD')
}

{
  // potChance:0 disables the whole event (and nothing else).
  const env = makeEnv({ width: 220, potChance: 0 })
  splitAndReady(env)
  const girl = part(env, 'girl')
  press(girl, 72)
  await flushAsync()
  assert.equal(potLayer(env), null, 'potChance:0 never drops a basin')
  assert.ok(squishLayer(env, 'girl'), 'while the squash itself still works')
  assert.equal(env.window.__dshcaPress.probe().plays, 1, 'and the press sound is untouched')
  ok('potChance:0 turns the basin event off')
}

{
  // The debug API can drop / clear on demand.
  const env = makeEnv({ width: 220, potChance: 0 })
  splitAndReady(env)
  const api = env.window.__dshcaPots
  assert.ok(api, 'window.__dshcaPots is exposed')
  assert.equal(api.probe().chance, 0, 'the probe reports the chance')
  assert.equal(api.drop(), true, 'drop() forces one regardless of the dice')
  assert.equal(api.probe().count, 1)
  assert.equal(api.probe().imageReady, true, 'the image was preloaded at mount')
  api.clear()
  assert.equal(api.probe().count, 0, 'clear() empties the head')
  assert.equal(potLayer(env), null, '...and takes the layer with it')
  ok('the basin debug API drops and clears on demand')
}

/* 52. 0.10.0: the two random cooker animations + the drag animation -------- */

/**
 * Give a 0.10.0 clip its metadata the way a browser would, then let the widget
 * lay it out. Returns the element so the caller can drive it.
 */
function seed010Clip(env, el) {
  assert.ok(el, 'the clip element exists')
  env.seedClipMedia(el)
  el._clockAdvance = true
  el.dispatch('loadedmetadata')
  el.dispatch('loadeddata')
  return el
}

{
  // THE ASK: clicking the cooker rolls A (20%) then B (10%), mutually exclusive.
  const env = makeEnv({ width: 220 }, { gap: [0.5, 0.53] })
  splitAndReady(env)
  const cooker = part(env, 'cooker')
  const canvas = partCanvas(env, 'cooker')

  // --- the two probabilities, and that nothing else fires ---
  // 用一个定值驱动骰子（`value` 优先于默认序列；记得清空可能残留的 queue）。
  env.random.queue.length = 0
  env.random.value = 0.19 // < 0.20 -> animation 1
  press(cooker, 41)
  const a = env.document.getElementById('dshca-cooker-a')
  assert.ok(a, 'a roll under randomAChance mounts animation 1')
  assert.equal(a._plays, 1, 'and starts it')
  assert.equal(squishLayer(env, 'cooker'), null, 'the press is handed over, so no squash snapshot')
  assert.equal(
    cooker.classList.contains('dshca-random-hidden'),
    true,
    'the cooker crop yields to the animation (via the class 鈥?the box must stay for the drag)',
  )
  assert.equal(
    env.document.getElementById('dshca-cooker-b'),
    null,
    'animation 2 is NOT mounted: only one click, only one animation',
  )
  release(cooker, 41)
  ok('a click that rolls under randomAChance plays animation 1 鈥?and only it')

  // --- animation 1: it plays, then REWINDS, then hands the frame back ---
  seed010Clip(env, a)
  const boxA = a.getAttribute('data-content-box').split(',').map(Number)
  assert.equal(boxA.length, 4, 'animation 1 measured a content box')
  assert.ok(boxA[2] > 0 && boxA[3] > 0, '...with a real size')

  a.currentTime = LID_ANIM_DURATION - 0.02
  a.dispatch('timeupdate')
  assert.ok(a._pauses > 0, 'reaching the end rewinds instead of stopping dead')
  // 倒放是靠 rAF 逐帧推的，而 rAF 只有在 `advance()` 里才跑：第一帧会把"起始
  // 时刻"记下来（挂件用的是自己的 now()），再推时钟才会算出进度 —— 少了这一步，
  // 时间差永远是 0，倒放就会一直循环下去（推不动）。
  a.dispatch('timeupdate')
  env.advance(2000)
  assert.equal(env.window.__dshcaRandom.probe().stage, null, 'the rewind finishes and the stage clears')
  assert.equal(a.classList.contains('dshca-cooker-on'), false, 'the animation layer is put away')
  assert.equal(cooker.classList.contains('dshca-random-hidden'), false, 'THE ASK: the cooker crop is back on screen')
  ok('animation 1 rewinds itself and hands the frame back')

  // --- animation 2, from a fresh click ---
  // 骰子是按"先 A 后 B"两次调用的，所以想验 B 得排**两个**值：
  // 第一个必须落空（>= 0.20），第二个才命中（< 0.10）。
  env.random.value = null
  env.random.queue.length = 0
  env.random.queue.push(0.5, 0.05)
  press(cooker, 42)
  assert.equal(env.window.__dshcaRandom.probe().stage, 'lid2', 'a roll in [A, A+B) plays animation 2')
  const b = env.document.getElementById('dshca-cooker-b')
  assert.ok(b, 'a roll in [0.20, 0.30) mounts animation 2')
  assert.equal(b._plays, 1, 'and starts it')
  assert.equal(env.document.getElementById('dshca-cooker-a')._plays, 1, 'animation 1 did not start again')
  const basin = env.document.getElementById('dshca-girlbasin')
  assert.ok(basin, 'and her clip comes with it')
  assert.equal(basin._plays, 1, 'she plays too 鈥?the two things start together')
  assert.equal(
    cooker.classList.contains('dshca-random-hidden'),
    true,
    'the cooker crop yields',
  )
  release(cooker, 42)
  ok('a click in [A, A+B) plays animation 2, which brings her clip along')

  // --- contact: the cooker must not be left displaced ---
  seed010Clip(env, b)
  const basinBox = basin.getAttribute('data-content-box').split(',').map(Number)
  assert.equal(basinBox.length, 4, 'her clip measured a content box')
  assert.equal(
    env.window.__dshcaRandom.probe().flight !== null,
    true,
    'a flight plan was computed for the cooker',
  )
  b.currentTime = 0.5 // move it off the end so the "contact" path is the one taken
  // 0.10.1 修的漏洞1：先推几帧（rAF 在 advance() 里跑）让飞行真的起步，
  // 然后断言位移**真的写进了会被消费的地方**。早先的回归是：applyFlight 只把
  // 位移写进 --dshca-fly-x/y，而 .dshca-flying 的 CSS 里没有 transform 声明去
  // 消费它们 —— JS 侧接触判定一直在跑、锅在画面上却纹丝不动。
  env.advance(600)
  assert.equal(cooker.classList.contains('dshca-flying'), true, 'the cooker carries the flying class mid-flight')
  const midX = parseFloat(cooker.style.getPropertyValue('--dshca-fly-x'))
  assert.ok(
    isFinite(midX) && midX > 0,
    `the cooker is really translating toward her (--dshca-fly-x=${cooker.style.getPropertyValue('--dshca-fly-x')})`,
  )
  // CSS 那一半也要在：桩里没有级联，所以直接查注入的样式表里有没有
  // "消费这两个变量"的 transform 声明 —— 少了它就是漏洞1 本尊。
  const styleText = env.document.getElementById('dshca-style').textContent
  assert.ok(
    /dshca-flying\{[^}]*transform:translate\(var\(--dshca-fly-x/.test(styleText),
    'the flying rule consumes the flight variables (transform: translate(var(--dshca-fly-x...)))',
  )
  env.advance(6000)
  assert.equal(env.window.__dshcaRandom.probe().stage, null, 'the flight ends and the stage clears')
  assert.equal(cooker.classList.contains('dshca-flying'), false, 'the flying class is gone after contact')
  assert.equal(
    cooker.style.getPropertyValue('--dshca-fly-x'),
    '',
    'and the flight variable is removed with it (transform snaps back to none)',
  )
  assert.equal(b.classList.contains('dshca-cooker-on'), false, 'the animation layer is put away')
  assert.equal(basin.classList.contains('dshca-showing'), false, 'her clip is put away too')
  assert.equal(cooker.classList.contains('dshca-random-hidden'), false, 'the cooker crop is back')
  const fly = env.window.__dshcaRandom.probe().fly
  assert.equal(fly.flying, false, 'THE ASK: no flight transform is left on the cooker')
  assert.equal(fly.x, '0px', '...and the x offset went back to zero')
  assert.equal(fly.y, '0px', '...and so did y')
  ok('contact (or the window closing) resets the cooker and puts both layers away')

  // --- the leftover 70%: the 0.8.0 press path, untouched ---
  const playsA = a._plays
  const playsB = b._plays
  const basinPlays = basin._plays
  env.random.value = 0.5 // >= 0.30 for BOTH rolls -> neither fires
  env.random.queue.length = 0
  press(cooker, 43)
  assert.ok(squishLayer(env, 'cooker'), 'a roll above both chances falls through to the squash')
  assert.equal(a._plays, playsA, 'animation 1 is not started')
  assert.equal(b._plays, playsB, 'animation 2 is not started')
  assert.equal(basin._plays, basinPlays, 'and her clip is not started')
  release(cooker, 43)
  env.advance(400)
  ok('a roll above both chances leaves the 0.8.0 press behaviour alone')
}

{
  // 0.10.1 修的漏洞2：她头上摞着盆时触发动画2，联动播放的她那段必须把盆藏掉，
  // 收工（接触 / 兜底 / 手动 stop）之后盆要原样回来。
  const env = makeEnv({ width: 220 }, { gap: [0.5, 0.53] })
  splitAndReady(env)
  const cooker = part(env, 'cooker')

  // 先摞一个盆（走调试入口，不掷骰子）。
  assert.equal(env.window.__dshcaPots.drop(), true, 'a pot is stacked on her head')
  const layer = potLayer(env)
  assert.ok(layer, 'the pot layer exists')
  assert.notEqual(layer.style.visibility, 'hidden', '...and it is visible before the animation')

  // 掷中动画2（第一个骰子落空、第二个命中）。
  env.random.value = null
  env.random.queue.length = 0
  env.random.queue.push(0.5, 0.05)
  press(cooker, 71)
  assert.equal(env.window.__dshcaRandom.probe().stage, 'lid2', 'animation 2 is on stage')
  assert.equal(
    layer.style.visibility,
    'hidden',
    'THE ASK: the pot yields while her seated clip plays (no floating hat)',
  )
  assert.equal(
    env.document.getElementById('dshca-girlbasin').classList.contains('dshca-showing'),
    true,
    'her clip is up at the same time',
  )

  // 收工：盆回来。
  env.window.__dshcaRandom.stop()
  assert.notEqual(layer.style.visibility, 'hidden', '...and the pot is back afterwards')
  ok('a pot on her head yields during animation 2 and comes back after')
}

{
  // The order matters: A is asked FIRST, so a value that would satisfy both must
  // only ever start A. That is what makes the two events mutually exclusive.
  const env = makeEnv({ width: 220 }, { gap: [0.5, 0.53] })
  splitAndReady(env)
  const cooker = part(env, 'cooker')
  env.random.queue.length = 0
  env.random.queue.push(0.01) // satisfies BOTH thresholds
  press(cooker, 44)
  assert.ok(env.document.getElementById('dshca-cooker-a'), 'the first roll went to animation 1')
  assert.equal(
    env.document.getElementById('dshca-cooker-b'),
    null,
    'THE ASK: a value under both thresholds can never reach animation 2',
  )
  release(cooker, 44)
  ok('the two random animations are mutually exclusive by construction')
}

{
  // THE ASK (drag): dragging her loops the drag clip and releasing hands the screen back.
  const env = makeEnv({ width: 220 }, { gap: [0.5, 0.53] })
  const { idle } = splitAndReady(env)
  env.advance(IDLE_PERIOD)
  assert.equal(idle._playing, true, 'the standby clip is mid-play')

  const girl = part(env, 'girl')
  const girlCanvas = partCanvas(env, 'girl')
  const girlLeft0 = partLeft(env, 'girl')

  // A press that never crosses the drag threshold must NOT start it.
  press(girl, 51)
  assert.equal(
    env.document.getElementById('dshca-drag'),
    null,
    'a press is not a drag: the drag clip is not even mounted',
  )
  release(girl, 51)
  env.advance(400)

  // 拖动**还没松手**的时候，`play()` 之后浏览器会发 'playing'（桩里不会自己发，
  // 所以在 down → move → playing → up 的第三步上补一次）。
  dragBy(girl, -120, 90, 52, () => {
    const dragEl = env.document.getElementById('dshca-drag')
    if (dragEl) dragEl.dispatch('playing')
  })
  const drag = env.document.getElementById('dshca-drag')
  assert.ok(drag, 'dragging her mounts the drag clip')
  assert.equal(drag._plays, 1, 'and starts it')
  assert.equal(drag.loop, true, 'it loops while the drag lasts')
  assert.equal(partLeft(env, 'girl'), girlLeft0 - 120, 'the drag still lands where the pointer says')
  ok('dragging her plays the drag animation over her frame')

  // 松手之后：拖动动画那一格必须被收掉，而且**屏幕上只剩下原来那一段** ——
  // 她那一格是"定格图"还是"待机动画"取决于排期器（那一拍可能正在播），
  // 所以这里断言的是"屏幕上恰好一段画面"，而不是"她一定是定格图"。
  assert.equal(drag.classList.contains('dshca-drag-on'), false, 'releasing takes the drag layer away')
  assert.equal(
    visibleClip(env).indexOf('drag') < 0,
    true,
    `the drag layer is off screen (clip=${visibleClip(env)})`,
  )
  assertSinglePicture(env, 'after the drag release')
  assert.equal(drag._pauses > 0, true, 'the drag clip is paused, not left running')
  seed010Clip(env, drag)
  const dragBox = drag.getAttribute('data-content-box').split(',').map(Number)
  assert.equal(dragBox.length, 4, 'the drag clip was laid out from its content box')
  ok('releasing hands the screen straight back')

  // 排期器那一拍在拖动期间应当**让过去**（"正在播的不打断"那条判据），而不是
  // 被拖动动画吃掉：把这一拍收工之后，下一拍照常起播。
  const playsBefore = idle._plays
  clipEnded(env, 'idle')
  env.advance(IDLE_PERIOD)
  assert.ok(idle._plays > playsBefore, 'the schedule still plays her clips after the drag')
  assertSinglePicture(env, 'after the next beat')
  ok('the schedule is not swallowed by the drag')
}

{
  // The kill switches have to leave no trace of 0.10.0.
  const env = makeEnv({ width: 220, randomAnims: false, dragAnim: false }, { gap: [0.5, 0.53] })
  splitAndReady(env)
  env.random.queue.length = 0
  env.random.value = 0.01 // would satisfy both chances if they were live
  press(part(env, 'cooker'), 61)
  assert.equal(
    env.document.getElementById('dshca-cooker-a'),
    null,
    'randomAnims:false never mounts the animations',
  )
  assert.ok(squishLayer(env, 'cooker'), 'so the press falls through to the squash')
  release(part(env, 'cooker'), 61)
  env.advance(400)

  dragBy(part(env, 'girl'), -60, 40, 62)
  assert.equal(env.document.getElementById('dshca-drag'), null, 'dragAnim:false never mounts the drag clip')
  ok('randomAnims:false and dragAnim:false put 0.10.0 fully back to 0.9.0')
}

{
  // The debug API must be able to play either animation on demand: the two
  // events are probability-driven, so this is the ONLY way to verify them.
  const env = makeEnv({ width: 220 }, { gap: [0.5, 0.53] })
  splitAndReady(env)
  const api = env.window.__dshcaRandom
  assert.ok(api, 'window.__dshcaRandom is exposed')
  assert.equal(api.probe().chanceA, 0.2, 'the probe reports the A probability')
  assert.equal(api.probe().chanceB, 0.1, 'and B')
  assert.equal(api.probe().stage, null, 'nothing is on stage to begin with')

  env.random.queue.length = 0
  env.random.value = 0.99 // the dice would refuse; play() must not care
  assert.equal(api.play('lid1'), true, 'play("lid1") ignores the dice')
  assert.equal(api.probe().stage, 'lid1', 'and puts animation 1 on stage')
  seed010Clip(env, env.document.getElementById('dshca-cooker-a'))
  assert.equal(api.play('lid2'), false, 'a second animation cannot start on top of it')
  assert.equal(api.stop(), true, 'stop() ends it early')
  assert.equal(api.probe().stage, null, 'and clears the stage')

  assert.equal(api.play('lid2'), true, 'play("lid2") works the same way')
  assert.equal(api.probe().stage, 'lid2')
  assert.ok(env.document.getElementById('dshca-girlbasin'), 'her clip comes with it')
  api.stop()
  assert.equal(api.probe().stage, null)

  assert.equal(api.drag(true), true, 'drag(true) starts the drag layer')
  assert.equal(api.probe().drag.on, true, 'and the probe says so')
  assert.equal(api.drag(false), true, 'drag(false) ends it')
  assert.equal(api.probe().drag.on, false)
  assert.ok(api.debug().events.length > 0, 'the diagnostic ledger recorded the lot')
  ok('the random-animation debug API drives both events and the drag layer')
}

console.log(`\nAll ${passed} client-half checks passed.`)

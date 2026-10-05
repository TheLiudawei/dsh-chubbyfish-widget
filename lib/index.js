/**
 * dsh-corner-anim —— 宿主半区（Host half）
 * ---------------------------------------------------------------------------
 * 职责只有三件事：
 *   1. 把客户端脚本注入 DSH 页面（Web 形态走 `webServer.tapIndex`，
 *      桌面 Electron 形态走 `webserver/index-inject` 结构化行）；
 *   2. 用 webServer 精确路由把客户端脚本、随包素材与 turn 信号发给浏览器；
 *   3. 允许通过 Cordis config 调整尺寸 / 角落 / 拖动 / 动画节拍 / 发送联动等行为。
 *
 * 注入通道的关键结论（与 dsh-whale-widget 在 issue #152/#153/#154 里的
 * 实测一致，这里照抄其结论以避免重踩）：
 *   - 桌面壳的 index.html 由安装包静态 dist 直出（`dsh-app://app/`），
 *     永远不经过宿主的 renderIndex()，所以 `tapIndex` 在桌面端不生效；
 *   - 桌面端唯一的注入通道是 `webserver/index-inject`，而那张注入表是
 *     **宿主启动时一次性收集**的 —— 订阅一旦晚于那次收集，行就永远进不了表。
 *     因此本文件的 `apply()` 第一件事就是注册注入行，**不放进 inject 回调**；
 *   - 页面侧解释器对 `script-src` 行是「加载失败即 reject 整个 boot」，
 *     所以这里推的是**内联 `script` 行**：由它自己建 `<script src=…>`
 *     并吞掉 onerror，路由不在时静默失败，绝不拖垮 DSH 启动。
 *
 * 随包素材全部收在一张 ASSETS 表里（文件名 → 路由 / 内容类型），
 * 注册与 /status 自检都从这张表派生 —— 新增素材只改一处。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS_DIR = path.join(PACKAGE_ROOT, 'assets')

const ROUTE_BASE = '/dsh-corner-anim'
const WIDGET_URL = `${ROUTE_BASE}/widget.js`
const STATUS_URL = `${ROUTE_BASE}/status`
const TURN_URL = `${ROUTE_BASE}/turn.json`

/**
 * 随包素材表。
 *
 * - `anim.webm`  开场动画（播完拆两块）；
 * - `idle.webm`  待机动画（每 5 秒一趟）；`act.webm` 动作动画（每 15 秒一趟）；
 * - `girl.webm`  点「发送消息」后小女孩那段；`lid.webm` 开盖那段
 *   —— **lid.webm 按用户要求保留原始音轨**，其余素材都无音轨；
 * - `pipe.mp3`   按压电饭煲时概率触发的"钢管"彩蛋音（已无损裁掉首部静音，
 *   见 tools/audio-trim.mjs）；`basin.png` / `basin.mp3` 掉盆的图与音效；
 * - `drag.webm`  拖动动画；`lid-empty.webm` / `lid-rice.webm` 电饭煲的两种
 *   随机动画（**带原始音轨**）；`girl-basin.webm` 动画2 里小女孩那段。
 *
 * VP9 的 alpha 存在独立的 BlockAdditions 里 —— 这些素材都是 `-c copy` 原样
 * 搬字节的产物，换素材时同样不要重编码（会压没 alpha）。
 */
const ASSETS = [
  { key: 'media', file: 'anim.webm', type: 'video/webm' },
  { key: 'idle', file: 'idle.webm', type: 'video/webm' },
  { key: 'act', file: 'act.webm', type: 'video/webm' },
  { key: 'girl', file: 'girl.webm', type: 'video/webm' },
  { key: 'lid', file: 'lid.webm', type: 'video/webm' },
  { key: 'pipe', file: 'pipe.mp3', type: 'audio/mpeg' },
  { key: 'basin', file: 'basin.png', type: 'image/png' },
  { key: 'basinSound', file: 'basin.mp3', type: 'audio/mpeg' },
  { key: 'drag', file: 'drag.webm', type: 'video/webm' },
  { key: 'lidEmpty', file: 'lid-empty.webm', type: 'video/webm' },
  { key: 'lidRice', file: 'lid-rice.webm', type: 'video/webm' },
  { key: 'girlBasin', file: 'girl-basin.webm', type: 'video/webm' },
].map((asset) => ({ ...asset, url: `${ROUTE_BASE}/${asset.file}`, path: path.join(ASSETS_DIR, asset.file) }))

const WIDGET_FILE = path.join(ASSETS_DIR, 'widget.js')

function readOwnVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const VERSION = readOwnVersion()

/**
 * 「本轮对话已完整结束」的计数器（turn.json 的 seq）。
 *
 * 每收到一条 `session/event` 的 `turn/end` 就 +1。客户端拿它和上一次的读数比：
 * 数字变大 = 有新的一轮结算完毕，这正是 whale 挂件弹「本次消费金额」的时刻。
 * 只在内存里累计（不落盘）：热重载后归零没关系，客户端第一次轮询只对齐读数、
 * 不触发动画，不会把"以前结束的轮次"当成新结算。
 */
let turnSeq = 0

/* -------------------------------------------------------------------------- */
/* config                                                                      */
/* -------------------------------------------------------------------------- */

const CORNERS = new Set(['top-right', 'top-left', 'bottom-right', 'bottom-left'])

const DEFAULTS = {
  enabled: true,
  corner: 'top-right',
  width: 220,
  minWidth: 80,
  maxWidth: 600,
  offsetX: 20,
  offsetY: 20,
  opacity: 1,
  draggable: true,
  showControls: true,
  rememberPosition: true,
  split: true,
  splitAutoDetect: true,
  splitRatio: 0.5,
  idle: true,
  idleEvery: 5000,
  idleScale: 1,
  act: true,
  actEvery: 15000,
  actScale: 1,
  // 「发送消息」联动。sendHook 关掉就完全回到无联动的行为（只剩开场 + 两条节拍），
  // sendSelector 是留给 DOM 变化的逃生门（留空 = 用内置的语义探测）。
  sendHook: true,
  sendSelector: '',
  sendGirlScale: 1,
  sendLidScale: 1,
  sendLabel: '肥鱼已经煮饭：',
  sendLabelColor: '#3b82f6',
  sendLidAudio: true,
  // 点击 Q 弹（按住把"当前这一帧"压扁、松开弹回并接着播）。
  // 只对拆分后的电饭煲 / 小女孩两块生效，发送联动的两段动画期间自动让开。
  clickSquish: true,
  // 点击 Q 弹的**按压音效**：普通按压是客户端现场合成的短促软弹音；
  // 电饭煲那一侧另有 pipeChance 的概率改放 pipe.mp3（"钢管"）那条彩蛋音。
  // 两者共用一个内置 CD（上一个没播完就不出声），所以永远不会叠着响。
  pressSound: true,
  pressVolume: 0.6,
  pipeChance: 0.07,
  // "钢管"那条彩蛋音相对 pressVolume 的倍率（0.5 = 调小一半）。
  pipeVolume: 0.5,
  // 按压小女孩时有这个概率从天而降一个盆，扣在她头上（可以不断摞高、
  // 也可以拖到一旁摘掉）；盆砸到头那一下的音效与摔盆的形变都在客户端里。
  potChance: 0.1,
  // 电饭煲上的两种随机动画（**互斥** —— 先掷 A，只有 A 没中才问 B，
  // 所以"点一下锅会演点什么"的总概率是两者之和，而两者永远不会同时播）。
  // 两个都设 0 就完全回到"点锅只剩点击 Q 弹 + 按压音效"。
  randomAnims: true,
  /** 动画1「开盖 · 空锅」（lid-empty.webm）的概率。播完倒放回原样。 */
  randomAChance: 0.2,
  /** 动画2「开盖 · 米饭热气」（lid-rice.webm）的概率。她那段 + 锅追过去。 */
  randomBChance: 0.1,
  /** 动画2 里电饭煲"追到她"的上限时长（毫秒）；接触更早就提前收工。 */
  randomFlightMs: 5000,
  /** 小女孩那段在**接触时刻**相对她自己那一块的高度比例（1 = 与她等高）。 */
  randomContactScale: 0.95,
  /** 反方向的两个旋钮：动画1 倒放的时长、动画2 里她那段的大小。 */
  randomReverseMs: 1200,
  randomRiceScale: 1,
  randomEmptyScale: 1,
  // 拖动动画（drag.webm）：拖小女孩那一块时循环出画，松手立刻切回她原来的画面。
  dragAnim: true,
  dragScale: 1,
  dragRate: 1,
}

function clampNumber(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

/**
 * 这个值最终会被客户端写进 `style.color`，所以它是一处**注入面**：
 * 只接受字面颜色（#hex / rgb() / hsl() / 颜色名），别的一律退回默认值。
 * 不做转义而做白名单 —— 白名单不可能漏掉某个边角语法。
 */
const COLOR_PATTERN =
  /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.\s,%]+\)|hsla?\(\s*[\d.\s,%deg]+\)|[a-z]{3,24})$/i

function normalizeColor(value, fallback) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 32) return fallback
  return COLOR_PATTERN.test(trimmed) ? trimmed : fallback
}

/**
 * 容错解析：配置来自 YAML，可能缺失、可能是字符串，也可能是 `!!js` 表达式
 * 的惰性包装对象。任何无法理解的值都退回默认值 —— 插件宁可跑默认行为，
 * 也不能因为一个配置项写错就整块不加载。
 */
function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const corner = typeof src.corner === 'string' && CORNERS.has(src.corner) ? src.corner : DEFAULTS.corner

  // minWidth / maxWidth 界定折叠面板里滑杆的范围；顺序写反时自动纠正，
  // width 再夹进这个区间 —— 保证客户端拿到的三个值永远自洽。
  const minWidth = Math.round(clampNumber(src.minWidth, DEFAULTS.minWidth, 48, 2000))
  const maxWidth = Math.round(clampNumber(src.maxWidth, DEFAULTS.maxWidth, minWidth, 4000))

  return {
    enabled: src.enabled !== false,
    corner,
    width: Math.round(clampNumber(src.width, DEFAULTS.width, minWidth, maxWidth)),
    minWidth,
    maxWidth,
    offsetX: Math.round(clampNumber(src.offsetX, DEFAULTS.offsetX, 0, 4000)),
    offsetY: Math.round(clampNumber(src.offsetY, DEFAULTS.offsetY, 0, 4000)),
    opacity: clampNumber(src.opacity, DEFAULTS.opacity, 0.05, 1),
    draggable: src.draggable !== false,
    showControls: src.showControls !== false,
    rememberPosition: src.rememberPosition !== false,
    // 拆分：默认开启自动探测（按最后一帧的 alpha 找主体之间的透明缝隙），
    // 探测不可用时退回 splitRatio。
    split: src.split !== false,
    splitAutoDetect: src.splitAutoDetect !== false,
    splitRatio: clampNumber(src.splitRatio, DEFAULTS.splitRatio, 0.05, 0.95),
    // 小女孩那块的动画排期：两段素材各自一条节拍，主视频播完、拆成两块之后
    // 由客户端轮流起播。idle = 待机动画（idle.webm），act = 动作动画（act.webm）；
    // 同一时刻只播一段，撞车时 act 优先。
    idle: src.idle !== false,
    idleEvery: Math.round(clampNumber(src.idleEvery, DEFAULTS.idleEvery, 1000, 3600000)),
    idleScale: clampNumber(src.idleScale, DEFAULTS.idleScale, 0.1, 10),
    act: src.act !== false,
    actEvery: Math.round(clampNumber(src.actEvery, DEFAULTS.actEvery, 1000, 3600000)),
    actScale: clampNumber(src.actScale, DEFAULTS.actScale, 0.1, 10),
    // 「发送消息」联动。label 允许自定义文案，颜色允许自定义；
    // 选择器原样透传（客户端只在一个 CSS 选择器上 try/catch，不会因为写错而崩）。
    sendHook: src.sendHook !== false,
    sendSelector: typeof src.sendSelector === 'string' ? src.sendSelector.slice(0, 400) : DEFAULTS.sendSelector,
    sendGirlScale: clampNumber(src.sendGirlScale, DEFAULTS.sendGirlScale, 0.1, 10),
    sendLidScale: clampNumber(src.sendLidScale, DEFAULTS.sendLidScale, 0.1, 10),
    sendLabel:
      typeof src.sendLabel === 'string' && src.sendLabel.length <= 40 ? src.sendLabel : DEFAULTS.sendLabel,
    sendLabelColor: normalizeColor(src.sendLabelColor, DEFAULTS.sendLabelColor),
    sendLidAudio: src.sendLidAudio !== false,
    // 点击 Q 弹：默认开，写 `clickSquish: false` 就完全回到没有它的样子。
    clickSquish: src.clickSquish !== false,
    // 按压音效：总开关 + 音量 + "钢管"彩蛋的概率（0 = 从不触发，1 = 每次都用它）。
    pressSound: src.pressSound !== false,
    pressVolume: clampNumber(src.pressVolume, DEFAULTS.pressVolume, 0, 1),
    pipeChance: clampNumber(src.pipeChance, DEFAULTS.pipeChance, 0, 1),
    pipeVolume: clampNumber(src.pipeVolume, DEFAULTS.pipeVolume, 0, 1),
    // 掉盆概率：0 = 从不掉，1 = 每次按压小女孩都掉（调试时好用）。
    potChance: clampNumber(src.potChance, DEFAULTS.potChance, 0, 1),
    // 两种随机动画：总开关 + 两条互斥的概率 + 三个手感旋钮。
    // 概率各自夹在 [0, 1] 之内（两者的**和**可以超过 1，但实现上先问 A 再问 B，
    // 所以 A 会吃掉它那一份，真正的总概率是 min(1, A + B)）。
    randomAnims: src.randomAnims !== false,
    randomAChance: clampNumber(src.randomAChance, DEFAULTS.randomAChance, 0, 1),
    randomBChance: clampNumber(src.randomBChance, DEFAULTS.randomBChance, 0, 1),
    randomFlightMs: Math.round(clampNumber(src.randomFlightMs, DEFAULTS.randomFlightMs, 600, 20000)),
    randomContactScale: clampNumber(src.randomContactScale, DEFAULTS.randomContactScale, 0.3, 2),
    randomReverseMs: Math.round(clampNumber(src.randomReverseMs, DEFAULTS.randomReverseMs, 300, 8000)),
    randomRiceScale: clampNumber(src.randomRiceScale, DEFAULTS.randomRiceScale, 0.1, 10),
    randomEmptyScale: clampNumber(src.randomEmptyScale, DEFAULTS.randomEmptyScale, 0.1, 10),
    // 拖动动画：关掉（dragAnim: false）就回到"拖动期间画面原样不动"。
    dragAnim: src.dragAnim !== false,
    dragScale: clampNumber(src.dragScale, DEFAULTS.dragScale, 0.1, 10),
    dragRate: clampNumber(src.dragRate, DEFAULTS.dragRate, 0.25, 4),
  }
}

/* -------------------------------------------------------------------------- */
/* responses                                                                   */
/* -------------------------------------------------------------------------- */

function sendPlain(res, status, text) {
  const body = Buffer.from(text, 'utf8')
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(body)
}

function sendJson(res, body, cacheControl) {
  const buffer = Buffer.from(body, 'utf8')
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(buffer.length),
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(buffer)
}

/** 客户端脚本：静态文件 + 一行运行时配置前缀。每次都读盘，便于边改边看。 */
function serveWidget(req, res, config) {
  let source
  try {
    source = fs.readFileSync(WIDGET_FILE, 'utf8')
  } catch {
    sendPlain(res, 404, 'dsh-corner-anim: widget.js not found in package assets')
    return
  }
  const prelude = `window.__DSH_CORNER_ANIM_CONFIG__=${JSON.stringify(config)};\n`
  const body = Buffer.from(prelude + source, 'utf8')
  res.writeHead(200, {
    'Content-Type': 'application/javascript; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

/**
 * `turn.json` 的响应体：seq + 时间戳，永远 200 + JSON，绝不悬挂。
 * 客户端每秒轮询一次，seq 变大即「这一轮真的结束了」→ 触发开盖动画。
 */
function serveTurn(res) {
  sendJson(res, JSON.stringify({ ok: true, seq: turnSeq, ts: Date.now() }), 'no-store')
}

/**
 * 素材路由。`<video>` / `<audio>` 基本一定会带 `Range` 请求（并且可能只取头部
 * 探测元数据），所以这里实现完整的单区间 Range：命中返回 206 + Content-Range，
 * 非法区间返回 416，无 Range 返回 200 全量。
 *
 * 所有素材共用这一个处理器 —— 字节区间语义完全一样，差别只有
 * 内容类型（`contentType`）与文件本身。
 */
function serveAssetFile(file, label, contentType) {
  return function serveMedia(req, res) {
    let size
    try {
      size = fs.statSync(file).size
    } catch {
      sendPlain(res, 404, `dsh-corner-anim: ${label} not found in package assets`)
      return
    }

    const headers = {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    }

    let start = 0
    let end = size - 1
    let status = 200

    const rawRange = req.headers && req.headers.range
    if (typeof rawRange === 'string' && rawRange) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(rawRange.trim())
      if (match && (match[1] !== '' || match[2] !== '')) {
        if (match[1] === '') {
          // suffix range: 最后 N 字节
          start = Math.max(0, size - Number(match[2]))
          end = size - 1
        } else {
          start = Number(match[1])
          end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)
        }
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
          res.writeHead(416, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Range': `bytes */${size}`,
            'Content-Length': '0',
          })
          res.end()
          return
        }
        status = 206
        headers['Content-Range'] = `bytes ${start}-${end}/${size}`
      }
    }

    headers['Content-Length'] = String(end - start + 1)
    res.writeHead(status, headers)

    if (req.method === 'HEAD') {
      res.end()
      return
    }

    const stream = fs.createReadStream(file, { start, end })
    stream.on('error', () => {
      try {
        res.destroy()
      } catch {
        /* socket already gone */
      }
    })
    stream.pipe(res)
  }
}

/**
 * 自检路由：排查「装上了但没反应」时先看这里。
 * `ok` = 客户端脚本与**每一份**随包素材都还在（少一份都会标成 false）。
 */
function serveStatus(res, config) {
  const describeAsset = (file) => {
    try {
      const stat = fs.statSync(file)
      return { bytes: stat.size, mtime: stat.mtime.toISOString() }
    } catch {
      return null
    }
  }
  let widget = null
  try {
    widget = { bytes: fs.statSync(WIDGET_FILE).size }
  } catch {
    widget = null
  }
  const assets = { widget }
  const routes = { widget: WIDGET_URL, turn: TURN_URL, status: STATUS_URL }
  for (const asset of ASSETS) {
    routes[asset.key] = asset.url
    assets[asset.key] = describeAsset(asset.path)
  }
  const body = JSON.stringify(
    {
      plugin: 'dsh-corner-anim',
      version: VERSION,
      ok: Boolean(widget) && ASSETS.every((asset) => assets[asset.key]),
      routes,
      turnSeq,
      assets,
      config,
    },
    null,
    2,
  )
  sendJson(res, body, 'no-store')
}

/* -------------------------------------------------------------------------- */
/* plugin                                                                      */
/* -------------------------------------------------------------------------- */

// 桌面端注入行：内联 script，自己建 <script src> 并吞掉 onerror。
// 详见文件头注释 —— 不能推 `script-src`，否则路由缺失会 reject 掉 __DSH_BOOT_READY__。
const DESKTOP_ROW_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;' +
  `var s=document.createElement("script");s.src="${WIDGET_URL}";s.async=true;` +
  's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

function hasOurRow(table) {
  for (const row of table) {
    if (!row) continue
    if (row.kind === 'script-src' && row.src === WIDGET_URL) return true
    if (row.kind === 'script' && typeof row.text === 'string' && row.text.indexOf(WIDGET_URL) >= 0) return true
  }
  return false
}

export default {
  name: 'dsh-corner-anim',

  /**
   * 注意：**不要**在这里写对象级 `inject`。对象级 inject 会把整个 apply()
   * 推迟到服务就绪之后，而桌面端的注入表是宿主启动时一次性收集的 ——
   * 那正是「插件装了但桌面端永远不出现」的竞态。注册行不依赖任何服务，
   * 所以立刻做；需要服务的那部分再放进局部 `root.inject([...], cb)`。
   */
  apply(root, rawConfig) {
    const config = normalizeConfig(rawConfig)
    if (!config.enabled) return

    const disposers = []
    root.effect(() => () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* already disposed */
        }
      }
    })

    // ① 桌面 Electron 形态：结构化注入行，必须最早进表。
    disposers.push(
      root.on('webserver/index-inject', (table) => {
        try {
          if (!Array.isArray(table)) return
          if (hasOurRow(table)) return
          table.push({ kind: 'script', placement: 'body', text: DESKTOP_ROW_TEXT })
        } catch {
          /* never break the host's index rendering */
        }
      }),
    )

    // ①′ 会话事件：`turn/end` = 一轮对话完整结束。
    // 与 dsh-whale-widget 的「本次消费金额」泡泡同一触发条件 —— 它在那一刻结算
    // 金额，我们在这里把 `turnSeq` +1，客户端轮询 `turn.json` 发现数字变大后
    // 触发开盖动画。监听不依赖任何服务，所以在 apply 里直接注册；收不到事件
    // （宿主版本不广播）时客户端有旧的"正文增长"探测兜底，动画不会永远不播。
    disposers.push(
      root.on('session/event', (session, event) => {
        try {
          if (event && event.type === 'turn/end') turnSeq += 1
        } catch {
          /* never break the host's session dispatch */
        }
      }),
    )

    // ② 需要 webServer 的部分：注册路由（两种形态共用）+ Web 形态的 tapIndex。
    root.inject(['webServer'], (ctx) => {
      const webServer = ctx.webServer
      if (!webServer) return

      const register = (route) => {
        try {
          disposers.push(webServer.register(route))
        } catch (err) {
          ctx.logger?.warn?.(`[dsh-corner-anim] route ${route.path} not registered: ${err && err.message}`)
        }
      }

      register({ kind: 'exact', path: WIDGET_URL, handler: (req, res) => serveWidget(req, res, config) })
      for (const asset of ASSETS) {
        register({
          kind: 'exact',
          path: asset.url,
          handler: serveAssetFile(asset.path, asset.file, asset.type),
        })
      }
      register({ kind: 'exact', path: TURN_URL, handler: (req, res) => serveTurn(res) })
      register({
        kind: 'exact',
        path: STATUS_URL,
        handler: (req, res) => (req.method === 'HEAD' ? sendPlain(res, 200, '') : serveStatus(res, config)),
      })

      // Web 形态：renderIndex 会对每个 index.html 响应跑一遍 tap。
      try {
        disposers.push(
          webServer.tapIndex((html) => {
            if (typeof html !== 'string') return html
            if (html.indexOf(WIDGET_URL) !== -1) return html
            const tag = `<script defer src="${WIDGET_URL}"></script>`
            return html.indexOf('</body>') !== -1 ? html.replace('</body>', `${tag}</body>`) : html + tag
          }),
        )
      } catch {
        /* tapIndex is optional across versions */
      }
    })
  },
}

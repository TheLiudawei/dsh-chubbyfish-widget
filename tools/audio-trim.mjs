/**
 * audio-trim.mjs —— 量出音频首尾的静音，并按 **MP3 帧边界**把它裁掉
 * ---------------------------------------------------------------------------
 * 为什么需要它：这台机器上没有 ffmpeg / ffprobe。而"前 3 秒是空的"这件事
 * 只能靠**解码**才看得出来，靠字节是看不出来的。所以这里用无头 Chromium 解码
 * （Web Audio 的 decodeAudioData），在真实样本上量出静音段，然后**不重新编码** ——
 * 直接按 MP3 帧（每帧固定 1152 个样本，长度由比特率/采样率算出）切字节。
 *
 * 为什么不做"重编码"：重编码会掉一代音质、还会把文件改大；按帧切是**无损**的，
 * 而且 mp3 本来就是一堆独立帧，丢开头几帧不会有任何解码副作用。
 *
 * 用法：
 *   node tools/audio-trim.mjs probe <in.mp3>
 *       只量不写：时长 / 声道 / 采样率 / 首尾静音 / 峰值 / 建议的裁切点
 *   node tools/audio-trim.mjs trim <in.mp3> <out.mp3> [--head] [--tail] [--margin 0.03]
 *       默认只裁**首部静音**（--tail 连尾部一起裁）；--margin 是往前留的安全余量
 *       （秒），避免把起音的第一个字切掉；裁切点一律对齐到帧边界（只会更保守）。
 *
 * 环境变量：DSH_PROBE_BROWSER 指定浏览器；DSH_TRIM_PORT 指定调试端口。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BROWSER =
  process.env.DSH_PROBE_BROWSER || String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`
const PORT = Number(process.env.DSH_TRIM_PORT || 9371)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------------------------------------------ mp3 frames */

const BITRATE_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
const BITRATE_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]
const RATE_V1 = [44100, 48000, 32000, 0]
const RATE_V2 = [22050, 24000, 16000, 0]
const RATE_V25 = [11025, 12000, 8000, 0]

/** ID3v2 头（`ID3` + 版本 + 标志 + 同步安全整数长度），没有就返回 0。 */
function id3v2Size(buf) {
  if (buf.length < 10) return 0
  if (buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return 0
  const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f)
  return 10 + size
}

/** 解析一帧 MP3 头；返回 { length, samples, sampleRate } 或 null。 */
function parseFrame(buf, at) {
  if (at + 4 > buf.length) return null
  if (buf[at] !== 0xff || (buf[at + 1] & 0xe0) !== 0xe0) return null
  const versionBits = (buf[at + 1] >> 3) & 0x03 // 3=MPEG1, 2=MPEG2, 0=MPEG2.5, 1=保留
  const layerBits = (buf[at + 1] >> 1) & 0x03 // 1 = Layer III
  if (versionBits === 1 || layerBits !== 1) return null
  const bitrateIndex = (buf[at + 2] >> 4) & 0x0f
  const rateIndex = (buf[at + 2] >> 2) & 0x03
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null
  const padding = (buf[at + 2] >> 1) & 0x01

  const v1 = versionBits === 3
  const bitrate = (v1 ? BITRATE_V1_L3 : BITRATE_V2_L3)[bitrateIndex] * 1000
  const sampleRate = (v1 ? RATE_V1 : versionBits === 2 ? RATE_V2 : RATE_V25)[rateIndex]
  if (!bitrate || !sampleRate) return null

  const samples = v1 ? 1152 : 576
  const length = Math.floor(((samples / 8) * bitrate) / sampleRate) + padding
  return { length, samples, sampleRate, bitrate, padding }
}

/** 走一遍帧头，得到每帧的起始偏移与它对应的起始时间（秒）。 */
function scanFrames(buf) {
  var offset = id3v2Size(buf)
  var audioStart = offset
  var time = 0
  var frames = []
  while (offset + 4 <= buf.length) {
    var head = parseFrame(buf, offset)
    if (!head) break
    frames.push({ offset: offset, time: time, length: head.length })
    time += head.samples / head.sampleRate
    offset += head.length
  }
  return { audioStart: audioStart, frames: frames, duration: time, end: offset }
}

/** 把秒换成"不晚于这个时刻的那一帧"（往前对齐 = 只会多留一点，绝不切掉起音）。 */
function frameFloor(frames, seconds) {
  var pick = frames[0]
  for (var i = 0; i < frames.length; i += 1) {
    if (frames[i].time <= seconds + 1e-9) pick = frames[i]
    else break
  }
  return pick
}

/* ------------------------------------------------------------------ measuring */

/** 起一个无头窗口，把音频**直接以 data URL 送进页面**解码，量首尾静音与峰值。 */
async function measure(file) {
  const bytes = fs.readFileSync(file)
  const b64 = bytes.toString('base64')
  // 每次都用独立的 profile 目录：复用同一个目录时，上一次没退干净的实例会让
  // 新的启动挂到旧窗口上，于是拿到的 target 属于上一次的会话（实测踩到过）。
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dshca-audio-trim-'))

  const child = spawn(
    BROWSER,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      'about:blank',
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
      if (r.exceptionDetails) {
        const d = r.exceptionDetails
        const detail = (d.exception && (d.exception.description || d.exception.value)) || d.text || 'exception'
        throw new Error(`${detail} @ ${await where()}`)
      }
      return r.result ? r.result.value : undefined
    }
    const where = async () => {
      const res = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true })
      return (res.result && res.result.result && res.result.result.value) || '?'
    }

    const expr = `(async () => {
      const raw = atob(${JSON.stringify(b64)})
      const bytes = new Uint8Array(raw.length)
      for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
      const ctx = new (window.AudioContext || window.webkitAudioContext)()
      const audio = await ctx.decodeAudioData(bytes.buffer)
      const rate = audio.sampleRate
      const chans = []
      for (let c = 0; c < audio.numberOfChannels; c += 1) chans.push(audio.getChannelData(c))
      const total = audio.length
      // 10ms 一块的峰值包络：静音判据用它，抗单点噪声。
      const block = Math.max(1, Math.round(rate / 100))
      const blocks = Math.ceil(total / block)
      const peaks = new Float32Array(blocks)
      let peak = 0
      for (let b = 0; b < blocks; b += 1) {
        let m = 0
        const from = b * block
        const to = Math.min(total, from + block)
        for (let c = 0; c < chans.length; c += 1) {
          const d = chans[c]
          for (let i = from; i < to; i += 1) {
            const v = d[i] < 0 ? -d[i] : d[i]
            if (v > m) m = v
          }
        }
        peaks[b] = m
        if (m > peak) peak = m
      }
      const TH = 0.01
      // 连续 3 块（30ms）超阈值才算"真的有声音"，避免起音前的一个爆点被当成起点。
      const RUN = 3
      let firstLoud = -1
      for (let b = 0; b + RUN <= blocks; b += 1) {
        let ok = true
        for (let k = 0; k < RUN; k += 1) if (peaks[b + k] <= TH) { ok = false; break }
        if (ok) { firstLoud = b; break }
      }
      let lastLoud = -1
      for (let b = blocks - 1; b - RUN + 1 >= 0; b -= 1) {
        let ok = true
        for (let k = 0; k < RUN; k += 1) if (peaks[b - k] <= TH) { ok = false; break }
        if (ok) { lastLoud = b; break }
      }
      // 静音段里的底噪/直流，用来判断"是真的空"还是"很轻的环境声"
      const silentBlocks = []
      for (let b = 0; b < blocks; b += 1) if (peaks[b] <= TH) silentBlocks.push(peaks[b])
      let silentPeak = 0
      for (const v of silentBlocks) if (v > silentPeak) silentPeak = v
      return {
        duration: audio.duration,
        sampleRate: rate,
        channels: audio.numberOfChannels,
        peak: peak,
        threshold: TH,
        blockMs: (block / rate) * 1000,
        headSilence: firstLoud < 0 ? null : (firstLoud * block) / rate,
        tailSilence: lastLoud < 0 ? null : ((blocks - 1 - lastLoud) * block) / rate,
        loudUntil: lastLoud < 0 ? null : (((lastLoud + 1) * block) / rate),
        silentPeak: silentPeak,
        loudBlocks: blocks,
      }
    })()`
    const out = await evaluate(expr)
    ws.close()
    return out
  } finally {
    try {
      child.kill()
    } catch {
      /* gone */
    }
    try {
      fs.rmSync(profile, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
}

/* ---------------------------------------------------------------------- main */

const [, , MODE, IN_FILE, OUT_FILE] = process.argv
if (!MODE || !IN_FILE) {
  console.error(
    'usage: node tools/audio-trim.mjs probe <in.mp3>\n' +
      '       node tools/audio-trim.mjs trim <in.mp3> <out.mp3> [--head] [--tail] [--margin 0.03]',
  )
  process.exit(2)
}

const buf = fs.readFileSync(IN_FILE)
const scan = scanFrames(buf)
const report = await measure(IN_FILE)

const info = {
  file: path.basename(IN_FILE),
  bytes: buf.length,
  id3v2Bytes: scan.audioStart,
  frames: scan.frames.length,
  frameDuration: scan.duration,
  ...report,
}
console.log(JSON.stringify(info, null, 2))

if (MODE === 'probe') process.exit(0)
if (MODE !== 'trim' || !OUT_FILE) {
  console.error('trim needs an output path')
  process.exit(2)
}

const flag = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] !== undefined ? Number(process.argv[i + 1]) : fallback
}
const margin = flag('--margin', 0.03)
// 首部静音默认就裁（这是这个工具存在的理由）。
let startAt = 0
if (report.headSilence !== null && report.headSilence > margin) startAt = report.headSilence - margin
// 尾部静音只在显式要求时裁。
let endAt = scan.duration
if (process.argv.includes('--tail') && report.loudUntil !== null) {
  if (scan.duration - report.loudUntil > margin) endAt = report.loudUntil + margin
}

const from = frameFloor(scan.frames, startAt)
let to = scan.frames[scan.frames.length - 1]
for (const f of scan.frames) {
  if (f.time <= endAt + 1e-9) to = f
}
const cutStart = from.offset
const cutEnd = Math.min(buf.length, to.offset + to.length)
const out = buf.subarray(cutStart, cutEnd)
fs.writeFileSync(OUT_FILE, out)

const frameSeconds = (to.length * 8) / (report.sampleRate * 1000) // 帧长(字节) → 秒
const keptSeconds = to.time + frameSeconds - from.time
console.log(
  `\ntrimmed: ${path.basename(IN_FILE)} -> ${path.basename(OUT_FILE)}\n` +
    `  starts at : ${from.time.toFixed(3)}s (silence ends ${report.headSilence.toFixed(3)}s, ` +
    `kept ${margin}s margin, frame-aligned)\n` +
    `  duration  : ${keptSeconds.toFixed(3)}s\n` +
    `  bytes     : ${buf.length} -> ${out.length}\n`,
)

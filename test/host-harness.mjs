/**
 * Host-half harness: loads lib/index.js against a mock Cordis context, then
 * serves the registered routes over a real HTTP server and asserts on the
 * responses. Run:  node test/host-harness.mjs
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import plugin from '../lib/index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// Read the shipped sizes instead of hardcoding them, so swapping an animation
// asset can never make this harness lie.
const MEDIA_BYTES = fs.statSync(path.join(HERE, '..', 'assets', 'anim.webm')).size
const IDLE_BYTES = fs.statSync(path.join(HERE, '..', 'assets', 'idle.webm')).size
const ACT_BYTES = fs.statSync(path.join(HERE, '..', 'assets', 'act.webm')).size
const GIRL_BYTES = fs.statSync(path.join(HERE, '..', 'assets', 'girl.webm')).size
const LID_BYTES = fs.statSync(path.join(HERE, '..', 'assets', 'lid.webm')).size
/** The trimmed 0.8.0 press-sound asset ("钢管"), see tools/audio-trim.mjs. */
const PIPE_BYTES = fs.statSync(path.join(HERE, '..', 'assets', 'pipe.mp3')).size
/** 0.9.0: the basin image (generator watermark cropped off) and its clang. */
const BASIN_BYTES = fs.statSync(path.join(HERE, '..', 'assets', 'basin.png')).size
const BASIN_SOUND_BYTES = fs.statSync(path.join(HERE, '..', 'assets', 'basin.mp3')).size
/** 0.10.0: the drag clip and the two random-cooker animations (+ her part). */
const DRAG_BYTES = fs.statSync(path.join(HERE, '..', 'assets', 'drag.webm')).size
const LID_EMPTY_BYTES = fs.statSync(path.join(HERE, '..', 'assets', 'lid-empty.webm')).size
const LID_RICE_BYTES = fs.statSync(path.join(HERE, '..', 'assets', 'lid-rice.webm')).size
const GIRL_BASIN_BYTES = fs.statSync(path.join(HERE, '..', 'assets', 'girl-basin.webm')).size

const ROUTE_BASE = '/dsh-corner-anim'

/* ---------------------------------------------------------------- mock ctx */

const registered = []
const disposers = []
const injectedTables = []
let injectCallbackRan = false

let indexInjectListener = null

const ctx = {
  on(name, fn) {
    if (name === 'webserver/index-inject') {
      indexInjectListener = fn
      // Emulate the host: collect remaining rows now, and the subscriber pushes into the table.
      const table = []
      injectedTables.push(table)
      fn(table)
    }
    return () => {}
  },
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
    return () => {}
  },
  inject(names, cb) {
    assert.deepEqual(names, ['webServer'], 'expected to inject exactly webServer')
    cb({ webServer, logger: { warn: (m) => console.log('  [warn]', m) } })
    injectCallbackRan = true
  },
  logger: { warn: (m) => console.log('  [warn]', m) },
}

const taps = []
const webServer = {
  register(route) {
    registered.push(route)
    return () => {}
  },
  tapIndex(fn) {
    taps.push(fn)
    return () => {}
  },
}

/* ------------------------------------------------------------------- run it */

assert.equal(plugin.name, 'dsh-corner-anim')
plugin.apply(ctx, undefined)

console.log('routes registered:')
for (const route of registered) console.log(`  ${route.kind.padEnd(6)} ${route.path}`)

assert.equal(injectCallbackRan, true, 'inject callback must run')

const paths = registered.map((r) => r.path).sort()
assert.deepEqual(
  paths,
  [
    `${ROUTE_BASE}/act.webm`,
    `${ROUTE_BASE}/anim.webm`,
    `${ROUTE_BASE}/basin.mp3`,
    `${ROUTE_BASE}/basin.png`,
    `${ROUTE_BASE}/drag.webm`,
    `${ROUTE_BASE}/girl-basin.webm`,
    `${ROUTE_BASE}/girl.webm`,
    `${ROUTE_BASE}/idle.webm`,
    `${ROUTE_BASE}/lid-empty.webm`,
    `${ROUTE_BASE}/lid-rice.webm`,
    `${ROUTE_BASE}/lid.webm`,
    `${ROUTE_BASE}/pipe.mp3`,
    `${ROUTE_BASE}/status`,
    `${ROUTE_BASE}/turn.json`,
    `${ROUTE_BASE}/widget.js`,
  ],
  'expected exactly the fifteen namespaced routes',
)

/* ------------------------------------- desktop injection row (index-inject) */

assert.equal(injectedTables.length, 1, 'must subscribe to webserver/index-inject')
const table = injectedTables[0]
assert.equal(table.length, 1, 'must push exactly one row before any service is ready')
const row = table[0]
assert.equal(row.kind, 'script', 'row must be an inline script row, never script-src')
assert.equal(row.placement, 'body')
assert.ok(row.text.includes(`${ROUTE_BASE}/widget.js`), 'row must reference the widget route')
assert.ok(!row.text.includes('</script'), 'inline row must be safe to inline')
console.log('desktop injection row: OK (inline script, onerror swallowed)')

// Dedupe contract: the host emits a FRESH table per `collectIndexInjections()`
// call, so dedupe is necessarily per-table — pushing twice into one table must
// not duplicate, and a fresh table legitimately gets its own row.
{
  const t = []
  indexInjectListener(t)
  assert.equal(t.length, 1)
  indexInjectListener(t)
  assert.equal(t.length, 1, 'pushing twice into the same table must not duplicate')

  const fresh = []
  indexInjectListener(fresh)
  assert.equal(fresh.length, 1, 'a fresh collection table gets its own row')
  console.log('row dedupe: OK (per-table)')
}

/* ------------------------------------------------------- tapIndex (web form) */

assert.equal(taps.length, 1, 'must register one index tap for the web form')
const html = '<html><body><div id="app"></div></body></html>'
const tapped = taps[0](html)
assert.ok(tapped.includes(`<script defer src="${ROUTE_BASE}/widget.js"></script>`), 'tap must inject the tag')
assert.equal(taps[0](tapped), tapped, 'tap must be idempotent')
console.log('web tapIndex: OK')

/* ------------------------------------------------------------ real HTTP run */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const route = registered.find((r) => r.path === url.pathname)
  if (!route) {
    res.writeHead(404).end('no route')
    return
  }
  Promise.resolve(route.handler(req, res)).catch((err) => {
    res.writeHead(500).end(String(err && err.stack))
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

async function get(path, headers = {}) {
  const response = await fetch(origin + path, { headers })
  const buffer = Buffer.from(await response.arrayBuffer())
  return { response, buffer }
}

try {
  /* ---- widget.js ---- */
  {
    const { response, buffer } = await get(`${ROUTE_BASE}/widget.js`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /javascript/)
    const text = buffer.toString('utf8')
    assert.ok(text.startsWith('window.__DSH_CORNER_ANIM_CONFIG__='), 'config prelude must come first')
    assert.ok(text.includes('dshca-root'), 'widget body must be present')
    assert.ok(text.includes('holdLastFrame'), 'last-frame logic must be in the payload')
    assert.ok(text.includes('analyseFrame'), 'split logic must be in the payload')
    console.log(`widget.js: OK (${buffer.length} bytes, config prelude present)`)
  }

  /* ---- status ---- */
  {
    const { response, buffer } = await get(`${ROUTE_BASE}/status`)
    assert.equal(response.status, 200)
    const json = JSON.parse(buffer.toString('utf8'))
    assert.equal(json.ok, true, 'status must report ok')
    assert.equal(json.assets.media.bytes, MEDIA_BYTES, 'media size must match the shipped webm')
    assert.equal(json.assets.idle.bytes, IDLE_BYTES, 'idle size must match the shipped webm')
    assert.equal(json.assets.act.bytes, ACT_BYTES, 'act size must match the shipped webm')
    assert.equal(json.routes.idle, `${ROUTE_BASE}/idle.webm`, 'status must advertise the idle route')
    assert.equal(json.routes.act, `${ROUTE_BASE}/act.webm`, 'status must advertise the act route')
    assert.equal(
      json.routes.pipe,
      `${ROUTE_BASE}/pipe.mp3`,
      'status must advertise the press-sound route (0.8.0)',
    )
    assert.equal(json.assets.pipe.bytes, PIPE_BYTES, 'pipe size must match the shipped mp3')
    assert.equal(json.routes.basin, `${ROUTE_BASE}/basin.png`, 'status must advertise the basin image')
    assert.equal(
      json.routes.basinSound,
      `${ROUTE_BASE}/basin.mp3`,
      'status must advertise the basin clang',
    )
    assert.equal(json.assets.basin.bytes, BASIN_BYTES, 'basin size must match the shipped png')
    assert.equal(
      json.assets.basinSound.bytes,
      BASIN_SOUND_BYTES,
      'basin sound size must match the shipped mp3',
    )
    console.log(
      `status: OK (version ${json.version}, anim ${json.assets.media.bytes} B, ` +
        `idle ${json.assets.idle.bytes} B, act ${json.assets.act.bytes} B, ` +
        `pipe ${json.assets.pipe.bytes} B, basin ${json.assets.basin.bytes} B)`,
    )
  }

  /* ---- media: full ---- */
  {
    const { response, buffer } = await get(`${ROUTE_BASE}/anim.webm`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'video/webm')
    assert.equal(response.headers.get('accept-ranges'), 'bytes')
    assert.equal(buffer.length, MEDIA_BYTES)
    assert.equal(buffer.subarray(0, 4).toString('hex'), '1a45dfa3', 'must be EBML/WebM')
    console.log('media full: OK (200, video/webm, EBML magic)')
  }

  /* ---- media: open-ended range (what <video> actually sends) ---- */
  {
    const { response, buffer } = await get(`${ROUTE_BASE}/anim.webm`, { Range: 'bytes=0-' })
    assert.equal(response.status, 206)
    assert.equal(response.headers.get('content-range'), `bytes 0-${MEDIA_BYTES - 1}/${MEDIA_BYTES}`)
    assert.equal(buffer.length, MEDIA_BYTES)
    console.log('media range bytes=0-: OK (206)')
  }

  /* ---- media: mid-file range ---- */
  {
    const { response, buffer } = await get(`${ROUTE_BASE}/anim.webm`, { Range: 'bytes=100-199' })
    assert.equal(response.status, 206)
    assert.equal(response.headers.get('content-range'), `bytes 100-199/${MEDIA_BYTES}`)
    assert.equal(buffer.length, 100)
    console.log('media range bytes=100-199: OK (206, 100 bytes)')
  }

  /* ---- media: suffix range ---- */
  {
    const { response, buffer } = await get(`${ROUTE_BASE}/anim.webm`, { Range: 'bytes=-64' })
    assert.equal(response.status, 206)
    assert.equal(buffer.length, 64)
    console.log('media suffix range bytes=-64: OK (206, 64 bytes)')
  }

  /* ---- media: unsatisfiable range ---- */
  {
    const { response } = await get(`${ROUTE_BASE}/anim.webm`, { Range: 'bytes=99999999-' })
    assert.equal(response.status, 416)
    assert.equal(response.headers.get('content-range'), `bytes */${MEDIA_BYTES}`)
    console.log('media bad range: OK (416)')
  }

  /* ---- idle media: full ---- */
  {
    const { response, buffer } = await get(`${ROUTE_BASE}/idle.webm`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'video/webm')
    assert.equal(buffer.length, IDLE_BYTES)
    assert.equal(buffer.subarray(0, 4).toString('hex'), '1a45dfa3', 'must be EBML/WebM')

    // The whole point of the shipped idle asset: it is the downloaded clip with
    // its BGM stripped, so the tracks are exactly one VP9 video and nothing else.
    // Both codec IDs live in the Tracks element near the head of the file.
    const head = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('latin1')
    assert.ok(head.includes('V_VP9'), 'idle.webm must carry a VP9 video track')
    for (const audio of ['A_OPUS', 'A_VORBIS', 'A_AAC', 'A_PCM']) {
      assert.ok(!head.includes(audio), `idle.webm must have no audio track (found ${audio})`)
    }
    console.log('idle media full: OK (200, VP9 only, audio track stripped)')
  }

  /* ---- idle media: range (what <video> sends) ---- */
  {
    const { response, buffer } = await get(`${ROUTE_BASE}/idle.webm`, { Range: 'bytes=0-' })
    assert.equal(response.status, 206)
    assert.equal(response.headers.get('content-range'), `bytes 0-${IDLE_BYTES - 1}/${IDLE_BYTES}`)
    assert.equal(buffer.length, IDLE_BYTES)
    const bad = await get(`${ROUTE_BASE}/idle.webm`, { Range: 'bytes=99999999-' })
    assert.equal(bad.response.status, 416)
    console.log('idle media range: OK (206 on bytes=0-, 416 on unsatisfiable)')
  }

  /* ---- act media: full ---- */
  {
    const { response, buffer } = await get(`${ROUTE_BASE}/act.webm`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'video/webm')
    assert.equal(buffer.length, ACT_BYTES)
    assert.equal(buffer.subarray(0, 4).toString('hex'), '1a45dfa3', 'must be EBML/WebM')

    // The action asset is a VP8 clip that arrived silent; the plugin must never
    // end up serving something with an audio track it did not ask for.
    const head = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('latin1')
    assert.ok(head.includes('V_VP8'), 'act.webm must carry a VP8 video track')
    for (const audio of ['A_OPUS', 'A_VORBIS', 'A_AAC', 'A_PCM']) {
      assert.ok(!head.includes(audio), `act.webm must have no audio track (found ${audio})`)
    }
    console.log('act media full: OK (200, VP8 only, silent)')
  }

  /* ---- act media: range ---- */
  {
    const { response, buffer } = await get(`${ROUTE_BASE}/act.webm`, { Range: 'bytes=0-' })
    assert.equal(response.status, 206)
    assert.equal(response.headers.get('content-range'), `bytes 0-${ACT_BYTES - 1}/${ACT_BYTES}`)
    assert.equal(buffer.length, ACT_BYTES)
    const bad = await get(`${ROUTE_BASE}/act.webm`, { Range: 'bytes=99999999-' })
    assert.equal(bad.response.status, 416)
    console.log('act media range: OK (206 on bytes=0-, 416 on unsatisfiable)')
  }

  /* ---- girl media (0.7.0): the send-message clip ---- */
  {
    const { response, buffer } = await get(`${ROUTE_BASE}/girl.webm`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'video/webm')
    assert.equal(buffer.length, GIRL_BYTES)
    assert.equal(buffer.subarray(0, 4).toString('hex'), '1a45dfa3', 'must be EBML/WebM')
    const head = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('latin1')
    assert.ok(head.includes('V_VP9'), 'girl.webm must carry a VP9 video track')
    for (const audio of ['A_OPUS', 'A_VORBIS', 'A_AAC', 'A_PCM']) {
      assert.ok(!head.includes(audio), `girl.webm must have no audio track (found ${audio})`)
    }
    const ranged = await get(`${ROUTE_BASE}/girl.webm`, { Range: 'bytes=0-' })
    assert.equal(ranged.response.status, 206)
    assert.equal(ranged.response.headers.get('content-range'), `bytes 0-${GIRL_BYTES - 1}/${GIRL_BYTES}`)
    console.log('girl media: OK (200 full + 206 range, VP9 + alpha, silent)')
  }

  /* ---- lid media (0.7.0): the open-lid clip, AUDIO KEPT on purpose ---- */
  {
    const { response, buffer } = await get(`${ROUTE_BASE}/lid.webm`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'video/webm')
    assert.equal(buffer.length, LID_BYTES)
    const head = buffer.subarray(0, Math.min(buffer.length, 8192)).toString('latin1')
    assert.ok(head.includes('V_VP9'), 'lid.webm must carry a VP9 video track')
    // Explicitly the opposite of the idle/act checks: the user asked for the
    // original audio track to survive, so this one MUST have it.
    assert.ok(
      ['A_VORBIS', 'A_OPUS', 'A_AAC', 'A_PCM'].some((a) => head.includes(a)),
      'lid.webm must keep its audio track (the user asked us not to strip it)',
    )
    const ranged = await get(`${ROUTE_BASE}/lid.webm`, { Range: 'bytes=100-199' })
    assert.equal(ranged.response.status, 206)
    assert.equal(ranged.buffer.length, 100)
    console.log('lid media: OK (200 full + 206 range, VP9 + alpha, AUDIO KEPT)')
  }

  /* ---- pipe.mp3 (0.8.0): the trimmed press-sound easter egg ---- */
  {
    const { response, buffer } = await get(`${ROUTE_BASE}/pipe.mp3`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'audio/mpeg')
    assert.equal(response.headers.get('accept-ranges'), 'bytes')
    assert.equal(buffer.length, PIPE_BYTES)
    // tools/audio-trim.mjs cuts at an MP3 **frame boundary**, so the file must
    // start on a frame sync (0xFFEx) -- byte 0 is the ID3 tag if the trim ever
    // regressed, and a decoder would also see the old 2.8s of silence again.
    assert.equal(buffer[0], 0xff, 'the trimmed mp3 must start on a frame sync')
    assert.equal(buffer[1] & 0xe0, 0xe0, '...with the full 11-bit sync word')
    // 39168 B is what "2.42s @ 128 kbps" actually weighs; a regression that
    // shipped the untrimmed 83949 B file would fail this.
    assert.ok(
      PIPE_BYTES < 50000,
      `the shipped pipe.mp3 must be the trimmed one (got ${PIPE_BYTES} B)`,
    )
    const ranged = await get(`${ROUTE_BASE}/pipe.mp3`, { Range: 'bytes=0-' })
    assert.equal(ranged.response.status, 206)
    assert.equal(ranged.response.headers.get('content-range'), `bytes 0-${PIPE_BYTES - 1}/${PIPE_BYTES}`)
    console.log(`pipe media: OK (200 + 206 range, audio/mpeg, trimmed to ${PIPE_BYTES} B)`)
  }

  /* ---- basin.png / basin.mp3 (0.9.0): the "drop a basin on her head" assets ---- */
  {
    const { response, buffer } = await get(`${ROUTE_BASE}/basin.png`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/png')
    assert.equal(buffer.length, BASIN_BYTES)
    // The 8-byte PNG signature: the asset must be the cropped transparent image,
    // not (say) an HTML error page or the raw 7z payload.
    assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'must be a real PNG')
    const ranged = await get(`${ROUTE_BASE}/basin.png`, { Range: 'bytes=0-99' })
    assert.equal(ranged.response.status, 206)
    assert.equal(ranged.buffer.length, 100)

    const sound = await get(`${ROUTE_BASE}/basin.mp3`)
    assert.equal(sound.response.status, 200)
    assert.equal(sound.response.headers.get('content-type'), 'audio/mpeg')
    assert.equal(sound.buffer.length, BASIN_SOUND_BYTES)
    assert.equal(sound.buffer[0], 0xff, 'the clang must start on an MP3 frame sync')
    assert.equal(sound.buffer[1] & 0xe0, 0xe0, '...with the full 11-bit sync word')
    console.log(
      `basin assets: OK (200 + 206 range, image/png ${BASIN_BYTES} B, audio/mpeg ${BASIN_SOUND_BYTES} B)`,
    )
  }

  /* ---- 0.10.0 assets: the drag clip and both random-cooker animations ---- */
  {
    const checks = [
      { route: 'drag.webm', bytes: DRAG_BYTES, audio: false },
      { route: 'lid-empty.webm', bytes: LID_EMPTY_BYTES, audio: true },
      { route: 'lid-rice.webm', bytes: LID_RICE_BYTES, audio: true },
      { route: 'girl-basin.webm', bytes: GIRL_BASIN_BYTES, audio: false },
    ]
    for (const { route, bytes, audio } of checks) {
      const { response, buffer } = await get(`${ROUTE_BASE}/${route}`)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-type'), 'video/webm')
      assert.equal(buffer.length, bytes, `${route} size must match the shipped file`)
      assert.equal(buffer.subarray(0, 4).toString('hex'), '1a45dfa3', `${route} must be EBML/WebM`)
      const head = buffer.subarray(0, Math.min(buffer.length, 8192)).toString('latin1')
      assert.ok(head.includes('V_VP9'), `${route} must carry a VP9 video track`)
      const hasAudio = ['A_VORBIS', 'A_OPUS', 'A_AAC', 'A_PCM'].some((a) => head.includes(a))
      assert.equal(
        hasAudio,
        audio,
        audio ? `${route} must KEEP its audio track` : `${route} must have no audio track`,
      )
      const ranged = await get(`${ROUTE_BASE}/${route}`, { Range: 'bytes=0-' })
      assert.equal(ranged.response.status, 206)
    }
    console.log('0.10.0 media: OK (drag + lid-empty + lid-rice + girl-basin, alpha intact)')
  }

  /* ---- turn.json (0.10.2): the "one turn fully finished" signal ---- */
  {
    const { response, buffer } = await get(`${ROUTE_BASE}/turn.json`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /json/)
    const json = JSON.parse(buffer.toString('utf8'))
    assert.equal(json.ok, true, 'turn.json must report ok')
    assert.equal(typeof json.seq, 'number', 'turn.json must carry a numeric seq')
    assert.equal(
      json.seq,
      0,
      'no turn/end event has been delivered through the mock session yet',
    )
    console.log('turn.json: OK (ok:true, numeric seq)')
  }

  /* ---- unknown ---- */
  {
    const { response } = await get(`${ROUTE_BASE}/nope`)
    assert.equal(response.status, 404)
    console.log('unknown route: OK (404)')
  }
} finally {
  server.close()
}

/* ---------------------------------------------- config plumbing & disabled */

{
  const seen = []
  const makeCtx = () =>
    ({
      on: () => () => {},
      effect: (fn) => {
        fn()
        return () => {}
      },
      inject: (names, cb) =>
        cb({
          webServer: {
            register: (r) => {
              seen.push(r)
              return () => {}
            },
            tapIndex: () => () => {},
          },
          logger: undefined,
        }),
    })

  seen.length = 0
  plugin.apply(makeCtx(), { width: '300', corner: 'bottom-left', opacity: 5, draggable: false, bogus: 1 })
  const status = seen.find((r) => r.path.endsWith('/status'))
  let captured = null
  await Promise.resolve(
    status.handler({ method: 'GET' }, { writeHead: () => {}, end: (b) => (captured = b) }),
  )
  const parsed = JSON.parse(captured.toString('utf8'))
  assert.equal(parsed.config.width, 300, 'string width coerced to number')
  assert.equal(parsed.config.corner, 'bottom-left')
  assert.equal(parsed.config.opacity, 1, 'opacity clamped to <= 1')
  assert.equal(parsed.config.draggable, false)
  assert.equal(parsed.config.minWidth, 80, 'minWidth default')
  assert.equal(parsed.config.maxWidth, 600, 'maxWidth default')
  assert.equal(parsed.config.split, true, 'split defaults to on')
  assert.equal(parsed.config.splitAutoDetect, true, 'auto-detection defaults to on')
  assert.equal(parsed.config.splitRatio, 0.5, 'splitRatio default')
  assert.equal(parsed.config.idle, true, 'idle animation defaults to on')
  assert.ok(!('bogus' in parsed.config), 'unknown keys dropped')
  console.log('config normalize: OK (coerce, clamp, whitelist)')

  /** Read the config the host would hand the client for a given raw config. */
  async function configFor(raw) {
    const routes = []
    const ctx = {
      on: () => () => {},
      effect: (fn) => {
        fn()
        return () => {}
      },
      inject: (names, cb) =>
        cb({ webServer: { register: (r) => (routes.push(r), () => {}), tapIndex: () => () => {} }, logger: undefined }),
    }
    plugin.apply(ctx, raw)
    let body = null
    routes
      .find((r) => r.path.endsWith('/status'))
      .handler({ method: 'GET' }, { writeHead: () => {}, end: (b) => (body = b) })
    return JSON.parse(body.toString('utf8')).config
  }

  // width is clamped into the [minWidth, maxWidth] window...
  const wide = await configFor({ width: 900, minWidth: 100, maxWidth: 300 })
  assert.equal(wide.width, 300, 'width clamps down to maxWidth')
  assert.equal((await configFor({ width: 10, minWidth: 150, maxWidth: 300 })).width, 150, 'width clamps up to minWidth')

  // ...and a reversed min/max pair is corrected instead of producing a broken range.
  const reversed = await configFor({ width: 220, minWidth: 500, maxWidth: 200 })
  assert.equal(reversed.minWidth, 500)
  assert.equal(reversed.maxWidth, 500, 'maxWidth is raised to minWidth when written backwards')
  assert.ok(
    reversed.width >= reversed.minWidth && reversed.width <= reversed.maxWidth,
    'width, minWidth and maxWidth are always mutually consistent',
  )
  console.log('config size bounds: OK (width always inside [minWidth, maxWidth])')

  // split knobs survive the round trip and are clamped sensibly
  const splitOff = await configFor({ split: false, splitAutoDetect: false })
  assert.equal(splitOff.split, false)
  assert.equal(splitOff.splitAutoDetect, false)
  assert.equal((await configFor({ splitRatio: 5 })).splitRatio, 0.95, 'splitRatio clamps into 0.05..0.95')
  assert.equal((await configFor({ splitRatio: -1 })).splitRatio, 0.05, 'splitRatio clamps into 0.05..0.95')
  assert.equal((await configFor({ splitRatio: '0.42' })).splitRatio, 0.42, 'string splitRatio coerced')
  console.log('config split knobs: OK (booleans + clamped ratio)')

  // animation knobs: both clips on by default, each switchable, periods clamped
  const animDefaults = await configFor({})
  assert.equal(animDefaults.idle, true, 'the standby clip defaults to on')
  assert.equal(animDefaults.idleEvery, 5000, 'the standby clip defaults to every 5s')
  assert.equal(animDefaults.idleScale, 1, 'idleScale defaults to 1')
  assert.equal(animDefaults.act, true, 'the action clip defaults to on')
  assert.equal(animDefaults.actEvery, 15000, 'the action clip defaults to every 15s')
  assert.equal(animDefaults.actScale, 1, 'actScale defaults to 1')

  assert.equal((await configFor({ idle: false })).idle, false)
  assert.equal((await configFor({ act: false })).act, false)
  assert.equal((await configFor({ idleScale: '1.25' })).idleScale, 1.25, 'string idleScale coerced')
  assert.equal((await configFor({ idleScale: 99 })).idleScale, 10, 'idleScale clamps to 10')
  assert.equal((await configFor({ idleScale: 0 })).idleScale, 0.1, 'idleScale clamps to 0.1')
  assert.equal((await configFor({ actScale: 3 })).actScale, 3, 'actScale round-trips')
  assert.equal((await configFor({ actScale: 99 })).actScale, 10, 'actScale clamps to 10')
  assert.equal((await configFor({ idleEvery: '8000' })).idleEvery, 8000, 'string period coerced')
  assert.equal((await configFor({ idleEvery: 10 })).idleEvery, 1000, 'a period below 1s clamps up')
  assert.equal((await configFor({ actEvery: 99999999 })).actEvery, 3600000, 'a huge period clamps down')
  console.log('config animation knobs: OK (defaults 5s/15s, switchable, clamped)')

  // The old 0.4.0 knobs are gone; passing them must not resurrect anything.
  const legacy = await configFor({ idleAutoplay: false, idleLoop: false })
  assert.ok(!('idleAutoplay' in legacy), 'the replaced idleAutoplay knob is dropped')
  assert.ok(!('idleLoop' in legacy), 'the replaced idleLoop knob is dropped')
  console.log('config legacy knobs: OK (idleAutoplay/idleLoop removed)')

  // 0.7.0 send-message hook knobs
  const sendDefaults = await configFor({})
  assert.equal(sendDefaults.sendHook, true, 'the send hook defaults to on')
  assert.equal(sendDefaults.sendSelector, '', 'the selector escape hatch defaults to empty (semantic detect)')
  assert.equal(sendDefaults.sendGirlScale, 1, 'sendGirlScale defaults to 1')
  assert.equal(sendDefaults.sendLidScale, 1, 'sendLidScale defaults to 1')
  assert.equal(sendDefaults.sendLabel, '\u80a5\u9c7c\u5df2\u7ecf\u716e\u996d\uff1a', 'the label is the requested Chinese text')
  assert.equal(sendDefaults.sendLidAudio, true, 'the lid clip is unmuted by default')
  assert.equal((await configFor({ sendHook: false })).sendHook, false, 'the send hook can be turned off')
  assert.equal(
    (await configFor({ sendGirlScale: 0 })).sendGirlScale,
    0.1,
    'sendGirlScale clamps up from below',
  )
  assert.equal((await configFor({ sendLidScale: 99 })).sendLidScale, 10, 'sendLidScale clamps down from above')
  assert.equal((await configFor({ sendSelector: '#send' })).sendSelector, '#send', 'a selector passes through')
  assert.equal(
    (await configFor({ sendSelector: 42 })).sendSelector,
    '',
    'a non-string selector falls back to semantic detection',
  )
  assert.equal(
    (await configFor({ sendLabel: 'x'.repeat(80) })).sendLabel,
    sendDefaults.sendLabel,
    'an overlong label falls back to the default',
  )
  assert.equal(
    (await configFor({ sendLabelColor: 'expression(alert(1))' })).sendLabelColor,
    sendDefaults.sendLabelColor,
    'a hostile label color is rejected',
  )
  assert.equal(
    (await configFor({ sendLabelColor: 'red;background:url(x)' })).sendLabelColor,
    sendDefaults.sendLabelColor,
    'a color that tries to smuggle another declaration is rejected',
  )
  assert.equal(
    (await configFor({ sendLabelColor: '#22d3ee' })).sendLabelColor,
    '#22d3ee',
    'a plain hex color round-trips',
  )
  assert.equal(
    (await configFor({ sendLabelColor: 'rgba(59,130,246,.9)' })).sendLabelColor,
    'rgba(59,130,246,.9)',
    'an rgba color round-trips',
  )
  console.log('config send-hook knobs: OK (defaults, clamps, selector + label guards)')

  // 0.8.0 click-squish knob: on by default, explicitly switchable off, and a
  // non-boolean is treated as "not false" (same convention as every other flag).
  const squishDefaults = await configFor({})
  assert.equal(squishDefaults.clickSquish, true, 'the click squish defaults to on')
  assert.equal((await configFor({ clickSquish: false })).clickSquish, false, 'it can be turned off')
  assert.equal(
    (await configFor({ clickSquish: 'no' })).clickSquish,
    true,
    'only an explicit false disables it',
  )
  console.log('config click-squish knob: OK (default on, switchable off)')

  // 0.8.0 press-sound knobs: on by default, volume and easter-egg chance clamped.
  const pressDefaults = await configFor({})
  assert.equal(pressDefaults.pressSound, true, 'the press sound defaults to on')
  assert.equal(pressDefaults.pressVolume, 0.6, 'pressVolume defaults to 0.6')
  assert.equal(pressDefaults.pipeChance, 0.07, 'the "pipe" easter egg defaults to the asked-for 7%')
  assert.equal((await configFor({ pressSound: false })).pressSound, false, 'the press sound can be muted')
  assert.equal((await configFor({ pressVolume: 5 })).pressVolume, 1, 'pressVolume clamps down to 1')
  assert.equal((await configFor({ pressVolume: -1 })).pressVolume, 0, 'pressVolume clamps up to 0')
  assert.equal((await configFor({ pipeChance: 2 })).pipeChance, 1, 'pipeChance clamps down to 1')
  assert.equal((await configFor({ pipeChance: -0.5 })).pipeChance, 0, 'pipeChance clamps up to 0')
  assert.equal((await configFor({ pipeChance: 'abc' })).pipeChance, 0.07, 'a junk chance falls back')
  assert.equal(pressDefaults.pipeVolume, 0.5, 'the pipe plays at half volume by default (as asked)')
  assert.equal((await configFor({ pipeVolume: 3 })).pipeVolume, 1, 'pipeVolume clamps down to 1')
  assert.equal((await configFor({ pipeVolume: -2 })).pipeVolume, 0, 'pipeVolume clamps up to 0')
  assert.equal(pressDefaults.potChance, 0.1, 'the basin event defaults to 10%')
  assert.equal((await configFor({ potChance: 5 })).potChance, 1, 'potChance clamps down to 1')
  assert.equal((await configFor({ potChance: 0 })).potChance, 0, 'potChance:0 is the off switch')
  console.log('config press-sound knobs: OK (default on, volume + chance clamped)')

  seen.length = 0
  plugin.apply(makeCtx(), { enabled: false })
  assert.equal(seen.length, 0, 'disabled plugin must register no routes')
  console.log('config enabled:false: OK (no routes)')
}

for (const dispose of disposers) dispose()

console.log('\nAll host-half checks passed.')

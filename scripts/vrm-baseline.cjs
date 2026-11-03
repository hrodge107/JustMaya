// Baseline capture for the stabilize-production-vrm-avatar revision.
// Run against production preview built with VITE_MASCOT_MODEL=cyber.
// VRM_SOFTWARE=1 forces SwiftShader; VRM_NO_PARALLEL=1 tests its absence.
// VRM_HOME_ONLY=1 skips backend-dependent paths.
//   node scripts/vrm-baseline.cjs
// Records production screenshots, frame-time/draw-call/React-commit/resource
// measurements, and the run metadata (browser, rendering mode, viewport,
// model, fixture coverage) needed for before/after comparisons.
const { chromium } = (() => { try { return require('playwright') } catch { return require('playwright-core') } })()
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const base = process.env.VRM_VERIFY_URL || 'http://127.0.0.1:5198'
const out = process.env.VRM_BASELINE_OUT || path.join(os.tmpdir(), 'mita-vrm-baseline')
const RUNS = Number(process.env.VRM_RUNS || 3)
fs.mkdirSync(out, { recursive: true })

const record = { base, startedAt: new Date().toISOString(), screenshots: {}, runs: [], loading: [], mounts: null, meta: {} }

async function realSession() {
  const docs = await fetch(`${base}/api/documents`).then(r => r.json())
  const doc = docs.documents?.[0]
  assert.ok(doc, 'real backend must serve at least one document')
  const roadmap = await fetch(`${base}/api/documents/${doc.document_id}/curriculum`).then(r => r.json())
  const outline = roadmap.episodes?.find(e => e.status === 'selected') ?? roadmap.episodes?.[0]
  assert.ok(outline, 'roadmap must list an episode')
  const session = await fetch(`${base}/api/episodes/${outline.episode_id}/sessions`, { method: 'POST' }).then(r => r.json())
  assert.ok(session.sessionId, 'session creation failed')
  return session.sessionId
}

function instrument(context) {
  return context.addInitScript(noParallel => {
    window.__loadingTasks = []
    const watchFirstFrame = () => {
      if (window.__mitaVrm?.frames > 0) window.__firstAvatarFrame = performance.now()
      else requestAnimationFrame(watchFirstFrame)
    }
    requestAnimationFrame(watchFirstFrame)
    new PerformanceObserver(list => {
      window.__loadingTasks.push(...list.getEntries().map(e => ({ start: e.startTime, duration: e.duration })))
    }).observe({ type: 'longtask', buffered: true })
    window.__glContexts = 0
    window.__glDeletes = 0
    const getCtx = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
      const ctx = getCtx.call(this, kind, ...args)
      if (ctx && (kind === 'webgl' || kind === 'webgl2')) window.__glContexts++
      return ctx
    }
    for (const Context of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
      if (!Context) continue
      if (noParallel) {
        const extension = Context.prototype.getExtension
        Context.prototype.getExtension = function (name) { return name === 'KHR_parallel_shader_compile' ? null : extension.call(this, name) }
      }
      const remove = Context.prototype.deleteProgram
      Context.prototype.deleteProgram = function (...a) { window.__glDeletes++; return remove.apply(this, a) }
    }
    window.__commits = 0
    const hook = {
      renderers: new Map(), supportsFiber: true,
      inject(i) { const id = this.renderers.size + 1; this.renderers.set(id, i); return id },
      onCommitFiberRoot() { window.__commits++ },
      checkDCE() {},
    }
    Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', {
      value: new Proxy(hook, { get: (t, k) => (k in t ? t[k] : () => {}) }),
    })
  }, process.env.VRM_NO_PARALLEL === '1')
}

async function waitReady(page) {
  await page.locator('.vrm-mascot:visible canvas').waitFor({ timeout: 60000 })
  await page.waitForFunction(() => window.__mitaVrm?.ready && window.__mitaVrm.frames > 10, null, { timeout: 60000 })
}

const debug = page => page.evaluate(() => ({ ...window.__mitaVrm }))

async function measureRun(page, seconds) {
  // rAF deltas approximate the production loop's own cadence; the app's tick
  // runs in the same queue. Commits counted via the injected devtools hook.
  const result = await page.evaluate(async secs => {
    const deltas = []
    const start = performance.now()
    let last = start
    await new Promise(done => {
      const loop = t => { deltas.push(t - last); last = t; if (t - start < secs * 1000) requestAnimationFrame(loop); else done() }
      requestAnimationFrame(loop)
    })
    window.__commits = 0
    const moveStart = performance.now()
    for (let i = 0; i < 120; i++) {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 200 + i * 8, clientY: 200 + (i % 30) * 10, bubbles: true }))
    }
    await new Promise(r => requestAnimationFrame(r))
    return { deltas, commits: window.__commits, moveMs: performance.now() - moveStart, debug: { ...window.__mitaVrm } }
  }, seconds)
  const sorted = result.deltas.slice(1).sort((a, b) => a - b)
  const pick = q => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
  return {
    frames: sorted.length,
    medianMs: +pick(.5).toFixed(2),
    p95Ms: +pick(.95).toFixed(2),
    commitsDuringPointerSweep: result.commits,
    draws: result.debug.draws,
    triangles: result.debug.triangles,
    geometries: result.debug.geometries,
    textures: result.debug.textures,
    programs: result.debug.programs,
    pixelRatio: result.debug.pixelRatio,
    bufferSize: [result.debug.bufferWidth, result.debug.bufferHeight],
    softwareRenderer: result.debug.softwareRenderer,
  }
}

async function main() {
  const browser = await chromium.launch({ channel: process.env.VRM_VERIFY_BROWSER || 'msedge', headless: true, args: process.env.VRM_SOFTWARE === '1' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [] })
  try {
    const probe = await browser.newPage()
    record.meta.glRenderer = await probe.evaluate(() => {
      const c = document.createElement('canvas')
      const gl = c.getContext('webgl2') || c.getContext('webgl')
      const ext = gl?.getExtension('WEBGL_debug_renderer_info')
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unavailable'
    })
    record.meta.browser = `chromium ${browser.version()}`
    record.meta.softwareRequested = process.env.VRM_SOFTWARE === '1'
    record.meta.noParallelRequested = process.env.VRM_NO_PARALLEL === '1'
    record.meta.emptyPageCadence = await measureRun(probe, 2)
    record.meta.model = 'cyber (vroid_models/cyber.vrm, VRM 0.0, VRoid) + cyber-idle.fbx'
    record.meta.devicePixelRatio = await probe.evaluate(() => window.devicePixelRatio)
    record.meta.fixtures = {
      vrm1: fs.existsSync('C:/Users/User/AppData/Local/Temp/justmaya-vrm-test.vrm') ? 'C:/Users/User/AppData/Local/Temp/justmaya-vrm-test.vrm' : 'MISSING',
      vrm0: fs.existsSync('C:/Users/User/AppData/Local/Temp/justmaya-vrm0-test.vrm') ? 'C:/Users/User/AppData/Local/Temp/justmaya-vrm0-test.vrm' : 'MISSING',
      fbx: fs.existsSync('C:/Users/User/AppData/Local/Temp/justmaya-idle-test.fbx') ? 'C:/Users/User/AppData/Local/Temp/justmaya-idle-test.fbx' : 'MISSING',
    }
    await probe.close()

    const sessionId = process.env.VRM_HOME_ONLY === '1' ? null : await realSession()
    record.meta.session = sessionId

    for (const vp of [{ name: 'desktop', width: 1920, height: 1080, dpr: 1 }, { name: 'mobile', width: 406, height: 738, dpr: 2 }]) {
      for (let i = 0; i < RUNS; i++) {
        const boot = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.dpr, reducedMotion: 'no-preference' })
        try {
          await instrument(boot)
          const page = await boot.newPage()
          for (const cache of ['cold', 'cached']) {
            await page.goto(base)
            await waitReady(page)
            await page.waitForTimeout(100)
            record.loading.push(await page.evaluate(({ viewport, run, cache }) => {
              const firstFrameMs = window.__mitaVrm.firstFrameAt || window.__firstAvatarFrame
              const tasks = window.__loadingTasks.filter(t => t.start <= firstFrameMs)
              return { viewport, run, cache, firstFrameMs, longestTaskMs: Math.max(0, ...tasks.map(t => t.duration)), tasks, stages: { modelParsedAt: window.__mitaVrm.modelParsedAt, preparedAt: window.__mitaVrm.preparedAt, firstFrameAt: window.__mitaVrm.firstFrameAt }, parallelCompile: window.__mitaVrm.parallelCompile, resources: performance.getEntriesByType('resource').filter(r => /\.vrm|\.fbx/.test(r.name)).map(r => ({ url: r.name, duration: r.duration, transferSize: r.transferSize })) }
            }, { viewport: vp.name, run: i + 1, cache }))
          }
        } finally { await boot.close() }
      }
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.dpr, reducedMotion: 'no-preference' })
      await instrument(context)
      const page = await context.newPage()
      page.on('pageerror', e => (record.errors ??= []).push(`${vp.name}: ${e.message}`))

      await page.goto(`${base}/`)
      await waitReady(page)
      await page.waitForTimeout(1800)
      const homeShot = path.join(out, `home-${vp.name}.png`)
      await page.screenshot({ path: homeShot })
      record.screenshots[`home-${vp.name}`] = homeShot
      record[`homeDebug-${vp.name}`] = await debug(page)

      if (sessionId) {
        await page.goto(`${base}/?session=${sessionId}`)
        await waitReady(page)
        await page.waitForTimeout(1800)
        const epShot = path.join(out, `episode-${vp.name}.png`)
        await page.screenshot({ path: epShot })
        record.screenshots[`episode-${vp.name}`] = epShot
        record[`episodeDebug-${vp.name}`] = await debug(page)
      }

      for (let i = 0; i < RUNS; i++) record.runs.push({ viewport: vp.name, ...await measureRun(page, 4) })

      // Repeated Home<->Episode mounts must not grow GPU resources.
      if (sessionId && vp.name === 'desktop' && process.env.VRM_SKIP_MOUNTS !== '1') {
        const before = await page.evaluate(() => ({ ctx: window.__glContexts, del: window.__glDeletes }))
        const memory = []
        const transitions = []
        for (let i = 0; i < 4; i++) {
          for (const [surface, url] of [['home', '/'], ['episode', `/?session=${sessionId}`]]) {
            await page.evaluate(url => {
              window.__previousVrm = window.__mitaVrm
              window.__navigationStart = performance.now()
              history.pushState({}, '', url); dispatchEvent(new PopStateEvent('popstate'))
            }, url)
            await page.waitForFunction(() => window.__mitaVrm !== window.__previousVrm && window.__mitaVrm?.ready, null, { timeout: 60000 })
            await waitReady(page)
            transitions.push(await page.evaluate(surface => ({ surface, firstFrameMs: window.__mitaVrm.firstFrameAt - window.__navigationStart, longestTaskMs: Math.max(0, ...window.__loadingTasks.filter(t => t.start >= window.__navigationStart && t.start <= window.__mitaVrm.firstFrameAt).map(t => t.duration)) }), surface))
          }
          memory.push(await debug(page))
        }
        const after = await page.evaluate(() => ({ ctx: window.__glContexts, del: window.__glDeletes }))
        record.mounts = { cycles: 4, contextsCreated: after.ctx - before.ctx, programsDeleted: after.del - before.del, memory, transitions }
      }
      await context.close()
    }

    fs.writeFileSync(path.join(out, 'baseline.json'), JSON.stringify(record, null, 2))
    console.log(JSON.stringify({ meta: record.meta, loading: record.loading, runs: record.runs, mounts: record.mounts && { contextsCreated: record.mounts.contextsCreated, programsDeleted: record.mounts.programsDeleted, geometries: record.mounts.memory.map(m => m.geometries), programs: record.mounts.memory.map(m => m.programs) }, screenshots: record.screenshots, errors: record.errors ?? [] }, null, 2))
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })

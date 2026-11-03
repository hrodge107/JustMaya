// Text-stream audit probe (read-only measurement, no app changes).
// Counts typing-interval fires, long tasks, forced-layout reads and rAF
// cadence during typing vs holding windows on Home and the player.
//   node scripts/stream-audit.cjs
// Env: AUDIT_URL (default http://localhost:5174), VRM_SOFTWARE=1, AUDIT_BROWSER
const { chromium } = (() => { try { return require('playwright') } catch { return require('C:/nvm4w/nodejs/node_modules/omniroute/node_modules/playwright') } })()

const base = process.env.AUDIT_URL || 'http://localhost:5174'

const instrument = context => context.addInitScript(() => {
  window.__longtasks = []
  new PerformanceObserver(list => { for (const e of list.getEntries()) window.__longtasks.push({ start: e.startTime, duration: e.duration }) }).observe({ type: 'longtask', buffered: true })
  window.__intervalFires = {}
  const si = window.setInterval
  window.setInterval = function (fn, delay, ...a) {
    return si.call(this, function (...b) {
      window.__intervalFires[delay] = (window.__intervalFires[delay] || 0) + 1
      return fn.apply(this, b)
    }, delay, ...a)
  }
  window.__rectCalls = 0
  window.__rectMs = 0
  const rect = Element.prototype.getBoundingClientRect
  Element.prototype.getBoundingClientRect = function (...a) {
    const t = performance.now(); const r = rect.apply(this, a)
    window.__rectCalls++; window.__rectMs += performance.now() - t
    return r
  }
  window.__selCalls = 0
  const qs = Element.prototype.querySelector
  Element.prototype.querySelector = function (...a) { window.__selCalls++; return qs.apply(this, a) }
})

async function installTextWatch(page) {
  await page.evaluate(() => {
    window.__charWrites = 0
    window.__writesByZone = {}
    const zone = el => el?.closest?.('.dlg-text') ? 'home' : el?.closest?.('.vn-text') ? 'player' : 'other'
    new MutationObserver(muts => {
      for (const m of muts) {
        const el = m.target.nodeType === 1 ? m.target : m.target.parentElement
        const z = zone(el)
        if (z !== 'other') { window.__charWrites++; window.__writesByZone[z] = (window.__writesByZone[z] || 0) + 1 }
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true })
  })
}

async function sample(page, secs, label) {
  const r = await page.evaluate(async ({ secs, label }) => {
    const deltas = []
    const start = performance.now(); let last = start
    const lt0 = window.__longtasks.length, f0 = window.__mitaVrm?.frames ?? 0
    const rc0 = window.__rectCalls, rm0 = window.__rectMs, s0 = window.__selCalls, w0 = window.__charWrites ?? 0
    const iv0 = { ...window.__intervalFires }
    await new Promise(done => {
      const loop = t => { deltas.push(t - last); last = t; if (t - start < secs * 1000) requestAnimationFrame(loop); else done() }
      requestAnimationFrame(loop)
    })
    const iv = {}
    for (const [k, v] of Object.entries(window.__intervalFires)) iv[k] = v - (iv0[k] ?? 0)
    const tasks = window.__longtasks.slice(lt0)
    const sorted = deltas.slice(1).sort((a, b) => a - b)
    const pick = q => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : 0
    return {
      label, secs,
      intervalFires: iv,
      charWrites: (window.__charWrites ?? 0) - w0,
      rectCalls: window.__rectCalls - rc0,
      rectMs: +(window.__rectMs - rm0).toFixed(1),
      selCalls: window.__selCalls - s0,
      vrmFrames: (window.__mitaVrm?.frames ?? 0) - f0,
      longtaskCount: tasks.length,
      longtaskMs: +tasks.reduce((s, e) => s + e.duration, 0).toFixed(1),
      longtaskMax: +(tasks.reduce((m, e) => Math.max(m, e.duration), 0)).toFixed(1),
      frames: sorted.length,
      frameMedianMs: +pick(.5).toFixed(2),
      frameP95Ms: +pick(.95).toFixed(2),
      frameWorstMs: +(sorted[sorted.length - 1] ?? 0).toFixed(2),
    }
  }, { secs, label })
  console.log(JSON.stringify(r))
  return r
}

async function waitVrm(page) {
  await page.locator('.vrm-mascot canvas').waitFor({ timeout: 90000 })
  await page.waitForFunction(() => window.__mitaVrm?.ready && window.__mitaVrm.frames > 10, null, { timeout: 90000 })
}

async function homePhase(page) {
  return page.evaluate(async () => {
    const el = () => document.querySelector('.dlg-text span[aria-hidden]')
    const a = el()?.textContent?.length ?? 0
    await new Promise(r => setTimeout(r, 400))
    const b = el()?.textContent?.length ?? 0
    return b > a ? 'typing' : 'holding'
  })
}

async function main() {
  const browser = await chromium.launch({
    channel: process.env.AUDIT_BROWSER || 'msedge', headless: true,
    args: process.env.VRM_SOFTWARE === '1' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [],
  })
  const out = { base, software: process.env.VRM_SOFTWARE === '1' }
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    await instrument(ctx)
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', e => errors.push(String(e)))
    await page.goto(base, { waitUntil: 'domcontentloaded' })
    await installTextWatch(page)
    await waitVrm(page)
    out.softwareRenderer = await page.evaluate(() => window.__mitaVrm?.softwareRenderer)
    for (let i = 0; i < 80; i++) { if (await homePhase(page) === 'typing') break; await page.waitForTimeout(250) }
    out.homeTyping = await sample(page, 3, 'home:typing')
    for (let i = 0; i < 80; i++) { if (await homePhase(page) === 'holding') break; await page.waitForTimeout(250) }
    out.homeHolding = await sample(page, 3, 'home:holding')
    out.homeErrors = errors
    await ctx.close()

    const docs = await fetch(`${base}/api/documents`).then(r => r.json())
    const doc = docs.documents?.[0]
    if (doc) {
      const roadmap = await fetch(`${base}/api/documents/${doc.document_id}/curriculum`).then(r => r.json())
      const outline = roadmap.episodes?.find(e => e.status === 'selected') ?? roadmap.episodes?.[0]
      if (outline) {
        const session = await fetch(`${base}/api/episodes/${outline.episode_id}/sessions`, { method: 'POST' }).then(r => r.json())
        const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } })
        await instrument(ctx2)
        const p2 = await ctx2.newPage()
        p2.on('pageerror', e => errors.push('player: ' + e))
        await p2.goto(`${base}/?session=${session.sessionId}`, { waitUntil: 'domcontentloaded' })
        await installTextWatch(p2)
        await waitVrm(p2)
        await p2.locator('.vn-text').waitFor({ timeout: 30000 })
        await p2.waitForTimeout(300)
        // sample a fresh reveal: click to finish current line, click again to advance
        for (let i = 0; i < 60; i++) {
          const revealing = await p2.evaluate(() => !!document.querySelector('.vn-text-rest')?.textContent?.length)
          if (!revealing) break
          await p2.waitForTimeout(250)
        }
        out.playerHolding = await sample(p2, 3, 'player:holding')
        await p2.locator('.vn-dialogue-target').click().catch(() => {})
        await p2.waitForTimeout(200)
        out.playerReveal = await sample(p2, 3, 'player:reveal')
        await p2.locator('.vn-dialogue-target').click().catch(() => {})
        await p2.locator('.vn-dialogue-target').click().catch(() => {})
        await p2.waitForTimeout(200)
        out.playerReveal2 = await sample(p2, 3, 'player:reveal2')
        await ctx2.close()
      } else out.playerSkipped = 'no episode outline'
    } else out.playerSkipped = 'no documents'
  } finally { await browser.close() }
  console.log('=== RESULT ===')
  console.log(JSON.stringify(out, null, 2))
}

main().catch(e => { console.error(e); process.exit(1) })

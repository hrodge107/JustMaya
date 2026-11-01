// Viewport-matrix framing verification for the production VRM stage.
// Run against a Vite dev server serving the real backend + sample model:
//   VITE_MASCOT_MODEL=sample npm run dev -- --host 127.0.0.1 --port 5198
//   node scripts/vrm-framing.cjs
//
// Covers task 3.3: Home + Episode screenshots at the reference sizes,
// 390x844, 768x1024, 1024x768, 844x390, and 200% text; checkpoint choices
// and a long-dialogue state; no horizontal overflow; controls reachable
// through the pointer-transparent avatar layer.
const { chromium } = (() => { try { return require('playwright') } catch { return require('playwright-core') } })()
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const base = process.env.VRM_VERIFY_URL || 'http://127.0.0.1:5198'
const out = path.join(os.tmpdir(), 'mita-vrm-framing')
fs.mkdirSync(out, { recursive: true })
const results = []
const errors = []

function check(name, fn) {
  try { fn(); results.push(`PASS ${name}`) }
  catch (e) { results.push(`FAIL ${name}: ${e.message}`) }
}

const VIEWPORTS = [
  // Match desktop-framing.png (8% crown) and mobile-framing.png (22% crown).
  //
  // Keep the reference viewports exact: these are composition inputs, not
  // scaled approximations of another aspect ratio.
  { name: 'ref-desktop', width: 1920, height: 1080 },
  { name: 'ref-mobile', width: 406, height: 738 },
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'tablet-landscape', width: 1024, height: 768 },
  { name: 'phone-landscape', width: 844, height: 390 },
]

async function realSession() {
  const docs = await fetch(`${base}/api/documents`).then(r => r.json())
  const doc = docs.documents?.[0]
  assert.ok(doc, 'real backend must serve at least one document')
  const roadmap = await fetch(`${base}/api/documents/${doc.document_id}/curriculum`).then(r => r.json())
  const outline = roadmap.episodes?.find(e => e.status === 'selected') ?? roadmap.episodes?.[0]
  const session = await fetch(`${base}/api/episodes/${outline.episode_id}/sessions`, { method: 'POST' }).then(r => r.json())
  return session.sessionId
}

async function waitReady(page) {
  await page.locator('.vrm-mascot:visible canvas').waitFor({ timeout: 60000 })
  await page.waitForFunction(() => window.__mitaVrm?.ready && window.__mitaVrm.frames > 8, null, { timeout: 60000 })
  await page.waitForTimeout(1200)
}

// The avatar layer must never box out interactive chrome. A trial click
// auto-scrolls the control into view (proving scroll reachability at zoom)
// then verifies it — not the layer above it — receives pointer events.
async function controlsReachable(page, tag) {
  const blocked = []
  for (const sel of ['.vn-dialogue-target', '.vn-raise', '.vn-menu-trigger']) {
    const el = page.locator(sel)
    if (!(await el.count()) || !(await el.isVisible().catch(() => false))) continue
    try { await el.click({ trial: true, timeout: 10000 }) }
    catch (e) { blocked.push(`${sel}: ${e.message.split('\n')[0]}`) }
  }
  check(`${tag}: chrome controls clickable through avatar layer`, () => assert.deepEqual(blocked, [], `blocked: ${blocked.join(', ')}`))
}

async function noOverflow(page, tag) {
  const width = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, inner: innerWidth, body: document.body.scrollWidth }))
  check(`${tag}: no horizontal overflow`, () => assert.ok(Math.max(width.doc, width.body) <= width.inner + 1, `doc=${width.doc} body=${width.body} inner=${width.inner}`))
}

// Reference composition landmarks: the subject stays centered, the head
// sits in the upper half of the stage, and the face clears the top edge
// of the dialogue strip below it (upper-body crop reading behind it).
async function faceLandmarks(page, tag) {
  const m = await page.evaluate(() => {
    const d = window.__mitaVrm
    const dlg = document.querySelector('.vn-dialogue, .vn-ask-strip, .home-dialogue, [class*=dialogue]')
    const canvas = document.querySelector('.vrm-viewport')?.getBoundingClientRect()
    const r = dlg?.getBoundingClientRect()
    const project = p => ({ x: canvas.left + (p[0] + 1) * canvas.width / 2, y: canvas.top + (1 - p[1]) * canvas.height / 2 })
    return { head: project(d.headNdc), crown: project(d.crownNdc), dialogTop: r?.top ?? null,
      pixelRatio: d.pixelRatio, bufferWidth: d.bufferWidth, bufferHeight: d.bufferHeight, softwareRenderer: d.softwareRenderer }
  })
  const { width, height, dpr } = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio }))
  const crownY = m.crown.y / height
  const headX = m.head.x / width
  const headY = m.head.y / height
  const targetHairY = tag.startsWith('ref-desktop') ? .08 : tag.startsWith('ref-mobile') ? .22 : null
  // The top-center bounds probe projects ~4.3% above the visible hair in
  // these references because the actual crown sits farther from the camera.
  const targetCrownY = targetHairY === null ? null : targetHairY - .043
  check(`${tag}: model crown maps to reference placement (${crownY.toFixed(3)})`, () => {
    if (targetCrownY !== null) assert.ok(Math.abs(crownY - targetCrownY) <= .015, `crown proxy y=${crownY.toFixed(3)}, target=${targetCrownY}`)
    assert.ok(Math.abs(m.crown.x / width - .5) < .08, `crown x=${m.crown.x.toFixed(1)}`)
  })
  if (targetCrownY !== null) {
    const targetHeadY = targetCrownY === .08 ? .38 : .41
    check(`${tag}: face center matches reference placement (${headX.toFixed(3)}, ${headY.toFixed(3)})`, () => {
      assert.ok(Math.abs(headX - .5) < .12, `head x=${headX.toFixed(3)}`)
      assert.ok(Math.abs(headY - targetHeadY) <= .08, `head y=${headY.toFixed(3)}, target=${targetHeadY}`)
      assert.ok(headY - crownY > .14, `crown-to-face span=${(headY - crownY).toFixed(3)}`)
    })
  }
  check(`${tag}: face remains centered and in frame`, () => {
    assert.ok(Math.abs(headX - .5) < .12 && headY > .12 && headY < .62, `head=(${headX.toFixed(3)}, ${headY.toFixed(3)})`)
  })
  check(`${tag}: renderer follows its pixel policy`, () => {
    if (m.softwareRenderer) assert.ok(m.bufferWidth * m.bufferHeight <= 960 * 540 + 2000,
      `software buffer=${m.bufferWidth}x${m.bufferHeight} ratio=${m.pixelRatio.toFixed(3)}`)
    else assert.ok(m.pixelRatio <= Math.min(dpr, 2) + .001, `hardware ratio=${m.pixelRatio.toFixed(3)}, device ratio=${dpr}`)
  })
  if (m.dialogTop !== null) {
    check(`${tag}: face clears the dialogue strip`, () => assert.ok(m.head.y < m.dialogTop, `head y=${m.head.y.toFixed(1)} vs dialogue top ${m.dialogTop.toFixed(1)}`))
  }
}

async function matrix(browser) {
  const sessionId = await realSession()
  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, reducedMotion: 'no-preference' })
    const page = await context.newPage()
    page.on('pageerror', e => errors.push(`${vp.name}: ${e.message}`))
    await page.goto(`${base}/`)
    await waitReady(page)
    await page.screenshot({ path: path.join(out, `${vp.name}-home.png`) })
    await noOverflow(page, `${vp.name}/home`)
    await faceLandmarks(page, `${vp.name}/home`)

    await page.goto(`${base}/?session=${sessionId}`)
    await waitReady(page)
    await page.screenshot({ path: path.join(out, `${vp.name}-episode.png`) })
    await noOverflow(page, `${vp.name}/episode`)
    await faceLandmarks(page, `${vp.name}/episode`)
    await controlsReachable(page, `${vp.name}/episode`)
    await context.close()
  }
}

// 200% text zoom keeps the composition and controls usable.
async function textZoom(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'no-preference' })
  const page = await context.newPage()
  page.on('pageerror', e => errors.push(`zoom: ${e.message}`))
  const sessionId = await realSession()
  await page.goto(`${base}/?session=${sessionId}`)
  await waitReady(page)
  await page.evaluate(() => { document.documentElement.style.zoom = '200%' })
  await page.waitForTimeout(400)
  await page.screenshot({ path: path.join(out, 'zoom200-episode.png') })
  await noOverflow(page, 'zoom200/episode')
  await controlsReachable(page, 'zoom200/episode')
  await context.close()
}

// Checkpoint choices + a long line, through the session fixture (stub APIs).
async function checkpointStates(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'no-preference' })
  const page = await context.newPage()
  page.on('pageerror', e => errors.push(`checkpoint: ${e.message}`))
  const longLine = 'Come stand beside me at the riverbank. '.repeat(6)
  const state = {
    session: { sessionId: 'fixture-session', episodeId: 'fixture-episode', mode: 'playing', sceneId: 'intro', dialogueIndex: 0, version: 1, status: 'active', updatedAt: '2026-10-28T00:00:00Z' },
  }
  const episode = {
    episodeId: 'fixture-episode', title: 'Framing fixture', status: 'ready', startSceneId: 'intro',
    scenes: [
      { sceneId: 'intro', kind: 'dialogue', nextSceneId: 'checkpoint', question: null, dialogue: [{ lineId: 'one', speaker: 'mascot', text: longLine, emotion: 'idle' }] },
      { sceneId: 'checkpoint', kind: 'checkpoint', nextSceneId: null, dialogue: [], question: { questionId: 'q', prompt: 'Which change let farming villages store surplus grain for the dry season, and why did it matter?', options: [{ optionId: 'a', label: 'Digging irrigation canals that kept fields watered through the dry months' }, { optionId: 'b', label: 'Building taller watchtowers along the river to guard the harvest' }] } },
    ], learningObjectives: [], estimatedMinutes: 1,
  }
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/advance')) {
      state.session.version++
      if (state.session.sceneId === 'intro') { state.session.sceneId = 'checkpoint'; state.session.mode = 'checkpoint'; state.session.dialogueIndex = 0 }
      return route.fulfill({ json: state.session })
    }
    if (url.pathname.includes('/sessions/')) return route.fulfill({ json: state.session })
    if (url.pathname === '/api/documents') return route.fulfill({ json: { documents: [] } })
    return route.fulfill({ json: episode })
  })
  await page.goto(`${base}/?session=fixture-session`)
  await waitReady(page)
  await page.screenshot({ path: path.join(out, 'checkpoint-long-dialogue.png') })
  await noOverflow(page, 'mobile/long-dialogue')
  await page.locator('.vn-dialogue').click()
  await page.locator('.vn-dialogue').click()
  await page.locator('.vn-choice').first().waitFor({ timeout: 15000 })
  await page.screenshot({ path: path.join(out, 'checkpoint-choices.png') })
  await noOverflow(page, 'mobile/checkpoint')
  const reach = await page.evaluate(() => {
    const el = document.querySelector('.vn-choice')
    const r = el.getBoundingClientRect()
    return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
  })
  check('mobile/checkpoint: choice buttons clickable through avatar layer', () => assert.ok(reach))
  await context.close()
}

async function main() {
  const browser = await chromium.launch({ channel: process.env.VRM_VERIFY_BROWSER || 'msedge', headless: true, args: process.env.VRM_SOFTWARE_GL === '0' ? [] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
  try {
    await matrix(browser)
    await textZoom(browser)
    await checkpointStates(browser)
  } finally { await browser.close() }
  for (const line of results) console.log(line)
  if (errors.length) console.log('page errors:', errors)
  const failed = results.filter(r => r.startsWith('FAIL'))
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed, ${errors.length} page errors -> ${out}`)
  if (failed.length || errors.length) process.exitCode = 1
}
main().catch(error => { console.error(error); process.exitCode = 1 })

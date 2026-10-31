// Run against Vite with Playwright available through Node's module search path.
// All API responses are isolated fixtures; no backend or model requests occur.
const { chromium } = (() => { try { return require('playwright') } catch { return require('playwright-core') } })()
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const base = process.env.PLAYER_VERIFY_URL || 'http://127.0.0.1:5173'
const output = process.env.PLAYER_VERIFY_OUTPUT || path.join(os.tmpdir(), 'meet-mita-motion-toggle')
fs.mkdirSync(output, { recursive: true })
const evidence = []
const errors = []
const episode = {
  episodeId: 'fixture-episode', title: 'Verification fixture: motion', status: 'ready', startSceneId: 'intro',
  scenes: [
    { sceneId: 'intro', kind: 'dialogue', nextSceneId: null, question: null, dialogue: [
      { lineId: 'one', speaker: 'mascot', text: 'Rivers shaped the first cities. Let us follow how people learned to work together.', emotion: 'talking' },
    ] },
  ],
  learningObjectives: [], estimatedMinutes: 1,
}
const session = { sessionId: 'fixture-session', episodeId: episode.episodeId, mode: 'playing', sceneId: 'intro', dialogueIndex: 0, version: 1, status: 'active', updatedAt: '2026-10-30T00:00:00Z' }

async function fixture(browser, reducedMotion) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('Failed to load resource')) errors.push(message.text()) })
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url())
    if (url.pathname.includes('/sessions/')) return route.fulfill({ json: session })
    if (url.pathname.endsWith(`/episodes/${episode.episodeId}`)) return route.fulfill({ json: episode })
    return route.fulfill({ status: 404, json: { error: { message: 'Fixture route miss.' } } })
  })
  await page.goto(`${base}/?session=fixture-session`)
  await page.locator('.vn-frame').waitFor()
  return { context, page }
}

const dataMotion = page => page.evaluate(() => document.documentElement.dataset.motion)
const stored = page => page.evaluate(() => localStorage.getItem('meet-mita:motion'))
const rest = page => page.locator('.vn-text-rest').textContent()

async function openMenu(page) {
  await page.getByRole('button', { name: 'Menu', exact: true }).click()
  const toggle = page.getByRole('switch', { name: 'Reduce motion' })
  await toggle.waitFor()
  return toggle
}

async function main() {
  const browser = await chromium.launch({ channel: process.env.PLAYER_VERIFY_BROWSER || 'msedge', headless: true })
  try {
    // Device asks for reduced motion: the switch follows it and typing is skipped.
    const reduced = await fixture(browser, 'reduce')
    assert.equal(await dataMotion(reduced.page), 'reduce')
    assert.equal(await rest(reduced.page), '', 'Device-reduced session must skip the typewriter')
    let toggle = await openMenu(reduced.page)
    assert.equal(await toggle.getAttribute('aria-checked'), 'true')
    assert.equal(await reduced.page.getByRole('button', { name: 'Use device setting' }).count(), 0, 'Reset only appears once a value is forced')
    // Forcing motion on overrides the device setting: typing begins.
    await toggle.click()
    assert.equal(await toggle.getAttribute('aria-checked'), 'false')
    assert.equal(await dataMotion(reduced.page), 'full')
    assert.equal(await stored(reduced.page), 'full')
    await reduced.page.keyboard.press('Escape')
    assert.ok(await rest(reduced.page), 'Forced-full session must run the typewriter')
    // The forced value survives reload.
    await reduced.page.reload()
    await reduced.page.locator('.vn-frame').waitFor()
    assert.equal(await dataMotion(reduced.page), 'full')
    toggle = await openMenu(reduced.page)
    assert.equal(await toggle.getAttribute('aria-checked'), 'false')
    // Resetting returns control to the device setting and clears storage.
    const reset = reduced.page.getByRole('button', { name: 'Use device setting' })
    assert.equal(await reset.count(), 1)
    await reset.click()
    assert.equal(await toggle.getAttribute('aria-checked'), 'true')
    assert.equal(await dataMotion(reduced.page), 'reduce')
    assert.equal(await stored(reduced.page), null)
    assert.equal(await reset.count(), 0, 'Reset disappears when following the device')
    await reduced.page.keyboard.press('Escape')
    assert.equal(await rest(reduced.page), '', 'Reset must restore the device-reduced skip')
    evidence.push({ check: 'device-reduce: follow, force full (types), persist across reload, reset to device', result: 'PASS' })
    await reduced.context.close()

    // Device has no preference: forcing reduce on skips typing and CSS motion.
    const full = await fixture(browser, 'no-preference')
    assert.equal(await dataMotion(full.page), 'full')
    assert.ok(await rest(full.page), 'No-preference session must run the typewriter')
    toggle = await openMenu(full.page)
    assert.equal(await toggle.getAttribute('aria-checked'), 'false')
    await toggle.click()
    assert.equal(await toggle.getAttribute('aria-checked'), 'true')
    assert.equal(await dataMotion(full.page), 'reduce')
    assert.equal(await stored(full.page), 'reduce')
    const transition = await full.page.evaluate(() => getComputedStyle(document.querySelector('.vn-menu-trigger')).transitionDuration)
    assert.equal(transition, '0s', 'Forced reduce must silence CSS transitions')
    await full.page.keyboard.press('Escape')
    await full.page.waitForFunction(() => document.querySelector('.vn-text-rest')?.textContent === '')
    assert.equal(await rest(full.page), '', 'Forced-reduce session must complete the line at once')
    evidence.push({ check: 'no-preference: follow full motion, force reduce (skips typing + CSS)', result: 'PASS' })
    await full.context.close()
  } finally {
    await browser.close()
    fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify({ evidence, errors }, null, 2))
  }
  for (const item of evidence) console.log(`${item.result} ${item.check}`)
  if (errors.length) { console.error('Page errors:', errors); process.exit(1) }
  console.log(`All motion-toggle checks passed. Evidence: ${output}`)
}

main().catch(error => { console.error(error); process.exit(1) })

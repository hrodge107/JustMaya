// Placement + icon check for the raise-hand / resume action (.vn-raise):
// it lives inside the .vn-rail action dock beside the dialogue, clear of the
// choice strips, SVG icon plus visible label (no text-glyph emojis).
// Stubbed APIs, no backend needed.
const { chromium } = (() => { try { return require('playwright') } catch { return require('playwright-core') } })()
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const base = process.env.PLAYER_VERIFY_URL || 'http://127.0.0.1:5173'
const output = process.env.PLAYER_VERIFY_OUTPUT || path.join(os.tmpdir(), 'meet-mita-raise-button')
fs.mkdirSync(output, { recursive: true })
const errors = []

const episode = {
  episodeId: 'fixture-episode', title: 'Verification fixture', status: 'ready', startSceneId: 'intro',
  scenes: [
    { sceneId: 'intro', kind: 'dialogue', nextSceneId: 'checkpoint', question: null, dialogue: [
      { lineId: 'one', speaker: 'mascot', text: 'Rivers shaped the first cities.', emotion: 'talking' },
      { lineId: 'two', speaker: 'narrator', text: 'Water made farming possible.', emotion: 'idle' },
    ] },
    { sceneId: 'checkpoint', kind: 'checkpoint', nextSceneId: null, dialogue: [], question: { questionId: 'q', prompt: 'Why did early settlements grow near rivers?', options: [{ optionId: 'a', label: 'Water and farming' }, { optionId: 'b', label: 'No shared work' }] } },
  ], learningObjectives: [], estimatedMinutes: 1,
}

async function fixture(browser, mode, viewport) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' })
  const page = await context.newPage()
  page.on('pageerror', err => errors.push(err.message))
  const session = {
    sessionId: 'fixture-session', episodeId: episode.episodeId, mode, version: 1, status: 'active',
    sceneId: mode === 'playing' ? 'intro' : 'checkpoint', dialogueIndex: 0, updatedAt: '2026-10-28T00:00:00Z',
    ...(mode === 'question' ? { resumeSnapshot: { mode: 'checkpoint', sceneId: 'checkpoint', dialogueIndex: 0, version: 1 }, interactions: [{ interactionId: 'i1', kind: 'raise_hand', userMessage: 'Why rivers?', answer: 'Verified tutor answer.', sourceRefs: [], createdAt: '2026-10-28T00:00:00Z', groundingStatus: 'supported', requestId: 'r1' }] } : {}),
  }
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url())
    if (url.pathname.includes('/sessions/')) return route.fulfill({ json: session })
    return route.fulfill({ json: episode })
  })
  await page.goto(`${base}/?session=fixture-session`)
  await page.locator('.vn-raise').waitFor()
  return { context, page }
}

function measure(page) {
  return page.evaluate(() => {
    const rect = sel => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height } }
    const raise = rect('.vn-raise'), dialogue = rect('.vn-dialogue'), rail = rect('.vn-rail')
    const strips = [...document.querySelectorAll('.vn-choice')].map(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom } })
    const overlap = (a, b) => a && b && a.x < b.right - 1 && a.right > b.x + 1 && a.y < b.bottom - 1 && a.bottom > b.y + 1
    return {
      raise, dialogue, rail, vw: innerWidth,
      inRail: !!rail && raise.y >= rail.y - 1 && raise.bottom <= rail.bottom + 1 && raise.x >= rail.x - 1 && raise.right <= rail.right + 1,
      clearDialogue: !overlap(raise, dialogue),
      stripHits: strips.filter(s => overlap(raise, s)).length,
      emojiFree: !/[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}\u{2B00}-\u{2BFF}]/u.test(document.querySelector('.vn-raise').textContent),
      iconCount: document.querySelector('.vn-raise svg') ? 1 : 0,
      tapSize: raise.width >= 44 && raise.height >= 44,
      label: document.querySelector('.vn-raise').getAttribute('aria-label'),
    }
  })
}

async function main() {
  const browser = await chromium.launch({ channel: process.env.PLAYER_VERIFY_BROWSER || 'msedge', headless: true })
  try {
    const evidence = []
    for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
      for (const mode of ['playing', 'checkpoint', 'question']) {
        const f = await fixture(browser, mode, viewport)
        const m = await measure(f.page)
        assert.ok(m.raise, `${mode}: no .vn-raise`)
        assert.ok(m.inRail, `${mode} ${m.vw}: action not inside the rail ${JSON.stringify(m)}`)
        assert.ok(m.clearDialogue, `${mode} ${m.vw}: action overlaps the dialogue ${JSON.stringify(m)}`)
        assert.equal(m.stripHits, 0, `${mode} ${m.vw}: action covers a strip ${JSON.stringify(m)}`)
        assert.ok(m.emojiFree && m.iconCount === 1, `${mode}: expected one SVG icon, no emoji`)
        assert.ok(m.tapSize, `${mode}: touch target under 44px`)
        await f.page.screenshot({ path: path.join(output, `raise-${mode}-${viewport.width}x${viewport.height}.png`) })
        evidence.push({ check: `${mode} ${viewport.width}x${viewport.height}: inRail=${m.inRail} clear=${m.clearDialogue} stripHits=${m.stripHits} icon=${m.label}`, result: 'PASS' })
        await f.context.close()
      }
    }
    assert.deepEqual(errors, [])
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ evidence, errors }, null, 2))
    console.log(JSON.stringify({ passed: evidence.length, errors, output }, null, 2))
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })

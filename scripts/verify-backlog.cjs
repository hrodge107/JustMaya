// Run against Vite with Playwright available through Node's module search path.
// All API responses are isolated fixtures; no backend or model requests occur.
const { chromium } = (() => { try { return require('playwright') } catch { return require('playwright-core') } })()
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const base = process.env.PLAYER_VERIFY_URL || 'http://127.0.0.1:5173'
const output = process.env.PLAYER_VERIFY_OUTPUT || path.join(os.tmpdir(), 'justmaya-backlog')
fs.mkdirSync(output, { recursive: true })
const evidence = []
const errors = []

const episode = {
  episodeId: 'fixture-episode', title: 'Verification fixture: Ancient settlements', status: 'ready', startSceneId: 'intro',
  scenes: [
    { sceneId: 'intro', kind: 'dialogue', nextSceneId: 'checkpoint', question: null, dialogue: [
      { lineId: 'one', speaker: 'mascot', text: 'Rivers shaped the first cities. Let us follow how people learned to work together.', emotion: 'talking' },
      { lineId: 'two', speaker: 'narrator', text: 'Water made farming possible, and shared work supported growing communities.', emotion: 'idle' },
    ] },
    { sceneId: 'checkpoint', kind: 'checkpoint', nextSceneId: 'ending', dialogue: [], question: { questionId: 'q', prompt: 'Why did early settlements grow near rivers?', options: [{ optionId: 'a', label: 'Water and farming' }, { optionId: 'b', label: 'No shared work' }] } },
    { sceneId: 'ending', kind: 'ending', nextSceneId: null, question: null, dialogue: [{ lineId: 'end', speaker: 'mascot', text: 'You have reached the end of this episode.', emotion: 'happy' }] },
  ], learningObjectives: [], estimatedMinutes: 1,
}

// The fixture session sits at the ending line with a completed checkpoint,
// a dropped-in tutor exchange anchored at intro:0, and picks with feedback.
function baseSession() {
  return {
    sessionId: 'fixture-session', episodeId: episode.episodeId, mode: 'playing',
    sceneId: 'ending', dialogueIndex: 0, version: 5, status: 'active',
    updatedAt: '2026-10-31T00:00:00Z',
    quizAttempts: [
      { questionId: 'q', selectedOptionId: 'b', correct: false, attemptNumber: 1, timestamp: '2026-10-31T00:01:00Z', feedback: 'Not quite. Shared work kept the settlement alive.' },
      { questionId: 'q', selectedOptionId: 'a', correct: true, attemptNumber: 2, timestamp: '2026-10-31T00:02:00Z', feedback: 'Exactly, water meant farming and farming fed the work.' },
    ],
    interactions: [{
      interactionId: 'i1', kind: 'raise_hand', userMessage: 'Why rivers and not the coast?',
      answer: 'Rivers gave both water and travel routes.', lines: [], sourceRefs: [],
      createdAt: '2026-10-31T00:00:30Z', groundingStatus: null, requestId: 'q1',
      position: { sceneId: 'intro', dialogueIndex: 0, mode: 'playing' },
    }],
    learningNotes: [], checkpoint: null, resumeSnapshot: null, tutorThreadId: null,
  }
}

async function fixture(browser, options = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', ...options.context })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('Failed to load resource')) errors.push(message.text()) })
  const state = {
    session: { ...baseSession(), ...options.session },
    episode: structuredClone(episode), calls: [], rewinds: [],
  }
  const sceneOrder = ['intro', 'checkpoint', 'ending']
  const questionScene = { q: 'checkpoint' }
  function rewindTo(body) {
    const target = [sceneOrder.indexOf(body.scene_id), body.dialogue_index]
    const atOrAfter = pos => {
      if (!pos) return false
      const key = [sceneOrder.indexOf(pos.sceneId), pos.dialogueIndex]
      return key[0] >= target[0] && (key[0] > target[0] || key[1] >= target[1])
    }
    const s = state.session
    s.sceneId = body.scene_id
    s.dialogueIndex = body.dialogue_index
    s.mode = body.scene_id === 'checkpoint' ? 'checkpoint' : 'playing'
    s.quizAttempts = s.quizAttempts.filter(a => sceneOrder.indexOf(questionScene[a.questionId]) < target[0])
    s.interactions = s.interactions.filter(i => !atOrAfter(i.position))
    s.resumeSnapshot = null
    s.tutorThreadId = null
    s.version++
  }
  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const call = { path: url.pathname, method: request.method(), body: request.postDataJSON() }
    state.calls.push(call)
    if (url.pathname.endsWith('/rewind')) {
      if (state.rewindError) {
        const status = state.rewindError
        state.rewindError = 0
        return route.fulfill({ status, json: { error: { code: status === 409 ? 'SESSION_CONFLICT' : 'E', message: 'Fixture rewind failure.' } } })
      }
      state.rewinds.push(call.body)
      rewindTo(call.body)
      return route.fulfill({ json: state.session })
    }
    if (url.pathname.includes('/sessions/')) return route.fulfill({ json: state.session })
    if (url.pathname === '/api/documents') return route.fulfill({ json: { documents: [] } })
    assert.equal(url.pathname, '/api/episodes/fixture-episode', 'Unexpected API route')
    return route.fulfill({ json: state.episode })
  })
  const go = async () => { await page.goto(`${base}/?session=fixture-session`); await page.locator('.vn-frame').waitFor() }
  return { context, page, state, go }
}

async function openBacklogViaCue(page) {
  await page.locator('.vn-backlog-cue').click()
  await page.locator('.bl-dialog[open]').waitFor()
}

async function text(page, selector) {
  return page.locator(selector).innerText()
}

async function main() {
  let browser
  for (const channel of ['msedge', 'chrome']) {
    try { browser = await chromium.launch({ channel }); break } catch { /* next channel */ }
  }
  browser ??= await chromium.launch()
  try {
    // 1. Cue inside the dialogue box opens the messenger card.
    {
      const { context, page, go } = await fixture(browser)
      await go()
      const cue = page.locator('.vn-backlog-cue')
      await cue.waitFor()
      const placement = await page.evaluate(() => {
        const c = document.querySelector('.vn-backlog-cue').getBoundingClientRect()
        const d = document.querySelector('.vn-dialogue').getBoundingClientRect()
        return { cueTop: c.top - d.top, cueRight: d.right - c.right, w: c.width, h: c.height }
      })
      assert.ok(placement.cueTop < 12 && placement.cueRight < 14, 'cue hugs the upper-right corner inside the box')
      assert.ok(placement.w >= 44 && placement.h >= 44, 'cue meets the 44px target')
      await openBacklogViaCue(page)
      assert.match(await text(page, '.bl-head h2'), /Backlog/)
      // Messenger rows: mita avatar, right-aligned you, prompt, marker.
      const rows = page.locator('.bl-row')
      assert.equal(await rows.count(), 10, 'every shown turn is a backlog entry')
      await page.locator('.bl-row.bl-mita .bl-av-mita').first().waitFor()
      await page.locator('.bl-row.bl-you .bl-av-you').first().waitFor()
      const youAlign = await page.locator('.bl-row.bl-you .bl-bubble').first().evaluate(el => {
        const bubble = el.getBoundingClientRect(), row = el.closest('.bl-row').getBoundingClientRect()
        return row.right - bubble.right
      })
      assert.ok(youAlign < 64, 'learner echoes hug the right edge')
      const narrationRow = page.locator('.bl-row.bl-mita', { hasText: 'Water made farming possible' })
      assert.match(await narrationRow.locator('.bl-bubble').innerText(), /Water made farming possible/)
      await narrationRow.locator('.bl-av-mita').waitFor()
      assert.match(await page.locator('.bl-row.bl-mita', { hasText: 'Why did early settlements' }).innerText(), /Why did early settlements/)
      await page.locator('.bl-here', { hasText: 'Here' }).waitFor()
      evidence.push('cue opens messenger card: avatars, echo alignment, narration as mita turn, prompt, here marker')
      await context.close()
    }

    // 2. Menu row opens the same modal; closing returns focus to Menu.
    {
      const { context, page, go } = await fixture(browser)
      await go()
      await page.locator('.vn-menu-trigger').click()
      await page.locator('.vn-menu-dialog[open]').waitFor()
      await page.locator('.vn-menu-backlog').click()
      await page.locator('.bl-dialog[open]').waitFor()
      assert.equal(await page.locator('.vn-menu-dialog[open]').count(), 0, 'menu hands off to the backlog')
      await page.locator('.bl-dialog .vn-quiet', { hasText: 'Close' }).click()
      await page.locator('.bl-dialog[open]').waitFor({ state: 'hidden' })
      const focus = await page.evaluate(() => document.activeElement?.className)
      assert.match(String(focus), /vn-menu-trigger/, 'focus returns to the menu trigger')
      evidence.push('menu row opens modal and focus returns to Menu')
      await context.close()
    }

    // 3. Warning gates the jump; Stay here sends nothing.
    {
      const { context, page, state, go } = await fixture(browser)
      await go()
      await openBacklogViaCue(page)
      const postCount = () => state.calls.filter(c => c.method === 'POST').length
      await page.locator('.bl-row', { hasText: 'Water made farming possible' }).locator('.bl-hit').click()
      await page.locator('.bl-warn[open]').waitFor()
      assert.match(await text(page, '.bl-warn h3'), /Jump back to this line\?/)
      assert.match(await text(page, '.bl-warn-copy'), /Rewinds progress and clears later log entries\./)
      await page.locator('.bl-warn .vn-quiet', { hasText: 'Stay here' }).click()
      await page.locator('.bl-warn[open]').waitFor({ state: 'hidden' })
      assert.equal(postCount(), 0, 'cancel sends no rewind')
      assert.equal(state.session.sceneId, 'ending', 'position unchanged after cancel')
      evidence.push('warning copy shown; Stay here keeps progress and sends nothing')
      await context.close()
    }

    // 4. Confirmed jump sends one versioned rewind and replays truncated log.
    {
      const { context, page, state, go } = await fixture(browser)
      await go()
      await openBacklogViaCue(page)
      await page.locator('.bl-row', { hasText: 'Water made farming possible' }).locator('.bl-hit').click()
      await page.locator('.bl-warn[open]').waitFor()
      await page.locator('.bl-warn .vn-button', { hasText: 'Jump back' }).click()
      assert.equal(state.rewinds.length, 1, 'exactly one rewind request')
      const body = state.rewinds[0]
      assert.deepEqual({ scene_id: body.scene_id, dialogue_index: body.dialogue_index }, { scene_id: 'intro', dialogue_index: 1 })
      assert.equal(body.expected_version, 5)
      assert.ok(body.request_id, 'request carries an id')
      await page.locator('.bl-dialog[open]').waitFor({ state: 'hidden' })
      await page.locator('.vn-text').filter({ hasText: 'Water made farming possible' }).waitFor()
      // Reopen: the log ends at the target line; picks, prompt and end are gone.
      await openBacklogViaCue(page)
      const texts = await page.locator('.bl-row .bl-bubble').allInnerTexts()
      assert.equal(texts.length, 4, 'log truncated to target: line, echo pair, target line')
      assert.ok(texts.some(t => t.includes('Why rivers and not the coast')), 'anchored exchange survives before target')
      assert.ok(!texts.some(t => t.includes('Why did early settlements')), 'later prompt dropped')
      assert.equal(await page.locator('.bl-here').count(), 1, 'one current marker at the new end')
      evidence.push('confirm sends one versioned rewind; truncated log replays with exchange intact')
      await context.close()
    }

    // 5. No jump affordance in question or completed modes.
    for (const [mode, extra] of [
      ['question', { resumeSnapshot: { sceneId: 'ending', dialogueIndex: 0, mode: 'playing' }, tutorThreadId: 't:1' }],
      ['completed', {}],
    ]) {
      const { context, page, go } = await fixture(browser, { session: { mode, ...extra } })
      await go()
      await openBacklogViaCue(page)
      assert.equal(await page.locator('.bl-list button.bl-hit').count(), 0, `${mode} offers no jump`)
      assert.ok(await page.locator('.bl-row').count() > 0, `${mode} still browsable`)
      evidence.push(`jump hidden but log browsable in ${mode} mode`)
      await context.close()
    }

    // 6. Keyboard: focus enters the modal, Escape backs out to the cue.
    {
      const { context, page, go } = await fixture(browser)
      await go()
      await page.locator('.vn-backlog-cue').focus()
      await page.keyboard.press('Enter')
      await page.locator('.bl-dialog[open]').waitFor()
      const inside = await page.evaluate(() => document.querySelector('.bl-dialog').contains(document.activeElement))
      assert.ok(inside, 'focus enters the modal')
      await page.keyboard.press('Escape')
      await page.locator('.bl-dialog[open]').waitFor({ state: 'hidden' })
      const back = await page.evaluate(() => document.activeElement?.className)
      assert.match(String(back), /vn-backlog-cue/, 'Escape returns focus to the cue')
      evidence.push('keyboard open, focus containment, Escape restores cue focus')
      await context.close()
    }

    // 7. Viewport sweep: the cue and modal hold at phone, tablet, desktop.
    for (const viewport of [{ width: 390, height: 844 }, { width: 800, height: 600 }, { width: 1280, height: 800 }, { width: 760, height: 380 }]) {
      const { context, page, go } = await fixture(browser, { context: { viewport } })
      await go()
      const cueVisible = await page.locator('.vn-backlog-cue').isVisible()
      assert.ok(cueVisible, `cue visible at ${viewport.width}x${viewport.height}`)
      await openBacklogViaCue(page)
      const fits = await page.evaluate(() => {
        const d = document.querySelector('.bl-dialog[open]').getBoundingClientRect()
        return d.top >= 0 && d.left >= 0 && d.bottom <= innerHeight && d.right <= innerWidth
      })
      assert.ok(fits, `modal fits at ${viewport.width}x${viewport.height}`)
      await page.screenshot({ path: path.join(output, `backlog-${viewport.width}x${viewport.height}.png`) })
      await context.close()
    }
    evidence.push('cue and modal verified at 390/800/1280 plus short landscape')

    // 8. A failed jump keeps the modal open with an error, success path intact.
    {
      const { context, page, state, go } = await fixture(browser)
      await go()
      await openBacklogViaCue(page)
      state.rewindError = 503
      await page.locator('.bl-row', { hasText: 'Water made farming possible' }).locator('.bl-hit').click()
      await page.locator('.bl-warn .vn-button', { hasText: 'Jump back' }).click()
      await page.locator('.bl-error').waitFor()
      assert.match(await text(page, '.bl-error'), /Could not jump back|Fixture rewind failure/)
      assert.ok(await page.locator('.bl-dialog[open]').count() === 1, 'backlog stays open on failure')
      assert.equal(state.session.sceneId, 'ending', 'failure left the session alone')
      evidence.push('failed jump surfaces an error inside the open modal')
      await context.close()
    }
  } finally {
    await browser.close()
  }
  for (const line of evidence) console.log(`OK ${line}`)
  if (errors.length) { console.error(errors); process.exit(1) }
  console.log('OK: backlog verification passed.')
}

main().catch(error => { console.error(error); process.exit(1) })

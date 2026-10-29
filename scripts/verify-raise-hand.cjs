// B03 browser verification: raise-hand question mode against real FastAPI
// endpoints. Only POST /questions is stubbed (synthesized from a live session
// GET) so tutor answers stay deterministic without a live model key; every
// other session call reaches the real backend on a copied database.
const { chromium } = (() => { try { return require('playwright') } catch { return require('playwright-core') } })()
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const base = process.env.PLAYER_VERIFY_URL || 'http://127.0.0.1:5173'
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const output = path.join(manifest.dataDir, 'browser')
fs.mkdirSync(output, { recursive: true })
const evidence = [], errors = []
const episode = manifest.episode
const id = () => crypto.randomUUID()

// Mirror of src/player/tutorCues.ts pools, extracted so copy edits don't drift.
const cuesSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'player', 'tutorCues.ts'), 'utf8')
const cuePool = name => [...cuesSrc.match(new RegExp(`${name}\\s*=\\s*\\[([^\\]]+)\\]`, 's'))[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map(m => m[1] ?? m[2])
const ASK_MORE = cuePool('ASK_MORE'), BACK_TO_LESSON = cuePool('BACK_TO_LESSON')

async function post(request, endpoint, body) {
  const response = await request.post(`${base}${endpoint}`, { data: body })
  assert.equal(response.status(), 200, await response.text())
  return response.json()
}
async function parked(request, sceneId = 'scene-03-checkpoint-1') {
  let session = await post(request, `/api/episodes/${episode.episodeId}/sessions`)
  while (session.sceneId !== sceneId) session = await post(request, `/api/sessions/${session.sessionId}/advance`, { request_id: id(), expected_version: session.version })
  return session
}
async function fixture(browser, viewport = { width: 390, height: 844 }, reducedMotion = 'reduce', extra = {}) {
  const context = await browser.newContext({ viewport, reducedMotion, ...extra })
  const page = await context.newPage()
  page.on('pageerror', err => errors.push(err.message))
  await page.clock.install(); await page.clock.pauseAt(new Date())
  const state = { fault: '', calls: [], gate: null, questionReplies: new Map(), get: sid => context.request.get(`${base}/api/sessions/${sid}`).then(r => r.json()) }
  await page.route('**/api/sessions/**', async route => {
    const request = route.request()
    if (request.method() === 'GET') return route.continue()
    state.calls.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() })
    if (state.gate) await state.gate
    return route.continue()
  })
  // Registered last so it wins: deterministic tutor answers, replay-aware.
  await page.route('**/api/sessions/*/questions', async route => {
    const req = route.request().postDataJSON()
    state.calls.push({ path: new URL(route.request().url()).pathname, body: req })
    if (state.gate) await state.gate
    const fault = state.fault; state.fault = ''
    if (fault === 'unavailable') return route.fulfill({ status: 503, json: { error: { message: 'Verification tutor unavailable.' } } })
    if (state.questionReplies.has(req.request_id)) return route.fulfill({ json: state.questionReplies.get(req.request_id) })
    const session = await state.get(new URL(route.request().url()).pathname.split('/')[3])
    const lines = [`Beat one answers "${req.question}".`, 'Beat two carries the middle.', 'Beat three lands the point.']
    const interaction = { interactionId: `verify-${req.request_id.slice(0, 8)}`, kind: 'raise_hand', userMessage: req.question, answer: lines.join('\n'), lines, sourceRefs: [{ chunkId: 'verify-chunk', documentId: session.episodeId, pageStart: 2, pageEnd: 3, sectionId: null }], createdAt: new Date().toISOString(), groundingStatus: 'partial', requestId: req.request_id }
    // The stubbed write never lands server-side, so the synthesized session
    // keeps the backend's real version — /resume must not 409 on it.
    const body = { interaction, session: { ...session, updatedAt: new Date().toISOString(), interactions: [...(session.interactions ?? []), interaction], learningNotes: [...(session.learningNotes ?? []), 'verify note'] } }
    state.questionReplies.set(req.request_id, body)
    await route.fulfill({ json: body })
  })
  const go = async session => { await page.goto(`${base}/?session=${session.sessionId}`); await page.locator('.vn-frame').waitFor() }
  return { page, context, state, go }
}
const raise = page => page.locator('.vn-raise')
const strip = page => page.locator('.vn-ask-strip')
const input = page => page.locator('.vn-ask-input')
const send = page => page.locator('.vn-ask-send')
const saved = f => f.state.get(f.session.sessionId)
const questionPosts = f => f.state.calls.filter(c => c.path.endsWith('/questions'))
const liveText = page => page.locator('.vn-dialogue .sr-only[aria-live]').textContent()
// Beats replace per dialogue activation; chrome unlocks on the closing cue.
async function throughBeats(f, marker = '.vn-ask-edit') {
  for (let i = 0; i < 24; i++) {
    if (await f.page.locator(marker).count()) return
    await f.page.locator('.vn-dialogue-target').click()
    await f.page.clock.runFor(40)
  }
  throw new Error('answer beats never reached the closing cue')
}
const waitCue = (page, pool) => page.waitForFunction(lines => {
  const t = document.querySelector('.vn-dialogue .sr-only[aria-live]')?.textContent ?? ''
  return lines.includes(t.replace('Instructor: ', ''))
}, pool)

async function coreFlow(browser) {
  // Raise from a checkpoint: icon morphs, listening mascot, focused input, prompt.
  const f = await fixture(browser)
  f.session = await parked(f.context.request)
  await f.go(f.session)
  await raise(f.page).waitFor()
  assert.equal(await raise(f.page).getAttribute('aria-label'), 'Raise your hand to ask a question')
  const waitRaise = f.page.waitForResponse(r => r.url().endsWith('/raise-hand') && r.request().method() === 'POST')
  await raise(f.page).click()
  await waitRaise
  await strip(f.page).waitFor()
  assert.equal(await raise(f.page).getAttribute('aria-label'), 'Resume the lesson')
  assert.equal(await f.page.locator('.mascot').getAttribute('data-emotion'), 'listening')
  assert.equal(await f.page.evaluate(() => document.activeElement === document.querySelector('.vn-ask-input')), true)
  await f.page.waitForFunction(() => document.querySelector('.vn-dialogue .sr-only[aria-live]')?.textContent === 'Instructor: What would you like to ask?')
  assert.equal(await f.page.locator('.vn-ask-resume').count(), 0, 'Resume Lesson appears only after the first question')
  assert.equal((await saved(f)).mode, 'question')
  assert.equal((await saved(f)).resumeSnapshot.mode, 'checkpoint')

  // Enter inside the input never sends; strip click does.
  await input(f.page).fill('What does section two cover?')
  const before = f.state.calls.length
  await f.page.keyboard.press('Enter')
  await f.page.clock.runFor(200)
  assert.equal(f.state.calls.length, before, 'Enter in the input does not send')
  assert.equal(await input(f.page).inputValue(), 'What does section two cover?', 'typed text is reflected')
  await send(f.page).click()
  await f.page.waitForFunction(() => document.querySelector('.vn-dialogue .sr-only[aria-live]')?.textContent.startsWith('Instructor: Beat one'))
  assert.equal(questionPosts(f).length, 1)
  assert.equal(questionPosts(f)[0].body.question, 'What does section two cover?')
  assert.equal(await f.page.locator('.vn-ask-text').textContent(), 'What does section two cover?')

  // Chrome waits for the closing cue beat; the sent strip stays throughout.
  assert.equal(await f.page.locator('.vn-ask-edit').count(), 0, 'pencil hidden until the closing beat')
  assert.equal(await f.page.locator('.vn-ask-resume').count(), 0, 'resume strip hidden until the closing beat')
  assert.equal(await f.page.locator('.vn-source-note').count(), 0, 'grounding note hidden until the closing beat')
  await f.page.locator('.vn-dialogue-target').click()
  await f.page.waitForFunction(() => document.querySelector('.vn-dialogue .sr-only[aria-live]')?.textContent.startsWith('Instructor: Beat two'))
  await f.page.locator('.vn-dialogue-target').click()
  await f.page.waitForFunction(() => document.querySelector('.vn-dialogue .sr-only[aria-live]')?.textContent.startsWith('Instructor: Beat three'))
  await f.page.locator('.vn-dialogue-target').click()
  await waitCue(f.page, ASK_MORE)
  const closing = (await liveText(f.page)).replace('Instructor: ', '')
  // The cue is frontend-composed; the persisted interaction never carries it.
  const reply = f.state.questionReplies.get(questionPosts(f)[0].body.request_id)
  assert.ok(!reply.interaction.lines.includes(closing) && !reply.interaction.answer.includes(closing), 'cue text stays out of the persisted interaction')
  await f.page.locator('.vn-ask-resume').waitFor()
  assert.ok(BACK_TO_LESSON.includes(await f.page.locator('.vn-ask-resume').textContent()), 'resume strip label rotates return-to-lesson copy')
  assert.equal(await f.page.locator('.vn-source-note').textContent(), 'Partly supported by your PDF.')
  await f.page.getByRole('button', { name: 'Sources', exact: true }).click()
  assert.deepEqual(await f.page.locator('.vn-source-badge').allTextContents(), ['Page 2–3'])

  // Pencil edits the sent question; resending is a new request id, new beats.
  await f.page.locator('.vn-ask-edit').click()
  assert.equal(await f.page.evaluate(() => document.activeElement === document.querySelector('.vn-ask-input')), true)
  assert.equal(await input(f.page).inputValue(), 'What does section two cover?')
  await input(f.page).fill('What does section three cover?')
  await send(f.page).click()
  await f.page.waitForFunction(() => document.querySelector('.vn-ask-text')?.textContent === 'What does section three cover?')
  assert.equal(questionPosts(f).length, 2)
  assert.notEqual(questionPosts(f)[1].body.request_id, questionPosts(f)[0].body.request_id)
  await throughBeats(f)

  // Resume restores the checkpoint exactly, behind one transient return beat.
  const waitResume = f.page.waitForResponse(r => r.url().endsWith('/resume') && r.request().method() === 'POST')
  await f.page.locator('.vn-ask-resume').click()
  await waitResume
  await waitCue(f.page, BACK_TO_LESSON)
  await f.page.locator('.vn-dialogue-target').click()
  await f.page.locator('.vn-choices .vn-choice').first().waitFor()
  const restored = await saved(f)
  assert.equal(restored.mode, 'checkpoint')
  assert.equal(restored.sceneId, 'scene-03-checkpoint-1')
  assert.equal(restored.resumeSnapshot, null)
  // The transient return beat is client-only: the persisted session has no trace.
  assert.ok(restored.interactions.every(i => ![i.answer, ...(i.lines ?? [])].some(l => BACK_TO_LESSON.includes(l))), 'transient cue never reaches persisted state')
  evidence.push({ check: 'raise->compose->send->beat sequence->closing cue->sources->pencil edit->new beats->resume label->transient return beat->checkpoint restored', result: 'PASS' })
  await f.context.close()
}

async function pendingAndCancel(browser) {
  // Pending send locks the strip and shows the thinking mascot.
  const f = await fixture(browser)
  f.session = await parked(f.context.request, episode.startSceneId)
  await f.go(f.session)
  await raise(f.page).click()
  await strip(f.page).waitFor()
  await input(f.page).fill('Held question')
  let release
  f.state.gate = new Promise(resolve => { release = resolve })
  await send(f.page).click()
  await f.page.waitForFunction(() => document.querySelector('.vn-ask-sent')?.getAttribute('aria-busy') === 'true')
  assert.equal(await f.page.locator('.mascot').getAttribute('data-emotion'), 'thinking')
  assert.equal(await f.page.locator('.vn-ask-text').textContent(), 'Held question')
  release(); f.state.gate = null
  await throughBeats(f)

  // Play icon resumes while answered, behind the transient return beat.
  const waitResume = f.page.waitForResponse(r => r.url().endsWith('/resume'))
  await raise(f.page).click()
  await waitResume
  await waitCue(f.page, BACK_TO_LESSON)
  assert.equal((await saved(f)).mode, 'playing')
  evidence.push({ check: 'pending locks strip + thinking mascot; Play icon resumes with return beat', result: 'PASS' })
  await f.context.close()

  // Escape equals Play.
  const esc = await fixture(browser)
  esc.session = await parked(esc.context.request, episode.startSceneId)
  await esc.go(esc.session)
  await raise(esc.page).click()
  await strip(esc.page).waitFor()
  const waitEsc = esc.page.waitForResponse(r => r.url().endsWith('/resume'))
  await esc.page.keyboard.press('Escape')
  await waitEsc
  assert.equal((await esc.state.get(esc.session.sessionId)).mode, 'playing')
  evidence.push({ check: 'Escape cancels composing and resumes the lesson', result: 'PASS' })
  await esc.context.close()
}

async function faultsAndReload(browser) {
  // Failed send preserves the question; retry reuses the same request id.
  const f = await fixture(browser)
  f.session = await parked(f.context.request)
  await f.go(f.session)
  await raise(f.page).click()
  await strip(f.page).waitFor()
  await input(f.page).fill('Will this retry?')
  f.state.fault = 'unavailable'
  await send(f.page).click()
  await f.page.locator('.vn-error').waitFor()
  assert.equal(await input(f.page).inputValue(), 'Will this retry?')
  assert.equal((await saved(f)).interactions.length, 0)
  await send(f.page).click()
  await throughBeats(f)
  assert.equal(questionPosts(f).length, 2)
  assert.deepEqual(questionPosts(f)[1].body, questionPosts(f)[0].body, 'retry reuses the frozen request body')
  evidence.push({ check: 'failed send preserves text; retry reuses request id and succeeds', result: 'PASS' })

  // Reload mid-compose restores question mode and listening state.
  await f.page.locator('.vn-ask-edit').click()
  await f.page.reload()
  await strip(f.page).waitFor()
  assert.equal(await f.page.locator('.mascot').getAttribute('data-emotion'), 'listening')
  assert.equal(await f.page.evaluate(() => document.activeElement === document.querySelector('.vn-ask-input')), true)
  assert.equal((await saved(f)).mode, 'question')

  // Dialogue activation during question mode reveals text but never advances.
  const before = f.state.calls.filter(c => c.path.endsWith('/advance')).length
  await f.page.locator('.vn-dialogue-target').click()
  await f.page.clock.runFor(300)
  assert.equal(f.state.calls.filter(c => c.path.endsWith('/advance')).length, before, 'no advance call while in question mode')
  evidence.push({ check: 'reload restores question mode; dialogue clicks never advance', result: 'PASS' })
  await f.context.close()
}

async function layouts(browser) {
  for (const viewport of [{ width: 390, height: 844 }, { width: 800, height: 1024 }, { width: 1280, height: 800 }, { width: 320, height: 568 }, { width: 844, height: 390 }]) {
    const f = await fixture(browser, viewport)
    f.session = await parked(f.context.request)
    await f.go(f.session)
    await raise(f.page).click()
    await strip(f.page).waitFor()
    await input(f.page).fill('Verification layout question that is deliberately long to wrap within the strip surface at every size. '.repeat(2))
    await f.page.addStyleTag({ content: 'html { font-size: 20px; }' })
    assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${viewport.width}x${viewport.height} horizontal overflow`)
    const raiseBox = await raise(f.page).boundingBox()
    assert.ok(raiseBox.width >= 44 && raiseBox.height >= 44, 'raise button hit size')
    const stripBox = await strip(f.page).boundingBox()
    assert.ok(stripBox.height >= 44, 'strip hit height')
    // Keyboard modality: Shift+Tab from the input reaches the strip visibly.
    await input(f.page).press('Shift+Tab')
    assert.equal(await f.page.evaluate(() => document.activeElement === document.querySelector('.vn-ask-strip')), true)
    assert.equal(await strip(f.page).evaluate(el => getComputedStyle(el).outlineStyle), 'solid')
    await f.page.screenshot({ path: path.join(output, `ask-${viewport.width}x${viewport.height}.png`), fullPage: true })
    evidence.push({ check: `${viewport.width}x${viewport.height}: strip+raise geometry, focus, no horizontal overflow`, result: 'PASS' })
    await f.context.close()
  }
}

async function touchAndMotion(browser) {
  const f = await fixture(browser, { width: 390, height: 844 }, 'no-preference', { hasTouch: true, isMobile: true })
  f.session = await parked(f.context.request, episode.startSceneId)
  await f.go(f.session)
  await raise(f.page).tap()
  await strip(f.page).waitFor()
  await input(f.page).fill('Tap-sent question')
  await send(f.page).tap()
  await throughBeats(f)
  assert.equal(questionPosts(f).length, 1)
  evidence.push({ check: 'touch tap sends the question without keyboard', result: 'PASS' })
  await f.context.close()
}

async function reloadRestoresClosingBeat(browser) {
  // The parked session carries a real persisted beat answer (see the .py
  // stage) — reload must land on the closing cue beat, revealed, and the
  // hash-drawn cue must be identical after the reload.
  const f = await fixture(browser)
  f.session = { sessionId: manifest.questionSessionId }
  await f.go(f.session)
  await f.page.waitForFunction(() => document.querySelector('.vn-dialogue .sr-only[aria-live]')?.textContent?.startsWith('Instructor: '))
  const before = (await liveText(f.page)).replace('Instructor: ', '')
  assert.ok(ASK_MORE.includes(before), 'first-answer closing cue comes from the ask-more pool')
  await f.page.locator('.vn-ask-edit').waitFor()
  await f.page.locator('.vn-source-note').waitFor()
  await f.page.locator('.vn-ask-resume').waitFor()
  assert.equal(await input(f.page).count(), 0, 'answered phase shows no compose input')
  const persisted = await saved(f)
  assert.ok(![persisted.interactions.at(-1).answer, ...persisted.interactions.at(-1).lines].includes(before), 'persisted lines stay cue-free')
  await f.page.reload()
  await f.page.waitForFunction(() => document.querySelector('.vn-dialogue .sr-only[aria-live]')?.textContent?.startsWith('Instructor: '))
  assert.equal(await liveText(f.page), `Instructor: ${before}`, 'closing cue is hash-stable across reload')
  evidence.push({ check: 'reload lands on the closing cue beat revealed; cue stable across reload; persisted state cue-free', result: 'PASS' })
  await f.context.close()
}

async function main() {
  const browser = await chromium.launch({ channel: process.env.PLAYER_VERIFY_BROWSER || 'msedge', headless: true })
  try { await coreFlow(browser); await pendingAndCancel(browser); await faultsAndReload(browser); await layouts(browser); await touchAndMotion(browser); await reloadRestoresClosingBeat(browser); assert.deepEqual(errors, []) }
  finally { await browser.close(); fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ evidence, errors }, null, 2)) }
  console.log(JSON.stringify({ passed: evidence.length, output, errors }, null, 2))
}
main().catch(error => { console.error(error); process.exitCode = 1 })

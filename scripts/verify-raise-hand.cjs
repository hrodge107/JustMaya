// B03 browser verification: raise-hand question mode against real FastAPI
// endpoints. Only POST /questions is stubbed (synthesized from a live session
// GET) so tutor answers stay deterministic without a live model key; every
// other session call reaches the real backend on a copied database.
const { chromium, request: pwRequest } = (() => { try { return require('playwright') } catch { return require('playwright-core') } })()
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
const ASK_MORE = cuePool('ASK_MORE'), BACK_TO_LESSON = cuePool('BACK_TO_LESSON'), STRIP_LABEL = cuePool('STRIP_LABEL')
const ALL_CUES = [...ASK_MORE, ...BACK_TO_LESSON, ...STRIP_LABEL]
assert.deepEqual(ASK_MORE.filter(c => STRIP_LABEL.includes(c) || BACK_TO_LESSON.includes(c)).concat(STRIP_LABEL.filter(c => BACK_TO_LESSON.includes(c))), [], 'cue pools must stay disjoint')

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
  // A standalone request context keeps in-flight session GETs alive when a
  // route callback outlives the browser context that issued them.
  const apiRequest = await pwRequest.newContext({ baseURL: base })
  const state = { fault: '', calls: [], gate: null, questionReplies: new Map(), nextFlow: null, getPatch: null, get: sid => apiRequest.get(`${base}/api/sessions/${sid}`).then(r => r.json()) }
  await page.route('**/api/sessions/**', async route => {
    const request = route.request()
    if (request.method() === 'GET') {
      if (!state.getPatch || !new URL(request.url()).pathname.match(/^\/api\/sessions\/[^/]+$/)) return route.continue()
      const response = await route.fetch()
      return route.fulfill({ response, json: state.getPatch(await response.json()) })
    }
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
    if (fault === 'anchor') return route.fulfill({ status: 422, json: { error: { message: 'That reply is no longer anchored to the latest tutor turn.' } } })
    if (state.questionReplies.has(req.request_id)) return route.fulfill({ json: state.questionReplies.get(req.request_id) })
    const session = await state.get(new URL(route.request().url()).pathname.split('/')[3])
    const lines = [`Beat one answers "${req.question}".`, 'Beat two carries the middle.', 'Beat three lands the point.']
    const parent = req.reply_to_interaction_id ? (session.interactions ?? []).find(i => i.interactionId === req.reply_to_interaction_id) : null
    const override = state.nextFlow; state.nextFlow = null
    const flow = {
      threadId: session.tutorThreadId ?? `${session.sessionId}:${session.version}`,
      topicQuestion: parent?.flow?.topicQuestion ?? parent?.userMessage ?? req.question,
      replyToInteractionId: req.reply_to_interaction_id ?? null,
      helpMode: req.help_mode ?? 'explain',
      move: override?.move ?? (req.help_mode === 'hint' ? 'diagnose' : 'explain'),
      hintLevel: override?.hintLevel ?? (req.help_mode === 'hint' ? 0 : null),
      reflection: req.reflection ?? null,
      awaiting: override?.awaiting ?? (req.help_mode === 'hint' ? 'attempt' : 'none'),
    }
    const interaction = { interactionId: `verify-${req.request_id.slice(0, 8)}`, kind: 'raise_hand', userMessage: req.question, answer: lines.join('\n'), lines, sourceRefs: [{ chunkId: 'verify-chunk', documentId: session.episodeId, pageStart: 2, pageEnd: 3, sectionId: null }], createdAt: new Date().toISOString(), groundingStatus: 'partial', requestId: req.request_id, flow }
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
// Beats replace per dialogue activation; the fresh input lands on the closing cue.
async function throughBeats(f, marker = '.vn-ask-input') {
  for (let i = 0; i < 24; i++) {
    if (await f.page.locator(marker).count()) return
    await f.page.locator('.vn-dialogue-target').click()
    await f.page.clock.runFor(40)
  }
  throw new Error('answer beats never reached the closing cue')
}
const waitCue = (page, pool) => page.waitForFunction(lines => {
  const t = document.querySelector('.vn-dialogue .sr-only[aria-live]')?.textContent ?? ''
  return lines.includes(t.replace('Mita: ', ''))
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
  await f.page.waitForFunction(() => document.querySelector('.vn-dialogue .sr-only[aria-live]')?.textContent === 'Mita: What would you like to ask?')
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
  let release1
  f.state.gate = new Promise(resolve => { release1 = resolve })
  await send(f.page).click()
  // Echo: strips disappear simultaneously and the sent question shows as a "You" turn.
  await f.page.waitForFunction(() => document.querySelector('.vn-dialogue .sr-only[aria-live]')?.textContent === 'You: What does section two cover?')
  assert.equal(await f.page.locator('.vn-speaker').textContent(), 'You', 'speaker label reads You while the question echoes')
  assert.equal(await f.page.locator('.vn-choices .vn-choice').count(), 0, 'every strip disappears once the question echoes')
  assert.equal(questionPosts(f).length, 1)
  assert.equal(questionPosts(f)[0].body.question, 'What does section two cover?')
  assert.equal(questionPosts(f)[0].body.help_mode, 'explain', 'Explain is the default help mode')
  assert.equal(questionPosts(f)[0].body.reply_to_interaction_id, null, 'first question opens a new topic')
  assert.equal(questionPosts(f)[0].body.reflection, null)
  release1(); f.state.gate = null
  await f.page.waitForFunction(() => document.querySelector('.vn-dialogue .sr-only[aria-live]')?.textContent.startsWith('Mita: Beat one'))
  assert.equal(await input(f.page).count(), 0, 'compose input hidden until the closing beat')
  assert.equal(await f.page.locator('.vn-ask-resume').count(), 0, 'resume strip hidden until the closing beat')
  assert.equal(await f.page.locator('.vn-source-note').count(), 0, 'grounding note hidden until the closing beat')
  await f.page.locator('.vn-dialogue-target').click()
  await f.page.waitForFunction(() => document.querySelector('.vn-dialogue .sr-only[aria-live]')?.textContent.startsWith('Mita: Beat two'))
  await f.page.locator('.vn-dialogue-target').click()
  await f.page.waitForFunction(() => document.querySelector('.vn-dialogue .sr-only[aria-live]')?.textContent.startsWith('Mita: Beat three'))
  await f.page.locator('.vn-dialogue-target').click()
  await waitCue(f.page, ASK_MORE)
  const closing = (await liveText(f.page)).replace('Mita: ', '')
  // The cue is frontend-composed; the persisted interaction never carries it.
  const reply = f.state.questionReplies.get(questionPosts(f)[0].body.request_id)
  assert.ok(!reply.interaction.lines.includes(closing) && !reply.interaction.answer.includes(closing), 'cue text stays out of the persisted interaction')
  await f.page.locator('.vn-ask-resume').waitFor()
  const stripLabel = await f.page.locator('.vn-ask-resume').textContent()
  assert.ok(STRIP_LABEL.includes(stripLabel), 'resume strip label comes from the label pool')
  assert.equal(await input(f.page).inputValue(), '', 'closing beat lands an empty editable input')
  assert.equal(await f.page.evaluate(() => document.activeElement === document.querySelector('.vn-ask-input')), true, 'fresh input takes focus')
  assert.equal(await f.page.locator('.vn-source-note').textContent(), 'Partly supported by retrieved PDF passages.')
  await f.page.getByRole('button', { name: 'Sources', exact: true }).click()
  assert.deepEqual(await f.page.locator('.vn-source-badge').allTextContents(), ['Page 2–3'])
  assert.equal(await f.page.locator('.vn-ask-new').count(), 1, 'New question control appears once a flow turn anchors the thread')

  // The fresh input accepts a follow-up directly; it sends as a new request id
  // anchored to the latest tutor turn.
  await input(f.page).fill('What does section three cover?')
  let release2
  f.state.gate = new Promise(resolve => { release2 = resolve })
  await send(f.page).click()
  await f.page.waitForFunction(() => document.querySelector('.vn-dialogue .sr-only[aria-live]')?.textContent === 'You: What does section three cover?')
  assert.equal(questionPosts(f).length, 2)
  assert.notEqual(questionPosts(f)[1].body.request_id, questionPosts(f)[0].body.request_id)
  const firstId = f.state.questionReplies.get(questionPosts(f)[0].body.request_id).interaction.interactionId
  assert.equal(questionPosts(f)[1].body.reply_to_interaction_id, firstId, 'follow-up anchors to the latest tutor turn')
  release2(); f.state.gate = null
  await throughBeats(f)

  // Resume restores the checkpoint exactly, behind one transient return beat.
  const waitResume = f.page.waitForResponse(r => r.url().endsWith('/resume') && r.request().method() === 'POST')
  await f.page.locator('.vn-ask-resume').click()
  await waitResume
  await waitCue(f.page, BACK_TO_LESSON)
  assert.notEqual((await liveText(f.page)).replace('Mita: ', ''), stripLabel, 'spoken return beat never repeats the strip label')
  await f.page.locator('.vn-dialogue-target').click()
  await f.page.locator('.vn-choices .vn-choice').first().waitFor()
  const restored = await saved(f)
  assert.equal(restored.mode, 'checkpoint')
  assert.equal(restored.sceneId, 'scene-03-checkpoint-1')
  assert.equal(restored.resumeSnapshot, null)
  // The transient return beat is client-only: the persisted session has no trace.
  assert.ok(restored.interactions.every(i => ![i.answer, ...(i.lines ?? [])].some(l => ALL_CUES.includes(l))), 'cue text never reaches persisted state')
  evidence.push({ check: 'raise->compose->send->beat sequence->closing cue->sources->pencil edit->new beats->resume label->transient return beat->checkpoint restored', result: 'PASS' })
  await f.context.close()
}

async function pendingAndCancel(browser) {
  // Full motion proves the order: echo types as "You" → mascot thinks until
  // the answer lands → only then do the answer beats begin.
  const f = await fixture(browser, { width: 390, height: 844 }, 'no-preference')
  f.session = await parked(f.context.request, episode.startSceneId)
  await f.go(f.session)
  await raise(f.page).click()
  await strip(f.page).waitFor()
  assert.equal(await f.page.evaluate(() => document.querySelector('.vn-scene')?.className.includes('vn-undim')), false, 'stage stays dimmed while composing')
  await input(f.page).fill('Held question')
  let release
  f.state.gate = new Promise(resolve => { release = resolve })
  await send(f.page).click()
  await f.page.waitForFunction(() => document.querySelector('.vn-dialogue .sr-only[aria-live]')?.textContent === 'You: Held question')
  assert.equal(await f.page.locator('.vn-choices .vn-choice').count(), 0, 'every strip disappears while the question echoes')
  assert.equal(await f.page.locator('.mascot').getAttribute('data-emotion'), 'listening', 'mascot listens while the echo types')
  await f.page.clock.runFor(500)
  await f.page.waitForFunction(() => document.querySelector('.mascot')?.getAttribute('data-emotion') === 'thinking')
  assert.equal(await liveText(f.page), 'You: Held question', 'the "You" turn stays up while the mascot thinks')
  assert.equal(await f.page.evaluate(() => document.querySelector('.vn-scene')?.className.includes('vn-undim')), true, 'stage undims for the thinking window')
  assert.equal(await f.page.locator('.vn-dialogue-target').getAttribute('aria-label'), 'Reveal your message')
  release(); f.state.gate = null
  await f.page.waitForFunction(() => document.querySelector('.vn-dialogue .sr-only[aria-live]')?.textContent.startsWith('Mita: Beat one'))
  await throughBeats(f)
  assert.equal(await f.page.evaluate(() => document.querySelector('.vn-scene')?.className.includes('vn-undim')), false, 'dimming returns with the fresh compose strip')

  // Play icon resumes while answered, behind the transient return beat.
  const waitResume = f.page.waitForResponse(r => r.url().endsWith('/resume'))
  await raise(f.page).click()
  await waitResume
  await waitCue(f.page, BACK_TO_LESSON)
  assert.equal((await saved(f)).mode, 'playing')
  evidence.push({ check: 'echo as "You" -> strips gone -> listening -> thinking undimmed -> beats only after echo -> dimming back in compose; Play icon resumes with return beat', result: 'PASS' })
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

  // Same text with a different help mode is a new action, not a replay: the
  // mode-edited send mints a new request id, and its own retry reuses it.
  f.state.fault = 'unavailable'
  await f.page.getByRole('button', { name: 'Hint', exact: true }).click()
  await input(f.page).fill('Will this retry as a hint?')
  await send(f.page).click()
  await f.page.locator('.vn-error').waitFor()
  const editedPost = questionPosts(f).at(-1).body
  assert.notEqual(editedPost.request_id, questionPosts(f)[1].body.request_id, 'edited mode mints a new request identity')
  assert.equal(editedPost.help_mode, 'hint')
  await send(f.page).click()
  await throughBeats(f)
  assert.equal(questionPosts(f).at(-1).body.request_id, editedPost.request_id, 'retry of the edited action reuses its id')
  evidence.push({ check: 'help-mode edit before retry is a new action; its retry replays the new identity', result: 'PASS' })

  // Reload mid-compose restores question mode and listening state; the
  // unsubmitted draft is client state and does not survive.
  await input(f.page).fill('unsubmitted draft')
  await f.page.reload()
  await strip(f.page).waitFor()
  assert.equal(await f.page.locator('.mascot').getAttribute('data-emotion'), 'listening')
  assert.equal(await f.page.evaluate(() => document.activeElement === document.querySelector('.vn-ask-input')), true)
  assert.equal(await input(f.page).inputValue(), '', 'unsubmitted draft does not survive reload')
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
    const modeBox = await f.page.locator('.vn-ask-mode').first().boundingBox()
    assert.ok(modeBox.height >= 44, 'help-mode pill hit height')
    // Keyboard modality: Shift+Tab from the input reaches the strip visibly.
    await input(f.page).press('Shift+Tab')
    assert.equal(await f.page.evaluate(() => document.activeElement === document.querySelector('.vn-ask-strip')), true)
    assert.equal(await strip(f.page).evaluate(el => getComputedStyle(el).outlineStyle), 'solid')
    // Focus back in the input keeps the strip's ring visible while typing.
    await input(f.page).focus()
    assert.equal(await strip(f.page).evaluate(el => getComputedStyle(el).outlineStyle), 'solid', 'compose strip keeps a focus ring while typing')
    // Forward Tab from the input lands on a named Send button; Enter sends once.
    await input(f.page).press('Tab')
    assert.equal(await f.page.evaluate(() => document.activeElement === document.querySelector('.vn-ask-send')), true, 'forward Tab reaches the Send button')
    assert.equal(await send(f.page).getAttribute('aria-label'), 'Send your question')
    await f.page.screenshot({ path: path.join(output, `ask-${viewport.width}x${viewport.height}.png`), fullPage: true })
    await f.page.keyboard.press('Enter')
    await f.page.waitForFunction(() => document.querySelector('.vn-dialogue .sr-only[aria-live]')?.textContent?.startsWith('You: '))
    assert.equal(questionPosts(f).length, 1, 'Enter on the Send button sends exactly once')
    evidence.push({ check: `${viewport.width}x${viewport.height}: strip+raise+mode geometry, visible focus typing/strip/send, keyboard send, no horizontal overflow`, result: 'PASS' })
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
  await f.page.waitForFunction(() => document.querySelector('.vn-dialogue .sr-only[aria-live]')?.textContent?.startsWith('Mita: '))
  const before = (await liveText(f.page)).replace('Mita: ', '')
  assert.ok(ASK_MORE.includes(before), 'first-answer closing cue comes from the ask-more pool')
  await input(f.page).waitFor()
  await f.page.locator('.vn-source-note').waitFor()
  await f.page.locator('.vn-ask-resume').waitFor()
  assert.equal(await input(f.page).inputValue(), '', 'restored closing beat lands the fresh input empty')
  const persisted = await saved(f)
  assert.ok(![persisted.interactions.at(-1).answer, ...persisted.interactions.at(-1).lines].some(l => ALL_CUES.includes(l)), 'persisted lines stay cue-free')
  await f.page.reload()
  await f.page.waitForFunction(() => document.querySelector('.vn-dialogue .sr-only[aria-live]')?.textContent?.startsWith('Mita: '))
  assert.equal(await liveText(f.page), `Mita: ${before}`, 'closing cue is hash-stable across reload')
  evidence.push({ check: 'reload lands on the closing cue beat revealed; cue stable across reload; persisted state cue-free', result: 'PASS' })
  await f.context.close()
}

async function helpModesAndFlow(browser) {
  // Explain/Hint selector, anchored continuations, reflection field, New
  // question reset, invalid-anchor recovery, and resuming mid-hint.
  const f = await fixture(browser)
  f.session = await parked(f.context.request)
  await f.go(f.session)
  await raise(f.page).click()
  await strip(f.page).waitFor()
  const explainBtn = f.page.getByRole('button', { name: 'Explain', exact: true })
  const hintBtn = f.page.getByRole('button', { name: 'Hint', exact: true })
  await explainBtn.waitFor()
  assert.equal(await explainBtn.getAttribute('aria-pressed'), 'true')
  assert.equal(await hintBtn.getAttribute('aria-pressed'), 'false')
  assert.equal(await f.page.locator('.vn-ask-new').count(), 0, 'no New question control before the first turn')

  // Hint send: the diagnose turn lands on its final content beat — the
  // closing cue stays out while the tutor awaits an attempt.
  await hintBtn.click()
  assert.equal(await hintBtn.getAttribute('aria-pressed'), 'true')
  await input(f.page).fill('How do I answer the checkpoint?')
  await send(f.page).click()
  await throughBeats(f)
  const diagPost = questionPosts(f).at(-1).body
  assert.equal(diagPost.help_mode, 'hint')
  assert.equal(diagPost.reply_to_interaction_id, null)
  assert.equal(diagPost.reflection, null)
  const diagText = (await liveText(f.page)).replace('Mita: ', '')
  assert.ok(diagText.startsWith('Beat three'), 'final beat is the diagnostic prompt')
  assert.ok(!ALL_CUES.includes(diagText), 'awaiting attempt suppresses the generic closing cue')
  assert.equal(await input(f.page).getAttribute('placeholder'), 'What have you tried so far?')

  // The attempt reply anchors to the diagnose turn.
  const diagId = f.state.questionReplies.get(diagPost.request_id).interaction.interactionId
  f.state.nextFlow = { move: 'hint', awaiting: 'reflection', hintLevel: 1 }
  await input(f.page).fill('I picked option B and it was eliminated')
  await send(f.page).click()
  await throughBeats(f)
  const attemptPost = questionPosts(f).at(-1).body
  assert.equal(attemptPost.reply_to_interaction_id, diagId, 'attempt reply anchors to the diagnose turn')
  assert.equal(attemptPost.reflection, null)
  assert.equal(await input(f.page).getAttribute('placeholder'), 'What did that tell you?')

  // Awaiting reflection: the typed reply is sent as both message and reflection.
  f.state.nextFlow = { move: 'hint', awaiting: 'reflection', hintLevel: 2 }
  await input(f.page).fill('The flood deposits silt that renews the soil')
  await send(f.page).click()
  await throughBeats(f)
  const reflPost = questionPosts(f).at(-1).body
  assert.equal(reflPost.reply_to_interaction_id, f.state.questionReplies.get(attemptPost.request_id).interaction.interactionId)
  assert.equal(reflPost.reflection, 'The flood deposits silt that renews the soil')
  assert.equal(reflPost.question, reflPost.reflection)
  evidence.push({ check: 'hint mode: diagnose awaits attempt, anchored replies, reflection field, cue suppressed', result: 'PASS' })

  // Invalid anchor: draft survives and the detached retry sends unanchored.
  f.state.fault = 'anchor'
  await input(f.page).fill('reply that loses its anchor')
  await send(f.page).click()
  await f.page.locator('.vn-error').waitFor()
  assert.equal(await input(f.page).inputValue(), 'reply that loses its anchor', 'draft survives a rejected anchor')
  await send(f.page).click()
  await throughBeats(f)
  assert.equal(questionPosts(f).at(-1).body.reply_to_interaction_id, null, 'detached retry sends as a new topic')
  evidence.push({ check: 'invalid anchor surfaces the error, keeps the draft, retries unanchored', result: 'PASS' })

  // New question detaches the thread, clears the draft and resets to Explain.
  await f.page.locator('.vn-ask-new').click()
  assert.equal(await input(f.page).inputValue(), '')
  assert.equal(await explainBtn.getAttribute('aria-pressed'), 'true', 'New question resets the mode to Explain')
  await input(f.page).fill('brand new topic')
  await send(f.page).click()
  await throughBeats(f)
  const freshPost = questionPosts(f).at(-1).body
  assert.equal(freshPost.help_mode, 'explain')
  assert.equal(freshPost.reply_to_interaction_id, null)
  evidence.push({ check: 'New question clears draft, resets mode, sends the next message unanchored', result: 'PASS' })

  // Resumable mid-hint: raise icon posts resume and the thread closes exactly.
  const waitResume = f.page.waitForResponse(r => r.url().endsWith('/resume') && r.request().method() === 'POST')
  await raise(f.page).click()
  await waitResume
  await waitCue(f.page, BACK_TO_LESSON)
  const done = await saved(f)
  assert.equal(done.mode, 'checkpoint')
  assert.equal(done.sceneId, 'scene-03-checkpoint-1')
  assert.equal(done.tutorThreadId, null, 'resume closes the tutor thread')
  assert.equal(done.resumeSnapshot, null)
  evidence.push({ check: 'hint exit resumes the exact checkpoint and clears the thread', result: 'PASS' })
  await f.context.close()
}

async function earlyAnswerOrder(browser) {
  // Answer landing while the "You" echo is still revealing: the tutor's
  // beats hold until the echo completes, then play in order.
  const f = await fixture(browser, { width: 390, height: 844 }, 'no-preference')
  f.session = await parked(f.context.request, episode.startSceneId)
  await f.go(f.session)
  await raise(f.page).click()
  await strip(f.page).waitFor()
  await input(f.page).fill('A question answered faster than its echo types')
  let release
  f.state.gate = new Promise(resolve => { release = resolve })
  await send(f.page).click()
  await f.page.clock.runFor(50)
  release(); f.state.gate = null
  await f.page.waitForResponse(r => r.url().endsWith('/questions'))
  assert.equal(await liveText(f.page), 'You: A question answered faster than its echo types', 'the landed answer does not cut off the echo')
  await f.page.clock.runFor(2000)
  await f.page.waitForFunction(() => document.querySelector('.vn-dialogue .sr-only[aria-live]')?.textContent.startsWith('Mita: Beat one'))
  evidence.push({ check: 'early answer: Mita beats wait for the "You" echo to finish revealing', result: 'PASS' })
  await f.context.close()
}

async function reloadRestoresAwaiting(browser) {
  // A persisted awaiting turn restores its final pedagogical prompt — not a
  // generic closing cue — across reloads; a legacy turn without flow metadata
  // keeps the old closing-cue behaviour and hides the New question control.
  const f = await fixture(browser)
  f.session = await parked(f.context.request)
  const raised = await post(f.context.request, `/api/sessions/${f.session.sessionId}/raise-hand`, { request_id: id(), expected_version: f.session.version })
  const flowTurn = {
    interactionId: 'verify-flow-turn', kind: 'raise_hand', userMessage: 'stuck on the checkpoint',
    answer: 'Hint beat one.\nWhat do you think that tells you?', lines: ['Hint beat one.', 'What do you think that tells you?'],
    sourceRefs: [], createdAt: new Date().toISOString(), groundingStatus: 'supported', requestId: 'verify-flow',
    flow: { threadId: raised.tutorThreadId, topicQuestion: 'stuck on the checkpoint', replyToInteractionId: null, helpMode: 'hint', move: 'hint', hintLevel: 2, reflection: 'earlier reflection', awaiting: 'reflection' },
  }
  f.state.getPatch = s => ({ ...s, interactions: [...(s.interactions ?? []), flowTurn] })
  await f.go(raised)
  await f.page.waitForFunction(() => document.querySelector('.vn-dialogue .sr-only[aria-live]')?.textContent?.startsWith('Mita: '))
  assert.equal(await liveText(f.page), 'Mita: What do you think that tells you?', 'restore lands on the final pedagogical prompt')
  assert.equal(await input(f.page).getAttribute('placeholder'), 'What did that tell you?')
  await f.page.locator('.vn-ask-new').waitFor()
  await f.page.reload()
  await f.page.waitForFunction(() => document.querySelector('.vn-dialogue .sr-only[aria-live]')?.textContent?.startsWith('Mita: '))
  assert.equal(await liveText(f.page), 'Mita: What do you think that tells you?', 'awaiting restore is stable across reload')
  evidence.push({ check: 'reload restores awaiting flow: final prompt beat, reflection placeholder, New question, no closing cue', result: 'PASS' })
  await f.context.close()

  const legacy = await fixture(browser)
  legacy.session = await parked(legacy.context.request)
  const raised2 = await post(legacy.context.request, `/api/sessions/${legacy.session.sessionId}/raise-hand`, { request_id: id(), expected_version: legacy.session.version })
  const legacyTurn = { ...flowTurn, interactionId: 'verify-legacy-turn', flow: undefined }
  legacy.state.getPatch = s => ({ ...s, interactions: [...(s.interactions ?? []), legacyTurn] })
  await legacy.go(raised2)
  await waitCue(legacy.page, ASK_MORE)
  assert.equal(await legacy.page.locator('.vn-ask-new').count(), 0, 'legacy turn renders without the New question control')
  await input(legacy.page).waitFor()
  evidence.push({ check: 'legacy interaction without flow metadata keeps the closing cue and old compose behaviour', result: 'PASS' })
  await legacy.context.close()
}

async function main() {
  const browser = await chromium.launch({ channel: process.env.PLAYER_VERIFY_BROWSER || 'msedge', headless: true })
  try { await coreFlow(browser); await pendingAndCancel(browser); await earlyAnswerOrder(browser); await faultsAndReload(browser); await helpModesAndFlow(browser); await reloadRestoresAwaiting(browser); await layouts(browser); await touchAndMotion(browser); await reloadRestoresClosingBeat(browser); assert.deepEqual(errors, []) }
  finally { await browser.close(); fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ evidence, errors }, null, 2)) }
  console.log(JSON.stringify({ passed: evidence.length, output, errors }, null, 2))
}
main().catch(error => { console.error(error); process.exitCode = 1 })

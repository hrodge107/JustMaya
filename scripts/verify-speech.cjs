// Deterministic UI integration: fake media events, real React/dialogue flows.
const { chromium } = (() => { try { return require('playwright') } catch { return require('playwright-core') } })()
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const base = process.env.PLAYER_VERIFY_URL || 'http://127.0.0.1:5173'
const output = path.join(os.tmpdir(), 'mita-speech-browser')
fs.mkdirSync(output, { recursive: true })
const errors = []
const texts = ['First lesson line.', 'Second lesson line.', 'Third lesson line.', 'Fourth lesson line.', 'Fifth lesson line.']
const episode = { episodeId: 'ep', title: 'Speech verification fixture', status: 'ready', startSceneId: 'intro', learningObjectives: [], estimatedMinutes: 1, scenes: [
  { sceneId: 'intro', kind: 'dialogue', dialogue: texts.map((text, i) => ({ lineId: `l${i}`, speaker: i === 1 ? 'narrator' : 'mascot', text, emotion: 'talking' })), nextSceneId: 'quiz', question: null },
  { sceneId: 'quiz', kind: 'checkpoint', dialogue: [], nextSceneId: 'end', question: { questionId: 'q', prompt: 'Which choice fits?', objectiveId: 'o', options: [{ optionId: 'a', label: 'Answer A' }, { optionId: 'b', label: 'Answer B' }] } },
  { sceneId: 'end', kind: 'ending', dialogue: [{ lineId: 'end', speaker: 'mascot', text: 'The lesson has ended.', emotion: 'happy' }], nextSceneId: null, question: null },
] }

async function fixture(browser, viewport = { width: 1280, height: 800 }) {
  const context = await browser.newContext({ reducedMotion: 'reduce', viewport })
  await context.addInitScript(() => {
    window.__voice = { instances: [], plays: [], revoked: [], blocked: false }
    const revoke = URL.revokeObjectURL.bind(URL)
    URL.revokeObjectURL = url => { window.__voice.revoked.push(url); revoke(url) }
    window.Audio = class {
      src = ''; paused = true; onplaying = null; onended = null; onerror = null
      constructor() { window.__voice.instances.push(this) }
      play() { if (window.__voice.blocked) return Promise.reject(new DOMException('gesture', 'NotAllowedError')); this.paused = false; window.__voice.plays.push(this.src); this.onplaying?.(); return Promise.resolve() }
      pause() { this.paused = true }
      removeAttribute() { this.src = '' }
      load() {}
      finish() { this.paused = true; this.onended?.() }
    }
  })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  const state = {
    calls: [], fail: false, questionGate: null,
    session: { sessionId: 's', episodeId: 'ep', mode: 'playing', sceneId: 'intro', dialogueIndex: 0, version: 1, status: 'active', updatedAt: '2026-11-02', interactions: [], quizAttempts: [] },
  }
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url())
    const body = req.method() === 'POST' ? req.postDataJSON() : null
    state.calls.push({ path: url.pathname, body })
    const json = value => route.fulfill({ json: value })
    if (url.pathname === '/api/speech') return state.fail
      ? route.fulfill({ status: 503, json: { error: { message: 'offline' } } })
      : route.fulfill({ contentType: 'audio/mpeg', body: Buffer.from('ID3fixture') })
    if (url.pathname === '/api/documents') return json({ documents: [] })
    if (url.pathname === '/api/mascot/chat') return json({ interaction: { interactionId: 'home1', lines: ['Home model answer.', 'Home second answer.'] } })
    if (url.pathname === '/api/episodes/ep') return json(episode)
    if (url.pathname === '/api/sessions/s' && req.method() === 'GET') return json(state.session)
    if (url.pathname.endsWith('/raise-hand')) state.session.mode = 'question'
    else if (url.pathname.endsWith('/questions')) {
      if (state.questionGate) await state.questionGate
      state.session.interactions.push({ interactionId: 't1', kind: 'raise_hand', userMessage: body.question, answer: 'Tutor first answer. Tutor second answer.', lines: ['Tutor first answer.', 'Tutor second answer.'], sourceRefs: [], createdAt: '2026-11-02', groundingStatus: 'supported', requestId: body.request_id })
      return json({ interaction: state.session.interactions.at(-1), session: { ...state.session, version: ++state.session.version } })
    } else if (url.pathname.endsWith('/resume')) state.session.mode = 'playing'
    else if (url.pathname.endsWith('/rewind')) { state.session.sceneId = body.scene_id; state.session.dialogueIndex = body.dialogue_index; state.session.mode = 'playing' }
    else if (url.pathname.endsWith('/answers')) {
      state.session.checkpoint = { questionId: 'q', attemptsUsed: 1, isCorrect: true, checkpointCompleted: true, selectedOptionId: 'a', feedback: 'Good reasoning.', correctOptionId: 'a' }
    } else if (url.pathname.endsWith('/advance')) {
      if (state.session.sceneId === 'intro' && state.session.dialogueIndex < texts.length - 1) state.session.dialogueIndex++
      else if (state.session.sceneId === 'intro') { state.session.sceneId = 'quiz'; state.session.mode = 'checkpoint'; state.session.dialogueIndex = 0 }
      else { state.session.sceneId = 'end'; state.session.mode = 'playing'; state.session.dialogueIndex = 0 }
    } else return route.fulfill({ status: 404, json: { error: { message: 'Unstubbed fixture' } } })
    state.session.version++
    return json(state.session)
  })
  return { context, page, state, speech: () => state.calls.filter(call => call.path === '/api/speech').map(call => call.body.text) }
}

async function menu(page) { await page.getByRole('button', { name: 'Menu', exact: true }).click() }
async function closeMenu(page) { await page.locator('dialog[open]').getByRole('button', { name: 'Close', exact: true }).click() }
async function enable(page) {
  await menu(page)
  const toggle = page.getByRole('switch', { name: 'Mita’s voice' })
  await toggle.focus(); await page.keyboard.press('Space')
  assert.equal(await toggle.getAttribute('aria-checked'), 'true')
  await closeMenu(page)
}
const playing = page => page.waitForFunction(() => window.__voice.instances.some(audio => !audio.paused))
const finish = page => page.evaluate(() => window.__voice.instances.at(-1).finish())

async function run() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  try {
    const f = await fixture(browser), { page, state } = f
    await page.goto(`${base}/?session=s`); await page.locator('.vn-frame').waitFor()
    assert.deepEqual(f.speech(), [])
    await enable(page); await playing(page)
    await page.waitForFunction(() => window.__voice.instances.at(-1).src.startsWith('blob:'))
    await page.waitForTimeout(150)
    assert.deepEqual(f.speech(), texts.slice(0, 4), 'current and exactly three known lines')
    await menu(page); assert.equal(await page.evaluate(() => window.__voice.instances.at(-1).paused), true)
    await page.screenshot({ path: path.join(output, 'voice-menu-desktop.png') })
    await closeMenu(page); await playing(page)
    await page.getByRole('button', { name: 'Gallery', exact: true }).click()
    assert.equal(await page.evaluate(() => window.__voice.instances.at(-1).paused), true)
    await page.locator('.vn-picture-dialog').getByRole('button', { name: 'Close', exact: true }).click(); await playing(page)
    await page.getByRole('button', { name: 'Open the dialogue backlog' }).click()
    assert.equal(await page.evaluate(() => window.__voice.instances.at(-1).paused), true)
    await page.locator('.bl-close').click(); await playing(page)
    await page.locator('.vn-dialogue-target').click(); await page.waitForFunction(() => document.querySelector('.vn-text')?.textContent === 'Second lesson line.')
    await playing(page)
    assert.ok((await page.evaluate(() => window.__voice.revoked.length)) > 0)
    assert.equal(f.speech().filter(text => text === texts[1]).length, 1, 'prefetch reuse, including legacy narrator')
    assert.ok(!f.speech().includes('Which choice fits?'), 'no checkpoint lookahead')
    const beforeRewind = await page.evaluate(() => window.__voice.instances.at(-1).src)
    await page.getByRole('button', { name: 'Open the dialogue backlog' }).click()
    await page.locator('button.bl-hit').filter({ hasText: texts[0] }).click()
    await page.getByRole('button', { name: 'Jump back', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.vn-text')?.textContent === 'First lesson line.')
    await playing(page)
    assert.notEqual(await page.evaluate(() => window.__voice.instances.at(-1).src), beforeRewind, 'rewind replaces the old clip')
    assert.ok(state.calls.some(call => call.path.endsWith('/rewind')))
    await page.locator('.vn-raise').click()
    await page.getByRole('textbox', { name: 'Your message' }).fill('Never read this learner message.')
    let reply; state.questionGate = new Promise(resolve => { reply = resolve })
    await page.locator('.vn-ask-send').click()
    await page.waitForFunction(() => document.querySelector('.vn-speaker')?.textContent === 'You')
    assert.ok(!f.speech().some(text => text.includes('Never read')))
    reply()
    await page.waitForFunction(() => document.querySelector('.vn-text')?.textContent === 'Tutor first answer.')
    await playing(page); await page.waitForTimeout(150)
    assert.ok(f.speech().includes('Tutor second answer.'))
    await menu(page); await page.getByRole('button', { name: 'Leave episode', exact: true }).click()
    await page.locator('.home').waitFor(); await playing(page)
    await menu(page)
    assert.equal(await page.getByRole('switch', { name: 'Mita’s voice' }).getAttribute('aria-checked'), 'true', 'preference crosses surfaces')
    await closeMenu(page)
    await page.getByRole('button', { name: 'Talk', exact: true }).click()
    await page.locator('.vn-ask-input').fill('Another learner message.')
    await page.locator('.vn-ask-send').click()
    await page.waitForFunction(() => document.querySelector('.dlg-text')?.textContent.includes('Home model answer.'))
    assert.ok(!f.speech().some(text => text.includes('Another learner')))
    state.fail = true
    for (let attempt = 0; attempt < 3 && !await page.getByRole('button', { name: 'Retry voice' }).count(); attempt++) {
      await page.locator('.dlg').click(); await page.waitForTimeout(150)
    }
    await page.getByRole('button', { name: 'Retry voice' }).waitFor()
    assert.ok(await page.locator('.dlg-text').innerText())
    await page.screenshot({ path: path.join(output, 'voice-error-desktop.png') })
    state.fail = false
    await page.getByRole('button', { name: 'Retry voice' }).click(); await playing(page)
    await menu(page); await page.getByRole('switch', { name: 'Mita’s voice' }).click(); await closeMenu(page)
    const count = f.speech().length
    await page.locator('.dlg').click(); await page.waitForTimeout(150)
    assert.equal(f.speech().length, count, 'muted dialogue makes no requests')
    await page.reload(); await menu(page)
    assert.equal(await page.getByRole('switch', { name: 'Mita’s voice' }).getAttribute('aria-checked'), 'false', 'reload resets preference')
    await f.context.close()
    console.log('PASS surfaces, keyboard switch, lookahead, pause/resume, reuse/cleanup, silent echoes, tutor replies, recovery, mute and reload')

    const quiz = await fixture(browser, { width: 390, height: 844 })
    quiz.state.session.sceneId = 'quiz'; quiz.state.session.mode = 'checkpoint'
    await quiz.page.goto(`${base}/?session=s`); await quiz.page.locator('.vn-frame').waitFor()
    await enable(quiz.page); await playing(quiz.page)
    assert.ok(!quiz.speech().includes('Answer A') && !quiz.speech().includes('Answer B'))
    await quiz.page.getByRole('button', { name: 'Answer A', exact: true }).click()
    await quiz.page.waitForFunction(() => document.querySelector('.vn-text')?.textContent === 'Good reasoning.')
    await playing(quiz.page); await quiz.page.waitForTimeout(3300)
    assert.equal(quiz.state.session.sceneId, 'quiz', 'auto advance waits for speech')
    await finish(quiz.page)
    await quiz.page.waitForFunction(() => document.querySelector('.vn-text')?.textContent === 'The lesson has ended.')
    await quiz.page.evaluate(() => { window.__voice.blocked = true })
    await menu(quiz.page); await quiz.page.getByRole('switch', { name: 'Mita’s voice' }).click(); await quiz.page.getByRole('switch', { name: 'Mita’s voice' }).click(); await closeMenu(quiz.page)
    await quiz.page.getByRole('button', { name: 'Play voice', exact: true }).waitFor()
    await quiz.page.screenshot({ path: path.join(output, 'voice-blocked-mobile.png') })
    assert.equal(await quiz.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await quiz.page.evaluate(() => { window.__voice.blocked = false })
    await quiz.page.getByRole('button', { name: 'Play voice', exact: true }).click(); await playing(quiz.page)
    await quiz.context.close()
    console.log('PASS checkpoint audio gate, answer-option silence, autoplay recovery and mobile reflow')
    assert.deepEqual(errors, [])
    console.log(`Screenshots: ${output}`)
  } finally { await browser.close() }
}
run().catch(error => { console.error(error); process.exitCode = 1 })

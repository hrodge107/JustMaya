// Run Vite + FastAPI against the database copy from verify-recall.py.
// NODE_PATH may point to an existing Playwright installation; no repo dependency is needed.
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
const scenes = new Map(episode.scenes.map(s => [s.sceneId, s]))
const id = () => crypto.randomUUID()
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
  const state = { fault: '', calls: [], gate: null, failGet: false }
  await page.route('**/api/sessions/**', async route => {
    const request = route.request()
    if (request.method() === 'GET') {
      if (state.failGet) return route.fulfill({ status: 503, json: { error: { message: 'Verification reload failed.' } } })
      return route.continue()
    }
    state.calls.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() })
    if (state.gate) await state.gate
    const fault = state.fault; state.fault = ''
    if (fault === 'lost') { await route.fetch(); return route.abort('failed') }
    if (fault === 'unavailable') return route.fulfill({ status: 503, json: { error: { message: 'Verification connection interrupted.' } } })
    if (fault === 'invalid') return route.fulfill({ status: 422, json: { error: { code: 'VALIDATION_ERROR', message: 'Verification rejected option.' } } })
    return route.continue()
  })
  const go = async session => { await page.goto(`${base}/?session=${session.sessionId}`); await page.locator('.vn-choices').waitFor() }
  return { page, context, state, go }
}
async function response(page, action, suffix) {
  const wait = page.waitForResponse(r => r.url().endsWith(suffix) && r.request().method() === 'POST')
  await action(); await wait
}
const readingDelay = text => Math.max(3000, text.trim().split(/\s+/u).filter(Boolean).length * 300)
const saved = f => f.context.request.get(`${base}/api/sessions/${f.session.sessionId}`).then(r => r.json())
async function start(browser, options = {}) {
  const f = await fixture(browser, options.viewport, options.motion, options.extra)
  f.session = await parked(f.context.request)
  await f.go(f.session)
  return f
}
async function waitFeedback(f, text) {
  await f.page.waitForFunction(text => document.querySelector('.vn-dialogue .sr-only[aria-live]')?.textContent === `Instructor: ${text}`, text)
}
async function advanceAfterReading(f, state) {
  const wait = f.page.waitForResponse(r => r.url().endsWith('/advance') && r.request().method() === 'POST')
  await f.page.clock.runFor(readingDelay(state.checkpoint.feedback) + 50)
  await wait
  await f.page.waitForFunction(() => !document.querySelector('.vn-choices'))
}
async function liveOutcomes(browser) {
  for (const outcome of ['correct-first', 'wrong-correct', 'all-wrong']) {
    const f = await start(browser)
    let missed = 0
    for (const sceneId of ['scene-03-checkpoint-1', 'scene-05-checkpoint-2']) {
      const q = scenes.get(sceneId).question, right = q.correctOptionId
      const wrongs = q.options.filter(o => o.optionId !== right).map(o => o.optionId)
      const answers = outcome === 'correct-first' ? [right] : outcome === 'wrong-correct' ? [wrongs[0], right] : [...wrongs, right]
      if (outcome !== 'correct-first') missed++
      const eliminated = []
      for (let attempt = 0; attempt < answers.length; attempt++) {
        const chosen = q.options.find(o => o.optionId === answers[attempt])
        const nodBefore = Number(await f.page.locator('.mascot').getAttribute('data-nod-trigger'))
        await response(f.page, () => f.page.locator('.vn-choice').filter({ has: f.page.locator('span', { hasText: chosen.label }) }).click(), '/answers')
        const state = await saved(f)
        await waitFeedback(f, state.checkpoint.feedback)
        assert.equal(state.checkpoint.attemptsUsed, attempt + 1)
        if (answers[attempt] !== right) eliminated.push(answers[attempt])
        assert.equal(await f.page.locator('.vn-choice[data-incorrect]').count(), eliminated.length, 'every wrong pick stays burned')
        assert.equal(await f.page.locator('.vn-choice[data-incorrect] .vn-choice-status').count(), eliminated.length)
        assert.equal(await f.page.locator('.vn-choice[data-correct]').count(), state.checkpoint.checkpointCompleted ? 1 : 0)
        const rendered = await f.page.locator('.vn-choice[data-selected]').evaluate(el => {
          const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0)
          const style = getComputedStyle(el), a = luminance(style.color), b = luminance(style.backgroundColor)
          return { background: style.backgroundColor, contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) }
        })
        assert.equal(rendered.background, answers[attempt] === right ? 'rgb(222, 244, 232)' : 'rgb(251, 230, 232)')
        assert.ok(rendered.contrast >= 4.5)
        assert.equal(await f.page.locator('.mascot').getAttribute('data-emotion'), answers[attempt] === right ? 'happy' : 'confused')
        assert.equal(Number(await f.page.locator('.mascot').getAttribute('data-nod-trigger')), nodBefore + (answers[attempt] === right ? 1 : 0))
        assert.equal(await f.page.locator('.vn-choice:enabled').count(), state.checkpoint.checkpointCompleted ? 0 : q.options.length - eliminated.length)
        if (!state.checkpoint.checkpointCompleted) assert.ok(!('correctOptionId' in state.checkpoint))
        if (answers[attempt] !== right) {
          const burned = f.page.locator('.vn-choice').filter({ has: f.page.locator('span', { hasText: chosen.label }) })
          assert.equal(await burned.evaluate(el => el.disabled), true, 'eliminated strip is disabled')
          const posts = f.state.calls.length
          await burned.evaluate(el => el.click())
          await f.page.clock.runFor(200)
          assert.equal(f.state.calls.length, posts, 'eliminated option sends no answer')
        }
        assert.equal(await f.page.locator('.vn-checkpoint-dialogue, .vn-checkpoint-heading, .vn-checkpoint-reading, .vn-checkpoint-actions').count(), 0)
        assert.equal(await f.page.getByRole('button', { name: /^(Retry|Continue)$/ }).count(), 0)
        await f.page.reload(); await f.page.locator('.vn-choices').waitFor()
        await waitFeedback(f, state.checkpoint.feedback)
        assert.equal(await f.page.locator('.vn-choice[data-incorrect]').count(), eliminated.length, 'reload restores eliminated strips')
        assert.equal(await f.page.locator('.vn-text-rest').textContent(), '')
        assert.equal(Number(await f.page.locator('.mascot').getAttribute('data-nod-trigger')), 0)
        assert.equal(await f.page.locator('.vn-choice[data-selected]').evaluate(el => el.getAnimations().length), 0)
      }
      const state = await saved(f)
      await f.page.screenshot({ path: path.join(output, `${outcome}-${sceneId}.png`), fullPage: true })
      const posts = f.state.calls.length
      const wait = f.page.waitForResponse(r => r.url().endsWith('/advance') && r.request().method() === 'POST')
      await f.page.locator('.vn-dialogue-target').click()
      await wait
      assert.equal(f.state.calls.length, posts + 1, 'completed dialogue activation skips the reading delay')
      let current = await saved(f)
      assert.equal(current.sceneId, scenes.get(sceneId).nextSceneId)
      await f.page.clock.runFor(readingDelay(state.checkpoint.feedback))
      assert.equal(f.state.calls.length, posts + 1, 'manual advance supersedes the reading timer')
      if (sceneId === 'scene-03-checkpoint-1') {
        while (current.mode === 'playing') {
          await response(f.page, () => f.page.locator('.vn-dialogue-target').click(), '/advance')
          current = await saved(f)
        }
        await f.page.locator('.vn-choices').waitFor()
      }
      evidence.push({ check: `${sceneId}: ${outcome}, eliminated strips persist/disable/no-send, restore, colors/nod, manual advance past reading delay`, result: 'PASS' })
    }
    assert.equal((await saved(f)).learningNotes.length, missed, 'one note per checkpoint missed on')
    await f.context.close()
  }
}
async function recovery(browser) {
  const f = await start(browser)
  const q = scenes.get(f.session.sceneId).question
  const wrong = q.options.find(o => o.optionId !== q.correctOptionId), right = q.options.find(o => o.optionId === q.correctOptionId)
  f.state.fault = 'lost'
  await f.page.getByRole('button', { name: wrong.label, exact: true }).click()
  await f.page.locator('.vn-error').waitFor()
  assert.equal(await f.page.locator('.vn-choice[data-incorrect], .vn-choice[data-correct]').count(), 0)
  assert.equal(await f.page.locator('.vn-choice:enabled').count(), 0)
  await response(f.page, () => f.page.locator('.vn-dialogue-target').click(), '/answers')
  assert.deepEqual(f.state.calls[0].body, f.state.calls[1].body)
  assert.equal((await saved(f)).quizAttempts.length, 1)
  await f.page.waitForFunction(() => document.querySelectorAll('.vn-choice:enabled').length > 0)
  let release
  f.state.gate = new Promise(resolve => { release = resolve })
  await f.page.getByRole('button', { name: right.label, exact: true }).click()
  await f.page.locator('.vn-dialogue-target').click({ clickCount: 3, force: true })
  await f.page.getByRole('button', { name: 'Menu', exact: true }).click()
  const posts = f.state.calls.length
  release(); f.state.gate = null
  let state = await saved(f)
  await f.page.waitForFunction(() => document.querySelectorAll('.vn-choice[data-correct]').length === 1)
  state = await saved(f)
  await f.page.clock.runFor(readingDelay(state.checkpoint.feedback) + 1000)
  assert.equal(f.state.calls.length, posts, 'Menu prevents auto advance and pending duplication')
  assert.equal(await f.page.evaluate(() => document.activeElement.textContent), 'Close')
  await f.page.keyboard.press('Escape')
  assert.equal(await f.page.evaluate(() => document.activeElement.textContent.trim()), 'Menu')
  f.state.fault = 'lost'
  await f.page.clock.runFor(readingDelay(state.checkpoint.feedback) + 100)
  await f.page.locator('.vn-error').waitFor()
  const failedCount = f.state.calls.length
  await f.page.clock.runFor(60000)
  assert.equal(f.state.calls.length, failedCount, 'failed auto advance must not loop')
  await response(f.page, () => f.page.locator('.vn-dialogue-target').click(), '/advance')
  assert.deepEqual(f.state.calls.at(-1).body, f.state.calls.at(-2).body)
  state = await saved(f)
  assert.equal(state.sceneId, scenes.get(f.session.sceneId).nextSceneId)
  assert.equal(state.dialogueIndex, 0)
  evidence.push({ check: 'Lost answer/automatic advance recovery through shared dialogue, exact bodies, Menu/pending suppression', result: 'PASS' })
  await f.context.close()

  const stale = await start(browser)
  await post(stale.context.request, `/api/sessions/${stale.session.sessionId}/answers`, { request_id: id(), expected_version: stale.session.version, questionId: q.questionId, optionId: right.optionId })
  stale.state.failGet = true
  await stale.page.getByRole('button', { name: wrong.label, exact: true }).click()
  await stale.page.locator('.vn-error').waitFor()
  assert.equal(await stale.page.locator('.vn-choice:enabled').count(), 0)
  stale.state.failGet = false
  await stale.page.locator('.vn-dialogue-target').click()
  await stale.page.waitForFunction(() => !document.querySelector('.vn-error'))
  assert.equal(stale.state.calls.length, 1)
  evidence.push({ check: 'Conflict reload failure locks choices; shared dialogue reload recovers without resubmitting', result: 'PASS' })
  await stale.context.close()

  const invalid = await start(browser)
  invalid.state.fault = 'invalid'
  await response(invalid.page, () => invalid.page.getByRole('button', { name: wrong.label, exact: true }).click(), '/answers')
  await invalid.page.locator('.vn-error').waitFor()
  assert.equal((await saved(invalid)).quizAttempts.length, 0)
  await invalid.page.locator('.vn-dialogue-target').click()
  await invalid.page.waitForFunction(() => !document.querySelector('.vn-error'))
  assert.equal(invalid.state.calls.length, 1, 'validation recovery reloads without another answer')
  assert.equal(await invalid.page.locator('.vn-choice:enabled').count(), q.options.length)
  evidence.push({ check: 'Rejected option uses shared dialogue recovery without burning an attempt', result: 'PASS' })
  await invalid.context.close()
}
async function layouts(browser) {
  for (const viewport of [{ width: 390, height: 844 }, { width: 800, height: 1024 }, { width: 1280, height: 800 }, { width: 320, height: 568 }, { width: 844, height: 390 }]) {
    const f = await fixture(browser, viewport)
    f.session = await parked(f.context.request)
    await f.page.route('**/api/episodes/*', async route => {
      const result = await route.fetch(), data = await result.json()
      const q = data.scenes.find(s => s.sceneId === f.session.sceneId).question
      q.prompt = 'Verification fixture long question: '.repeat(30)
      q.options = q.options.slice(0, 2)
      q.options.push({ optionId: 'extra1', label: 'Long verification response about writing and materials. '.repeat(8) }, { optionId: 'extra2', label: 'Another verification response with detail for short screens. '.repeat(3) })
      await route.fulfill({ response: result, json: data })
    })
    await f.go(f.session)
    await f.page.addStyleTag({ content: 'html { font-size: 20px; }' })
    assert.equal(await f.page.locator('.vn-dialogue-target .vn-text').count(), 1)
    assert.equal(await f.page.locator('.vn-choice').count(), 4)
    assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    for (const choice of await f.page.locator('.vn-choice').all()) {
      await choice.scrollIntoViewIfNeeded(); const box = await choice.boundingBox()
      assert.ok(box.height >= 44 && box.width >= 44)
    }
    const choice = f.page.locator('.vn-choice').last()
    await choice.focus()
    assert.equal(await choice.evaluate(el => getComputedStyle(el).outlineStyle), 'solid')
    const geometry = await f.page.evaluate(() => {
      const box = selector => document.querySelector(selector).getBoundingClientRect()
      const tag = box('.vn-speaker'), panel = box('.vn-dialogue'), menu = box('.vn-menu-rail'), frame = box('.vn-frame')
      return { tagLeft: tag.left - panel.left, tagTop: tag.top - panel.top, tagWidth: tag.width, panelWidth: panel.width,
        menuTop: menu.top - frame.top, menuRight: frame.right - menu.right, railBelow: menu.top >= panel.bottom, bottomGap: frame.bottom - panel.bottom }
    })
    assert.ok(geometry.tagLeft >= 0 && geometry.tagLeft <= 35 && geometry.tagTop >= 0 && geometry.tagTop <= 30)
    assert.ok(geometry.tagWidth < geometry.panelWidth * .8)
    if (viewport.width >= 1000) assert.ok(geometry.menuTop === 0 && geometry.menuRight === 0 && geometry.bottomGap <= 21)
    else assert.ok(geometry.railBelow)
    await f.page.locator('.vn-dialogue-scroll-area').evaluate(el => { el.scrollTop = el.scrollHeight })
    await f.page.getByRole('button', { name: 'Menu', exact: true }).click(); await f.page.keyboard.press('Escape')
    await f.page.screenshot({ path: path.join(output, `layout-${viewport.width}x${viewport.height}.png`), fullPage: true })
    evidence.push({ check: `${viewport.width}x${viewport.height}: shared dialogue, four long choices, enlarged text, Menu geometry/focus`, result: 'PASS' })
    await f.context.close()
  }
}
async function timerAndInput(browser) {
  const f = await start(browser, { motion: 'no-preference' })
  const q = scenes.get(f.session.sceneId).question
  const wrong = q.options.find(o => o.optionId !== q.correctOptionId), right = q.options.find(o => o.optionId === q.correctOptionId)
  assert.ok((await f.page.locator('.vn-text-rest').textContent()).length > 0)
  await f.page.locator('.vn-dialogue-target').click()
  assert.equal(await f.page.locator('.vn-text-rest').textContent(), '')
  assert.equal(f.state.calls.length, 0, 'question activation only reveals')
  await f.page.getByRole('button', { name: wrong.label, exact: true }).focus()
  await response(f.page, () => f.page.keyboard.press('Enter'), '/answers')
  let state = await saved(f); await waitFeedback(f, state.checkpoint.feedback)
  assert.ok((await f.page.locator('.vn-text-rest').textContent()).length > 0)
  assert.equal(await f.page.locator('.vn-choice:enabled').count(), q.options.length - 1)
  assert.equal(await f.page.getByRole('button', { name: wrong.label }).evaluate(el => el.disabled), true)
  await f.page.getByRole('button', { name: right.label, exact: true }).focus()
  await response(f.page, () => f.page.keyboard.press('Space'), '/answers')
  state = await saved(f); await waitFeedback(f, state.checkpoint.feedback)
  assert.ok(await f.page.locator('.vn-choice[data-selected]').evaluate(el => el.getAnimations().length > 0))
  const count = f.state.calls.length
  await f.page.getByRole('button', { name: 'Menu', exact: true }).click()
  await f.page.clock.runFor(state.checkpoint.feedback.length * 18 + 200)
  assert.equal(f.state.calls.length, count, 'reveal can finish under Menu without advancing')
  await f.page.keyboard.press('Escape')
  const delay = readingDelay(state.checkpoint.feedback)
  await f.page.clock.runFor(delay - 500)
  await f.page.locator('.vn-dialogue-scroll-area').dispatchEvent('wheel', { deltaY: 100 })
  await f.page.clock.runFor(600)
  assert.equal(f.state.calls.length, count, 'manual reading restarts full delay')
  await f.page.getByRole('button', { name: 'Menu', exact: true }).click()
  await f.page.clock.runFor(delay * 2)
  assert.equal(f.state.calls.length, count)
  await f.page.keyboard.press('Escape')
  await f.page.clock.runFor(delay - 1200)
  assert.equal(f.state.calls.length, count, 'Menu resumes remaining time, not time spent hidden')
  // Visibility is injected only in this isolated test to deterministically exercise hidden-time accounting.
  await f.page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) })
  await f.page.clock.runFor(delay * 2)
  assert.equal(f.state.calls.length, count)
  await f.page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')) })
  await advanceAfterReading(f, state)
  await f.page.clock.runFor(delay * 2)
  assert.equal(f.state.calls.length, count + 1, 'one automatic transition only')
  evidence.push({ check: 'Enter/Space, progressive shared turns, immediate second selection, reveal-before-delay, scrolling reset, Menu/visibility pause and single advance', result: 'PASS' })
  await f.context.close()

  const touch = await start(browser, { extra: { hasTouch: true, isMobile: true } })
  await response(touch.page, () => touch.page.getByRole('button', { name: right.label, exact: true }).tap(), '/answers')
  const completed = await saved(touch); await waitFeedback(touch, completed.checkpoint.feedback)
  assert.equal(await touch.page.locator('.vn-text-rest').textContent(), '')
  assert.equal(await touch.page.locator('.vn-choice[data-selected]').evaluate(el => el.getAnimations().length), 0)
  await advanceAfterReading(touch, completed)
  evidence.push({ check: 'Touch and reduced motion: full turn, no bounce, automatic continuation', result: 'PASS' })
  await touch.context.close()

  const minimum = await start(browser)
  await minimum.page.route('**/api/sessions/*/answers', async route => {
    const result = await route.fetch(), data = await result.json()
    data.checkpoint.feedback = 'Correct.' // Short-text presentation fixture; grading still uses real FastAPI.
    await route.fulfill({ response: result, json: data })
  })
  await response(minimum.page, () => minimum.page.getByRole('button', { name: right.label, exact: true }).click(), '/answers')
  await waitFeedback(minimum, 'Correct.')
  await minimum.page.clock.runFor(2999)
  assert.equal(minimum.state.calls.length, 0, 'short feedback gets at least three seconds')
  const advanced = minimum.page.waitForResponse(r => r.url().endsWith('/advance'))
  await minimum.page.clock.runFor(2); await advanced
  evidence.push({ check: 'Short feedback fixture enforces the three-second minimum reading delay', result: 'PASS' })
  await minimum.context.close()

  for (const duringAnswer of [true, false]) {
    const leaving = await start(browser)
    let release
    if (duringAnswer) leaving.state.gate = new Promise(resolve => { release = resolve })
    await leaving.page.getByRole('button', { name: right.label, exact: true }).click()
    if (!duringAnswer) await leaving.page.waitForFunction(() => document.querySelectorAll('.vn-choice[data-correct]').length === 1)
    await leaving.page.getByRole('button', { name: 'Menu', exact: true }).click()
    await leaving.page.getByRole('button', { name: 'Leave episode', exact: true }).click()
    await leaving.page.locator('.learner').waitFor()
    if (release) { release(); leaving.state.gate = null }
    const before = leaving.state.calls.length
    await leaving.page.clock.runFor(60000)
    assert.equal(await leaving.page.locator('.vn-frame').count(), 0)
    assert.equal(leaving.state.calls.length, before)
    await leaving.context.close()
  }
  evidence.push({ check: 'Exit cancels reading timer and ignores late answer responses', result: 'PASS' })
}
async function main() {
  const browser = await chromium.launch({ channel: process.env.PLAYER_VERIFY_BROWSER || 'msedge', headless: true })
  try { await liveOutcomes(browser); await recovery(browser); await layouts(browser); await timerAndInput(browser); assert.deepEqual(errors, []) }
  finally { await browser.close(); fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ evidence, errors }, null, 2)) }
  console.log(JSON.stringify({ passed: evidence.length, output, errors }, null, 2))
}
main().catch(error => { console.error(error); process.exitCode = 1 })

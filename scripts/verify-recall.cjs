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
    return route.continue()
  })
  const go = async session => { await page.goto(`${base}/?session=${session.sessionId}`); await page.locator('.vn-choices').waitFor() }
  return { page, context, state, go }
}
async function response(page, action, suffix) {
  const wait = page.waitForResponse(r => r.url().endsWith(suffix) && r.request().method() === 'POST')
  await action(); await wait
}
async function liveOutcomes(browser) {
  for (const outcome of ['correct-first', 'wrong-correct', 'wrong-wrong']) {
    const f = await fixture(browser)
    let session = await parked(f.context.request)
    await f.go(session)
    for (const sceneId of ['scene-03-checkpoint-1', 'scene-05-checkpoint-2']) {
      const question = scenes.get(sceneId).question
      const right = question.options.find(o => o.optionId === question.correctOptionId)
      const wrong = question.options.find(o => o.optionId !== question.correctOptionId)
      const options = outcome === 'correct-first' ? [right] : [wrong, outcome === 'wrong-correct' ? right : wrong]
      for (let attempt = 0; attempt < options.length; attempt++) {
        const option = options[attempt]
        if (attempt) { await f.page.getByRole('button', { name: 'Retry', exact: true }).click() }
        const nodBefore = Number(await f.page.locator('.mascot').getAttribute('data-nod-trigger'))
        await response(f.page, () => f.page.getByRole('button', { name: option.label, exact: true }).click(), '/answers')
        await f.page.locator('.vn-feedback p').first().waitFor()
        await f.page.waitForTimeout(60)
        const state = await (await f.context.request.get(`${base}/api/sessions/${session.sessionId}`)).json()
        assert.equal(state.checkpoint.attemptsUsed, attempt + 1)
        assert.equal(await f.page.locator('.mascot').getAttribute('data-emotion'), option === right ? 'happy' : 'confused')
        assert.equal(Number(await f.page.locator('.mascot').getAttribute('data-nod-trigger')), nodBefore + (option === right ? 1 : 0))
        if (!state.checkpoint.checkpointCompleted) {
          assert.equal(await f.page.getByRole('button', { name: 'Continue', exact: true }).count(), 0)
          assert.ok(!('correctOptionId' in state.checkpoint))
          assert.equal(await f.page.locator('.vn-choice:enabled').count(), 0)
        }
        await f.page.reload()
        await f.page.locator('.vn-feedback p').first().waitFor()
        assert.equal(Number(await f.page.locator('.mascot').getAttribute('data-nod-trigger')), 0, 'reload must not replay a historical nod')
        assert.equal(await f.page.locator('.vn-feedback').innerText().then(t => t.includes(state.checkpoint.feedback)), true)
      }
      await f.page.screenshot({ path: path.join(output, `${outcome}-${sceneId}.png`), fullPage: true })
      await response(f.page, () => f.page.getByRole('button', { name: 'Continue', exact: true }).click(), '/advance')
      session = await (await f.context.request.get(`${base}/api/sessions/${session.sessionId}`)).json()
      assert.equal(session.sceneId, scenes.get(sceneId).nextSceneId)
      if (sceneId === 'scene-03-checkpoint-1') {
        while (session.mode === 'playing') {
          await response(f.page, () => f.page.locator('.vn-dialogue-target').click(), '/advance')
          session = await (await f.context.request.get(`${base}/api/sessions/${session.sessionId}`)).json()
        }
        assert.equal(session.sceneId, 'scene-05-checkpoint-2')
      }
    }
    assert.equal(session.learningNotes.length, outcome === 'wrong-wrong' ? 2 : 0)
    evidence.push({ check: `Live Episode 1: ${outcome}, both checkpoints, reload, notes, nod and Continue`, result: 'PASS' })
    await f.context.close()
  }
}
async function recovery(browser) {
  const f = await fixture(browser, undefined, 'no-preference')
  const session = await parked(f.context.request)
  await f.go(session)
  const q = scenes.get(session.sceneId).question
  const wrong = q.options.find(o => o.optionId !== q.correctOptionId)
  f.state.fault = 'lost'
  await f.page.getByRole('button', { name: wrong.label, exact: true }).click()
  await f.page.getByRole('button', { name: 'Retry submission' }).waitFor({ state: 'visible' })
  await f.page.locator('.vn-error').waitFor()
  assert.equal(await f.page.locator('.vn-choice:enabled').count(), 0)
  await response(f.page, () => f.page.getByRole('button', { name: 'Retry submission' }).click(), '/answers')
  assert.deepEqual(f.state.calls[0].body, f.state.calls[1].body)
  await f.page.getByRole('button', { name: 'Retry', exact: true }).waitFor()
  let saved = await (await f.context.request.get(`${base}/api/sessions/${session.sessionId}`)).json()
  assert.equal(saved.quizAttempts.length, 1)
  await f.page.getByRole('button', { name: 'Retry', exact: true }).click()
  let release
  f.state.gate = new Promise(resolve => { release = resolve })
  const right = q.options.find(o => o.optionId === q.correctOptionId)
  await f.page.getByRole('button', { name: right.label, exact: true }).click()
  assert.equal(await f.page.locator('.vn-choice:enabled').count(), 0)
  await f.page.getByRole('button', { name: 'Menu', exact: true }).click()
  const count = f.state.calls.length
  release(); f.state.gate = null
  await f.page.getByRole('button', { name: 'Continue', exact: true }).waitFor()
  assert.equal(f.state.calls.length, count)
  assert.equal(await f.page.evaluate(() => document.activeElement.textContent), 'Close')
  await f.page.keyboard.press('Escape')
  assert.equal(await f.page.evaluate(() => document.activeElement.textContent.trim()), 'Menu')
  f.state.fault = 'lost'
  await f.page.getByRole('button', { name: 'Continue', exact: true }).click()
  await f.page.locator('.vn-error').waitFor()
  await response(f.page, () => f.page.getByRole('button', { name: 'Continue', exact: true }).click(), '/advance')
  assert.deepEqual(f.state.calls.at(-1).body, f.state.calls.at(-2).body)
  saved = await (await f.context.request.get(`${base}/api/sessions/${session.sessionId}`)).json()
  assert.equal(saved.sceneId, scenes.get(session.sceneId).nextSceneId)
  assert.equal(saved.dialogueIndex, 0)
  evidence.push({ check: 'Lost answer/Continue responses retain bodies; no extra attempt/advance; pending suppression and Menu focus', result: 'PASS' })
  await f.context.close()

  const stale = await fixture(browser)
  const old = await parked(stale.context.request)
  await stale.go(old)
  await post(stale.context.request, `/api/sessions/${old.sessionId}/answers`, { request_id: id(), expected_version: old.version, questionId: q.questionId, optionId: right.optionId })
  stale.state.failGet = true
  await stale.page.getByRole('button', { name: wrong.label, exact: true }).click()
  await stale.page.getByRole('button', { name: 'Reload checkpoint' }).waitFor()
  assert.equal(await stale.page.locator('.vn-choice:enabled').count(), 0)
  stale.state.failGet = false
  await stale.page.getByRole('button', { name: 'Reload checkpoint' }).click()
  await stale.page.getByRole('button', { name: 'Continue', exact: true }).waitFor()
  assert.equal(stale.state.calls.length, 1)
  evidence.push({ check: 'Stale version reload failure remains locked; reload restores completed checkpoint without resubmission', result: 'PASS' })
  await stale.context.close()
}
async function layouts(browser) {
  for (const viewport of [{ width: 390, height: 844 }, { width: 800, height: 1024 }, { width: 1280, height: 800 }, { width: 320, height: 568 }, { width: 844, height: 390 }]) {
    const f = await fixture(browser, viewport)
    const session = await parked(f.context.request)
    await f.page.route('**/api/episodes/*', async route => {
      const response = await route.fetch(); const data = await response.json()
      const q = data.scenes.find(s => s.sceneId === session.sceneId).question
      q.prompt = 'Verification fixture: ' + q.prompt
      q.options = [...q.options.slice(0, 2), { optionId: 'extra1', label: 'An additional long response about the importance of understanding what people wrote and why they used available materials. '.repeat(2) }, { optionId: 'extra2', label: 'Another long response with more detail, so every returned option must remain reachable even in a short or narrow viewport.' }]
      await route.fulfill({ response, json: data })
    })
    await f.go(session)
    await f.page.addStyleTag({ content: 'html { font-size: 20px; }' })
    assert.equal(await f.page.locator('.vn-choice').count(), 4)
    const width = await f.page.evaluate(() => document.documentElement.scrollWidth)
    assert.ok(width <= viewport.width + 1, `${width} overflows ${viewport.width}`)
    for (const choice of await f.page.locator('.vn-choice').all()) {
      await choice.scrollIntoViewIfNeeded(); const box = await choice.boundingBox()
      assert.ok(box.height >= 44 && box.width >= 44)
      assert.ok(await choice.isVisible())
    }
    const last = f.page.locator('.vn-choice').last()
    await last.focus()
    assert.equal(await last.evaluate(el => getComputedStyle(el).outlineStyle), 'solid')
    const prompt = f.page.locator('#checkpoint-prompt')
    await prompt.scrollIntoViewIfNeeded()
    assert.ok(await prompt.isVisible())
    await f.page.getByRole('button', { name: 'Menu', exact: true }).click()
    await f.page.keyboard.press('Escape')
    await f.page.screenshot({ path: path.join(output, `layout-${viewport.width}x${viewport.height}.png`), fullPage: true })
    evidence.push({ check: `${viewport.width}x${viewport.height}: four wrapping options, 125% text, prompt, focus and Menu`, result: 'PASS' })
    await f.context.close()
  }
}
async function keyboardTouchAndExit(browser) {
  const f = await fixture(browser, undefined, 'no-preference')
  const session = await parked(f.context.request)
  await f.go(session)
  const q = scenes.get(session.sceneId).question
  const wrong = q.options.find(o => o.optionId !== q.correctOptionId)
  const right = q.options.find(o => o.optionId === q.correctOptionId)
  await f.page.getByRole('button', { name: wrong.label, exact: true }).focus()
  await response(f.page, () => f.page.keyboard.press('Enter'), '/answers')
  const retry = f.page.getByRole('button', { name: 'Retry', exact: true })
  await retry.focus(); await f.page.keyboard.press('Space')
  await f.page.getByRole('button', { name: right.label, exact: true }).focus()
  await response(f.page, () => f.page.keyboard.press('Space'), '/answers')
  await f.page.getByRole('button', { name: 'Continue', exact: true }).waitFor()
  assert.ok(await f.page.locator('.mascot-body').evaluate(el => el.getAnimations().length > 0), 'correct answer nod must animate once')
  const headingBefore = await f.page.locator('.vn-checkpoint-heading').boundingBox()
  await f.page.locator('.vn-checkpoint-reading').evaluate(el => { el.scrollTop = el.scrollHeight })
  assert.deepEqual(await f.page.locator('.vn-checkpoint-heading').boundingBox(), headingBefore)
  await f.page.getByRole('button', { name: 'Continue', exact: true }).focus()
  await response(f.page, () => f.page.keyboard.press('Enter'), '/advance')
  evidence.push({ check: 'Enter/Space answer, Retry and Continue; one real nod; prompt stays visible during feedback scroll', result: 'PASS' })
  await f.context.close()

  const touch = await fixture(browser, undefined, 'reduce', { hasTouch: true, isMobile: true })
  const s = await parked(touch.context.request)
  await touch.go(s)
  await response(touch.page, () => touch.page.getByRole('button', { name: right.label, exact: true }).tap(), '/answers')
  await touch.page.getByRole('button', { name: 'Continue', exact: true }).waitFor()
  assert.equal(await touch.page.locator('.mascot-body').evaluate(el => el.getAnimations().length), 0)
  await response(touch.page, () => touch.page.getByRole('button', { name: 'Continue', exact: true }).tap(), '/advance')
  evidence.push({ check: 'Touch answer/Continue and reduced-motion nod suppression', result: 'PASS' })
  await touch.context.close()

  const leaving = await fixture(browser)
  await leaving.go(await parked(leaving.context.request))
  let release
  leaving.state.gate = new Promise(resolve => { release = resolve })
  await leaving.page.getByRole('button', { name: right.label, exact: true }).click()
  await leaving.page.getByRole('button', { name: 'Menu', exact: true }).click()
  await leaving.page.getByRole('button', { name: 'Leave episode', exact: true }).click()
  await leaving.page.locator('.learner').waitFor()
  release(); leaving.state.gate = null
  await leaving.page.waitForTimeout(300)
  assert.equal(await leaving.page.locator('.vn-frame').count(), 0)
  evidence.push({ check: 'Leaving during an answer ignores the late response', result: 'PASS' })
  await leaving.context.close()
}
async function main() {
  const browser = await chromium.launch({ channel: process.env.PLAYER_VERIFY_BROWSER || 'msedge', headless: true })
  try { await liveOutcomes(browser); await recovery(browser); await layouts(browser); await keyboardTouchAndExit(browser); assert.deepEqual(errors, []) }
  finally { await browser.close(); fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ evidence, errors }, null, 2)) }
  console.log(JSON.stringify({ passed: evidence.length, output, errors }, null, 2))
}
main().catch(error => { console.error(error); process.exitCode = 1 })

// Run against Vite with Playwright available through Node's module search path.
// All API responses are isolated fixtures; no backend or model requests occur.
const { chromium } = (() => { try { return require('playwright') } catch { return require('playwright-core') } })()
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const base = process.env.PLAYER_VERIFY_URL || 'http://127.0.0.1:5173'
const output = process.env.PLAYER_VERIFY_OUTPUT || path.join(os.tmpdir(), 'justmaya-portrait-menu')
fs.mkdirSync(output, { recursive: true })
const evidence = []
const errors = []
const longText = 'Cities grew around rivers and shared work. Explain how water, food, and cooperation shaped the earliest settlements. '.repeat(7)
const episode = {
  episodeId: 'fixture-episode', title: 'Verification fixture: Ancient settlements', status: 'ready', startSceneId: 'intro',
  scenes: [
    { sceneId: 'intro', kind: 'dialogue', nextSceneId: 'checkpoint', question: null, dialogue: [
      { lineId: 'one', speaker: 'mascot', text: 'Rivers shaped the first cities. Let us follow how people learned to work together.', emotion: 'talking', sourceRefs: ['PRIVATE-REFERENCE'] },
      { lineId: 'two', speaker: 'narrator', text: 'Water made farming possible, and shared work supported growing communities.', emotion: 'idle' },
    ] },
    { sceneId: 'checkpoint', kind: 'checkpoint', nextSceneId: 'ending', dialogue: [], question: { questionId: 'q', prompt: 'Why did early settlements grow near rivers?', options: [{ optionId: 'a', label: 'Water and farming' }, { optionId: 'b', label: 'No shared work' }] } },
    { sceneId: 'ending', kind: 'ending', nextSceneId: null, question: null, dialogue: [{ lineId: 'end', speaker: 'mascot', text: 'You have reached the end of this episode.', emotion: 'happy' }] },
  ], learningObjectives: [], estimatedMinutes: 1,
}

async function fixture(browser, options = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', ...options.context })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('Failed to load resource')) errors.push(message.text()) })
  const state = {
    session: { sessionId: 'fixture-session', episodeId: episode.episodeId, mode: 'playing', sceneId: 'intro', dialogueIndex: 0, version: 1, status: 'active', updatedAt: '2026-10-28T00:00:00Z', ...options.session },
    episode: structuredClone(episode), calls: [], next: 'ok', gate: null, loadGate: null, loadError: 0,
  }
  if (options.long) { state.episode.title = 'Verification fixture: '.repeat(9); state.episode.scenes[0].dialogue[0].text = longText }
  const accepted = new Map()
  function advance() {
    state.session.version++
    if (state.session.sceneId === 'ending') { state.session.mode = 'completed'; state.session.status = 'completed' }
    else if (state.session.dialogueIndex === 0) state.session.dialogueIndex = 1
    else { state.session.sceneId = 'checkpoint'; state.session.dialogueIndex = 0; state.session.mode = 'checkpoint' }
  }
  await page.route('**/api/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const call = { path: url.pathname, method: request.method(), body: request.postDataJSON() }
    state.calls.push(call)
    if (url.pathname.endsWith('/advance')) {
      if (state.gate) await state.gate
      const outcome = state.next
      state.next = 'ok'
      if (outcome === 'fail') return route.fulfill({ status: 503, json: { error: { message: 'Fixture connection interrupted.' } } })
      if (outcome === 'conflict') {
        advance()
        return route.fulfill({ status: 409, json: { error: { code: 'SESSION_CONFLICT', message: 'Fixture version conflict.' } } })
      }
      if (!accepted.has(call.body.request_id)) { advance(); accepted.set(call.body.request_id, structuredClone(state.session)) }
      return route.fulfill({ json: accepted.get(call.body.request_id) })
    }
    if (url.pathname.includes('/sessions/')) {
      if (state.loadGate) await state.loadGate
      if (state.loadError) return route.fulfill({ status: state.loadError, json: { error: { message: 'Fixture session unavailable.' } } })
      return route.fulfill({ json: state.session })
    }
    assert.equal(url.pathname, '/api/episodes/fixture-episode', 'Unexpected API route')
    return route.fulfill({ json: state.episode })
  })
  const go = async () => { await page.goto(`${base}/?session=fixture-session`); await page.locator('.vn-frame').waitFor() }
  const count = () => state.calls.filter(call => call.method === 'POST').length
  return { context, page, state, go, count }
}

async function layout(page) {
  return page.evaluate(() => {
    const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right } }
    const dialogue = box('.vn-dialogue'), rail = box('.vn-menu-rail'), frame = box('.vn-frame')
    const target = document.querySelector('.vn-dialogue-scroll-area')
    const style = target && getComputedStyle(target)
    return {
      dialogue, rail, frame, width: innerWidth, height: innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      dialogueTarget: target && { height: target.getBoundingClientRect().height, clientHeight: target.clientHeight, scrollHeight: target.scrollHeight, clientWidth: target.clientWidth, scrollWidth: target.scrollWidth, scrollTop: target.scrollTop, overflowY: style.overflowY, scrollbarWidth: style.scrollbarWidth },
    }
  })
}

function assertMenuPlacement(layout) {
  if (layout.width < 1000) return assert.ok(layout.dialogue.bottom <= layout.rail.y + 1)
  assert.ok(layout.rail.y - layout.frame.y <= 1, 'desktop Menu is at frame top')
  assert.ok(Math.abs(layout.rail.right - layout.frame.right) <= 1, 'desktop Menu is at frame right')
  assert.ok(layout.frame.bottom - layout.dialogue.bottom <= 21, 'desktop has no reserved bottom Menu space')
}

async function revealBoundary(page) {
  return page.evaluate(() => {
    const target = document.querySelector('.vn-dialogue-scroll-area')
    const marker = document.querySelector('.vn-reveal-boundary')
    const speaker = target?.querySelector('.vn-speaker')
    if (!target || !marker || !speaker) return null
    const targetRect = target.getBoundingClientRect()
    const markerRect = marker.getBoundingClientRect()
    const speakerRect = speaker.getBoundingClientRect()
    const viewTop = targetRect.top + target.clientTop
    const readingTop = speakerRect.bottom + 8
    const readingBottom = viewTop + target.clientHeight - 8
    return {
      scrollTop: target.scrollTop,
      markerTop: markerRect.top,
      markerBottom: markerRect.bottom,
      readingTop,
      readingBottom,
      markerVisible: markerRect.top >= readingTop - 1 && markerRect.bottom <= readingBottom + 1,
    }
  })
}

async function contrastCheck(page) {
  const samples = await page.evaluate(() => {
    const style = selector => getComputedStyle(document.querySelector(selector))
    const frame = style('.vn-frame')
    return {
      text: style('.vn-text').color, dialogue: style('.vn-dialogue').backgroundColor,
      scrollbar: style('.vn-dialogue-scroll-area').scrollbarColor,
      speaker: style('.vn-speaker').color, nameplate: style('.vn-speaker').backgroundColor,
      headerText: style('.player-title').color, header: style('.player-header').backgroundColor,
      menuText: style('.vn-menu-trigger').color, menu: style('.vn-menu-trigger').backgroundColor,
      modalText: style('.vn-menu-dialog').color, modal: style('.vn-menu-dialog').backgroundColor,
      leaveText: style('.vn-menu-leave').color, leave: style('.vn-menu-leave').backgroundColor,
      standin: style('.mascot-standin').color,
      stages: [frame.getPropertyValue('--stage-a').trim(), frame.getPropertyValue('--stage-b').trim()],
    }
  })
  const rgb = value => value.startsWith('#') ? value.slice(1).match(/../g).map(v => parseInt(v, 16)) : value.match(/[\d.]+/g).map(Number)
  const luminance = color => color.slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((n, v, i) => n + v * [.2126, .7152, .0722][i], 0)
  const ratio = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05) }
  const foreground = rgb(samples.dialogue), alpha = foreground[3]
  const results = {
    dialogue: Math.min(...samples.stages.map(stage => ratio(rgb(samples.text), rgb(stage).map((v, i) => foreground[i] * alpha + v * (1 - alpha))))),
    scrollbar: Math.min(...samples.stages.map(stage => ratio(rgb(samples.scrollbar), foreground.slice(0, 3).map((v, i) => v * alpha + rgb(stage)[i] * (1 - alpha))))),
    speaker: ratio(rgb(samples.speaker), rgb(samples.nameplate)),
    header: ratio(rgb(samples.headerText), rgb(samples.header)),
    menu: ratio(rgb(samples.menuText), rgb(samples.menu)),
    modal: ratio(rgb(samples.modalText), rgb(samples.modal)),
    leave: ratio(rgb(samples.leaveText), rgb(samples.leave)),
    standin: Math.min(...samples.stages.map(stage => ratio(rgb(samples.standin), rgb(stage)))),
  }
  for (const [name, value] of Object.entries(results)) assert.ok(value >= (name === 'scrollbar' ? 3 : 4.5), `${name} contrast ${value}`)
  return results
}

async function modalCheck(page, count) {
  const before = count()
  const menu = page.getByRole('button', { name: 'Menu', exact: true })
  await menu.click()
  const dialog = page.getByRole('dialog', { name: 'Episode menu' })
  await dialog.waitFor()
  await page.waitForFunction(() => document.activeElement?.textContent === 'Close')
  const measurements = await dialog.evaluate(el => {
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height, vw: innerWidth, vh: innerHeight, backdrop: getComputedStyle(el, '::backdrop').backgroundColor }
  })
  assert.ok(Math.abs(measurements.x + measurements.width / 2 - measurements.vw / 2) < 2)
  assert.ok(Math.abs(measurements.y + measurements.height / 2 - measurements.vh / 2) < 2)
  assert.equal(measurements.backdrop, 'rgba(15, 15, 29, 0.68)')
  await page.screenshot({ path: path.join(output, `menu-${measurements.vw}x${measurements.vh}.png`) })
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press(i < 6 ? 'Tab' : 'Shift+Tab')
    assert.ok(await page.evaluate(() => !!document.activeElement?.closest('dialog')), 'Focus escaped the dialog')
  }
  await page.mouse.click(3, 3)
  assert.ok(await dialog.isVisible(), 'Backdrop should keep modal open')
  assert.equal(count(), before, 'Menu/background click sent an advance')
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-haspopup') === 'dialog')
  assert.equal(await dialog.isVisible(), false)
  await menu.click()
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  assert.equal(count(), before)
  return measurements
}

async function main() {
  const browser = await chromium.launch({ channel: process.env.PLAYER_VERIFY_BROWSER || 'msedge', headless: true })
  try {
    for (const [width, height] of [[390, 844], [320, 568], [844, 390], [800, 1024], [1280, 800]]) {
      const f = await fixture(browser, { context: { viewport: { width, height } } })
      await f.go()
      if (width === 390) evidence.push({ check: 'computed contrast across stage gradient endpoints', ratios: await contrastCheck(f.page), result: 'PASS' })
      const normal = await layout(f.page)
      if (width === 390) { assert.equal(normal.frame.height, height); assert.equal(normal.frame.x, 0); assert.ok(normal.rail.bottom <= height + 1) }
      assertMenuPlacement(normal)
      assert.equal(normal.dialogueTarget.overflowY, 'auto')
      if (width === 390) assert.ok(normal.dialogueTarget.scrollHeight <= normal.dialogueTarget.clientHeight + 1, 'A short line should not display an overflow scrollbar')
      await modalCheck(f.page, f.count)
      await f.page.screenshot({ path: path.join(output, `${width}x${height}.png`), fullPage: true })
      f.state.episode.scenes[0].dialogue[0].text = longText
      f.state.episode.title = 'Verification fixture long title '.repeat(9)
      await f.page.reload()
      await f.page.locator('.vn-dialogue-target').waitFor()
      const rootSize = await f.page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))
      await f.page.addStyleTag({ content: `:root { font-size: ${rootSize * 2}px !important; }` })
      const long = await layout(f.page)
      assert.ok(long.scrollWidth <= width + 1, `Horizontal overflow at ${width}: ${long.scrollWidth}`)
      assert.ok(long.dialogueTarget.scrollHeight > long.dialogueTarget.clientHeight + 1, `Long line did not overflow its dialogue at ${width}x${height}`)
      assert.ok(long.dialogueTarget.scrollWidth <= long.dialogueTarget.clientWidth + 1, `Horizontal dialogue overflow at ${width}x${height}`)
      assert.equal(long.dialogueTarget.scrollbarWidth, 'thin')
      assert.equal(long.dialogue.height, normal.dialogue.height, `Dialogue height changed with long text at ${width}x${height}`)
      assertMenuPlacement(long)
      const viewport = f.page.locator('.vn-dialogue-scroll-area')
      await viewport.evaluate(target => { target.scrollTop = target.scrollHeight })
      const pinned = await viewport.evaluate(target => {
        const speaker = target.querySelector('.vn-speaker').getBoundingClientRect()
        const button = target.closest('.vn-dialogue-target')
        const cue = button.querySelector('.vn-advance-cue').getBoundingClientRect()
        const box = target.getBoundingClientRect()
        const buttonBox = button.getBoundingClientRect()
        return { atEnd: target.scrollTop + target.clientHeight >= target.scrollHeight - 1, speakerInside: speaker.top >= box.top - 1 && speaker.bottom <= box.bottom + 1, cueInside: cue.top >= buttonBox.top - 1 && cue.bottom <= buttonBox.bottom + 1 }
      })
      assert.deepEqual(pinned, { atEnd: true, speakerInside: true, cueInside: true })
      const button = f.page.getByRole('button', { name: 'Menu', exact: true })
      await button.scrollIntoViewIfNeeded()
      await modalCheck(f.page, f.count)
      for (const name of ['Menu', 'Close', 'Leave episode']) {
        if (name === 'Close') await button.click()
        const bounds = await f.page.getByRole('button', { name, exact: true }).boundingBox()
        assert.ok(bounds.width >= 44 && bounds.height >= 44, `${name}: undersized touch target`)
      }
      await f.page.screenshot({ path: path.join(output, `${width}x${height}-long-200-menu.png`), fullPage: true })
      await f.page.keyboard.press('Escape')
      await f.page.getByRole('button', { name: 'Menu', exact: true }).click()
      await f.page.getByRole('button', { name: 'Leave episode', exact: true }).click()
      await f.page.locator('.learner').waitFor()
      assert.equal(new URL(f.page.url()).searchParams.has('session'), false)
      await f.go()
      assert.equal(f.state.session.version, 1)
      evidence.push({ check: `layout/menu/exit/restore ${width}x${height}`, normal, long, result: 'PASS' })
      await f.context.close()
    }

    const revealing = await fixture(browser, { context: { reducedMotion: 'no-preference' }, long: true })
    await revealing.go()
    const revealTarget = revealing.page.locator('.vn-dialogue-scroll-area')
    await revealing.page.waitForFunction(() => document.querySelector('.vn-dialogue-scroll-area')?.scrollTop > 100, undefined, { timeout: 15000 })
    let boundary = await revealBoundary(revealing.page)
    assert.ok(boundary?.markerVisible, 'Auto-follow should keep the active reveal boundary in the reading region')
    await revealTarget.hover()
    await revealing.page.mouse.wheel(0, -500)
    await revealing.page.waitForFunction(() => document.querySelector('.vn-dialogue-scroll-area')?.scrollTop === 0)
    await revealing.page.waitForTimeout(500)
    assert.equal(await revealTarget.evaluate(target => target.scrollTop), 0, 'Auto-follow should pause while the learner rereads earlier text')
    const reentryTop = await revealing.page.evaluate(() => {
      const target = document.querySelector('.vn-dialogue-scroll-area')
      const marker = document.querySelector('.vn-reveal-boundary').getBoundingClientRect()
      const bottom = target.getBoundingClientRect().top + target.clientHeight - 8
      target.scrollTop += marker.bottom - bottom + 48
      return target.scrollTop
    })
    await revealing.page.waitForTimeout(60)
    boundary = await revealBoundary(revealing.page)
    assert.ok(boundary?.markerVisible, `Returning to the current boundary should resume following: ${JSON.stringify({ reentryTop, boundary })}`)
    await revealing.page.waitForFunction(previous => document.querySelector('.vn-dialogue-scroll-area')?.scrollTop > previous, reentryTop, { timeout: 6000 })
    boundary = await revealBoundary(revealing.page)
    assert.ok(boundary?.markerVisible, 'Resumed following should keep the new reveal boundary visible')
    assert.equal(await revealing.page.locator('[aria-live="polite"]').count(), 1)
    assert.equal(await revealing.page.locator('.vn-text').getAttribute('aria-hidden'), 'true')
    assert.ok((await revealing.page.locator('[aria-live="polite"]').textContent()).endsWith(longText), 'Assistive technology should receive the complete line once')
    evidence.push({ check: 'long reveal follows its boundary, pauses on reread, resumes at latest text; single full-line live announcement', result: 'PASS' })
    await revealing.context.close()

    const scrollKeys = await fixture(browser, { context: { reducedMotion: 'reduce' }, long: true })
    await scrollKeys.go()
    const keyTarget = scrollKeys.page.locator('.vn-dialogue-target')
    const keyViewport = scrollKeys.page.locator('.vn-dialogue-scroll-area')
    assert.equal(await keyTarget.locator('.vn-text-rest').textContent(), '')
    await keyViewport.hover()
    await scrollKeys.page.mouse.wheel(0, 180)
    await scrollKeys.page.waitForFunction(() => document.querySelector('.vn-dialogue-scroll-area')?.scrollTop > 0)
    const afterPointerWheel = await keyViewport.evaluate(target => target.scrollTop)
    assert.equal(scrollKeys.count(), 0, 'Pointer scrolling must not activate dialogue')
    await keyTarget.focus()
    await keyTarget.press('ArrowDown')
    const afterArrowDown = await keyViewport.evaluate(target => target.scrollTop)
    assert.ok(afterArrowDown > afterPointerWheel)
    await keyTarget.press('PageDown')
    const afterPageDown = await keyViewport.evaluate(target => target.scrollTop)
    assert.ok(afterPageDown > afterArrowDown)
    await keyTarget.press('PageUp')
    assert.ok(await keyViewport.evaluate((target, previous) => target.scrollTop < previous, afterPageDown))
    await keyTarget.press('ArrowUp')
    await keyTarget.press('Home')
    assert.equal(await keyViewport.evaluate(target => target.scrollTop), 0)
    assert.equal(scrollKeys.count(), 0, 'Scroll keys must not activate dialogue')
    await keyTarget.press('End')
    assert.ok(await keyViewport.evaluate(target => target.scrollTop + target.clientHeight >= target.scrollHeight - 1))
    await keyTarget.press('Enter')
    await scrollKeys.page.waitForFunction(() => document.querySelector('.vn-text')?.textContent.includes('Water made farming possible'))
    assert.equal(await scrollKeys.page.locator('.vn-dialogue-scroll-area').evaluate(target => target.scrollTop), 0, 'A new line should start at the beginning')
    assert.equal(scrollKeys.count(), 1)
    await scrollKeys.page.locator('.vn-dialogue-target').press('Space')
    await scrollKeys.page.locator('.vn-choices').waitFor()
    assert.equal(scrollKeys.count(), 2)
    evidence.push({ check: 'pointer wheel and Arrow/Page/Home/End scrolling, Enter/Space activation, reduced motion and line reset', result: 'PASS' })
    await scrollKeys.context.close()

    const touchScroll = await fixture(browser, { context: { hasTouch: true, isMobile: true, reducedMotion: 'reduce' }, long: true })
    await touchScroll.go()
    const touchTarget = touchScroll.page.locator('.vn-dialogue-target')
    const touchViewport = touchScroll.page.locator('.vn-dialogue-scroll-area')
    const touchBounds = await touchViewport.boundingBox()
    const touchX = touchBounds.x + touchBounds.width / 2
    const touchY = touchBounds.y + touchBounds.height * .72
    const cdp = await touchScroll.context.newCDPSession(touchScroll.page)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: touchX, y: touchY, id: 1 }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: touchX, y: touchY - 96, id: 1 }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await touchScroll.page.waitForTimeout(100)
    assert.ok(await touchViewport.evaluate(target => target.scrollTop > 0), 'A touch drag should scroll the dialogue')
    assert.equal(touchScroll.count(), 0, 'A touch drag must not activate dialogue')
    await touchTarget.tap()
    await touchScroll.page.waitForFunction(() => document.querySelector('.vn-text')?.textContent.includes('Water made farming possible'))
    assert.equal(touchScroll.count(), 1, 'A tap should still activate dialogue')
    evidence.push({ check: 'touch drag scrolls without activation; tap still advances', result: 'PASS' })
    await touchScroll.context.close()

    for (const outcome of ['ok', 'fail', 'conflict']) {
      const f = await fixture(browser)
      await f.go()
      let release
      f.state.gate = new Promise(resolve => { release = resolve })
      f.state.next = outcome
      await f.page.locator('.vn-dialogue-target').click()
      await f.page.waitForFunction(() => document.querySelector('.vn-dialogue-target')?.getAttribute('aria-busy') === 'true')
      // Actual rapid pointer activations while the first request is held.
      await f.page.locator('.vn-dialogue-target').click({ clickCount: 3, force: true })
      await f.page.getByRole('button', { name: 'Menu', exact: true }).click()
      assert.equal(f.count(), 1)
      release()
      await f.page.waitForFunction(() => document.querySelector('.vn-dialogue-target')?.getAttribute('aria-busy') !== 'true')
      assert.ok(await f.page.evaluate(() => !!document.activeElement?.closest('dialog')))
      await f.page.keyboard.press('Escape')
      assert.equal(f.count(), 1)
      if (outcome === 'fail') {
        await f.page.getByRole('button', { name: 'Retry advancing dialogue' }).click()
        await f.page.waitForFunction(() => !document.querySelector('.vn-error'))
        const posts = f.state.calls.filter(call => call.method === 'POST')
        assert.equal(posts.length, 2)
        assert.equal(posts[0].body.request_id, posts[1].body.request_id)
      }
      assert.equal(f.state.session.dialogueIndex, 1)
      await f.page.reload()
      await f.page.locator('.vn-dialogue-target').waitFor()
      assert.equal(await f.page.locator('.vn-text').innerText(), episode.scenes[0].dialogue[1].text)
      assert.equal(await f.page.locator('body').innerText().then(text => text.includes('PRIVATE-REFERENCE')), false)
      evidence.push({ check: `pending ${outcome}, focus/retry/restore`, calls: f.state.calls, result: 'PASS' })
      await f.context.close()
    }

    const touch = await fixture(browser, { context: { hasTouch: true, isMobile: true, reducedMotion: 'no-preference' }, long: true })
    await touch.go()
    assert.ok(await touch.page.locator('.vn-text-rest').textContent())
    await touch.page.locator('.vn-dialogue-target').tap()
    assert.equal(touch.count(), 0)
    assert.equal(await touch.page.locator('.vn-text-rest').textContent(), '')
    await touch.page.getByRole('button', { name: 'Menu', exact: true }).tap()
    await touch.page.getByRole('button', { name: 'Close', exact: true }).tap()
    assert.equal(touch.count(), 0)
    await touch.page.locator('.vn-dialogue-target').tap()
    await touch.page.waitForFunction(() => document.querySelector('.vn-speaker')?.textContent === 'Narrator')
    assert.equal(touch.count(), 1)
    await touch.page.locator('.vn-dialogue-target').press('Enter')
    assert.equal(touch.count(), 1)
    await touch.page.locator('.vn-dialogue-target').press('Space')
    await touch.page.locator('.vn-choices').waitFor()
    assert.equal(touch.state.session.mode, 'checkpoint')
    evidence.push({ check: 'normal-motion touch reveal/advance, Enter reveal, Space checkpoint', result: 'PASS' })
    await touch.context.close()

    for (const mode of ['checkpoint', 'completed']) {
      const f = await fixture(browser, { session: { mode, sceneId: mode === 'checkpoint' ? 'checkpoint' : 'ending', status: mode === 'completed' ? 'completed' : 'active' } })
      await f.go()
      assert.equal(await f.page.locator('.vn-dialogue-target').count(), mode === 'checkpoint' ? 1 : 0)
      await modalCheck(f.page, f.count)
      assert.equal(f.count(), 0)
      assert.equal(await f.page.getByRole('button', { name: 'Water and farming' }).count(), mode === 'checkpoint' ? 1 : 0)
      if (mode === 'completed') { await f.page.getByRole('button', { name: 'Back to your lesson' }).click(); await f.page.locator('.learner').waitFor() }
      evidence.push({ check: `${mode} boundaries and contextual exit`, result: 'PASS' })
      await f.context.close()
    }

    const loading = await fixture(browser)
    let releaseLoad
    loading.state.loadGate = new Promise(resolve => { releaseLoad = resolve })
    await loading.page.goto(`${base}/?session=fixture-session`)
    await loading.page.getByRole('status').waitFor()
    releaseLoad()
    await loading.page.locator('.vn-frame').waitFor()
    loading.state.loadError = 404
    await loading.page.reload()
    await loading.page.getByRole('alert').waitFor()
    await loading.page.getByRole('button', { name: 'Back to your lesson' }).click()
    await loading.page.locator('.learner').waitFor()
    evidence.push({ check: 'loading, not-found, recovery exit', result: 'PASS' })
    await loading.context.close()

    const leaving = await fixture(browser)
    await leaving.go()
    let finish
    leaving.state.gate = new Promise(resolve => { finish = resolve })
    await leaving.page.locator('.vn-dialogue-target').click()
    await leaving.page.getByRole('button', { name: 'Menu', exact: true }).click()
    await leaving.page.getByRole('button', { name: 'Leave episode', exact: true }).click()
    await leaving.page.locator('.learner').waitFor()
    finish()
    evidence.push({ check: 'leave during pending request', result: 'PASS' })
    await leaving.context.close()

    const dark = await fixture(browser, { context: { colorScheme: 'dark' } })
    await dark.go()
    await modalCheck(dark.page, dark.count)
    await contrastCheck(dark.page)
    evidence.push({ check: 'fixed scene palette under OS dark preference', result: 'PASS' })
    await dark.context.close()

    const sweep = await fixture(browser)
    await sweep.go()
    for (const width of [360, 639, 640, 768, 999, 1000, 1024]) {
      await sweep.page.setViewportSize({ width, height: 800 })
      const current = await layout(sweep.page)
      assert.ok(current.scrollWidth <= width + 1)
      assertMenuPlacement(current)
    }
    evidence.push({ check: 'width sweep including 639/640 and 999/1000 breakpoints', result: 'PASS' })
    await sweep.context.close()

    for (const viewport of [{width: 320, height: 568}, {width: 390, height: 844}, {width: 800, height: 1024}, {width: 1280, height: 800}, {width: 844, height: 390}]) {
      const f = await fixture(browser, { context: { viewport }, long: true })
      await f.go()
      const tag = f.page.locator('.vn-speaker')
      const short = await tag.boundingBox(), panel = await f.page.locator('.vn-dialogue').boundingBox()
      assert.ok(short.x >= panel.x && short.x < panel.x + 45 && short.y >= panel.y && short.y < panel.y + 35)
      assert.ok(short.width < panel.width * .8, 'short name must not stretch')
      await tag.evaluate(el => { el.textContent = 'Verification instructor with a long display name' })
      const before = await tag.boundingBox()
      await f.page.locator('.vn-dialogue-scroll-area').evaluate(el => { el.scrollTop = el.scrollHeight })
      const after = await tag.boundingBox()
      assert.ok(after.x + after.width <= panel.x + panel.width && Math.abs(after.y-before.y) < 1)
      assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
      await f.page.screenshot({ path: path.join(output, `name-tag-${viewport.width}x${viewport.height}.png`), fullPage: true })
      evidence.push({ check: `${viewport.width}x${viewport.height}: compact top-left short/long speaker tag stays visible while scrolling`, result: 'PASS' })
      await f.context.close()
    }
    assert.deepEqual(errors, [])
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ evidence, errors }, null, 2))
    console.log(JSON.stringify({ passed: evidence.length, errors, output }, null, 2))
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })

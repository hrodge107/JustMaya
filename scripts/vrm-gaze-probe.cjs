// Deterministic directional gaze probe for the production VRM renderer.
// Run against a Vite dev server started with VITE_MASCOT_MODEL=sample:
//   VITE_MASCOT_MODEL=sample npm run dev -- --host 127.0.0.1 --port 5198
//   node scripts/vrm-gaze-probe.cjs
//
// Asserts screen-space gaze direction via window.__mitaVrm (faceNdc relative
// to headNdc) — a pixel-diff is not evidence of direction. Random blink/
// saccade noise is neutralized with a constant Math.random seed. Exits
// non-zero on any failed direction, stale-target, or parked-offset check.
const { chromium } = (() => { try { return require('playwright') } catch { return require('playwright-core') } })()
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const base = process.env.VRM_VERIFY_URL || 'http://127.0.0.1:5198'
const out = path.join(os.tmpdir(), 'mita-vrm-gaze-probe')
fs.mkdirSync(out, { recursive: true })
const results = []
const errors = []

const DIRS = {
  center: { x: 0, y: 0 },
  left: { x: -0.8, y: 0 },
  right: { x: 0.8, y: 0 },
  up: { x: 0, y: -0.7 },
  down: { x: 0, y: 0.7 },
}

function check(name, fn) {
  try { fn(); results.push(`PASS ${name}`) }
  catch (e) { results.push(`FAIL ${name}: ${e.message}`) }
}

async function seedNoise(context) {
  await context.addInitScript(() => { Math.random = () => .5 })
}

// Sample the debug seam, waiting until the reading stabilizes (damped gaze
// converges in sim-time, which runs slower than wall-time under swiftshader).
async function gaze(page, settleMs = 1200, { stable = false } = {}) {
  if (stable) {
    const deadline = Date.now() + 6000
    let prev = null
    do {
      await page.waitForTimeout(300)
      const cur = await gaze(page, 0)
      if (prev && Math.abs(cur.fx - prev.fx) < 0.002 && Math.abs(cur.fy - prev.fy) < 0.002) return cur
      prev = cur
    } while (Date.now() < deadline)
    return prev
  }
  await page.waitForTimeout(settleMs)
  return page.evaluate(() => {
    const d = window.__mitaVrm
    return d && {
      fx: d.faceNdc[0] - d.headNdc[0],
      fy: d.faceNdc[1] - d.headNdc[1],
      headNdc: [...d.headNdc],
      cam: [d.camX, d.camY, d.camZ],
      headYaw: d.headYaw, headPitch: d.headPitch,
      eyeYaw: d.eyeYaw, eyePitch: d.eyePitch,
      lookX: d.lookX, lookY: d.lookY,
      gazeYaw: d.gazeYaw, gazePitch: d.gazePitch,
      armZ: d.armZ, idleOn: d.idleOn, ready: d.ready, gestureW: d.gestureW,
      frames: d.frames, elapsed: d.elapsed,
      softwareRenderer: d.softwareRenderer, pixelRatio: d.pixelRatio,
      bufferWidth: d.bufferWidth, bufferHeight: d.bufferHeight,
    }
  })
}

async function mountCanvas(page, { idle = true, tracking = true, idleDelay = 0 } = {}) {
  // idle: true loads the clip, 'fail' requests it but aborts (failure path),
  // false configures no clip at all.
  if (idle === false || idle === 'fail') await page.route('**/mascot/sample-idle.fbx', route => route.abort())
  else if (idleDelay) await page.route('**/mascot/sample-idle.fbx', async route => { await new Promise(r => setTimeout(r, idleDelay)); route.continue() })
  await page.goto(base)
  await page.evaluate(opts => new Promise((resolve, reject) => {
    Promise.all([
      import('/node_modules/.vite/deps/react.js'),
      import('/node_modules/.vite/deps/react-dom_client.js'),
      import('/src/player/VRMCanvas.tsx'),
    ]).then(([{ default: React }, { default: ReactDOM }, { default: VRMCanvas }]) => {
      document.body.innerHTML = '<main id="test" style="width:100vw;height:100vh;display:flex;align-items:center;justify-content:center"></main>'
      let root = ReactDOM.createRoot(document.querySelector('#test'))
      window.__mountVrm = () => { root = ReactDOM.createRoot(document.querySelector('#test')); window.__renderVrm({}) }
      window.__unmountVrm = () => root.unmount()
      const baseProps = {
        emotion: 'idle', isSpeaking: false, nodTrigger: 0, customAnimationTrigger: null,
        lookTargetOffset: null, enablePointerTracking: opts.tracking,
        modelUrl: '/mascot/sample.vrm', idleUrl: opts.idle !== false ? '/mascot/sample-idle.fbx' : undefined,
        fallback: null, onError: () => reject(new Error('VRM failed')),
      }
      window.__renderVrm = props => root.render(React.createElement(VRMCanvas, { ...baseProps, ...props }))
      window.__renderVrm({})
      resolve()
    }).catch(reject)
  }), { idle, tracking })
  await page.locator('.vrm-mascot:visible canvas').waitFor({ timeout: 60000 })
  await waitVrm(page)
}

async function waitVrm(page) {
  await page.waitForFunction(() => window.__mitaVrm?.ready && window.__mitaVrm.frames > 5, null, { timeout: 60000 })
}

async function moveTo(page, dir) {
  const rect = await page.locator('.vrm-viewport').boundingBox()
  const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2
  // Clamp the move inside the viewport so a direction isn't silently clipped.
  const rx = Math.min(600, Math.max(cx, await page.evaluate(() => innerWidth) - cx) - 40)
  const ry = Math.min(400, Math.max(cy, await page.evaluate(() => innerHeight) - cy) - 40)
  await page.mouse.move(cx + dir.x * rx, cy + dir.y * ry, { steps: 3 })
}

// Task 4.1/4.3/5.1: first-visible pose, delayed/failed idle, hidden-tab
// physics resume, and unmount/remount cleanup — all through the real model.
async function lifecycleChecks(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'no-preference' })
  await seedNoise(context)

  // 4.1a: the FBX stalls — the first visible pose must already be relaxed
  // (resting arms), never a bind-pose T-pose flash.
  {
    const page = await context.newPage()
    page.on('pageerror', e => errors.push(`firstpose: ${e.message}`))
    await mountCanvas(page, { idle: true, idleDelay: 3000 })
    const first = await gaze(page, 0)
    await page.screenshot({ path: path.join(out, 'firstpose-delayed-fbx.png') })
    check('firstpose: first visible pose is arms-down, not bind pose', () => assert.ok(Math.abs(first.armZ) > .5, `armZ=${first.armZ.toFixed(3)}`))
    await page.waitForFunction(() => window.__mitaVrm?.idleOn, null, { timeout: 30000 })
    const after = await gaze(page, 0)
    check('firstpose: idle blends in without pose snap', () => assert.ok(after.idleOn === true && Math.abs(after.armZ) > .5, `idleOn=${after.idleOn} armZ=${after.armZ.toFixed(3)}`))
    await page.close()
  }

  // 4.1b: FBX fails outright — figure still reaches ready on the rest pose,
  // no renderer failure, and the loop keeps drawing.
  {
    const page = await context.newPage()
    page.on('pageerror', e => errors.push(`failedfbx: ${e.message}`))
    await mountCanvas(page, { idle: 'fail' })
    const s0 = await gaze(page, 0)
    check('failedfbx: ready on rest pose without renderer failure', () => assert.ok(s0.ready && Math.abs(s0.armZ) > .5 && s0.idleOn === false, `ready=${s0.ready} armZ=${s0.armZ.toFixed(3)} idleOn=${s0.idleOn}`))
    const s1 = await gaze(page, 800)
    check('failedfbx: render loop continues (procedural breath/pose)', () => assert.ok(s1.frames > s0.frames, `frames ${s0.frames} -> ${s1.frames}`))
    await page.close()
  }

  // 4.3: hidden tab pauses the loop; resume restarts without a physics or
  // pose burst (dt resets to 0 on the first frame back).
  {
    const page = await context.newPage()
    page.on('pageerror', e => errors.push(`hidden: ${e.message}`))
    await mountCanvas(page, { idle: 'fail' })
    await page.evaluate(() => {
      let hidden = false
      Object.defineProperty(document, 'hidden', { get: () => hidden, configurable: true })
      window.__setHidden = v => { hidden = v; document.dispatchEvent(new Event('visibilitychange')) }
    })
    const f1 = (await gaze(page, 0)).frames
    await page.evaluate(() => window.__setHidden(true))
    await page.waitForTimeout(900)
    const f2 = (await gaze(page, 0)).frames
    check('hidden: render loop pauses while hidden', () => assert.ok(f2 - f1 < 3, `frames advanced ${f1} -> ${f2} while hidden`))
    const before = await gaze(page, 0)
    await page.evaluate(() => window.__setHidden(false))
    await page.waitForFunction(f => window.__mitaVrm?.frames > f + 5, f2, { timeout: 30000 })
    const after = await gaze(page, 0)
    check('hidden: resumes with no pose/physics burst', () => assert.ok(Math.abs(after.fx - before.fx) < .05 && Math.abs(after.armZ) > .5, `fx ${before.fx.toFixed(3)} -> ${after.fx.toFixed(3)} armZ=${after.armZ.toFixed(3)}`))
    await page.close()
  }

  // 5.1: repeated unmount/remount — canvases, listeners and the debug seam
  // release every cycle; a fresh renderer comes up cleanly each time.
  {
    const page = await context.newPage()
    page.on('pageerror', e => errors.push(`mount: ${e.message}`))
    await mountCanvas(page, { idle: 'fail' })
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.__unmountVrm())
      await page.waitForTimeout(150)
      const canvases = await page.locator('.vrm-mascot canvas').count()
      const seam = await page.evaluate(() => window.__mitaVrm ?? null)
      check(`mount: cycle ${i + 1} releases canvas + debug seam`, () => assert.ok(canvases === 0 && seam === null, `canvases=${canvases} seam=${seam !== null}`))
      await page.evaluate(() => window.__mountVrm())
      await page.locator('.vrm-mascot:visible canvas').waitFor({ timeout: 60000 })
      await waitVrm(page)
      const count = await page.locator('canvas').count()
      check(`mount: cycle ${i + 1} remounts a single live renderer`, () => assert.equal(count, 1, `canvases=${count}`))
    }
    await page.close()
  }

  // 4.2: bounded gesture — while speaking, the blend rises once, holds a
  // bounded interval, then releases smoothly back to rest.
  {
    const page = await context.newPage()
    page.on('pageerror', e => errors.push(`gesture: ${e.message}`))
    await mountCanvas(page, { idle: 'fail' })
    await page.evaluate(() => { window.__renderVrm({ isSpeaking: true }); window.__mitaVrm.gestureNow = true })
    await page.waitForFunction(() => (window.__mitaVrm?.gestureW ?? 0) > .4, null, { timeout: 30000 })
    const rise = await gaze(page, 0)
    check('gesture: hand rises while speaking', () => assert.ok(rise.gestureW > .4, `gestureW=${rise.gestureW.toFixed(2)}`))
    await page.waitForFunction(() => (window.__mitaVrm?.gestureW ?? 1) < .1, null, { timeout: 30000 })
    const rest = await gaze(page, 0)
    check('gesture: releases back to rest', () => assert.ok(rest.gestureW < .1 && Math.abs(rest.armZ - 1.25) < .2, `gestureW=${rest.gestureW.toFixed(2)} armZ=${rest.armZ.toFixed(2)}`))
    await page.close()
  }

  await context.close()
}

async function directionMatrix(browser, idle) {
  const tag = idle ? 'idle-on' : 'idle-off'
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'no-preference', hasTouch: true })
  await seedNoise(context)
  const page = await context.newPage()
  page.on('pageerror', e => errors.push(`${tag}: ${e.message}`))
  await mountCanvas(page, { idle })
  await page.evaluate(() => { if (window.__mitaVrm) window.__mitaVrm.quiet = true })
  const shot = name => page.screenshot({ path: path.join(out, `${tag}-${name}.png`) })

  // Neutral settle then direction sweep.
  const neutral = await gaze(page, 0, { stable: true })
  await shot('center')
  check(`${tag}: renderer pixel policy`, () => process.env.VRM_SOFTWARE_GL === '0'
    ? assert.ok(!neutral.softwareRenderer && neutral.pixelRatio <= 2, `software=${neutral.softwareRenderer} ratio=${neutral.pixelRatio}`)
    : assert.ok(neutral.softwareRenderer && neutral.bufferWidth * neutral.bufferHeight <= 960 * 540 + 2000,
      `software=${neutral.softwareRenderer} buffer=${neutral.bufferWidth}x${neutral.bufferHeight} ratio=${neutral.pixelRatio}`))
  const seen = {}
  for (const name of ['left', 'right', 'up', 'down']) {
    await moveTo(page, DIRS[name])
    seen[name] = await gaze(page, 0, { stable: true })
    await shot(name)
  }
  check(`${tag}: neutral faces viewer (|fx| ${neutral.fx.toFixed(3)} <= 0.03)`, () => assert.ok(Math.abs(neutral.fx) <= 0.03, `neutral fx=${neutral.fx.toFixed(4)} headYaw=${neutral.headYaw.toFixed(3)}`))
  check(`${tag}: pointer left turns face left`, () => assert.ok(seen.left.fx < neutral.fx - 0.004, `left fx=${seen.left.fx.toFixed(4)} vs neutral ${neutral.fx.toFixed(4)}`))
  check(`${tag}: pointer right turns face right`, () => assert.ok(seen.right.fx > neutral.fx + 0.004, `right fx=${seen.right.fx.toFixed(4)} vs neutral ${neutral.fx.toFixed(4)}`))
  check(`${tag}: pointer up tips face up`, () => assert.ok(seen.up.fy > neutral.fy + 0.004, `up fy=${seen.up.fy.toFixed(4)} vs neutral ${neutral.fy.toFixed(4)}`))
  check(`${tag}: pointer down tips face down`, () => assert.ok(seen.down.fy < neutral.fy - 0.004, `down fy=${seen.down.fy.toFixed(4)} vs neutral ${neutral.fy.toFixed(4)} lookY=${seen.down.lookY} gazePitch=${seen.down.gazePitch?.toFixed(3)} eyePitch=${seen.down.eyePitch.toFixed(1)}`))
  check(`${tag}: eyes follow (eyeYaw spans left->right)`, () => assert.ok(seen.right.eyeYaw > seen.left.eyeYaw, `eyeYaw L=${seen.left.eyeYaw.toFixed(2)} R=${seen.right.eyeYaw.toFixed(2)}`))

  // Pointer exit / blur must clear the target within one second of active
  // rendering (spec deadline) — measured in rendered sim-time, not frames.
  await moveTo(page, DIRS.right)
  const parked = await gaze(page, 0, { stable: true })
  const exitAt = parked.elapsed
  await page.evaluate(() => { document.dispatchEvent(new PointerEvent('pointerout', { pointerType: 'mouse' })); window.dispatchEvent(new Event('blur')) })
  const clearHandle = await page.waitForFunction(() => { const d = window.__mitaVrm; return d && Math.abs(d.faceNdc[0] - d.headNdc[0]) <= .03 ? d.elapsed : false }, null, { timeout: 30000 })
  const clearedElapsed = await clearHandle.jsonValue()
  check(`${tag}: pointer exit/blur returns gaze forward within 1s`, () => assert.ok(clearedElapsed - exitAt <= 1.05, `returned after ${(clearedElapsed - exitAt).toFixed(2)} rendered seconds (parked fx=${parked.fx.toFixed(4)})`))
  const forward = await gaze(page, 0, { stable: true })

  // A completed tap glances briefly then returns within two wall-clock
  // seconds of release, even when frames take longer than the 50ms sim step.
  await page.evaluate(() => {
    window.__touchEvents = []
    for (const name of ['pointerdown', 'pointerup', 'pointercancel']) window.addEventListener(name, event => {
      if (event.pointerType === 'touch') window.__touchEvents.push({ name, x: event.clientX, y: event.clientY, target: event.target?.tagName })
    }, true)
  })
  const rect = await page.locator('.vrm-viewport').boundingBox()
  await page.touchscreen.tap(rect.x + rect.width * 0.9, rect.y + rect.height * 0.4)
  const releaseAt = await page.evaluate(() => performance.now())
  const glanceHandle = await page.waitForFunction(baseline => {
    const d = window.__mitaVrm
    return d && d.faceNdc[0] - d.headNdc[0] > baseline.fx + .004 ? performance.now() : false
  }, forward, { timeout: 15000, polling: 100 }).catch(async error => {
    const snapshot = await gaze(page, 0)
    const events = await page.evaluate(() => window.__touchEvents)
    throw new Error(`${error.message}; touch diagnostic=${JSON.stringify(snapshot)} events=${JSON.stringify(events)}`)
  })
  const glanceAt = await glanceHandle.jsonValue()
  const backHandle = await page.waitForFunction(baseline => {
    const d = window.__mitaVrm
    return d && Math.hypot(d.faceNdc[0] - d.headNdc[0] - baseline.fx, d.faceNdc[1] - d.headNdc[1] - baseline.fy) <= .03 ? performance.now() : false
  }, forward, { timeout: 40000, polling: 100 })
  const backAt = await backHandle.jsonValue()
  check(`${tag}: tap glances toward the touch`, () => assert.ok((glanceAt - releaseAt) / 1000 <= 1.5, `glance arrived ${((glanceAt - releaseAt) / 1000).toFixed(2)}s after release`))
  check(`${tag}: tap returns forward within 2s`, () => assert.ok((backAt - releaseAt) / 1000 <= 2, `returned after ${((backAt - releaseAt) / 1000).toFixed(2)} wall-clock seconds`))

  // Camera lock: drag/wheel over the avatar must not move the subject in
  // frame (task 3.2 — production framing is not user-adjustable).
  const lockBefore = await gaze(page, 0)
  const box = await page.locator('.vrm-viewport').boundingBox()
  if (box) {
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2
    await page.mouse.move(cx, cy)
    await page.mouse.down(); await page.mouse.move(cx + 160, cy + 80, { steps: 4 }); await page.mouse.up()
    await page.mouse.wheel(0, -400)
    const lockAfter = await gaze(page, 0)
    check(`${tag}: drag/wheel cannot move the camera`, () => assert.deepEqual(lockAfter.cam, lockBefore.cam, `camera moved (${lockBefore.cam} -> ${lockAfter.cam})`))
  }
  await context.close()
  return { neutral, seen }
}

// Home surface: the shared stage must face the viewer and track the pointer.
async function homeSurface(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'no-preference' })
  await seedNoise(context)
  const page = await context.newPage()
  page.on('pageerror', e => errors.push(`home: ${e.message}`))
  await page.route('**/api/**', route => route.fulfill({ json: { documents: [] } }))
  await page.goto(base)
  await page.locator('.vrm-mascot:visible canvas').waitFor({ timeout: 60000 })
  await page.waitForFunction(() => window.__mitaVrm?.ready && window.__mitaVrm.frames > 5, null, { timeout: 60000 })
  await page.evaluate(() => { if (window.__mitaVrm) window.__mitaVrm.quiet = true })
  const neutral = await gaze(page, 0, { stable: true })
  check('home: faces viewer (|fx| <= 0.03)', () => assert.ok(Math.abs(neutral.fx) <= 0.03, `home neutral fx=${neutral.fx.toFixed(4)}`))
  const rect = await page.locator('.vrm-viewport').boundingBox()
  if (rect) {
    await page.mouse.move(rect.x + rect.width / 2 + 300, rect.y + rect.height / 2, { steps: 3 })
    const right = await gaze(page, 0, { stable: true })
    check('home: pointer right turns face right', () => assert.ok(right.fx > neutral.fx + 0.004, `right fx=${right.fx.toFixed(4)} vs neutral ${neutral.fx.toFixed(4)}`))
  }
  await context.close()
}

// Production surface: checkpoint/tutor modes remain forward without input,
// and pointer tracking stays available through the lesson states.
async function productionSurface(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'no-preference', hasTouch: true })
  await seedNoise(context)
  const page = await context.newPage()
  page.on('pageerror', e => errors.push(`surface: ${e.message}`))
  const state = {
    session: { sessionId: 'fixture-session', episodeId: 'fixture-episode', mode: 'playing', sceneId: 'intro', dialogueIndex: 0, version: 1, status: 'active', updatedAt: '2026-10-28T00:00:00Z' },
  }
  const episode = {
    episodeId: 'fixture-episode', title: 'Gaze fixture', status: 'ready', startSceneId: 'intro',
    scenes: [
      { sceneId: 'intro', kind: 'dialogue', nextSceneId: 'checkpoint', question: null, dialogue: [{ lineId: 'one', speaker: 'mascot', text: 'Line one.', emotion: 'idle' }] },
      { sceneId: 'checkpoint', kind: 'checkpoint', nextSceneId: null, dialogue: [], question: { questionId: 'q', prompt: 'Pick one.', options: [{ optionId: 'a', label: 'A' }, { optionId: 'b', label: 'B' }] } },
    ], learningObjectives: [], estimatedMinutes: 1,
  }
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/advance')) {
      state.session.version++
      if (state.session.sceneId === 'intro') { state.session.sceneId = 'checkpoint'; state.session.mode = 'checkpoint'; state.session.dialogueIndex = 0 }
      return route.fulfill({ json: state.session })
    }
    if (url.pathname.endsWith('/raise-hand')) {
      state.session.version++
      state.session.mode = 'question'
      return route.fulfill({ json: state.session })
    }
    if (url.pathname.includes('/sessions/')) return route.fulfill({ json: state.session })
    if (url.pathname === '/api/documents') return route.fulfill({ json: { documents: [] } })
    return route.fulfill({ json: episode })
  })
  await page.goto(`${base}/?session=fixture-session`)
  await page.locator('.vrm-mascot:visible canvas').waitFor({ timeout: 60000 })
  await page.waitForFunction(() => window.__mitaVrm?.ready && window.__mitaVrm.frames > 5, null, { timeout: 60000 })
  const playing = await gaze(page, 1600)
  await page.screenshot({ path: path.join(out, 'surface-playing.png') })

  // A tap on the dialogue advance control is a control action — it advances
  // the scene but must not register as an avatar gaze glance (task 2.3).
  const dlgBtn = await page.locator('.vn-dialogue-target').boundingBox()
  assert.ok(dlgBtn, 'dialogue advance control must exist on the playing surface')
  const before = (await gaze(page, 0)).frames
  await page.touchscreen.tap(dlgBtn.x + dlgBtn.width * 0.9, dlgBtn.y + dlgBtn.height * 0.5)
  await page.waitForFunction(f => window.__mitaVrm?.frames >= f + 6, before, { timeout: 15000 })
  const afterTap = await gaze(page, 0)
  check('surface: control tap does not glance', () => assert.ok(Math.abs(afterTap.fx - playing.fx) <= 0.02, `control-tap fx=${afterTap.fx.toFixed(4)} vs playing ${playing.fx.toFixed(4)}`))

  // Advance into the checkpoint: entry is mandatory — a swallowed timeout
  // would let the gaze checks pass without ever reaching the state.
  await page.locator('.vn-dialogue').click()
  await page.locator('.vn-checkpoint-scene, [class*=checkpoint]').first().waitFor({ timeout: 30000 })
  await page.mouse.move(640, 450)
  const thinking = await gaze(page, 1600)
  await page.screenshot({ path: path.join(out, 'surface-checkpoint.png') })
  check('surface: playing state faces viewer', () => assert.ok(Math.abs(playing.fx) <= 0.03, `playing fx=${playing.fx.toFixed(4)}`))
  check('surface: thinking/checkpoint does not park upper-right', () => assert.ok(Math.abs(thinking.fx) <= 0.03 && Math.abs(thinking.fy) <= 0.05, `thinking fx=${thinking.fx.toFixed(4)} fy=${thinking.fy.toFixed(4)} look=(${thinking.lookX},${thinking.lookY}) eye=(${thinking.eyeYaw.toFixed(1)},${thinking.eyePitch.toFixed(1)})`))

  // Tutor compose removes its fixed down-look. Center the mouse before
  // checking neutral gaze, then ensure tracking still works in this state.
  const raise = page.locator('.vn-raise')
  assert.ok(await raise.count(), 'raise-hand control must exist on the checkpoint surface')
  await raise.click()
  await page.locator('.vn-ask-strip, [class*=ask]').first().waitFor({ timeout: 30000 })
  const stage = await page.locator('.vrm-viewport').boundingBox()
  assert.ok(stage, 'vrm viewport must exist on the tutor surface')
  const centerX = stage.x + stage.width / 2, centerY = stage.y + stage.height / 2
  await page.mouse.move(centerX, centerY)
  const tutor = await gaze(page, 0, { stable: true })
  await page.screenshot({ path: path.join(out, 'surface-tutor.png') })
  check('surface: tutor compose faces forward without input', () => assert.ok(Math.abs(tutor.fx) <= 0.03 && Math.abs(tutor.fy) <= 0.05, `tutor fx=${tutor.fx.toFixed(4)} fy=${tutor.fy.toFixed(4)} look=(${tutor.lookX},${tutor.lookY})`))
  await page.mouse.move(stage.x + stage.width * .9, centerY, { steps: 3 })
  const tracked = await gaze(page, 0, { stable: true })
  check('surface: tutor compose follows the mouse', () => assert.ok(tracked.fx > tutor.fx + .004, `tracked fx=${tracked.fx.toFixed(4)} vs neutral ${tutor.fx.toFixed(4)}`))
  await context.close()
}

async function main() {
  const args = process.env.VRM_SOFTWARE_GL === '0' ? [] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  const browser = await chromium.launch({ channel: process.env.VRM_VERIFY_BROWSER || 'msedge', headless: true, args })
  try {
    await directionMatrix(browser, false)
    if (!process.env.VRM_ONLY_TOUCH) {
      await directionMatrix(browser, true)
      await homeSurface(browser)
      await productionSurface(browser)
      await lifecycleChecks(browser)
    }
  } finally { await browser.close() }
  for (const line of results) console.log(line)
  if (errors.length) console.log('page errors:', errors)
  fs.writeFileSync(path.join(out, 'results.txt'), [...results, ...errors].join('\n'))
  const failed = results.filter(r => r.startsWith('FAIL'))
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed, ${errors.length} page errors -> ${out}`)
  if (failed.length || errors.length) process.exitCode = 1
}
main().catch(error => { console.error(error); process.exitCode = 1 })

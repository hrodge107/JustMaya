// Run with VITE_MASCOT_VRM_URL=/__fixture/avatar.vrm and VITE_MASCOT_IDLE_URL=/__fixture/idle.fbx.
// Supply temporary, appropriately licensed fixtures through VRM_TEST_MODEL, VRM0_TEST_MODEL and VRM_TEST_FBX.
const { chromium } = (() => { try { return require('playwright') } catch { return require('playwright-core') } })()
const assert = require('node:assert/strict')
const fs = require('node:fs')
const base = process.env.VRM_VERIFY_URL || 'http://127.0.0.1:5198'
const models = [process.env.VRM_TEST_MODEL, process.env.VRM0_TEST_MODEL]
const fbx = process.env.VRM_TEST_FBX
if (models.some(path => !path || !fs.existsSync(path)) || !fbx || !fs.existsSync(fbx)) throw new Error('VRM_TEST_MODEL, VRM0_TEST_MODEL and VRM_TEST_FBX must point to test fixtures')

async function preparationChecks(browser) {
  for (const mode of ['compile-unmount', 'compile-hidden', 'upload-unmount', 'upload-context-loss', 'warm-unmount', 'ready-context-loss', 'no-parallel']) {
    const context = await browser.newContext({ viewport: { width: 406, height: 738 }, deviceScaleFactor: 2, reducedMotion: 'no-preference' })
    try {
      await context.addInitScript(mode => {
        localStorage.setItem('meet-mita:motion', 'reduce')
        window.__uploads = 0; window.__draws = 0; window.__compileChecks = 0
        window.__holdCompile = mode.startsWith('compile-')
        for (const C of [WebGLRenderingContext, WebGL2RenderingContext]) {
          const extension = C.prototype.getExtension
          C.prototype.getExtension = function (name) {
            if (name === 'KHR_parallel_shader_compile') {
              if (mode === 'no-parallel') return null
              if (mode.startsWith('compile-')) return { COMPLETION_STATUS_KHR: 0x91b1 }
            }
            return extension.call(this, name)
          }
          const parameter = C.prototype.getProgramParameter
          C.prototype.getProgramParameter = function (program, name) {
            if (name === 0x91b1) { window.__compileChecks++; if (mode.startsWith('compile-')) return !window.__holdCompile }
            return parameter.call(this, program, name)
          }
          for (const name of ['texImage2D', 'texSubImage2D', 'texImage3D', 'texSubImage3D']) {
            const original = C.prototype[name]
            if (original) C.prototype[name] = function (...args) {
              const result = original.apply(this, args)
              window.__uploads++
              if (window.__interruptUpload && window.__mitaVrm?.modelParsedAt > 0) { const interrupt = window.__interruptUpload; window.__interruptUpload = null; interrupt(this.canvas) }
              return result
            }
          }
          const draw = C.prototype.drawElements
          C.prototype.drawElements = function (...args) {
            window.__draws++
            const result = draw.apply(this, args)
            if (mode === 'warm-unmount' && window.__mitaVrm?.modelParsedAt > 0) window.__unmountVrm()
            return result
          }
        }
      }, mode)
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', e => errors.push(e.message))
      await page.route('**/__fixture/avatar.vrm', route => route.fulfill({ body: fs.readFileSync(models[0]), contentType: 'model/gltf-binary' }))
      // Avoid mounting the app's avatar: this harness owns exactly one renderer.
      await page.route('**/api/**', route => route.fulfill({ json: { documents: [] } }))
      await page.goto(`${base}/?vrm-preparation-test`)
      await page.evaluate(async mode => {
        const [{ default: React }, { default: ReactDOM }, { default: VRMCanvas }] = await Promise.all([
          import('/node_modules/.vite/deps/react.js'), import('/node_modules/.vite/deps/react-dom_client.js'), import('/src/player/VRMCanvas.tsx'),
        ])
        const host = document.createElement('main'); document.body.append(host)
        const root = ReactDOM.createRoot(host)
        window.__unmountVrm = () => root.unmount()
        window.__interruptUpload = mode === 'upload-unmount' ? () => root.unmount()
          : mode === 'upload-context-loss' ? canvas => canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true })) : null
        root.render(React.createElement(VRMCanvas, { emotion: 'idle', isSpeaking: false, nodTrigger: 0, enablePointerTracking: false, modelUrl: '/__fixture/avatar.vrm', onError: () => { window.__preparationFailed = true; root.unmount() } }))
      }, mode)
      if (mode.startsWith('compile-')) {
        await page.waitForFunction(() => window.__compileChecks > 0)
        assert.equal(await page.evaluate(() => window.__mitaVrm.ready), false)
        await page.evaluate(() => {
          Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange'))
          Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange'))
        })
        const draws = await page.evaluate(() => window.__draws)
        await page.waitForTimeout(100)
        assert.equal(await page.evaluate(() => window.__draws), draws, 'visibility must not bypass preparation')
        if (mode === 'compile-unmount') await page.evaluate(() => window.__unmountVrm())
        else await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) })
        await page.evaluate(() => { window.__holdCompile = false })
        if (mode === 'compile-hidden') {
          await page.waitForFunction(() => window.__mitaVrm?.preparedAt > 0)
          assert.equal(await page.evaluate(() => window.__mitaVrm.ready), false, 'hidden preparation must not reveal/start animation')
          const count = await page.evaluate(() => window.__draws)
          await page.waitForTimeout(150)
          assert.equal(await page.evaluate(() => window.__draws), count)
          await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')) })
        }
      }
      if (mode === 'compile-unmount' || mode === 'warm-unmount' || mode.startsWith('upload-')) {
        await page.waitForFunction(() => !window.__mitaVrm)
        const counts = await page.evaluate(() => [window.__uploads, window.__draws])
        await page.waitForTimeout(200)
        assert.deepEqual(await page.evaluate(() => [window.__uploads, window.__draws]), counts, 'cancelled preparation performs no more GPU work')
        if (mode === 'upload-context-loss') assert.ok(await page.evaluate(() => window.__preparationFailed))
      } else {
        await page.waitForFunction(() => window.__mitaVrm?.ready)
        const d = await page.evaluate(() => window.__mitaVrm)
        assert.ok(d.modelParsedAt <= d.preparedAt && d.preparedAt <= d.firstFrameAt)
        assert.equal(d.bufferWidth, 406); assert.equal(d.bufferHeight, 738)
        if (mode === 'no-parallel') assert.equal(d.parallelCompile, false)
        await page.setViewportSize({ width: 3840, height: 2160 })
        await page.waitForFunction(() => window.__mitaVrm.bufferWidth === 960 || window.__mitaVrm.bufferWidth === 1920)
        const resized = await page.evaluate(() => window.__mitaVrm)
        assert.ok(resized.bufferWidth * resized.bufferHeight <= (resized.softwareRenderer ? 960 * 540 : 1920 * 1080))
        if (mode === 'ready-context-loss') {
          await page.evaluate(() => document.querySelector('.vrm-viewport canvas').getContext('webgl2').getExtension('WEBGL_lose_context').loseContext())
          await page.waitForFunction(() => window.__preparationFailed && !window.__mitaVrm)
          const draws = await page.evaluate(() => window.__draws)
          await page.waitForTimeout(150)
          assert.equal(await page.evaluate(() => window.__draws), draws)
        }
      }
      assert.deepEqual(errors, [])
      console.log(`PASS preparation ${mode}`)
    } finally { await context.close() }
  }
}

async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: process.env.VRM_SOFTWARE_GL === '0' ? [] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
  try {
    await preparationChecks(browser)
    for (const model of models) {
      const context = await browser.newContext({ viewport: { width: 1000, height: 800 }, reducedMotion: 'no-preference' })
      const page = await context.newPage()
      await page.addInitScript(() => {
        window.__vrmDraws = 0
        window.__vrmDeletes = 0
        for (const Context of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
          if (!Context) continue
          const remove = Context.prototype.deleteProgram
          Context.prototype.deleteProgram = function (...args) { window.__vrmDeletes++; return remove.apply(this, args) }
          for (const name of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
            const original = Context.prototype[name]
            if (original) Context.prototype[name] = function (...args) { window.__vrmDraws++; return original.apply(this, args) }
          }
        }
      })
      let downloads = 0, idleRequests = 0
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      await page.route('**/__fixture/avatar.vrm', route => { downloads++; return route.fulfill({ body: fs.readFileSync(model), contentType: 'model/gltf-binary' }) })
      await page.route('**/__fixture/idle.fbx', route => { idleRequests++; return route.fulfill({ body: fs.readFileSync(fbx), contentType: 'application/octet-stream' }) })
      await page.goto(base)
      await page.locator('.vrm-mascot:visible canvas').waitFor({ timeout: 60000 })
      await page.waitForTimeout(1500)
      assert.equal(downloads, 1)
      assert.equal(idleRequests, 1)
      await page.locator('.vrm-mascot[data-idle-playing]').waitFor({ timeout: 30000 })
      assert.deepEqual(errors, [])
      const beforePause = await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); return window.__vrmDraws })
      await page.waitForTimeout(600)
      const paused = await page.evaluate(() => window.__vrmDraws)
      assert.ok(paused - beforePause <= 2, 'hidden tab should stop drawing')
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')) })
      await page.waitForTimeout(600)
      await page.waitForFunction(count => window.__vrmDraws > count, paused, { timeout: 10000 })
      await page.reload()
      await page.locator('.vrm-mascot:visible canvas').waitFor({ timeout: 60000 })
      assert.equal(downloads, 1, 'Cache API should prevent another model request')
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.getByText('Stand-in character').waitFor()
      assert.equal(await page.locator('.vrm-mascot canvas').count(), 0, 'switching to reduced motion unmounts the renderer')
      assert.ok(await page.evaluate(() => window.__vrmDeletes) > 0, 'renderer cleanup disposes GPU programs')
      await context.close()
      console.log(`PASS ${model}: model, animation request, cached reload, reduced-motion cleanup`)
    }
    const interaction = await browser.newContext({ viewport: { width: 800, height: 800 }, reducedMotion: 'no-preference' })
    await interaction.addInitScript(() => localStorage.setItem('meet-mita:motion', 'reduce'))
    const interactionPage = await interaction.newPage()
    await interactionPage.route('**/__fixture/avatar.vrm', route => route.fulfill({ body: fs.readFileSync(models[0]), contentType: 'model/gltf-binary' }))
    await interactionPage.route('**/__fixture/idle.fbx', route => route.abort())
    await interactionPage.goto(base)
    await interactionPage.evaluate(async () => {
      const { default: React } = await import('/node_modules/.vite/deps/react.js')
      const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js')
      const { default: VRMCanvas } = await import('/src/player/VRMCanvas.tsx')
      document.body.innerHTML = '<main id="test"></main>'
      const root = ReactDOM.createRoot(document.querySelector('#test'))
      const baseProps = { emotion: 'idle', isSpeaking: false, nodTrigger: 0, customAnimationTrigger: null, lookTargetOffset: null, enablePointerTracking: false, modelUrl: '/__fixture/avatar.vrm', fallback: null, onError: () => { throw new Error('VRM failed') } }
      window.__renderVrm = props => root.render(React.createElement(VRMCanvas, { ...baseProps, ...props }))
      window.__renderVrm({})
    })
    const canvas = interactionPage.locator('.vrm-mascot:visible canvas')
    await canvas.waitFor({ timeout: 60000 })
    await interactionPage.waitForTimeout(800)
    let previous = await canvas.screenshot()
    for (const props of [{ emotion: 'happy' }, { emotion: 'confused' }, { emotion: 'thinking' }, { emotion: 'talking', isSpeaking: true }, { emotion: 'idle', lookTargetOffset: { x: 1, y: -.5 } }, { emotion: 'idle', nodTrigger: 1 }]) {
      await interactionPage.evaluate(value => window.__renderVrm(value), props)
      await interactionPage.waitForTimeout(props.nodTrigger ? 150 : 700)
      const next = await canvas.screenshot()
      assert.notDeepEqual(next, previous, `render changes for ${JSON.stringify(props)}`)
      previous = next
    }
    await interaction.close()
    console.log('PASS visible emotion, speaking, gaze and nod changes')
    const context = await browser.newContext({ reducedMotion: 'no-preference' })
    const page = await context.newPage()
    let cacheFetches = 0
    await page.route('**/__fixture/cache.vrm', route => { cacheFetches++; return route.fulfill({ body: Buffer.from([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 12, 0, 0, 0]) }) })
    await page.route('**/__fixture/avatar.vrm', route => route.fulfill({ body: 'not a VRM' }))
    await page.goto(base)
    await page.getByText('Stand-in character').waitFor()
    const cacheResult = await page.evaluate(async () => {
      const url = '/__fixture/cache.vrm'
      const cache = await caches.open('meet-mita-vrm-v1')
      await cache.put(url, new Response('corrupt'))
      const { fetchVRM } = await import('/src/player/vrmCache.ts')
      const [first, second] = await Promise.all([fetchVRM(url), fetchVRM(url)])
      new Uint8Array(first)[0] = 0
      return new Uint8Array(second)[0]
    })
    assert.equal(cacheResult, 0x67)
    assert.equal(cacheFetches, 1, 'corrupt cache is replaced and concurrent requests share a fetch')
    await page.waitForTimeout(1000)
    assert.equal(await page.locator('.vrm-mascot:visible').count(), 0)
    await context.close()
    const noWebGL = await browser.newContext({ reducedMotion: 'no-preference' })
    await noWebGL.addInitScript(() => { const original = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (kind, ...args) { return kind === 'webgl' || kind === 'webgl2' ? null : original.call(this, kind, ...args) } })
    const page2 = await noWebGL.newPage()
    await page2.goto(base)
    await page2.getByText('Stand-in character').waitFor()
    await page2.waitForTimeout(1000)
    assert.equal(await page2.locator('.vrm-mascot:visible').count(), 0)
    await noWebGL.close()
    console.log('PASS invalid model and unavailable WebGL fallback')
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })

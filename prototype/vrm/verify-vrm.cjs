// PROTOTYPE smoke check: throwaway, not part of CI.
// Opens the homepage over file://, waits for the VRM stage to come online,
// then pins every emotion/state via the Mascot lab and screenshots each.
// Run: node verify-vrm.cjs
//   or PROTO_URL=http://localhost:5173/prototype/homepage/index.html node verify-vrm.cjs
let chromium
try { chromium = require(require('path').join(require('os').tmpdir(), 'proto-pw', 'node_modules', 'playwright-core')).chromium }
catch { chromium = require('playwright-core').chromium }
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const base = process.env.PROTO_URL || 'file:///' + path.resolve(__dirname, '..', 'homepage', 'index.html').replace(/\\/g, '/')
const out = path.join(os.tmpdir(), 'meet-mita-vrm-proto')
fs.mkdirSync(out, { recursive: true })
const errors = []

function findBrowser() {
  const dir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright')
  try {
    for (const d of fs.readdirSync(dir).sort().reverse()) {
      const shell = path.join(dir, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')
      const full = path.join(dir, d, 'chrome-win64', 'chrome.exe')
      if (d.startsWith('chromium_headless_shell') && fs.existsSync(shell)) return shell
      if (d.startsWith('chromium-') && fs.existsSync(full)) return full
    }
  } catch {}
  return undefined
}

async function main() {
  const browser = await chromium.launch({ executablePath: findBrowser(), args: ['--enable-unsafe-swiftshader'] })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    page.on('pageerror', e => errors.push(`page: ${e.message}`))
    page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })
    const variant = process.env.PROTO_VARIANT || 'b'
    await page.goto(`${base}?v=${variant}`, { waitUntil: 'load' })

    // VRM stage comes online: viewport unhidden, stand-in faces hidden.
    await page.waitForSelector('#mayaVrm:not([hidden]) canvas', { timeout: 30000 })
    await page.waitForSelector('.maya.vrm-on')
    console.log('vrm stage: online')

    // Lab drawer: model summary + every emotion chip.
    await page.click('#labToggle')
    await page.waitForSelector('#lab:not([hidden])')
    assert.match(await page.textContent('#labSub'), /VRM 0\.0/, 'model spec reported')
    const chips = await page.$$('#labEmo button')
    assert.deepEqual(chips.map(() => 0).length, 7, 'seven emotion chips')
    console.log('lab:', (await page.textContent('#labSub')).trim())

    // Pin each emotion and screenshot it — this is the point of the lab.
    for (const e of ['idle', 'talking', 'thinking', 'happy', 'confused', 'listening', 'reading']) {
      await page.click(`#labEmo button[data-e="${e}"]`)
      await page.waitForFunction(s => document.getElementById('maya').dataset.state === s, e)
      await page.waitForTimeout(900) // damp-lerp settles
      await page.screenshot({ path: path.join(out, `vrm-${e}.png`) })
    }
    console.log('emotions pinned + screenshotted')

    // Speaking cadence + nod + gaze off + a raw expression pin.
    await page.click('#labEmo button[data-e="idle"]')
    await page.click('#labSpeak')
    await page.waitForTimeout(700)
    await page.screenshot({ path: path.join(out, 'vrm-speaking.png') })
    await page.click('#labSpeak')
    await page.click('#labNod')
    await page.waitForTimeout(200)
    await page.screenshot({ path: path.join(out, 'vrm-nod.png') })
    await page.click('#labExprBox > summary')
    const sliders = await page.$$('#labExpr input[type=range]')
    assert.ok(sliders.length >= 10, `expression sliders (${sliders.length})`)
    console.log(`expressions exposed: ${sliders.length}`)
    const happy = await page.$$('#labExpr input[type=range]')
    const pin = happy[Math.min(11, happy.length - 1)]
    await pin.evaluate(el => { el.value = '1'; el.dispatchEvent(new Event('input')) })
    await page.waitForTimeout(700)
    await page.screenshot({ path: path.join(out, 'vrm-expr-pin.png') })
    await page.click('#labClear')

    // Resume hands control back to the ambient script.
    await page.click('#labResume')
    await page.waitForFunction(() => /mode=idle/.test(document.getElementById('labRead').textContent))
    await page.screenshot({ path: path.join(out, 'vrm-resumed.png') })
    await page.close()
    console.log('state controls + resume: ok')
  } finally {
    await browser.close()
  }
  if (errors.length) {
    console.error('page errors:')
    errors.forEach(e => console.error(' -', e))
    process.exit(1)
  }
  console.log(`vrm prototype clean. screenshots in ${out}`)
}
main().catch(e => { console.error(e); process.exit(1) })

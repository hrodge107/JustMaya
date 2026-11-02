// Native HTMLAudio + real backend inference, with the real avatar visible.
const { chromium } = (() => { try { return require('playwright') } catch { return require('playwright-core') } })()
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const base = process.env.PLAYER_VERIFY_URL || 'http://127.0.0.1:5173'

async function run() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    await context.addInitScript(() => {
      const NativeAudio = window.Audio
      window.__nativeVoice = { instances: [], events: [] }
      window.Audio = function(...args) {
        const audio = new NativeAudio(...args)
        window.__nativeVoice.instances.push(audio)
        for (const event of ['playing', 'ended', 'error']) audio.addEventListener(event, () => window.__nativeVoice.events.push({ event, time: performance.now(), duration: audio.duration }))
        return audio
      }
      window.Audio.prototype = NativeAudio.prototype
    })
    const page = await context.newPage()
    const requests = [], errors = [], records = new Map()
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/speech') { const record = { text: request.postDataJSON().text, started: Date.now() }; requests.push(record); records.set(request, record) } })
    page.on('response', response => { const record = records.get(response.request()); if (record) { record.status = response.status(); record.seconds = (Date.now() - record.started) / 1000 } })
    await page.route('**/api/documents', route => route.fulfill({ json: { documents: [] } }))
    await page.goto(base)
    await page.locator('.vrm-viewport canvas').waitFor({ timeout: 60000 })
    await page.getByRole('button', { name: 'Menu', exact: true }).click()
    await page.getByRole('switch', { name: 'Mita’s voice' }).click()
    await page.locator('#menuDlg').getByRole('button', { name: 'Close', exact: true }).click()
    await page.waitForFunction(() => window.__nativeVoice.events.some(item => item.event === 'playing'), null, { timeout: 45000 })
    await page.waitForFunction(() => window.__nativeVoice.events.some(item => item.event === 'ended'), null, { timeout: 45000 })
    assert.ok(requests.some(request => request.status === 200))
    const media = await page.evaluate(() => ({ events: window.__nativeVoice.events, duration: window.__nativeVoice.instances.at(-1).duration, readyState: window.__nativeVoice.instances.at(-1).readyState }))
    assert.ok(!media.events.some(event => event.event === 'error'))
    assert.deepEqual(errors, [])
    const output = path.join(os.tmpdir(), 'mita-speech-native-browser')
    fs.mkdirSync(output, { recursive: true })
    await page.screenshot({ path: path.join(output, 'native-voice-avatar.png') })
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ requests, media, errors }, null, 2))
    console.log(JSON.stringify({ requests, media, output }, null, 2))
  } finally { await browser.close() }
}
run().catch(error => { console.error(error); process.exitCode = 1 })

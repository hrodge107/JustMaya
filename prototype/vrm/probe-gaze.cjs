// Gaze diagnostic: force lookTargetOffset to known directions and screenshot
// each — plus dump the live __vrmCtl.look trace for sign verification.
// Run: node prototype/vrm/probe-gaze.cjs
let chromium
try { chromium = require(require('path').join(require('os').tmpdir(), 'proto-pw', 'node_modules', 'playwright-core')).chromium }
catch { chromium = require('playwright-core').chromium }
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const base = process.env.PROTO_URL || 'file:///' + path.resolve(__dirname, '..', 'homepage', 'index.html').replace(/\\/g, '/')
const out = path.join(os.tmpdir(), 'meet-mita-vrm-gaze')
fs.mkdirSync(out, { recursive: true })

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

// x>0 = cursor right, y>0 = cursor at bottom of screen
const DIRS = [
  ['center', { x: 0, y: 0 }],
  ['right', { x: 1, y: 0 }],
  ['left', { x: -1, y: 0 }],
  ['down', { x: 0, y: 1 }],
  ['up', { x: 0, y: -1 }],
]

async function main() {
  const browser = await chromium.launch({ executablePath: findBrowser(), args: ['--enable-unsafe-swiftshader'] })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message))
  await page.goto(`${base}?v=b`, { waitUntil: 'load' })
  await page.waitForSelector('#mayaVrm:not([hidden]) canvas', { timeout: 30000 })
  await page.waitForTimeout(2000)
  await page.evaluate(() => window.__vrmCtl.setProps({ enablePointerTracking: false }))
  for (const [name, off] of DIRS) {
    const trace = await page.evaluate(async (o) => {
      window.__vrmCtl.setProps({ lookTargetOffset: o })
      await new Promise(r => setTimeout(r, 1200))
      return window.__vrmCtl.look
    }, off)
    console.log(name, JSON.stringify({ ...off, trace: Object.fromEntries(Object.entries(trace).map(([k, v]) => [k, +v.toFixed(2)])) }))
    await page.screenshot({ path: path.join(out, `gaze-${name}.png`) })
  }
  await browser.close()
  console.log('done ->', out)
}
main().catch((e) => { console.error(e); process.exit(1) })

// Dev-only probe: iterate upper-body bone rotations over file:// and screenshot
// each candidate so pose values can be tuned visually.
// Run: node prototype/vrm/probe.cjs
let chromium
try { chromium = require(require('path').join(require('os').tmpdir(), 'proto-pw', 'node_modules', 'playwright-core')).chromium }
catch { chromium = require('playwright-core').chromium }
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const base = process.env.PROTO_URL || 'file:///' + path.resolve(__dirname, '..', 'homepage', 'index.html').replace(/\\/g, '/')
const out = path.join(os.tmpdir(), 'meet-mita-vrm-pose')
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

// Each entry: [name, {bone: [x,y,z] overrides}]
const COMBOS = JSON.parse(process.env.PROBE_COMBOS || 'null') || [
  ['t-up', { rightUpperArm: [0.7, -0.2, -0.9] }],
  ['t-loX', { rightUpperArm: [0.7, -0.2, -0.9], rightLowerArm: [-1.4, 0, 0] }],
  ['t-loY', { rightUpperArm: [0.7, -0.2, -0.9], rightLowerArm: [0, -1.4, 0] }],
  ['t-loZ', { rightUpperArm: [0.7, -0.2, -0.9], rightLowerArm: [0, 0, -1.4] }],
  ['t-loZ+', { rightUpperArm: [0.7, -0.2, -0.9], rightLowerArm: [0, 0, 1.4] }],
  ['t-loY+', { rightUpperArm: [0.7, -0.2, -0.9], rightLowerArm: [0, 1.4, 0] }],
]

async function main() {
  const browser = await chromium.launch({ executablePath: findBrowser(), args: ['--enable-unsafe-swiftshader'] })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message))
  await page.goto(`${base}?v=b`, { waitUntil: 'load' })
  await page.waitForSelector('#mayaVrm:not([hidden]) canvas', { timeout: 30000 })
  await page.waitForTimeout(2500)
  for (const [name, overrides] of COMBOS) {
    await page.evaluate((o) => {
      const p = window.__vrmProbe
      for (const k of Object.keys(p)) delete p[k]
      Object.assign(p, o)
    }, overrides)
    await page.waitForTimeout(900)
    await page.screenshot({ path: path.join(out, `pose-${name}.png`) })
    console.log('shot', name)
  }
  await browser.close()
  console.log('done ->', out)
}
main().catch((e) => { console.error(e); process.exit(1) })

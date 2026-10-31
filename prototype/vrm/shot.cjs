// PROTOTYPE helper: screenshot the VRM stage on a variant. Throwaway.
// Run: node shot.cjs [variant] [name]
let chromium
try { chromium = require(require('path').join(require('os').tmpdir(), 'proto-pw', 'node_modules', 'playwright-core')).chromium }
catch { chromium = require('playwright-core').chromium }
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const v = process.argv[2] || 'b'
const name = process.argv[3] || 'vrm-variant-' + v
const base = 'file:///' + path.resolve(__dirname, '..', 'homepage', 'index.html').replace(/\\/g, '/')
const out = path.join(os.tmpdir(), 'meet-mita-vrm-proto')
fs.mkdirSync(out, { recursive: true })
const dir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright')
let exe
for (const d of fs.readdirSync(dir).sort().reverse()) {
  const s = path.join(dir, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')
  const f = path.join(dir, d, 'chrome-win64', 'chrome.exe')
  if (d.startsWith('chromium_headless_shell') && fs.existsSync(s)) { exe = s; break }
  if (d.startsWith('chromium-') && fs.existsSync(f)) { exe = f; break }
}
;(async () => {
  const b = await chromium.launch({ executablePath: exe, args: ['--enable-unsafe-swiftshader'] })
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } })
  p.on('pageerror', e => console.log('ERR', e.message))
  await p.goto(base + '?v=' + v, { waitUntil: 'load' })
  await p.waitForSelector('#mayaVrm:not([hidden]) canvas', { timeout: 30000 })
  await p.waitForTimeout(2500)
  await p.screenshot({ path: path.join(out, name + '.png') })
  console.log('saved', name + '.png')
  await b.close()
})().catch(e => { console.error(e); process.exit(1) })

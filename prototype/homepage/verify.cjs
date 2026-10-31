// PROTOTYPE smoke check: throwaway, not part of CI.
// Exercises the homepage spec on all three variants (?v=a|b|c):
// rail buttons, mascot, Talk->Input answer, Upload->reading progress,
// Learn episode list, About modal.
// Run: node verify.cjs            (opens the file directly, no server needed)
//   or PROTO_URL=http://localhost:5173/prototype/homepage/index.html node verify.cjs
// Prefer the proto-pw copy — its chromium build is the one installed locally.
let chromium
try { chromium = require(require('path').join(require('os').tmpdir(), 'proto-pw', 'node_modules', 'playwright-core')).chromium }
catch { chromium = require('playwright-core').chromium }
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const base = process.env.PROTO_URL || 'file:///' + path.resolve(__dirname, 'index.html').replace(/\\/g, '/')
const out = path.join(os.tmpdir(), 'justmaya-home-proto')
fs.mkdirSync(out, { recursive: true })
const errors = []

async function run(browser, variant) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' })
  page.on('pageerror', e => errors.push(`[${variant}] ${e.message}`))
  page.on('console', m => { if (m.type() === 'error') errors.push(`[${variant}] console: ${m.text()}`) })
  page.on('response', r => { if (r.status() >= 400) errors.push(`[${variant}] ${r.status()} ${r.url()}`) })
  await page.goto(`${base}?v=${variant}`, { waitUntil: 'load' })

  // Fixed spec: dialogue box, left rail with the four actions, mascot.
  await page.waitForSelector('.dlg')
  const rail = await page.$$('.rail button')
  assert.equal(rail.length, 4, `[${variant}] rail buttons`)
  const labels = await Promise.all(rail.map(b => b.textContent()))
  assert.deepEqual(labels.map(s => s.trim()), ['Talk', 'Upload', 'Learn', 'About'], `[${variant}] rail labels`)
  const mascotSel = variant === 'b' ? '.face-mascot' : '.maya-svg'
  assert.ok(await page.$(`${mascotSel}:visible`), `[${variant}] mascot rendered`)
  await page.waitForFunction(() => document.getElementById('dlgText').textContent.length > 3)
  await page.screenshot({ path: path.join(out, `v${variant}-home.png`) })

  // Talk -> [Input|Nothing] -> typed question gets a routed answer.
  await page.click('[data-act="talk"]')
  await page.waitForSelector('#dlgChoices:not([hidden])')
  const chips = await page.$$('#dlgChoices button')
  assert.equal(chips.length, 2, `[${variant}] talk choices`)
  assert.equal((await chips[0].textContent()).trim(), 'Input')
  assert.equal((await chips[1].textContent()).trim(), 'Nothing')
  await chips[0].click()
  await page.waitForSelector('#composer:not([hidden])')
  await page.fill('#composerInput', 'what is this app?')
  await page.click('#composer button[type="submit"]')
  await page.waitForFunction(() => /visual|novel|lesson|document|roadmap/i.test(document.getElementById('dlgText').textContent))
  // After the answer the choices return; "Nothing" exits to idle.
  await page.waitForSelector('#dlgChoices:not([hidden])')
  const again = await page.$$('#dlgChoices button')
  await again[again.length - 1].click() // Nothing / Never mind
  await page.waitForSelector('#dlgChoices[hidden]', { state: 'attached' })

  // Upload -> modal -> sample -> reading state + progress bar -> Learn entry.
  await page.click('[data-act="upload"]')
  await page.waitForSelector('#uploadDlg[open]')
  await page.screenshot({ path: path.join(out, `v${variant}-upload.png`) })
  await page.click('#sampleBtn')
  await page.waitForSelector('#uploadChip:not([hidden])')
  await page.waitForFunction(() => document.getElementById('maya').dataset.state === 'reading')
  await page.waitForFunction(() => document.getElementById('upPct').textContent === '100%', null, { timeout: 30000 })
  await page.waitForSelector('#uploadChip[hidden]', { state: 'attached', timeout: 15000 })

  // Learn: Episode 1 ready (updated by the upload), 2-5 planned outlines.
  await page.click('[data-act="learn"]')
  await page.waitForSelector('#learnDlg[open]')
  const eps = await page.$$('#epList .ep')
  assert.equal(eps.length, 5, `[${variant}] episode rows`)
  assert.match(await page.textContent('#ep1Status'), /Ready/, `[${variant}] ep1 ready`)
  assert.match(await page.textContent('#ep1Title'), /rivers and cities/i, `[${variant}] ep1 took uploaded name`)
  assert.match(await page.textContent('#epList'), /Planned outline/, `[${variant}] outlines present`)
  await page.screenshot({ path: path.join(out, `v${variant}-learn.png`) })
  await page.click('#learnDlg [data-close]')

  // About modal.
  await page.click('[data-act="about"]')
  await page.waitForSelector('#aboutDlg[open]')
  assert.match(await page.textContent('#aboutDlg'), /JustMaya turns a document/i)
  await page.click('#aboutDlg [data-close]')

  await page.close()
  console.log(`variant ${variant}: ok`)
}

function findBrowser() {
  // Playwright-core in node_modules/proto-pw expects a newer browser than the
  // one installed — launch the installed chromium directly instead.
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
  const browser = await chromium.launch({ executablePath: findBrowser() })
  try {
    for (const v of ['a', 'b', 'c']) await run(browser, v)
  } finally {
    await browser.close()
  }
  if (errors.length) {
    console.error('page errors:'); errors.forEach(e => console.error(' -', e))
    process.exit(1)
  }
  console.log(`all variants clean. screenshots in ${out}`)
}
main().catch(e => { console.error(e); process.exit(1) })

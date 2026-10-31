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

  // Fixed spec: dialogue box, left rail with the three main actions, mascot.
  await page.waitForSelector('.dlg')
  const rail = await page.$$('.rail button')
  assert.equal(rail.length, 3, `[${variant}] rail buttons`)
  const labels = await Promise.all(rail.map(b => b.textContent()))
  assert.deepEqual(labels.map(s => s.trim()), ['Talk', 'Upload', 'Learn'], `[${variant}] rail labels`)

  // Menu trigger sits top-right on desktop (1280px wide here).
  const mtBox = await (await page.$('.menu-trigger')).boundingBox()
  assert.ok(mtBox.x > 1100 && mtBox.y < 80, `[${variant}] menu trigger top-right on desktop`)
  const mascotSel = variant === 'b' ? '.face-mascot' : '.maya-svg'
  assert.ok(await page.$(`${mascotSel}:visible`), `[${variant}] mascot rendered`)
  await page.waitForFunction(() => document.getElementById('dlgText').textContent.length > 3)
  await page.screenshot({ path: path.join(out, `v${variant}-home.png`) })

  // Talk -> overlay strips [{input} | Nothing] over the dimmed scene.
  await page.click('[data-act="talk"]')
  await page.waitForSelector('#askOverlay:not([hidden])')
  assert.ok(await page.$('#stage.ask-dim'), `[${variant}] scene dims while choosing`)
  assert.ok(await page.$('#askStrip'), `[${variant}] input strip`)
  assert.ok(await page.$('#askNothing'), `[${variant}] Nothing strip`)

  // Send via the strip: question echoes as "You", Mita answers, Talk ends.
  await page.fill('#askInput', 'what is this app?')
  await page.click('#askSend')
  await page.waitForSelector('#askOverlay[hidden]', { state: 'attached' })
  await page.waitForFunction(() => document.getElementById('dlgName').textContent === 'You')
  await page.waitForFunction(() => /visual|novel|lesson|document|roadmap/i.test(document.getElementById('dlgText').textContent))
  assert.equal(await page.textContent('#dlgName'), 'Mita', `[${variant}] speaker returns to Mita`)
  assert.ok(await page.$('#askOverlay[hidden]'), `[${variant}] no second compose — Talk is over`)

  // Nothing exits to idle.
  await page.click('[data-act="talk"]')
  await page.waitForSelector('#askOverlay:not([hidden])')
  await page.click('#askNothing')
  await page.waitForSelector('#askOverlay[hidden]', { state: 'attached' })
  await page.waitForFunction(() => !document.getElementById('stage').classList.contains('ask-dim'))

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

  // Menu bundles Reduce motion (role=switch, device reset) and About.
  await page.click('#menuTrigger')
  await page.waitForSelector('#menuDlg[open]')
  await page.waitForSelector('#motionRow[role="switch"]')
  const motionBefore = await page.evaluate(() => document.documentElement.dataset.motion)
  await page.click('#motionRow')
  const motionAfter = await page.evaluate(() => document.documentElement.dataset.motion)
  assert.notEqual(motionAfter, motionBefore, `[${variant}] motion switch flips`)
  await page.waitForSelector('#motionReset:not([hidden])')
  await page.click('#motionReset')
  assert.equal(await page.evaluate(() => document.documentElement.dataset.motion), motionBefore, `[${variant}] device reset restores motion`)
  await page.screenshot({ path: path.join(out, `v${variant}-menu.png`) })

  // About via the menu row: closes the menu, opens the about dialog.
  await page.click('#menuAbout')
  await page.waitForSelector('#aboutDlg[open]')
  assert.match(await page.textContent('#aboutDlg'), /JustMaya turns a document/i)
  await page.click('#aboutDlg [data-close]')

  // Player-driven dialogue: clicking the box advances to the next line.
  await page.waitForFunction(() => document.getElementById('dlgText').textContent.length > 3)
  const line1 = await page.textContent('#dlgText')
  await page.click('#dlg')
  await page.waitForFunction(prev => {
    const t = document.getElementById('dlgText').textContent
    return t !== prev && t.length > 3
  }, line1)
  assert.notEqual(await page.textContent('#dlgText'), line1, `[${variant}] click advances dialogue`)

  // Auto-advance only after ~10s idle — checked once on variant a.
  if (variant === 'a') {
    const line2 = await page.textContent('#dlgText')
    await page.waitForFunction(prev => document.getElementById('dlgText').textContent !== prev, line2, { timeout: 14000 })
  }

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
    // Mobile: rail sits below the dialogue box, centred to it, Menu on the same row.
    const mp = await browser.newPage({ viewport: { width: 420, height: 800 }, reducedMotion: 'reduce' })
    mp.on('pageerror', e => errors.push(`[mobile] ${e.message}`))
    await mp.goto(`${base}?v=a`, { waitUntil: 'load' })
    const dlg = await (await mp.$('#dlg')).boundingBox()
    const rail = await (await mp.$('.rail')).boundingBox()
    const mm = await (await mp.$('.menu-trigger')).boundingBox()
    assert.ok(rail.y >= dlg.y + dlg.height - 2, '[mobile] rail below the dialogue box')
    const railCx = rail.x + rail.width / 2, dlgCx = dlg.x + dlg.width / 2
    assert.ok(Math.abs(railCx - dlgCx) < 40, `[mobile] rail centred to dialogue (${railCx.toFixed(0)} vs ${dlgCx.toFixed(0)})`)
    assert.ok(mm.y + mm.height > rail.y && mm.y < rail.y + rail.height, '[mobile] Menu on the same row')
    assert.ok(mm.x + mm.width > 380, '[mobile] Menu at the right end')
    assert.ok(mm.x >= rail.x + rail.width - 2, '[mobile] no Menu/rail overlap')
    await mp.screenshot({ path: path.join(out, 'mobile-foot.png') })
    await mp.close()
    console.log('mobile rail/menu placement: ok')
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

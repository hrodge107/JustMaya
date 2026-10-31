// PROTOTYPE smoke check — throwaway, not part of CI.
// Exercises the backlog overlay, jump warning, and truncation on all variants.
// Run: node verify.cjs  (expects vite dev on 5174, or set PROTO_URL)
const { chromium } = require(require('path').join(require('os').tmpdir(), 'proto-pw', 'node_modules', 'playwright-core'))
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const base = process.env.PROTO_URL || 'http://localhost:5174/prototype/backlog/index.html'
const out = path.join(os.tmpdir(), 'justmaya-backlog-proto-2')
fs.mkdirSync(out, { recursive: true })
const errors = []

async function run(browser, variant) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' })
  page.on('pageerror', e => errors.push(`[${variant}] ${e.message}`))
  page.on('console', m => { if (m.type() === 'error') errors.push(`[${variant}] console: ${m.text()}`) })
  page.on('response', r => { if (r.status() >= 400) errors.push(`[${variant}] ${r.status()} ${r.url()}`) })
  await page.goto(`${base}?v=${variant}`, { waitUntil: 'networkidle' })

  // Scene copied: header, mascot, dialogue box, menu rail all present.
  await page.waitForSelector('.vn-dialogue')
  assert.ok(await page.$('.mascot-face'), 'mascot rendered')
  assert.ok(await page.$('.vn-menu-trigger'), 'menu trigger rendered')
  assert.ok(await page.$('#cue'), 'backlog ^ cue inside dialogue')

  // Entry point 1: ^ inside the dialogue box.
  await page.click('#cue')
  await page.waitForSelector('#backlog:not([hidden])')
  const rows = await page.$$('.bl-row')
  assert.ok(rows.length >= 6, `backlog rows render (${rows.length})`)
  await page.screenshot({ path: path.join(out, `v${variant}-backlog.png`) })

  // Click a chat -> warning modal -> confirm -> progress + backlog rewind.
  const target = 2
  await rows[target].click()
  if (variant === 'b') {
    await page.waitForSelector('#bl-confirm:not([hidden])')
    await page.click('#bl-jump')
  } else {
    await page.waitForSelector('dialog.bl-warn[open]')
    await page.screenshot({ path: path.join(out, `v${variant}-warn.png`) })
    await page.click('#warn-jump')
  }
  await page.waitForSelector('#backlog[hidden]', { state: 'attached' })
  await page.waitForFunction(() => document.getElementById('vn-shown').textContent.length > 0)
  const shown = await page.textContent('#vn-shown')
  assert.ok(shown.length > 0, 'dialogue shows the jumped-to line')

  // Reopen via entry point 2: menu -> Backlog. Log must be truncated to target+1.
  await page.click('#menu-open')
  await page.click('#menu-backlog')
  await page.waitForSelector('#backlog:not([hidden])')
  const rowsAfter = await page.$$('.bl-row')
  assert.equal(rowsAfter.length, target + 1, `backlog truncated to ${target + 1} rows`)
  await page.screenshot({ path: path.join(out, `v${variant}-after-jump.png`) })
  await page.close()
}

async function main() {
let browser
for (const channel of ['msedge', 'chrome']) {
  try { browser = await chromium.launch({ channel }); break } catch { /* next channel */ }
}
if (!browser) throw new Error('No system Edge/Chrome found for playwright-core')
for (const v of ['a', 'b', 'c']) await run(browser, v)
await browser.close()
if (errors.length) { console.error('ERRORS:\n' + errors.join('\n')); process.exit(1) }
console.log('OK — 3 variants verified. Shots at ' + out)
}
main().catch(e => { console.error(e); process.exit(1) })

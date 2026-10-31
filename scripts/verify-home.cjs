// Homepage (variant B integration) verification. Runs against Vite with
// Playwright; all API responses are stubbed fixtures — no backend or model.
// Covers: chrome/icons, dialogue advance rules, Talk overlay, upload ->
// real job drive -> confirm -> ready -> Learn -> session, failure+retry,
// ?job= resume, Menu/motion/About, mobile layout, reduced motion.
// Rail display is locked at icon + text (the prototype's 3-state toggle is gone).
const { chromium } = (() => { try { return require('playwright') } catch { return require('playwright-core') } })()
const assert = require('node:assert/strict')

const base = process.env.HOME_VERIFY_URL || 'http://127.0.0.1:5173'
const evidence = []
const errors = []

const DOC_ID = 'doc-1', EP_ID = 'ep-1', SESSION_ID = 'sess-1'
const EP_TITLE = 'Rivers and Cities'
const episode = {
  episodeId: EP_ID, title: EP_TITLE, status: 'ready', startSceneId: 's1',
  scenes: [
    { sceneId: 's1', kind: 'dialogue', nextSceneId: 's2', question: null, dialogue: [{ lineId: 'l1', speaker: 'mascot', text: 'Fixture lesson line.', emotion: 'talking' }] },
    { sceneId: 's2', kind: 'ending', nextSceneId: null, question: null, dialogue: [{ lineId: 'l2', speaker: 'mascot', text: 'Done.', emotion: 'happy' }] },
  ],
  learningObjectives: [], estimatedMinutes: 9,
}
const outlines = [
  { episode_id: EP_ID, title: EP_TITLE, objective_ids: ['o1'], status: 'selected', estimated_minutes: 9, warnings: [] },
  { episode_id: 'ep-2', title: 'Trade and early writing', objective_ids: ['o1'], status: 'planned_only', estimated_minutes: 8, warnings: [] },
  { episode_id: 'ep-3', title: 'Law, kingship, and order', objective_ids: ['o1'], status: 'planned_only', estimated_minutes: 8, warnings: [] },
]
const roadmapFor = confirmed => ({ revision: 1, confirmed, objectives: [{ id: 'o1', description: 'Explain rivers.' }], concepts: [], uncovered_concept_ids: [], uncovered_reasons: {}, episodes: outlines })
const sessionRow = { sessionId: SESSION_ID, episodeId: EP_ID, mode: 'playing', sceneId: 's1', dialogueIndex: 0, version: 1, status: 'active', updatedAt: '2026-10-28T00:00:00Z' }

// A scripted job lifecycle: each GET advances one stage; awaiting_review
// parks until the app confirms the roadmap and POSTs run again.
const NEXT = { queued: 'extract', extract: 'index', index: 'analyze', analyze: 'plan', plan: 'awaiting_review', awaiting_review: 'awaiting_review', detail: 'generate', generate: 'validate', validate: 'complete', complete: 'complete', failed: 'failed' }
function makeJob(state, failAt = null) { return { state, failAt, confirmed: false } }
function jobRow(j) {
  const s = j.state
  const failed = s === 'failed' || s === j.failAt
  const exec = failed ? 'failed' : s === 'complete' ? 'complete' : s === 'awaiting_review' ? 'awaiting_review' : s === 'queued' ? 'queued' : 'running'
  return {
    job_id: 'x', document_id: DOC_ID, error: failed ? 'fixture generate exploded' : null,
    status: s === 'complete' ? 'ready' : failed ? 'failed' : s === 'awaiting_review' ? 'awaiting_review' : 'running',
    stage: failed ? (j.failAt ?? 'generate') : s === 'complete' ? 'validate' : s === 'awaiting_review' ? 'plan' : s,
    execution_state: exec, can_run: s === 'queued' || failed,
  }
}

async function stub(page, { failAt = null, resumeJob = null } = {}) {
  const calls = []
  const jobs = new Map()
  jobs.set('job-1', makeJob('queued', failAt))
  if (resumeJob) jobs.set('job-2', makeJob(resumeJob))
  await page.route('**/api/**', async route => {
    const req = route.request()
    const url = new URL(req.url())
    const path = url.pathname
    calls.push({ path, method: req.method() })
    const json = (body, status = 200) => route.fulfill({ status, json: body })
    const err = (status, code, message) => route.fulfill({ status, json: { error: { code, message } } })
    if (path === '/api/documents' && req.method() === 'GET') return json({ documents: [{ document_id: DOC_ID, filename: 'fixture-chapter.pdf', page_count: 12, created_at: '2026-10-28T00:00:00Z' }] })
    if (path === '/api/documents' && req.method() === 'POST') {
      const name = /filename="([^"]+)"/.exec(req.postData() ?? '')?.[1] ?? 'upload.bin'
      if (!name.toLowerCase().endsWith('.pdf')) return err(422, 'INVALID_FILE_TYPE', 'Only PDF files are supported.')
      jobs.set('job-1', makeJob('queued', failAt))
      return json({ job_id: 'job-1', document_id: DOC_ID }, 201)
    }
    const jobMatch = /^\/api\/jobs\/([^/]+)(\/run)?$/.exec(path)
    if (jobMatch) {
      const j = jobs.get(jobMatch[1])
      if (!j) return err(404, 'NOT_FOUND', 'Job not found.')
      if (jobMatch[2]) {
        if (j.state === 'queued') j.state = 'extract'
        else if (j.state === 'awaiting_review' && j.confirmed) j.state = 'detail'
        else if (j.state === 'failed' || j.state === j.failAt) { j.state = 'detail'; j.failAt = null }
        return json({ ...jobRow(j), job_id: jobMatch[1] })
      }
      const row = { ...jobRow(j), job_id: jobMatch[1] }
      if (j.state === j.failAt) j.state = 'failed'
      else j.state = NEXT[j.state] ?? j.state
      return json(row)
    }
    if (path === `/api/documents/${DOC_ID}/curriculum` && req.method() === 'GET') return json(roadmapFor(jobs.get('job-1').confirmed))
    if (path === `/api/documents/${DOC_ID}/curriculum/confirm` && req.method() === 'POST') {
      for (const j of jobs.values()) if (j.state === 'awaiting_review') j.confirmed = true
      return json(roadmapFor(true))
    }
    if (path === `/api/episodes/${EP_ID}` && req.method() === 'GET') return json(episode)
    if (path === `/api/episodes/${EP_ID}/sessions` && req.method() === 'POST') return json(sessionRow, 201)
    if (path === `/api/sessions/${SESSION_ID}` && req.method() === 'GET') return json(sessionRow)
    return err(404, 'NOT_FOUND', `Unstubbed ${req.method()} ${path}`)
  })
  return calls
}

const dlgText = page => page.locator('.dlg-text').first().innerText()
async function advanceTo(page, predicate, { timeout = 30000, label = 'dialogue state' } = {}) {
  // Poll + click: each click completes typing then advances a hold.
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await page.locator('.dlg').click({ timeout: 2000 }).catch(() => {})
    await page.waitForTimeout(300)
  }
  throw new Error(`Timed out waiting for ${label}; last line: ${await dlgText(page)}`)
}
const track = (name, fn) => fn().then(() => evidence.push({ check: name, result: 'PASS' })).catch(e => { evidence.push({ check: name, result: `FAIL: ${e.message}` }) })

async function run() {
  const browser = await chromium.launch({ channel: process.env.PLAYER_VERIFY_BROWSER || 'msedge', headless: true })

  // ---------- desktop happy path ----------
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`))
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errors.push(`console: ${m.text()}`) })
  const calls = await stub(page)
  await page.goto(`${base}/`)
  await page.locator('.home').waitFor()

  await track('chrome: rail with icon+text locked, mascot', async () => {
    const buttons = page.locator('.rail button')
    await assert.deepEqual(await buttons.allInnerTexts().then(t => t.map(x => x.trim())), ['Talk', 'Upload', 'Learn', 'Menu'])
    assert.equal(await page.locator('.rail button .bi').count(), 4)
    assert.equal(await page.locator('.rail button .bi:visible').count(), 4, 'icons always shown')
    assert.equal(await page.locator('.rail button span:visible').count(), 4, 'labels always shown')
    assert.equal(await page.locator('#iconToggle').count(), 0, 'no display toggle')
    await page.locator('.mascot-face').waitFor()
    await page.locator('.dlg-name').waitFor()
    assert.match(await dlgText(page), /\S/)
  })

  await track('idle dialogue auto-advances after 10s', async () => {
    const first = await dlgText(page)
    await page.waitForTimeout(11500)
    assert.notEqual(await dlgText(page), first)
  })

  await track('dialogue click completes then advances', async () => {
    const before = await dlgText(page)
    await page.locator('.dlg').click()
    const completed = await dlgText(page)
    assert.ok(completed.length >= before.length, 'click should reveal the full line')
    await page.locator('.dlg').click()
    await page.waitForTimeout(600)
    assert.notEqual(await dlgText(page), completed)
  })

  await track('Talk: overlay, You echo, single answer, ambient resumes', async () => {
    await page.getByRole('button', { name: 'Talk', exact: true }).click()
    await page.locator('.ask-overlay').waitFor()
    await page.locator('.stage.ask-dim').waitFor()
    await page.locator('.ask-strip').click()
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('.ask-strip input')), true, 'empty strip should focus the input')
    await page.locator('.ask-strip input').fill('what is this app')
    const send = page.locator('.ask-strip button', { hasText: 'Send' })
    await send.waitFor()
    await send.click()
    await page.locator('.ask-overlay').waitFor({ state: 'detached' })
    await advanceTo(page, async () => (await page.locator('.dlg-name').innerText()) === 'You', { label: 'You echo' })
    assert.match(await dlgText(page), /what is this app/)
    await advanceTo(page, async () => /Meet Mita|document|visual-novel|lesson/i.test(await dlgText(page)), { label: 'Mita answer' })
    assert.equal(await page.locator('.ask-overlay').count(), 0, 'no second compose strip')
  })

  await track('Talk: Nothing exits to idle', async () => {
    await page.getByRole('button', { name: 'Talk', exact: true }).click()
    await page.locator('.ask-overlay').waitFor()
    await page.getByRole('button', { name: 'Nothing', exact: true }).click()
    await page.locator('.ask-overlay').waitFor({ state: 'detached' })
    await advanceTo(page, async () => /warm|show|unclear/i.test(await dlgText(page)), { label: 'talk-end line' })
  })

  await track('Upload: rejects non-PDF inside the modal', async () => {
    await page.getByRole('button', { name: 'Upload', exact: true }).click()
    await page.locator('#uploadDlg[open]').waitFor()
    await page.setInputFiles('#filePick', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') })
    await page.locator('#uploadDlg .form-error').waitFor()
    assert.match(await page.locator('#uploadDlg .form-error').innerText(), /PDF/)
    assert.ok(await page.locator('#uploadDlg[open]').count(), 'modal stays open on failure')
  })

  await track('Upload: real job drives reading, ready, Learn, Play', async () => {
    await page.setInputFiles('#filePick', { name: 'fixture-chapter.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 fixture') })
    await page.locator('#uploadDlg[open]').waitFor({ state: 'detached' })
    await page.locator('.upload-chip').waitFor()
    await page.locator('.mascot[data-emotion="reading"]').waitFor()
    assert.match(await page.locator('.upload-chip .up-name').innerText(), /fixture-chapter\.pdf/)
    assert.equal(await page.getByRole('button', { name: 'Talk', exact: true }).getAttribute('aria-disabled'), 'true')
    await page.locator('.up-fill').waitFor()
    await assert.doesNotReject(async () => {
      await page.waitForFunction(() => {
        const el = document.querySelector('.up-fill')
        return el && parseFloat(el.style.width) >= 100
      }, null, { timeout: 60000 })
    }, 'progress should reach 100%')
    assert.ok(calls.some(c => c.path === '/api/jobs/job-1/run' && c.method === 'POST'), 'run posted')
    assert.ok(calls.some(c => c.path.endsWith('/curriculum/confirm') && c.method === 'POST'), 'roadmap auto-confirmed')
    await advanceTo(page, async () => (await dlgText(page)).includes(EP_TITLE), { timeout: 40000, label: 'read-done turn naming the episode' })
    await page.locator('.upload-chip').waitFor({ state: 'detached' })

    await page.getByRole('button', { name: 'Learn', exact: true }).click()
    await page.locator('#learnDlg[open]').waitFor()
    await page.locator('.ep.ready').waitFor()
    const rows = await page.locator('.ep').allInnerTexts()
    assert.ok(rows[0].includes(EP_TITLE) && /Ready/.test(rows[0]), `ready row: ${rows[0]}`)
    assert.ok(rows.slice(1).every(r => /Planned outline/.test(r)), 'later episodes are planned outlines only')
    assert.equal(await page.locator('.ep button').count(), 1, 'only the ready episode is playable')
    await page.locator('.ep button', { hasText: 'Play' }).click()
    await page.locator('.vn-frame').waitFor({ timeout: 15000 })
    assert.equal(new URL(page.url()).searchParams.get('session'), SESSION_ID)
    await page.locator('.vn-dialogue-target').waitFor()
    assert.ok(calls.some(c => c.path === `/api/episodes/${EP_ID}/sessions` && c.method === 'POST'))
  })

  await track('player exit returns to home lobby', async () => {
    await page.getByRole('button', { name: 'Menu', exact: true }).click()
    await page.getByRole('button', { name: 'Leave episode', exact: true }).click()
    await page.locator('.home').waitFor()
    assert.equal(new URL(page.url()).searchParams.has('session'), false)
  })

  await track('Menu: motion switch, reset, About', async () => {
    await page.getByRole('button', { name: 'Menu', exact: true }).click()
    await page.locator('#menuDlg[open]').waitFor()
    const row = page.locator('.menu-row[role="switch"]')
    await row.click()
    assert.equal(await page.evaluate(() => document.documentElement.dataset.motion), 'reduce')
    await page.locator('.motion-reset').waitFor()
    await page.locator('.motion-reset').click()
    assert.notEqual(await page.evaluate(() => document.documentElement.dataset.motion), 'reduce')
    await page.locator('.menu-row', { hasText: 'About' }).click()
    await page.locator('#aboutDlg[open]').waitFor()
    assert.match(await page.locator('#aboutDlg').innerText(), /turns a document into a playable lesson/)
    await page.locator('#aboutDlg .ghost').click()
    await page.locator('#aboutDlg[open]').waitFor({ state: 'detached' })
  })

  // ---------- job failure + retry ----------
  const ctxFail = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const pageFail = await ctxFail.newPage()
  pageFail.on('pageerror', e => errors.push(`pageerror(fail): ${e.message}`))
  const callsFail = await stub(pageFail, { failAt: 'generate' })
  await pageFail.goto(`${base}/`)
  await pageFail.locator('.dlg').click()
  await track('job failure: fail line, error chip, Retry recovers', async () => {
    await pageFail.getByRole('button', { name: 'Upload', exact: true }).click()
    await pageFail.locator('#uploadDlg[open]').waitFor()
    await pageFail.setInputFiles('#filePick', { name: 'fixture-chapter.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 fixture') })
    await pageFail.locator('.upload-chip').waitFor()
    await pageFail.locator('.upload-chip .up-err').waitFor({ timeout: 60000 })
    await advanceTo(pageFail, async () => /stalled|snag|fought back|didn't finish/i.test(await dlgText(pageFail)), { label: 'fail line' })
    const runs = () => callsFail.filter(c => c.path === '/api/jobs/job-1/run' && c.method === 'POST').length
    const before = runs()
    await pageFail.getByRole('button', { name: 'Retry', exact: true }).click()
    await pageFail.waitForFunction(() => {
      const el = document.querySelector('.up-fill')
      return el && parseFloat(el.style.width) >= 100
    }, null, { timeout: 60000 })
    assert.ok(runs() > before, 'retry fired another run')
  })

  // ---------- ?job= resume ----------
  const ctxResume = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const pageResume = await ctxResume.newPage()
  pageResume.on('pageerror', e => errors.push(`pageerror(resume): ${e.message}`))
  await stub(pageResume, { resumeJob: 'generate' })
  await pageResume.goto(`${base}/?job=job-2`)
  await track('reload with ?job= resumes the read narration', async () => {
    await pageResume.locator('.upload-chip').waitFor()
    await pageResume.locator('.mascot[data-emotion="reading"]').waitFor()
    await pageResume.waitForFunction(() => {
      const el = document.querySelector('.up-fill')
      return el && parseFloat(el.style.width) >= 100
    }, null, { timeout: 60000 })
  })

  // ---------- mobile layout ----------
  const ctxMobile = await browser.newContext({ viewport: { width: 420, height: 800 } })
  const pageMobile = await ctxMobile.newPage()
  pageMobile.on('pageerror', e => errors.push(`pageerror(mobile): ${e.message}`))
  await stub(pageMobile)
  await pageMobile.goto(`${base}/`)
  await track('mobile: rail row under dialogue, no overflow', async () => {
    await pageMobile.locator('.home').waitFor()
    const dlgBox = await pageMobile.locator('.dlg').boundingBox()
    const railBox = await pageMobile.locator('.rail').boundingBox()
    assert.ok(railBox.y >= dlgBox.y + dlgBox.height - 1, 'rail sits below the dialogue')
    const widths = await pageMobile.locator('.rail button').evaluateAll(els => els.map(e => e.getBoundingClientRect().width))
    assert.equal(widths.length, 4)
    assert.ok(Math.max(...widths) - Math.min(...widths) < 8, `rail buttons share the row: ${widths}`)
    const overflow = await pageMobile.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    assert.ok(overflow <= 1, `horizontal overflow: ${overflow}px`)
  })

  // ---------- reduced motion ----------
  const ctxReduce = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' })
  const pageReduce = await ctxReduce.newPage()
  pageReduce.on('pageerror', e => errors.push(`pageerror(reduce): ${e.message}`))
  await stub(pageReduce)
  await pageReduce.goto(`${base}/`)
  await track('reduced motion: full lines land instantly', async () => {
    await pageReduce.waitForFunction(() => (document.querySelector('.dlg-text')?.innerText.length ?? 0) > 20, null, { timeout: 5000 })
    const a = await dlgText(pageReduce)
    await pageReduce.waitForTimeout(400)
    assert.equal(await dlgText(pageReduce), a, 'no typewriter under reduced motion')
  })

  await browser.close()
}

run().then(() => {
  console.log('\n=== verify-home results ===')
  for (const item of evidence) console.log(`${item.result.startsWith('PASS') ? 'PASS' : 'FAIL'}  ${item.check}${item.result === 'PASS' ? '' : ` -- ${item.result}`}`)
  if (errors.length) { console.log('\npage errors:'); for (const e of errors) console.log(' -', e) }
  const failed = evidence.filter(i => i.result !== 'PASS')
  if (failed.length || errors.length) { console.log(`\n${failed.length} failing check(s), ${errors.length} page error(s)`); process.exit(1) }
  console.log(`\nAll ${evidence.length} checks passed.`)
}).catch(e => { console.error('verify-home crashed:', e); process.exit(1) })

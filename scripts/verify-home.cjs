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
    if (path === '/api/documents/photos' && req.method() === 'POST') {
      const filenames = [...(req.postData() ?? '').matchAll(/filename="([^"]+)"/g)].map(match => match[1])
      calls.push({ photos: filenames })
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
      if (calls.some(call => call.photos)) row.warnings = ['Photo 2 (second.png) had uncertain text omitted.']
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

// Browser-shelf (IndexedDB PoC) probes — same 'meet-mita' db + 'docs' store the
// app writes. Records are projected so Blob fields serialize as sizes.
const shelfRows = page => page.evaluate(() => new Promise((res, rej) => {
  const req = indexedDB.open('meet-mita', 1)
  req.onupgradeneeded = () => req.result.createObjectStore('docs', { keyPath: 'documentId' })
  req.onsuccess = () => {
    const g = req.result.transaction('docs', 'readonly').objectStore('docs').getAll()
    g.onsuccess = () => res(g.result.map(r => ({ documentId: r.documentId, docName: r.docName, episodeId: r.episodeId, episodeTitle: r.episodeTitle, pdfSize: r.pdf instanceof Blob ? r.pdf.size : null })))
    g.onerror = () => rej(g.error)
  }
  req.onerror = () => rej(req.error)
}))
const putRawShelf = (page, rec) => page.evaluate(r => new Promise((res, rej) => {
  const req = indexedDB.open('meet-mita', 1)
  req.onupgradeneeded = () => req.result.createObjectStore('docs', { keyPath: 'documentId' })
  req.onsuccess = () => {
    const tx = req.result.transaction('docs', 'readwrite')
    tx.objectStore('docs').put(r)
    tx.oncomplete = () => res()
    tx.onerror = () => rej(tx.error)
  }
  req.onerror = () => rej(req.error)
}), rec)
// The detached shelf write lands a tick after the ready UI flips — poll briefly.
const waitForShelf = async page => {
  for (let i = 0; i < 50; i++) {
    const rows = await shelfRows(page)
    if (rows.length) return rows
    await page.waitForTimeout(200)
  }
  return []
}

async function run() {
  const browser = await chromium.launch({ channel: process.env.PLAYER_VERIFY_BROWSER || 'msedge', headless: true })

  // ---------- desktop happy path ----------
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`))
  // GLTFLoader blob-texture failures are headless-Edge flake on the mascot's
  // embedded textures — same class of noise as 'Failed to load resource'.
  const noise = m => m.type() !== 'error' || m.text().includes('Failed to load resource') || m.text().includes('THREE.GLTFLoader')
  page.on('console', m => { if (!noise(m)) errors.push(`console: ${m.text()}`) })
  const calls = await stub(page)
  await page.goto(`${base}/`)
  await page.locator('.home').waitFor()

  await track('chrome: rail with icon+text locked, mascot', async () => {
    const buttons = page.locator('.rail button')
    await assert.deepEqual(await buttons.allInnerTexts().then(t => t.map(x => x.trim())), ['Talk', 'Upload', 'Learn'])
    assert.equal(await page.locator('.rail button .bi').count(), 3, 'Talk/Upload/Learn keep SVG icons')
    assert.equal(await page.locator('.rail button .bi:visible').count(), 3, 'icons always shown')
    assert.equal(await page.locator('#iconToggle').count(), 0, 'no display toggle')
    await page.locator('.mascot:visible').waitFor()
    await page.locator('.dlg-name').waitFor()
    assert.match(await dlgText(page), /\S/)
  })

  await track('shared chrome: Upload/Learn/Menu use the player vn-menu identity', async () => {
    const triggers = page.locator('.home .vn-menu-trigger')
    assert.equal(await triggers.count(), 3, 'Upload, Learn and Menu are vn-menu-trigger pills')
    assert.equal(await page.locator('.home .vn-menu-rail .vn-menu-icon > span').count(), 3, 'CSS hamburger has three bars')
    for (const trigger of await triggers.all()) {
      const skin = await trigger.evaluate(el => { const c = getComputedStyle(el); return { bg: c.backgroundColor, fg: c.color, ring: c.boxShadow } })
      assert.equal(skin.bg, 'rgb(52, 64, 94)', 'trigger uses the shared navy rail')
      assert.equal(skin.fg, 'rgb(255, 255, 255)', 'trigger label is white')
      assert.notEqual(skin.ring, 'none', 'rail buttons have a visible outline')
    }
  })

  await track('idle dialogue auto-advances after 10s', async () => {
    const first = await dlgText(page)
    await page.waitForTimeout(11500)
    assert.notEqual(await dlgText(page), first)
  })

  await track('dialogue click completes then advances', async () => {
    // Avatar preparation can outlast the initial typewriter. Start from an
    // observed typing state rather than assuming the 11.5s wait landed in one.
    await page.locator('.dlg').click()
    await page.waitForFunction(() => {
      const visible = document.querySelector('.dlg-text > [aria-hidden]')?.textContent
      const full = document.querySelector('.dlg-text > [aria-live]')?.textContent
      return visible && visible !== full
    }, null, { timeout: 15000 })
    const full = await page.locator('.dlg-text > [aria-live]').first().textContent()
    await page.locator('.dlg').click()
    assert.equal(await page.locator('.dlg-text > [aria-hidden]').first().textContent(), full, 'click should reveal the full line')
    await page.locator('.dlg').click()
    await page.waitForFunction(full => document.querySelector('.dlg-text > [aria-live]')?.textContent !== full, full)
  })

  await track('Talk: overlay, You echo, single answer, ambient resumes', async () => {
    await page.getByRole('button', { name: 'Talk', exact: true }).click()
    await page.locator('.ask-overlay').waitFor()
    await page.locator('.stage.ask-dim').waitFor()
    assert.equal(await page.locator('.vn-ask-strip').evaluate(el => getComputedStyle(el).transitionDuration), '0.16s',
      'Talk strips carry the shared vn-choice transform animation')
    await page.locator('.vn-ask-strip').click()
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('.vn-ask-input')), true, 'empty strip should focus the input')
    await page.locator('.vn-ask-input').fill('what is this app')
    const send = page.locator('.vn-ask-send', { hasText: 'Send' })
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
    assert.ok(await page.locator('#uploadDlg.vn-menu-dialog').count(), 'upload modal shares the vn-menu-dialog frame')
    const head = await page.locator('#uploadDlg h2').evaluate(el => { const c = getComputedStyle(el); return { color: c.color, w: getComputedStyle(el.closest('dialog')).width } })
    assert.equal(head.color, 'rgb(48, 48, 76)', 'modal heading is ink, not white')
    assert.ok(parseFloat(head.w) >= 540, `upload modal widened to fit (${head.w})`)
    await page.getByRole('button', { name: /PDF.*One document/ }).click()
    await page.setInputFiles('#filePick', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') })
    await page.getByRole('button', { name: 'Create lesson from PDF' }).click()
    await page.locator('#uploadDlg .form-error').waitFor()
    assert.match(await page.locator('#uploadDlg .form-error').innerText(), /PDF/)
    assert.ok(await page.locator('#uploadDlg[open]').count(), 'modal stays open on failure')
  })

  await track('Upload: real job drives reading, ready, Learn, Play', async () => {
    await page.setInputFiles('#filePick', { name: 'fixture-chapter.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 fixture') })
    await page.getByRole('button', { name: 'Create lesson from PDF' }).click()
    await page.locator('#uploadDlg[open]').waitFor({ state: 'detached' })
    await page.locator('.upload-chip').waitFor()
    await page.locator('.mascot[data-emotion="reading"]:visible').waitFor()
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
    // The episode persists as the same chip, now a playable card, and Mita
    // asks once whether to play it. The chip never detaches on success.
    await page.locator('.upload-chip.ready').waitFor({ timeout: 10000 })
    await page.locator('.ask-overlay').waitFor({ timeout: 15000 })
    assert.equal(await page.locator('.ask-overlay .vn-choice').count(), 2, 'offer shows Yes/No choices')
    assert.equal(await page.getByRole('button', { name: 'Talk', exact: true }).getAttribute('aria-disabled'), 'true', 'Talk disabled during the offer')
    await page.getByRole('button', { name: 'Not now', exact: true }).click()
    await advanceTo(page, async () => (await page.locator('.dlg-name').innerText()) === 'You', { label: 'decline echo' })
    assert.match(await dlgText(page), /no|not/i, 'learner filler echoes the decline')
    await advanceTo(page, async () => /card|learn/i.test(await dlgText(page)), { label: 'Mita points at card + Learn' })
    assert.ok(await page.locator('.upload-chip.ready').count(), 'ready card persists after declining')
    await page.locator('.ask-overlay').waitFor({ state: 'detached' })

    await page.getByRole('button', { name: 'Learn', exact: true }).click()
    await page.locator('#learnDlg[open]').waitFor()
    await page.locator('.ep-list .ep.ready').waitFor()
    const learnW = await page.locator('#learnDlg').evaluate(el => parseFloat(getComputedStyle(el).width))
    assert.ok(learnW >= 620, `learn modal widened to fit episode rows (${learnW}px)`)
    // Per document only episode 1 shows; later outlines collapse behind a
    // disclosure the learner must click — they are not playable anyway.
    assert.equal(await page.locator('.ep-list .ep:visible').count(), 1, 'only episode 1 is visible per document')
    const summary = page.locator('.ep-more > summary')
    assert.match(await summary.innerText(), /2 more planned outlines/)
    await summary.click()
    const rows = await page.locator('.ep-list .ep:visible').allInnerTexts()
    assert.ok(rows[0].includes(EP_TITLE) && /Ready/.test(rows[0]), `ready row: ${rows[0]}`)
    assert.ok(rows.slice(1).every(r => /Planned outline/.test(r)), 'later episodes are planned outlines only')
    assert.equal(await page.locator('.ep-list .ep .vn-button').count(), 1, 'only the ready episode is playable')
    await page.locator('.ep-list .ep .vn-button', { hasText: 'Play' }).click()
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

  // ---------- browser shelf (IndexedDB PoC): reload, play, remove, clear ----------
  await track('shelf: ready flow cached PDF + episode; reopen/play/remove/clear', async () => {
    const rec = (await waitForShelf(page)).find(r => r.documentId === DOC_ID)
    assert.ok(rec, 'shelf record exists after the ready flow')
    assert.ok((rec.pdfSize ?? 0) > 0, 'PDF bytes cached')
    assert.equal(rec.episodeId, EP_ID)
    assert.equal(rec.episodeTitle, EP_TITLE)
    assert.equal(rec.docName, 'fixture-chapter.pdf')

    // Reopen after reload: the record lists in the Learn dialog.
    await page.reload()
    await page.locator('.home').waitFor()
    await page.getByRole('button', { name: 'Learn', exact: true }).click()
    await page.locator('#learnDlg[open]').waitFor()
    const row = page.locator('.shelf .ep')
    await row.waitFor()
    const rowText = await row.innerText()
    assert.match(rowText, new RegExp(EP_TITLE), 'episode title in the row')
    assert.match(rowText, /fixture-chapter\.pdf/, 'filename in the row')
    assert.match(rowText, /saved/, 'saved timestamp in the row')

    // Cached Play goes through the same server session path.
    await row.locator('.vn-button').click()
    await page.locator('.vn-frame').waitFor({ timeout: 15000 })
    assert.equal(new URL(page.url()).searchParams.get('session'), SESSION_ID)
    await page.getByRole('button', { name: 'Menu', exact: true }).click()
    await page.getByRole('button', { name: 'Leave episode', exact: true }).click()
    await page.locator('.home').waitFor()

    // Remove: a named confirmation gates deletion; Keep and Escape keep it.
    await page.getByRole('button', { name: 'Learn', exact: true }).click()
    await page.locator('#learnDlg[open]').waitFor()
    await page.locator('.shelf .ep .shelf-remove').click()
    await page.locator('.bl-warn[open]').waitFor()
    assert.match(await page.locator('.bl-warn').innerText(), /fixture-chapter\.pdf/, 'confirmation names the document')
    assert.equal(await page.locator('.bl-warn .vn-quiet').evaluate(el => document.activeElement === el), true, 'safe action focused')
    await page.getByRole('button', { name: 'Keep it', exact: true }).click()
    await page.locator('.bl-warn[open]').waitFor({ state: 'hidden' })
    assert.equal(await page.locator('.shelf .ep').count(), 1, 'Keep leaves the record')
    await page.locator('.shelf .ep .shelf-remove').click()
    await page.locator('.bl-warn[open]').waitFor()
    await page.keyboard.press('Escape')
    await page.locator('.bl-warn[open]').waitFor({ state: 'hidden' })
    assert.equal(await page.locator('.shelf .ep').count(), 1, 'Escape leaves the record')
    await page.locator('.shelf .ep .shelf-remove').click()
    await page.locator('.bl-warn[open]').waitFor()
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await page.locator('.shelf-empty').waitFor()
    assert.equal((await shelfRows(page)).length, 0, 'record deleted from IndexedDB')

    // Confirmed deletion persists across reload.
    await page.reload()
    await page.locator('.home').waitFor()
    await page.getByRole('button', { name: 'Learn', exact: true }).click()
    await page.locator('#learnDlg[open]').waitFor()
    assert.equal(await page.locator('.shelf .ep').count(), 0, 'deletion persists across reload')

    // A cached entry whose episode vanished server-side still shows the
    // existing learn error and stays removable.
    await putRawShelf(page, { documentId: 'doc-ghost', docName: 'ghost.pdf', episodeId: 'ep-gone', episodeTitle: 'Ghost lesson', episode, pdf: null, savedAt: Date.now() })
    await page.reload()
    await page.locator('.home').waitFor()
    await page.getByRole('button', { name: 'Learn', exact: true }).click()
    await page.locator('#learnDlg[open]').waitFor()
    await page.locator('.shelf .ep').waitFor()
    await page.locator('.shelf .ep .vn-button').click()
    await page.locator('#learnDlg .form-error:not(.shelf-note)').waitFor()
    assert.equal(await page.locator('.shelf .ep').count(), 1, 'entry stays after a server 404')
    await page.locator('.shelf .ep .shelf-remove').click()
    await page.locator('.bl-warn[open]').waitFor()
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await page.locator('.shelf-empty').waitFor()

    // Clear-all empties the store without a confirmation prompt.
    await putRawShelf(page, { documentId: 'doc-seed', docName: 'seed.pdf', episodeId: EP_ID, episodeTitle: EP_TITLE, episode, pdf: null, savedAt: Date.now() })
    await page.reload()
    await page.locator('.home').waitFor()
    await page.getByRole('button', { name: 'Learn', exact: true }).click()
    await page.locator('#learnDlg[open]').waitFor()
    await page.locator('.shelf .ep').waitFor()
    await page.getByRole('button', { name: 'Clear browser copies', exact: true }).click()
    await page.locator('.shelf-empty').waitFor()
    assert.equal((await shelfRows(page)).length, 0, 'clear-all empties IndexedDB')
    await page.locator('#learnDlg .row-end .vn-quiet').click()
    await page.locator('#learnDlg[open]').waitFor({ state: 'hidden' })
  })

  await track('Menu: motion switch, reset, About', async () => {
    await page.getByRole('button', { name: 'Menu', exact: true }).click()
    await page.locator('#menuDlg[open]').waitFor()
    assert.ok(await page.locator('#menuDlg.vn-menu-dialog').count(), 'menu shares the vn-menu-dialog identity')
    const mh = await page.locator('#menuDlg .vn-menu-heading h2').evaluate(el => getComputedStyle(el).color)
    assert.equal(mh, 'rgb(48, 48, 76)', 'menu heading is ink, not white')
    assert.equal(await page.locator('#menuDlg .vn-motion').first().evaluate(el => getComputedStyle(el).fontWeight), '850', 'menu rows keep the player vn-motion weight')
    const row = page.locator('.vn-motion[role="switch"]')
    await row.click()
    assert.equal(await page.evaluate(() => document.documentElement.dataset.motion), 'reduce')
    await page.locator('.vn-motion-reset').waitFor()
    await page.locator('.vn-motion-reset').click()
    assert.notEqual(await page.evaluate(() => document.documentElement.dataset.motion), 'reduce')
    await page.locator('.vn-motion', { hasText: 'About' }).click()
    await page.locator('#aboutDlg[open]').waitFor()
    const ah = await page.locator('#aboutDlg h2').evaluate(el => getComputedStyle(el).color)
    assert.equal(ah, 'rgb(48, 48, 76)', 'about heading is ink, not white')
    assert.match(await page.locator('#aboutDlg').innerText(), /turns a document into a playable lesson/)
    await page.locator('#aboutDlg .vn-quiet').click()
    await page.locator('#aboutDlg[open]').waitFor({ state: 'detached' })
  })

  // ---------- job failure + retry ----------
  await ctx.close()
  const ctxFail = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const pageFail = await ctxFail.newPage()
  pageFail.on('pageerror', e => errors.push(`pageerror(fail): ${e.message}`))
  const callsFail = await stub(pageFail, { failAt: 'generate' })
  await pageFail.goto(`${base}/`)
  await pageFail.locator('.dlg').click()
  await track('job failure: fail line, error chip, Retry recovers', async () => {
    await pageFail.getByRole('button', { name: 'Upload', exact: true }).click()
    await pageFail.locator('#uploadDlg[open]').waitFor()
    await pageFail.getByRole('button', { name: /PDF.*One document/ }).click()
    await pageFail.setInputFiles('#filePick', { name: 'fixture-chapter.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 fixture') })
    await pageFail.getByRole('button', { name: 'Create lesson from PDF' }).click()
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
    // The retried completion lands on the persistent card; clicking it plays.
    await pageFail.locator('.upload-chip.ready').waitFor({ timeout: 10000 })
    await pageFail.locator('.upload-chip.ready').click()
    await pageFail.locator('.vn-frame').waitFor({ timeout: 15000 })
    assert.equal(new URL(pageFail.url()).searchParams.get('session'), SESSION_ID, 'card click starts a session')
  })

  // ---------- sample chapter: client-side mock pipeline ----------
  await ctxFail.close()
  const ctxMock = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const pageMock = await ctxMock.newPage()
  pageMock.on('pageerror', e => errors.push(`pageerror(mock): ${e.message}`))
  const callsMock = await stub(pageMock)
  await pageMock.goto(`${base}/`)
  await track('sample mock: narrated fake pipeline, offer Yes plays', async () => {
    await pageMock.getByRole('button', { name: 'Upload', exact: true }).click()
    await pageMock.locator('#uploadDlg[open]').waitFor()
    await pageMock.getByRole('button', { name: /PDF.*One document/ }).click()
    await pageMock.locator('#sampleBtn').click()
    await pageMock.locator('#uploadDlg[open]').waitFor({ state: 'detached' })
    await pageMock.locator('.upload-chip').waitFor()
    await pageMock.locator('.mascot[data-emotion="reading"]:visible').waitFor()
    await pageMock.waitForFunction(() => {
      const el = document.querySelector('.up-fill')
      return el && parseFloat(el.style.width) >= 100
    }, null, { timeout: 30000 })
    assert.ok(!callsMock.some(c => c.path === '/api/documents' && c.method === 'POST'), 'mock never uploads')
    assert.ok(!callsMock.some(c => c.path.startsWith('/api/jobs')), 'mock never touches jobs')
    await pageMock.locator('.upload-chip.ready').waitFor({ timeout: 10000 })
    await pageMock.locator('.ask-overlay').waitFor({ timeout: 15000 })
    await pageMock.getByRole('button', { name: /yes, play it/i }).click()
    await advanceTo(pageMock, async () => (await pageMock.locator('.dlg-name').innerText()) === 'You', { label: 'accept echo' })
    await pageMock.locator('.vn-frame').waitFor({ timeout: 15000 })
    assert.equal(new URL(pageMock.url()).searchParams.get('session'), SESSION_ID, 'Yes starts a session')
    // The sample caches a PDF-less shelf record — nothing was ever uploaded.
    const rec = (await waitForShelf(pageMock)).find(r => r.documentId === DOC_ID)
    assert.ok(rec, 'sample wrote a shelf record')
    assert.equal(rec.docName, 'sample-chapter.pdf')
    assert.equal(rec.pdfSize, null, 'sample caches no PDF bytes')
    assert.equal(rec.episodeId, EP_ID)
  })

  // ---------- ?job= resume ----------
  await ctxMock.close()
  const ctxResume = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const pageResume = await ctxResume.newPage()
  pageResume.on('pageerror', e => errors.push(`pageerror(resume): ${e.message}`))
  await stub(pageResume, { resumeJob: 'generate' })
  await pageResume.goto(`${base}/?job=job-2`)
  await track('reload with ?job= resumes the read narration', async () => {
    await pageResume.locator('.upload-chip').waitFor()
    // Resume can finish before GPU preparation reveals the avatar.
    await pageResume.locator('.mascot[data-emotion="reading"]').waitFor({ state: 'attached' })
    await pageResume.waitForFunction(() => {
      const el = document.querySelector('.up-fill')
      return el && parseFloat(el.style.width) >= 100
    }, null, { timeout: 60000 })
    // The resumed ready flow also writes a shelf record — PDF-less, since no
    // File object survives a reload.
    const rec = (await waitForShelf(pageResume)).find(r => r.documentId === DOC_ID)
    assert.ok(rec, 'resumed ready flow wrote a shelf record')
    assert.equal(rec.docName, 'your document')
    assert.equal(rec.pdfSize, null, 'resume caches no PDF bytes')
    assert.equal(rec.episodeId, EP_ID)
    await pageResume.locator('.mascot:visible').waitFor()
  })

  // ---------- degraded storage: IndexedDB deleted before the app boots ----------
  await ctxResume.close()
  const ctxDegraded = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await ctxDegraded.addInitScript(() => {
    try { Object.defineProperty(window, 'indexedDB', { configurable: true, get: () => undefined }) } catch { /* older engines keep the global */ }
  })
  const pageDegraded = await ctxDegraded.newPage()
  pageDegraded.on('pageerror', e => errors.push(`pageerror(degraded): ${e.message}`))
  await stub(pageDegraded)
  await pageDegraded.goto(`${base}/`)
  await track('shelf: IndexedDB unavailable degrades to a notice, ready flow intact', async () => {
    await pageDegraded.getByRole('button', { name: 'Upload', exact: true }).click()
    await pageDegraded.locator('#uploadDlg[open]').waitFor()
    await pageDegraded.getByRole('button', { name: /PDF.*One document/ }).click()
    await pageDegraded.setInputFiles('#filePick', { name: 'fixture-chapter.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 fixture') })
    await pageDegraded.getByRole('button', { name: 'Create lesson from PDF' }).click()
    await pageDegraded.locator('.upload-chip').waitFor()
    await pageDegraded.waitForFunction(() => {
      const el = document.querySelector('.up-fill')
      return el && parseFloat(el.style.width) >= 100
    }, null, { timeout: 60000 })
    // The ready card + play offer survive storage failure untouched.
    await pageDegraded.locator('.upload-chip.ready').waitFor({ timeout: 10000 })
    await pageDegraded.locator('.ask-overlay').waitFor({ timeout: 15000 })
    await pageDegraded.getByRole('button', { name: 'Not now', exact: true }).click()
    await pageDegraded.locator('.ask-overlay').waitFor({ state: 'detached' })
    await pageDegraded.getByRole('button', { name: 'Learn', exact: true }).click()
    await pageDegraded.locator('#learnDlg[open]').waitFor()
    const note = pageDegraded.locator('.shelf-note')
    await note.waitFor()
    assert.match(await note.innerText(), /couldn't keep|unavailable/i)
    await note.locator('.vn-quiet').click()
    assert.equal(await pageDegraded.locator('.shelf-note').count(), 0, 'note dismisses')
    assert.equal(await pageDegraded.evaluate(() => typeof indexedDB), 'undefined', 'IndexedDB really is gone')
  })

  // ---------- shelf independence: section renders when the document API is down ----------
  await ctxDegraded.close()
  const ctxNoApi = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const pageNoApi = await ctxNoApi.newPage()
  pageNoApi.on('pageerror', e => errors.push(`pageerror(noapi): ${e.message}`))
  await stub(pageNoApi)
  await pageNoApi.route('**/api/documents', route => {
    if (route.request().method() === 'GET') return route.fulfill({ status: 500, json: { error: { code: 'DOWN', message: 'documents down' } } })
    return route.continue()
  })
  await pageNoApi.goto(`${base}/`)
  await track('shelf: section still renders when the backend list fails', async () => {
    await putRawShelf(pageNoApi, { documentId: 'doc-local', docName: 'local.pdf', episodeId: EP_ID, episodeTitle: EP_TITLE, episode, pdf: null, savedAt: Date.now() })
    await pageNoApi.reload()
    await pageNoApi.locator('.home').waitFor()
    await pageNoApi.getByRole('button', { name: 'Learn', exact: true }).click()
    await pageNoApi.locator('#learnDlg[open]').waitFor()
    await pageNoApi.locator('.shelf .ep').waitFor()
    assert.match(await pageNoApi.locator('.shelf .ep').innerText(), /local\.pdf/, 'cached row renders without the backend')
    await pageNoApi.locator('#learnDlg .form-error:not(.shelf-note)').waitFor()
  })

  // ---------- shelf reflow: narrow + medium dialog widths ----------
  await ctxNoApi.close()
  for (const width of [390, 800]) {
    const ctxW = await browser.newContext({ viewport: { width, height: 800 } })
    const pageW = await ctxW.newPage()
    pageW.on('pageerror', e => errors.push(`pageerror(${width}): ${e.message}`))
    await stub(pageW)
    await pageW.goto(`${base}/`)
    await track(`shelf: rows reflow inside the dialog at ${width}px`, async () => {
      await putRawShelf(pageW, { documentId: 'doc-w', docName: 'a-very-long-document-name-for-reflow-testing.pdf', episodeId: EP_ID, episodeTitle: EP_TITLE, episode, pdf: null, savedAt: Date.now() })
      await pageW.reload()
      await pageW.locator('.home').waitFor()
      await pageW.getByRole('button', { name: 'Learn', exact: true }).click()
      await pageW.locator('#learnDlg[open]').waitFor()
      await pageW.locator('.shelf .ep').waitFor()
      // Measure .modal, not the dialog element: at 390px the dialog gains a
      // vertical scrollbar, which shows up as scrollWidth - clientWidth ≈ 14
      // without any horizontal overflow.
      const overflow = await pageW.locator('#learnDlg .modal').evaluate(el => el.scrollWidth - el.clientWidth)
      assert.ok(overflow <= 1, `dialog content overflows at ${width}px: ${overflow}`)
      const rowOverflow = await pageW.locator('.shelf .ep').evaluate(el => el.scrollWidth - el.clientWidth)
      assert.ok(rowOverflow <= 1, `shelf row overflows at ${width}px: ${rowOverflow}`)
    })
    await ctxW.close()
  }

  const photoContext = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const photoPage = await photoContext.newPage()
  photoPage.on('pageerror', e => errors.push(`pageerror(photos): ${e.message}`))
  const photoCalls = await stub(photoPage)
  await photoPage.goto(`${base}/`)
  await track('Photos: sequential pages, limits, removal, keyboard and mobile reflow', async () => {
    await photoPage.getByRole('button', { name: 'Upload', exact: true }).click()
    assert.equal(await photoPage.locator('#sampleBtn').count(), 0)
    await photoPage.getByRole('button', { name: /PDF.*One document/ }).click()
    await photoPage.setInputFiles('#filePick', { name: 'draft.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF fixture') })
    assert.equal(photoCalls.filter(call => call.path === '/api/documents' && call.method === 'POST').length, 0, 'PDF waits for confirmation')
    await photoPage.getByRole('button', { name: 'Back', exact: true }).click()
    await photoPage.getByRole('button', { name: /Photos.*Up to 5/ }).click()
    const file = name => ({ name, mimeType: 'image/png', buffer: Buffer.from('stub image') })
    await photoPage.setInputFiles('#photoPick', file('first.png'))
    await photoPage.setInputFiles('#photoPick', file('second.png'))
    await photoPage.getByRole('button', { name: 'Back', exact: true }).click()
    await photoPage.getByRole('button', { name: /PDF.*One document/ }).click()
    assert.match(await photoPage.locator('.selected-pdf').innerText(), /draft\.pdf/)
    await photoPage.getByRole('button', { name: 'Back', exact: true }).click()
    await photoPage.getByRole('button', { name: /Photos.*Up to 5/ }).click()
    assert.deepEqual(await photoPage.locator('.photo-list li span').allTextContents(), ['first.png', 'second.png'])
    await photoPage.keyboard.press('Escape')
    await photoPage.getByRole('button', { name: 'Upload', exact: true }).click()
    await photoPage.getByRole('button', { name: /PDF.*One document/ }).click()
    assert.equal(await photoPage.locator('.selected-pdf').count(), 0, 'closing clears the PDF draft')
    await photoPage.getByRole('button', { name: 'Back', exact: true }).click()
    await photoPage.getByRole('button', { name: /Photos.*Up to 5/ }).click()
    assert.equal(await photoPage.locator('.photo-list li').count(), 0, 'closing clears photo drafts')
    await photoPage.setInputFiles('#photoPick', file('first.png'))
    await photoPage.locator('.photo-upload .dropzone').evaluate(el => {
      const data = new DataTransfer()
      data.items.add(new File(['stub image'], 'second.png', { type: 'image/png' }))
      el.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: data }))
    })
    await photoPage.setInputFiles('#photoPick', file('remove.png'))
    await photoPage.getByRole('button', { name: 'Remove photo 3', exact: true }).click()
    assert.deepEqual(await photoPage.locator('.photo-list li span').allTextContents(), ['first.png', 'second.png'])
    await photoPage.setInputFiles('#photoPick', ['3.png', '4.png', '5.png', '6.png'].map(file))
    assert.match(await photoPage.locator('#uploadDlg .form-error').innerText(), /up to 5/)
    await photoPage.setInputFiles('#photoPick', { name: 'large.png', mimeType: 'image/png', buffer: Buffer.alloc(10 * 1024 * 1024 + 1) })
    assert.match(await photoPage.locator('#uploadDlg .form-error').innerText(), /10 MiB/)
    await photoPage.setInputFiles('#photoPick', file('unsupported.heic'))
    assert.match(await photoPage.locator('#uploadDlg .form-error').innerText(), /JPEG/)
    assert.equal(photoCalls.filter(call => call.path === '/api/documents/photos').length, 0, 'no automatic photo submission')
    await photoPage.getByRole('button', { name: 'Drop photos here, or choose photos', exact: true }).focus()
    assert.equal(await photoPage.locator(':focus').innerText(), 'Drop photos here, or choose photos')
    const overflow = await photoPage.locator('#uploadDlg .modal').evaluate(el => el.scrollWidth - el.clientWidth)
    assert.ok(overflow <= 1, `photo modal overflow: ${overflow}`)
    for (const width of [390, 800, 1280]) {
      await photoPage.setViewportSize({ width, height: 844 })
      assert.ok(await photoPage.locator('#uploadDlg .modal').evaluate(el => el.scrollWidth - el.clientWidth) <= 1)
      await photoPage.screenshot({ path: `${process.env.TEMP || '/tmp'}/mita-photo-upload-${width}.png` })
    }
  })
  await track('Photos: submit ordered pages, retain warnings and cache episode without PDF', async () => {
    await photoPage.getByRole('button', { name: 'Create lesson from photos', exact: true }).click()
    await photoPage.locator('.upload-chip.ready').waitFor({ timeout: 60000 })
    assert.deepEqual(photoCalls.find(call => call.photos)?.photos, ['first.png', 'second.png'])
    assert.match(await photoPage.locator('.upload-chip.ready .photo-warning').innerText(), /Photo 2/)
    const rows = await waitForShelf(photoPage)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].pdfSize, null)
    assert.equal(rows[0].episodeId, EP_ID)
    await photoPage.reload()
    await photoPage.getByRole('button', { name: 'Learn', exact: true }).click()
    await photoPage.locator('.shelf .ep-title', { hasText: EP_TITLE }).waitFor()
  })

  // ---------- mobile layout ----------
  await photoContext.close()
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
    assert.equal(widths.length, 3)
    assert.ok(Math.max(...widths) - Math.min(...widths) < 8, `rail buttons share the row: ${widths}`)
    const overflow = await pageMobile.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    assert.ok(overflow <= 1, `horizontal overflow: ${overflow}px`)
  })

  // ---------- reduced motion ----------
  await ctxMobile.close()
  const ctxReduce = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' })
  await ctxReduce.addInitScript(() => localStorage.setItem('meet-mita:motion', 'reduce'))
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

  // ---------- dark color-scheme: the index.css global h1/h2 goes near-white;
  // shared chrome pins every modal heading to ink ----------
  await ctxReduce.close()
  const ctxDark = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' })
  const pageDark = await ctxDark.newPage()
  pageDark.on('pageerror', e => errors.push(`pageerror(dark): ${e.message}`))
  await stub(pageDark)
  await pageDark.goto(`${base}/`)
  await track('dark scheme: modal headings stay ink', async () => {
    await pageDark.locator('.home').waitFor()
    const ink = 'rgb(48, 48, 76)'
    const h2color = sel => pageDark.locator(sel).evaluate(el => getComputedStyle(el).color)
    await pageDark.getByRole('button', { name: 'Upload', exact: true }).click()
    await pageDark.locator('#uploadDlg[open]').waitFor()
    assert.equal(await h2color('#uploadDlg h2'), ink, 'upload heading')
    await pageDark.locator('#uploadDlg .row-end .vn-quiet').click()
    await pageDark.getByRole('button', { name: 'Learn', exact: true }).click()
    await pageDark.locator('#learnDlg[open]').waitFor()
    assert.equal(await h2color('#learnDlg h2'), ink, 'learn heading')
    await pageDark.locator('#learnDlg .row-end .vn-quiet').click()
    await pageDark.getByRole('button', { name: 'Menu', exact: true }).click()
    await pageDark.locator('#menuDlg[open]').waitFor()
    assert.equal(await h2color('#menuDlg .vn-menu-heading h2'), ink, 'menu heading')
    const openDialogs = await pageDark.locator('dialog[open]').evaluateAll(els => els.map(e => e.id || e.className))
    assert.deepEqual(openDialogs, ['menuDlg'], `dialogs open before About: ${JSON.stringify(openDialogs)}`)
    await pageDark.locator('.vn-motion', { hasText: 'About' }).click()
    await pageDark.locator('#aboutDlg[open]').waitFor()
    assert.equal(await h2color('#aboutDlg h2'), ink, 'about heading')
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

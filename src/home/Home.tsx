import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import { api, ApiError, type Job } from '../learnerApi'
import { setMotionOverride, useMotionOverride, useReducedMotion } from '../motionPreference'
import MascotStage from '../player/MascotStage'
import HomeDialogue from './dialogueEngine'
import { readDoneTurns, readFailTurn } from './script'
import './home.css'

/* Upload narration follows the real job: each backend stage maps to a
   dialogue rotator pool, a chip label, and a progress landmark. The bar only
   moves when the job reports a stage, so progress is honest. */
const STAGE_LABEL: Record<string, string> = {
  extract: 'Reading your pages', index: 'Indexing your document', analyze: 'Mapping the ideas',
  plan: 'Planning your episodes', detail: 'Studying Episode 1', generate: 'Writing Episode 1', validate: 'Checking the lesson',
}
const STAGE_STEP: Record<string, number> = { extract: 0, index: 1, analyze: 2, plan: 3, detail: 3, generate: 4, validate: 4 }
const STAGE_PCT: Record<string, number> = { extract: 8, index: 20, analyze: 35, plan: 50, detail: 62, generate: 82, validate: 95 }

type Chip = { visible: boolean; name: string; stage: string; pct: number; error: string; jobId: string }
type LearnRow = { n: number; title: string; status: string; ready: boolean; episodeId: string | null; isNew: boolean }
type LearnDoc = { name: string; rows: LearnRow[] }
type Icons = 'on' | 'off' | 'icon'
const ICON_LABEL: Record<Icons, string> = { on: 'Rail display: icons and text', off: 'Rail display: text only', icon: 'Rail display: icons only' }

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const jobParam = () => new URLSearchParams(window.location.search).get('job')
function setJobParam(id: string) {
  const url = new URL(window.location.href)
  url.searchParams.set('job', id)
  window.history.replaceState({}, '', url)
}
function clearJobParam() {
  const url = new URL(window.location.href)
  url.searchParams.delete('job')
  window.history.replaceState({}, '', url)
}

export default function Home({ onPlay }: { onPlay(sessionId: string): void }) {
  const engineRef = useRef<HomeDialogue | null>(null)
  if (!engineRef.current) engineRef.current = new HomeDialogue()
  const engine = engineRef.current
  const snap = useSyncExternalStore(engine.subscribe, engine.getSnap)
  const reduced = useReducedMotion()
  const override = useMotionOverride()
  const [icons, setIcons] = useState<Icons>('on')
  const [chip, setChip] = useState<Chip>({ visible: false, name: '', stage: '', pct: 0, error: '', jobId: '' })
  const [askText, setAskText] = useState('')
  const [uploadErr, setUploadErr] = useState('')
  const [uploadBusy, setUploadBusy] = useState(false)
  const [docs, setDocs] = useState<LearnDoc[] | null>(null)
  const [learnErr, setLearnErr] = useState('')
  const [playingId, setPlayingId] = useState<string | null>(null)
  const [readyEpisodeId, setReadyEpisodeId] = useState<string | null>(null)
  const jobGen = useRef(0)
  const runInFlight = useRef(false)
  const uploading = useRef(false)
  // Ambient-suspension tokens are tracked per dialog: a chained open (Menu ->
  // About) bumps the engine seq, so a stale token can never resume ambient
  // under a still-open dialog.
  const modalTokens = useRef(new Map<HTMLDialogElement, number>())
  const uploadDlg = useRef<HTMLDialogElement>(null)
  const learnDlg = useRef<HTMLDialogElement>(null)
  const menuDlg = useRef<HTMLDialogElement>(null)
  const aboutDlg = useRef<HTMLDialogElement>(null)
  const filePick = useRef<HTMLInputElement>(null)
  const askInput = useRef<HTMLInputElement>(null)
  const menuTrigger = useRef<HTMLButtonElement>(null)
  const [dragOver, setDragOver] = useState(false)

  const reading = snap.mode === 'read'

  useEffect(() => {
    const gen = jobGen
    const pendingJob = jobParam()
    if (pendingJob) void drive(pendingJob)
    else void engine.start()
    return () => { gen.current++; engine.dispose() }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- boot once per mount
  }, [])

  // Keep the question draft in sync with the overlay lifecycle.
  useEffect(() => { if (!snap.askOpen) setAskText('') }, [snap.askOpen])

  function openDialog(ref: RefObject<HTMLDialogElement | null>) {
    const dialog = ref.current
    if (!dialog) return
    modalTokens.current.set(dialog, engine.beginModal())
    dialog.showModal()
  }

  function onDialogClose(e: React.SyntheticEvent<HTMLDialogElement>) {
    const dialog = e.currentTarget
    engine.endModal(modalTokens.current.get(dialog) ?? 0)
    modalTokens.current.delete(dialog)
  }

  // ---- Upload pipeline: upload -> run/poll -> auto-confirm -> ready -------
  function kickRun(jobId: string, token: number) {
    if (runInFlight.current) return
    runInFlight.current = true
    api.run(jobId)
      .catch(err => {
        if (token !== jobGen.current) return
        // 409 means another run already owns the job (e.g. one started
        // before a reload); polling simply keeps watching it.
        if (!(err instanceof ApiError && err.status === 409)) failDrive(err instanceof Error ? err.message : 'the pipeline stopped', jobId)
      })
      .finally(() => { runInFlight.current = false })
  }

  async function confirmAndRun(jobId: string, documentId: string, token: number) {
    try {
      let roadmap = await api.roadmap(documentId)
      if (!roadmap.confirmed) await api.confirm(documentId, roadmap.revision)
      if (token !== jobGen.current) return
      kickRun(jobId, token)
    } catch (err) {
      // Stale revision: refetch once and retry, per the existing contract.
      if (err instanceof ApiError && err.status === 409) {
        try {
          const fresh = await api.roadmap(documentId)
          if (!fresh.confirmed) await api.confirm(documentId, fresh.revision)
          if (token !== jobGen.current) return
          kickRun(jobId, token)
          return
        } catch (retry) {
          if (token === jobGen.current) failDrive(retry instanceof Error ? retry.message : 'roadmap confirmation failed', jobId)
          return
        }
      }
      if (token === jobGen.current) failDrive(err instanceof Error ? err.message : 'roadmap confirmation failed', jobId)
    }
  }

  async function finishDrive(job: Job, docName: string, token: number) {
    setChip(c => ({ ...c, stage: 'episode ready', pct: 100 }))
    clearJobParam()
    let turns
    try {
      const roadmap = await api.roadmap(job.document_id)
      const outline = roadmap.episodes.find(o => o.status === 'selected') ?? roadmap.episodes[0]
      const episode = outline ? await api.episode(outline.episode_id) : null
      if (token !== jobGen.current) return
      setReadyEpisodeId(episode?.episodeId ?? null)
      turns = readDoneTurns(docName, episode?.title ?? '')
    } catch {
      turns = readDoneTurns(docName, '')
    }
    void engine.endRead(turns)
    setDocs(null)
    setTimeout(() => { if (token === jobGen.current) setChip(c => ({ ...c, visible: false })) }, 1800)
  }

  function failDrive(reason: string, jobId: string) {
    clearJobParam()
    const short = reason.trim().slice(0, 140) || 'the pipeline stopped'
    setChip(c => ({ ...c, error: short, jobId }))
    void engine.failRead(readFailTurn(short))
  }

  async function drive(jobId: string, docName = 'your document', retries = 0) {
    const token = ++jobGen.current
    engine.beginRead()
    setChip({ visible: true, name: docName, stage: 'preparing', pct: 0, error: '', jobId })
    let stepShown = -1
    let confirming = false
    let retriesLeft = retries
    while (token === jobGen.current) {
      let job: Job
      try { job = await api.job(jobId) }
      catch { await sleep(4000); continue }
      if (token !== jobGen.current) return
      const stage = job.stage ?? ''
      if (STAGE_STEP[stage] !== undefined && stepShown !== STAGE_STEP[stage]) {
        stepShown = STAGE_STEP[stage]
        engine.readStep(stepShown)
      }
      if (STAGE_LABEL[stage]) setChip(c => c.visible ? { ...c, stage: STAGE_LABEL[stage], pct: Math.max(c.pct, STAGE_PCT[stage] ?? 0) } : c)
      const exec = job.execution_state ?? ''
      if (job.status === 'failed' || exec === 'failed') {
        // A learner-initiated retry gets exactly one fresh run: fire it and
        // keep polling; rows that still say failed while the run is in flight
        // are just the pre-claim state.
        if (job.can_run && retriesLeft > 0 && !runInFlight.current) { retriesLeft--; kickRun(jobId, token) }
        else if (!runInFlight.current) { failDrive(job.error ?? 'the pipeline stopped', jobId); return }
      } else if (exec === 'complete' || job.status === 'ready') { await finishDrive(job, docName, token); return }
      else if (exec === 'awaiting_review') {
        if (!confirming) {
          confirming = true
          void confirmAndRun(jobId, job.document_id, token).finally(() => { confirming = false })
        }
      } else if (job.can_run) kickRun(jobId, token)
      await sleep(3000)
    }
  }

  async function uploadFile(file: File) {
    if (uploading.current) return
    uploading.current = true
    setUploadBusy(true)
    setUploadErr('')
    try {
      const { job_id } = await api.upload(file)
      uploadDlg.current?.close()
      setJobParam(job_id)
      void drive(job_id, file.name)
    } catch (err) {
      setUploadErr(err instanceof Error ? err.message : 'Upload failed. Try again.')
    } finally {
      uploading.current = false
      setUploadBusy(false)
      if (filePick.current) filePick.current.value = ''
    }
  }

  // ---- Learn: documents -> roadmaps -> rows; Play creates a real session --
  async function loadEpisodes() {
    setDocs(null)
    setLearnErr('')
    try {
      const { documents } = await api.documents()
      const loaded = await Promise.all(documents.slice(0, 8).map(async doc => {
        try {
          const roadmap = await api.roadmap(doc.document_id)
          const rows = await Promise.all(roadmap.episodes.map(async (outline, i): Promise<LearnRow> => {
            let ready = false
            if (outline.status === 'selected') {
              try { ready = (await api.episode(outline.episode_id)).status === 'ready' } catch { /* treat as not ready */ }
            }
            return { n: i + 1, title: outline.title, status: outline.status, ready, episodeId: outline.episode_id, isNew: outline.episode_id === readyEpisodeId }
          }))
          return { name: doc.filename, rows }
        } catch { return null }
      }))
      setDocs(loaded.filter((d): d is LearnDoc => !!d))
    } catch (err) {
      setLearnErr(err instanceof Error ? err.message : 'Could not load episodes.')
      setDocs([])
    }
  }

  async function play(episodeId: string) {
    if (playingId) return
    setPlayingId(episodeId)
    setLearnErr('')
    try {
      const session = await api.createSession(episodeId)
      onPlay(session.sessionId)
    } catch (err) {
      setLearnErr(err instanceof Error ? err.message : 'Could not start the episode.')
    } finally { setPlayingId(null) }
  }

  // ---- Talk / rail wiring --------------------------------------------------
  function activateAsk() {
    const outcome = engine.askActivate(askText)
    if (outcome === 'send') setAskText('')
    else if (outcome === 'focus') askInput.current?.focus()
  }

  function onMenuKeyDown(e: React.KeyboardEvent<HTMLDialogElement>) {
    if (e.key !== 'Tab') return
    const dlg = e.currentTarget
    const items = [...dlg.querySelectorAll<HTMLElement>('button, input, [tabindex]')].filter(el => !el.hidden && el.offsetParent !== null)
    if (!items.length) return
    const first = items[0]
    const last = items[items.length - 1]
    const active = document.activeElement
    if (e.shiftKey && (active === first || !dlg.contains(active))) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && (active === last || !dlg.contains(active))) { e.preventDefault(); first.focus() }
  }

  return <main className="home" data-icons={icons}>
    <h1 className="sr-only">Meet Mita</h1>
    <div className="room" aria-hidden="true"><div className="b-scene" /></div>

    <button type="button" id="iconToggle" aria-label={ICON_LABEL[icons]} title={ICON_LABEL[icons]}
      onClick={() => setIcons(i => i === 'on' ? 'off' : i === 'off' ? 'icon' : 'on')}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <g className="st st-on"><rect x="3" y="4" width="7" height="7" rx="1.5" /><path d="M14 6h7M14 10h7M3 15h18M3 19h18" /></g>
        <g className="st st-icon"><rect x="6" y="6" width="12" height="12" rx="2" /></g>
        <g className="st st-off"><path d="M4 7h16M4 12h16M4 17h16" /></g>
      </svg>
    </button>

    <div className={`stage${snap.dimmed ? ' ask-dim' : ''}`}>
      {snap.askOpen && <div className="ask-overlay">
        <div className="ask-choices">
          <div className="ask-strip" role="button" tabIndex={0}
            aria-label="Type a message, then select this strip to send it"
            onClick={e => { if (e.target === askInput.current) return; activateAsk() }}
            onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); activateAsk() } }}>
            <input ref={askInput} type="text" autoComplete="off" maxLength={240} placeholder="Type your question"
              aria-label="Your message" enterKeyHint="done" value={askText} onChange={e => setAskText(e.target.value)} />
            {askText.trim() !== '' && <button type="button" onClick={e => { e.stopPropagation(); activateAsk() }}>Send</button>}
          </div>
          <button type="button" className="ask-choice" onClick={() => void engine.askNothing()}>Nothing</button>
        </div>
      </div>}
      <div className="maya-wrap">
        <MascotStage
          emotion={snap.emotion}
          isSpeaking={snap.speaking}
          nodTrigger={0}
          customAnimationTrigger={null}
          lookTargetOffset={null}
          enablePointerTracking={!reading}
        />
      </div>
    </div>

    <div className="dock">
      <div className="dlg" role="button" tabIndex={0} aria-label="Dialogue, click to advance"
        onClick={() => engine.activate()}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); engine.activate() } }}>
        <span className="dlg-name">{snap.speaker}</span>
        <div className="dlg-body">
          <p className="dlg-text"><span aria-hidden="true">{snap.text}</span><span className="sr-only" aria-live="polite">{snap.line}</span></p>
        </div>
        <span className="dlg-cue" aria-hidden="true" hidden={!snap.cue}>▾</span>
      </div>
      <div className="foot">
        <nav className="rail" aria-label="Home actions">
          <button type="button" data-act="talk" aria-disabled={reading || undefined} onClick={() => void engine.startTalk()}>
            <svg className="bi" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg><span>Talk</span>
          </button>
          <button type="button" data-act="upload" aria-disabled={reading || uploadBusy || undefined} onClick={() => { if (reading || uploadBusy) return; setUploadErr(''); openDialog(uploadDlg) }}>
            <svg className="bi" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M17 8l-5-5-5 5" /><path d="M12 3v12" /></svg><span>Upload</span>
          </button>
          <button type="button" data-act="learn" onClick={() => { openDialog(learnDlg); void loadEpisodes() }}>
            <svg className="bi" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" /></svg><span>Learn</span>
          </button>
          <button type="button" data-act="menu" ref={menuTrigger} aria-haspopup="dialog" onClick={() => openDialog(menuDlg)}>
            <svg className="bi" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg><span>Menu</span>
          </button>
        </nav>
      </div>
    </div>

    {chip.visible && <div className="upload-chip" role="status" data-error={chip.error ? '' : undefined}>
      <span className="up-name">{chip.error ? 'Read stalled' : `Reading ${chip.name}`}</span>
      <div className="up-track"><i className="up-fill" style={{ width: `${chip.pct}%` }} /></div>
      <div className="up-foot"><span>{chip.stage}</span><span>{Math.round(chip.pct)}%</span></div>
      {chip.error !== '' && <>
        <p className="up-err">{chip.error}</p>
        <div className="up-actions">
          <button type="button" onClick={() => { setChip(c => ({ ...c, error: '' })); setJobParam(chip.jobId); void drive(chip.jobId, chip.name, 1) }}>Retry</button>
          <button type="button" className="ghost" onClick={() => setChip(c => ({ ...c, visible: false }))}>Dismiss</button>
        </div>
      </>}
    </div>}

    <dialog ref={uploadDlg} id="uploadDlg" aria-labelledby="upTitle" onClose={onDialogClose}
      onClick={e => { if (e.target === e.currentTarget) e.currentTarget.close() }}>
      <div className="modal">
        <h2 id="upTitle">Upload a document</h2>
        <p className="sub">PDF works best: a chapter, a paper, lecture notes. I'll plan a lesson from it.</p>
        <label className={`dropzone${dragOver ? ' drag-over' : ''}`} htmlFor="filePick" tabIndex={0} role="button"
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); filePick.current?.click() } }}
          onDragOver={e => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) void uploadFile(f) }}>
          <span>{uploadBusy ? 'Uploading…' : 'Drop a PDF here, or click to browse'}</span>
          <small>PDF only</small>
        </label>
        <input ref={filePick} id="filePick" type="file" accept="application/pdf,.pdf" hidden
          onChange={e => { const f = e.target.files?.[0]; if (f) void uploadFile(f) }} />
        {uploadErr !== '' && <p className="form-error" role="alert">{uploadErr}</p>}
        <div className="row-end"><button type="button" className="ghost" onClick={e => e.currentTarget.closest('dialog')?.close()}>Cancel</button></div>
      </div>
    </dialog>

    <dialog ref={learnDlg} id="learnDlg" aria-labelledby="learnTitle" onClose={onDialogClose}
      onClick={e => { if (e.target === e.currentTarget) e.currentTarget.close() }}>
      <div className="modal">
        <h2 id="learnTitle">Episodes</h2>
        <p className="sub">Generated lessons from your documents. Episode 1 plays; the rest stay as outlines until it proves itself.</p>
        {docs === null && !learnErr && <p className="ep-empty">Loading your episodes…</p>}
        {learnErr !== '' && <p className="form-error" role="alert">{learnErr}</p>}
        {docs !== null && docs.length === 0 && !learnErr && <p className="ep-empty">No episodes yet — upload a document and I'll plan your first one.</p>}
        {docs !== null && docs.length > 0 && <ol className="ep-list">
          {docs.flatMap(doc => [
            <li className="ep-doc" key={`doc-${doc.name}`}>{doc.name}</li>,
            ...doc.rows.map(row => <li className={`ep${row.ready ? ' ready' : ''}`} key={`${doc.name}-${row.n}`}>
              <span className="ep-num">{String(row.n).padStart(2, '0')}</span>
              <span className="ep-meta">
                <span className="ep-title">{row.title}</span>
                <span className="ep-status">{row.ready ? `Ready${row.isNew ? ' · new' : ''}` : 'Planned outline'}</span>
              </span>
              {row.ready && row.episodeId && <button type="button" disabled={playingId !== null}
                onClick={() => void play(row.episodeId!)}>{playingId === row.episodeId ? 'Starting…' : 'Play'}</button>}
            </li>),
          ])}
        </ol>}
        <div className="row-end"><button type="button" className="ghost" onClick={e => e.currentTarget.closest('dialog')?.close()}>Close</button></div>
      </div>
    </dialog>

    <dialog ref={menuDlg} id="menuDlg" aria-labelledby="menuTitle" onKeyDown={onMenuKeyDown}
      onClose={e => { onDialogClose(e); if (!aboutDlg.current?.open && !learnDlg.current?.open && !uploadDlg.current?.open) menuTrigger.current?.focus({ preventScroll: true }) }}
      onClick={e => { if (e.target === e.currentTarget) e.currentTarget.close() }}>
      <div className="modal">
        <div className="menu-heading"><h2 id="menuTitle">Menu</h2><button type="button" className="ghost" onClick={e => e.currentTarget.closest('dialog')?.close()}>Close</button></div>
        <button type="button" className="menu-row" role="switch" aria-checked={reduced}
          onClick={() => setMotionOverride(reduced ? 'full' : 'reduce')}>
          <span>Reduce motion</span>
          <span className="switch" aria-hidden="true"><span className="switch-thumb" /></span>
        </button>
        {override !== null && <button type="button" className="motion-reset" onClick={() => setMotionOverride(null)}>Use device setting</button>}
        <button type="button" className="menu-row" onClick={() => { openDialog(aboutDlg); menuDlg.current?.close() }}>
          <span>About</span><span className="menu-row-glyph" aria-hidden="true">i</span>
        </button>
      </div>
    </dialog>

    <dialog ref={aboutDlg} id="aboutDlg" aria-labelledby="aboutTitle" onClose={onDialogClose}
      onClick={e => { if (e.target === e.currentTarget) e.currentTarget.close() }}>
      <div className="modal">
        <h2 id="aboutTitle">About Meet Mita</h2>
        <p className="about-p"><b>Meet Mita turns a document into a playable lesson.</b> Upload a PDF and it plans a learning roadmap, generates a visual-novel episode, and checks your understanding inside the story, with a tutor you can raise your hand for at any point.</p>
        <p className="about-p">Mita is the in-app guide: she narrates, teaches, and keeps you company between sessions.</p>
        <p className="about-p">React and Vite in front of a FastAPI pipeline. Episodes are generated once from your document, then played back without per-line model calls.</p>
        <div className="row-end"><button type="button" className="ghost" onClick={e => e.currentTarget.closest('dialog')?.close()}>Close</button></div>
      </div>
    </dialog>
  </main>
}

import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import { api, ApiError, type Job } from '../learnerApi'
import { putShelf, listShelf, removeShelf, clearShelf, type ShelfRecord } from './browserShelf'
import MascotStage from '../player/MascotStage'
import MotionToggle from '../player/MotionToggle'
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
type ReadyCard = { episodeId: string | null; title: string; docName: string }

/* The sample button's mock pipeline: the same stage labels/pcts a real job
   reports, on a fixed timer, so the whole generate->ready->offer flow is
   demonstrable without backend work. Only session creation touches the API. */
const MOCK_DOC = 'sample-chapter.pdf'
const MOCK_STAGES = ['extract', 'index', 'analyze', 'plan', 'detail', 'generate', 'validate']
  .map(stage => ({ step: STAGE_STEP[stage], label: STAGE_LABEL[stage], pct: STAGE_PCT[stage] }))

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
  const [chip, setChip] = useState<Chip>({ visible: false, name: '', stage: '', pct: 0, error: '', jobId: '' })
  const [askText, setAskText] = useState('')
  const [uploadErr, setUploadErr] = useState('')
  const [uploadBusy, setUploadBusy] = useState(false)
  const [uploadView, setUploadView] = useState<'choose' | 'pdf' | 'photos'>('choose')
  const [selectedPdf, setSelectedPdf] = useState<File | null>(null)
  const [photos, setPhotos] = useState<File[]>([])
  const [photoWarnings, setPhotoWarnings] = useState<string[]>([])
  const [docs, setDocs] = useState<LearnDoc[] | null>(null)
  const [learnErr, setLearnErr] = useState('')
  const [shelf, setShelf] = useState<ShelfRecord[] | null>(null)
  const [shelfNote, setShelfNote] = useState('')
  const [confirming, setConfirming] = useState<ShelfRecord | null>(null)
  const [playingId, setPlayingId] = useState<string | null>(null)
  const [readyCard, setReadyCard] = useState<ReadyCard | null>(null)
  const [readyErr, setReadyErr] = useState('')
  const jobGen = useRef(0)
  const runInFlight = useRef(false)
  const uploading = useRef(false)
  // Ambient-suspension tokens are tracked per dialog: a chained open (Menu ->
  // About) bumps the engine seq, so a stale token can never resume ambient
  // under a still-open dialog.
  const modalTokens = useRef(new Map<HTMLDialogElement, number>())
  const uploadDlg = useRef<HTMLDialogElement>(null)
  const uploadHeading = useRef<HTMLHeadingElement>(null)
  const learnDlg = useRef<HTMLDialogElement>(null)
  const removeDlg = useRef<HTMLDialogElement>(null)
  const keepBtn = useRef<HTMLButtonElement>(null)
  const pendingPdf = useRef<File | null>(null)
  const menuDlg = useRef<HTMLDialogElement>(null)
  const aboutDlg = useRef<HTMLDialogElement>(null)
  const filePick = useRef<HTMLInputElement>(null)
  const photoPick = useRef<HTMLInputElement>(null)
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
  useEffect(() => { if (uploadDlg.current?.open) uploadHeading.current?.focus() }, [uploadView])

  function openDialog(ref: RefObject<HTMLDialogElement | null>) {
    const dialog = ref.current
    if (!dialog) return
    modalTokens.current.set(dialog, engine.beginModal())
    dialog.showModal()
  }

  function onDialogClose(e: React.SyntheticEvent<HTMLDialogElement>) {
    const dialog = e.currentTarget
    // Nested dialogs (the shelf warn) propagate their close up here too —
    // only the dialog's own close counts as its dismissal.
    if (e.target !== dialog) return
    if (dialog === uploadDlg.current) {
      setUploadView('choose')
      setSelectedPdf(null)
      setPhotos([])
      setUploadErr('')
      setDragOver(false)
    }
    engine.endModal(modalTokens.current.get(dialog) ?? 0)
    modalTokens.current.delete(dialog)
  }

  // ---- Browser shelf (PoC): cache the ready episode + PDF in IndexedDB ----
  // Detached from the ready flow: a write failure only raises the section
  // note, never the card or offer. Storage stays invisible until it matters.
  function cacheReady(record: ShelfRecord) {
    void putShelf(record)
      .then(() => { setShelfNote(''); void loadShelf() })
      .catch(() => setShelfNote("Couldn't keep a copy in this browser. The episode still lives on the server."))
  }

  async function loadShelf() {
    try { setShelf(await listShelf()) }
    catch { setShelfNote("This browser's saved copies are unavailable right now.") }
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
    let episodeId: string | null = null
    let title = ''
    let turns
    try {
      const roadmap = await api.roadmap(job.document_id)
      const outline = roadmap.episodes.find(o => o.status === 'selected') ?? roadmap.episodes[0]
      const episode = outline ? await api.episode(outline.episode_id) : null
      if (token !== jobGen.current) return
      episodeId = episode?.episodeId ?? null
      title = episode?.title ?? ''
      turns = readDoneTurns(docName, title)
      // The uploaded File only rides along when its name still matches the
      // document being finished — a ?job= resume or a stale upload from a
      // different document caches without PDF bytes.
      if (episode) cacheReady({
        documentId: job.document_id, docName,
        episodeId: episode.episodeId, episodeTitle: episode.title, episode,
        pdf: pendingPdf.current?.name === docName ? pendingPdf.current : null,
        savedAt: Date.now(),
      })
    } catch {
      turns = readDoneTurns(docName, '')
    }
    if (token !== jobGen.current) return
    setReadyCard({ episodeId, title, docName })
    setReadyErr('')
    void engine.endRead(turns, true)
    setDocs(null)
  }

  function failDrive(reason: string, jobId: string) {
    clearJobParam()
    const short = reason.trim().slice(0, 140) || 'the pipeline stopped'
    setChip(c => ({ ...c, error: short, jobId }))
    void engine.failRead(readFailTurn(short))
  }

  async function drive(jobId: string, docName = 'your document', retries = 0) {
    const token = ++jobGen.current
    setReadyCard(null)
    setReadyErr('')
    setPhotoWarnings([])
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
      setPhotoWarnings(job.warnings ?? [])
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

  // The sample chapter runs a client-side mock of the whole pipeline. The
  // narrated stages and the ready card + play offer are identical to a real
  // run, but no upload or job ever leaves the browser.
  function useSample() {
    uploadDlg.current?.close()
    setUploadErr('')
    void mockDrive()
  }

  async function mockDrive() {
    const token = ++jobGen.current
    setReadyCard(null)
    setReadyErr('')
    setPhotoWarnings([])
    engine.beginRead()
    setChip({ visible: true, name: MOCK_DOC, stage: 'preparing', pct: 0, error: '', jobId: '' })
    for (const s of MOCK_STAGES) {
      engine.readStep(s.step)
      setChip(c => c.visible && !c.error ? { ...c, stage: s.label, pct: Math.max(c.pct, s.pct) } : c)
      await sleep(1100 + Math.random() * 500)
      if (token !== jobGen.current) return
    }
    let card: ReadyCard = { episodeId: null, title: '', docName: MOCK_DOC }
    try {
      const { documents } = await api.documents()
      const doc = documents.find(d => d.filename === MOCK_DOC) ?? documents[0]
      const roadmap = doc ? await api.roadmap(doc.document_id) : null
      const outline = roadmap?.episodes.find(o => o.status === 'selected') ?? roadmap?.episodes[0]
      const episode = outline ? await api.episode(outline.episode_id) : null
      if (token !== jobGen.current) return
      card = { episodeId: episode?.episodeId ?? outline?.episode_id ?? null, title: episode?.title ?? '', docName: MOCK_DOC }
      if (doc && episode) cacheReady({
        documentId: doc.document_id, docName: MOCK_DOC,
        episodeId: episode.episodeId, episodeTitle: episode.title, episode,
        pdf: null, savedAt: Date.now(),
      })
    } catch { /* backend offline; the card still persists, play retries the resolve */ }
    setChip(c => ({ ...c, stage: 'episode ready', pct: 100 }))
    setReadyCard(card)
    void engine.endRead(readDoneTurns(MOCK_DOC, card.title), true)
  }

  // Find the episode a card should play: the document that generated it if
  // its name is known, otherwise the first document with a selected outline.
  async function resolveEpisodeId(docName: string): Promise<string | null> {
    const { documents } = await api.documents()
    const doc = documents.find(d => d.filename === docName) ?? documents[0]
    if (!doc) return null
    const roadmap = await api.roadmap(doc.document_id)
    const outline = roadmap.episodes.find(o => o.status === 'selected') ?? roadmap.episodes[0]
    return outline?.episode_id ?? null
  }

  // The persistent ready card and the offer's Yes both land here: resolve a
  // missing episode id lazily, then start a real session like Learn's Play.
  async function playReady() {
    if (!readyCard || playingId) return
    setReadyErr('')
    setPlayingId('ready-card')
    try {
      const episodeId = readyCard.episodeId ?? await resolveEpisodeId(readyCard.docName)
      if (!episodeId) throw new Error('Could not find a playable episode yet.')
      if (!readyCard.episodeId) setReadyCard(r => r ? { ...r, episodeId } : r)
      const session = await api.createSession(episodeId)
      onPlay(session.sessionId)
    } catch (err) {
      setReadyErr(err instanceof Error ? err.message : 'Could not start the episode.')
    } finally { setPlayingId(null) }
  }

  async function acceptOffer() {
    const token = jobGen.current
    await engine.offerYes()
    if (token === jobGen.current) void playReady()
  }

  async function uploadFile(file: File) {
    if (uploading.current) return
    uploading.current = true
    setUploadBusy(true)
    setUploadErr('')
    try {
      const { job_id } = await api.upload(file)
      pendingPdf.current = file
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

  function selectPdf(file: File) {
    if (uploading.current) return
    setSelectedPdf(file)
    setUploadErr('')
  }

  function changeUploadView(view: 'choose' | 'pdf' | 'photos') {
    setUploadErr('')
    setDragOver(false)
    setUploadView(view)
  }

  function addPhotos(files: File[]) {
    if (uploading.current) return
    const next = [...photos, ...files]
    if (next.length > 5) { setUploadErr('Choose up to 5 photos for one lesson.'); return }
    if (next.some(file => file.size > 10 * 1024 * 1024) || next.reduce((size, file) => size + file.size, 0) > 20 * 1024 * 1024) {
      setUploadErr('Use photos up to 10 MiB each and 20 MiB combined.'); return
    }
    if (next.some(file => !/\.(jpe?g|png|webp)$/i.test(file.name))) {
      setUploadErr('Use JPEG, PNG, or static WebP photos.'); return
    }
    setUploadErr('')
    setPhotos(next)
  }

  async function uploadPhotos() {
    if (uploading.current || photos.length === 0) return
    uploading.current = true
    setUploadBusy(true)
    setUploadErr('')
    try {
      const { job_id } = await api.uploadPhotos(photos)
      pendingPdf.current = null
      uploadDlg.current?.close()
      setJobParam(job_id)
      const name = photos.length === 1 ? photos[0].name : `${photos[0].name} (+${photos.length - 1} photos)`
      setPhotos([])
      void drive(job_id, name)
    } catch (err) {
      setUploadErr(err instanceof Error ? err.message : 'Upload failed. Try again.')
    } finally { uploading.current = false; setUploadBusy(false) }
  }

  // ---- Learn: documents -> roadmaps -> rows; Play creates a real session --
  async function loadEpisodes() {
    setDocs(null)
    setLearnErr('')
    void loadShelf()
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
            return { n: i + 1, title: outline.title, status: outline.status, ready, episodeId: outline.episode_id, isNew: outline.episode_id === readyCard?.episodeId }
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

  // The warn dialog inherits the Learn dialog's ambient suspension — it never
  // registers a modal token, so closing it can't resume ambient under a still-
  // open Learn dialog. Focus lands on the safe action like the backlog warn.
  useEffect(() => {
    const dlg = removeDlg.current
    if (!dlg) return
    if (confirming && !dlg.open) { dlg.showModal(); keepBtn.current?.focus({ preventScroll: true }) }
    else if (!confirming && dlg.open) dlg.close()
  }, [confirming])

  async function confirmRemove() {
    const rec = confirming
    removeDlg.current?.close()
    if (!rec) return
    try { await removeShelf(rec.documentId); setShelf(s => s?.filter(r => r.documentId !== rec.documentId) ?? s) }
    catch { setShelfNote("Couldn't delete that copy. Try again.") }
  }

  async function clearAll() {
    try { await clearShelf(); setShelf(s => (s ? [] : s)) }
    catch { setShelfNote("Couldn't clear the saved copies. Try again.") }
  }

  // ---- Talk / rail wiring --------------------------------------------------
  function activateAsk() {
    const outcome = engine.askActivate(askText)
    if (outcome === 'send') setAskText('')
    else if (outcome === 'focus') askInput.current?.focus()
  }

  function renderRow(doc: LearnDoc, row: LearnRow) {
    return <li className={`ep${row.ready ? ' ready' : ''}`} key={`${doc.name}-${row.n}`}>
      <span className="ep-num">{String(row.n).padStart(2, '0')}</span>
      <span className="ep-meta">
        <span className="ep-title">{row.title}</span>
        <span className="ep-status">{row.ready ? `Ready${row.isNew ? ' · new' : ''}` : 'Planned outline'}</span>
      </span>
      {row.ready && row.episodeId && <button type="button" className="vn-button" disabled={playingId !== null}
        onClick={() => void play(row.episodeId!)}>{playingId === row.episodeId ? 'Starting…' : 'Play'}</button>}
    </li>
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

  return <main className="home">
    <h1 className="sr-only">Meet Mita</h1>
    <div className="room" aria-hidden="true"><div className="b-scene" /></div>

    <div className={`stage${snap.dimmed ? ' ask-dim' : ''}`}>
      {snap.askOpen && <div className="ask-overlay vn-ask-overlay">
        <div className="vn-choices">
          <div className="vn-choice vn-ask-strip" role="button" tabIndex={0}
            aria-label="Type a message, then select this strip to send it"
            onClick={e => { if (e.target === askInput.current) return; activateAsk() }}
            onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); activateAsk() } }}>
            <input ref={askInput} type="text" className="vn-ask-input" autoComplete="off" maxLength={240} placeholder="Type your question"
              aria-label="Your message" enterKeyHint="done" value={askText} onChange={e => setAskText(e.target.value)} />
            {askText.trim() !== '' && <button type="button" className="vn-ask-send" onClick={e => { e.stopPropagation(); activateAsk() }}>Send</button>}
          </div>
          <button type="button" className="vn-choice" onClick={() => void engine.askNothing()}>Nothing</button>
        </div>
      </div>}
      {snap.offerOpen && <div className="ask-overlay vn-ask-overlay" role="group" aria-label="Play your finished episode now?">
        <div className="vn-choices">
          <button type="button" className="vn-choice" onClick={() => void acceptOffer()}>Yes, play it</button>
          <button type="button" className="vn-choice" onClick={() => void engine.offerNo()}>Not now</button>
        </div>
      </div>}
      <div className="maya-wrap">
        <MascotStage
          emotion={snap.emotion}
          isSpeaking={snap.speaking}
          nodTrigger={0}
          customAnimationTrigger={null}
          lookTargetOffset={null}
          enablePointerTracking
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
          <button type="button" data-act="talk" aria-disabled={reading || snap.mode === 'offer' || undefined} onClick={() => void engine.startTalk()}>
            <svg className="bi" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg><span>Talk</span>
          </button>
          <button type="button" data-act="upload" aria-disabled={reading || uploadBusy || snap.mode === 'offer' || undefined} onClick={() => { if (reading || uploadBusy || snap.mode === 'offer') return; setUploadErr(''); openDialog(uploadDlg) }}>
            <svg className="bi" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M17 8l-5-5-5 5" /><path d="M12 3v12" /></svg><span>Upload</span>
          </button>
          <button type="button" data-act="learn" onClick={() => { openDialog(learnDlg); void loadEpisodes() }}>
            <svg className="bi" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" /></svg><span>Learn</span>
          </button>
          <button type="button" data-act="menu" ref={menuTrigger} className="vn-menu-trigger" aria-haspopup="dialog" aria-controls="menuDlg" onClick={() => openDialog(menuDlg)}>
            <span className="vn-menu-icon" aria-hidden="true"><span /><span /><span /></span>
            Menu
          </button>
        </nav>
      </div>
    </div>

    {chip.visible && (readyCard
      // The finished episode persists as the same chip, now a playable card.
      // This is the "access it later" surface Mita's No answer points at.
      ? <div className="upload-chip ready" role="button" tabIndex={0}
          aria-label={`Episode ready: ${readyCard.title || readyCard.docName}. Activate to play it.`}
          onClick={() => void playReady()}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void playReady() } }}>
          <span className="up-name">{readyCard.title || readyCard.docName}</span>
          <div className="up-track" aria-hidden="true"><i className="up-fill" style={{ width: '100%' }} /></div>
          <div className="up-foot"><span>{playingId === 'ready-card' ? 'Starting…' : 'Episode ready. Tap to play'}</span><span aria-hidden="true">▸</span></div>
          {readyErr !== '' && <p className="up-err" role="alert">{readyErr}</p>}
          {photoWarnings.map(warning => <p className="photo-warning" key={warning}>{warning}</p>)}
        </div>
      : <div className="upload-chip" role="status" data-error={chip.error ? '' : undefined}>
        <span className="up-name">{chip.error ? 'Read stalled' : `Reading ${chip.name}`}</span>
        <div className="up-track"><i className="up-fill" style={{ width: `${chip.pct}%` }} /></div>
        <div className="up-foot"><span>{chip.stage}</span><span>{Math.round(chip.pct)}%</span></div>
        {photoWarnings.map(warning => <p className="photo-warning" key={warning}>{warning}</p>)}
        {chip.error !== '' && <>
          <p className="up-err">{chip.error}</p>
          <div className="up-actions">
            <button type="button" className="vn-button" onClick={() => { setChip(c => ({ ...c, error: '' })); setJobParam(chip.jobId); void drive(chip.jobId, chip.name, 1) }}>Retry</button>
            <button type="button" className="vn-quiet" onClick={() => setChip(c => ({ ...c, visible: false }))}>Dismiss</button>
          </div>
        </>}
      </div>)}

    <dialog ref={uploadDlg} id="uploadDlg" className="vn-menu-dialog" aria-labelledby="upTitle" onClose={onDialogClose}
      onCancel={e => { if (uploadBusy) e.preventDefault() }}
      onClick={e => { if (e.target === e.currentTarget && !uploadBusy) e.currentTarget.close() }}>
      <div className="modal">
        <h2 ref={uploadHeading} id="upTitle" tabIndex={-1}>{uploadView === 'choose' ? 'Choose a source' : uploadView === 'pdf' ? 'Upload a PDF' : 'Upload photos'}</h2>
        {uploadView === 'choose' && <>
          <p className="sub">Choose what you want to learn from.</p>
          <div className="source-choices">
            <button type="button" className="vn-motion" onClick={() => changeUploadView('pdf')}><strong>PDF</strong><span>One document or chapter</span></button>
            <button type="button" className="vn-motion" onClick={() => changeUploadView('photos')}><strong>Photos</strong><span>Up to 5 pages or notes</span></button>
          </div>
        </>}
        {uploadView === 'pdf' && <>
        <p className="sub">Choose one PDF to create a lesson.</p>
        <label className={`dropzone${dragOver ? ' drag-over' : ''}`} htmlFor="filePick" tabIndex={0} role="button"
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); filePick.current?.click() } }}
          onDragOver={e => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files.length !== 1) { setUploadErr('Choose one PDF at a time.'); return } selectPdf(e.dataTransfer.files[0]) }}>
          <span>{uploadBusy ? 'Uploading…' : 'Drop a PDF here, or click to browse'}</span>
          <small>PDF only</small>
        </label>
        <input ref={filePick} id="filePick" type="file" accept="application/pdf,.pdf" hidden
          onChange={e => { const f = e.target.files?.[0]; if (f) selectPdf(f); e.target.value = '' }} />
        {selectedPdf && <p className="selected-pdf">Selected: {selectedPdf.name}</p>}
        <button type="button" className="vn-button source-submit" disabled={uploadBusy || !selectedPdf} onClick={() => { if (selectedPdf) void uploadFile(selectedPdf) }}>{uploadBusy ? 'Uploading…' : 'Create lesson from PDF'}</button>
        <div className="or">or</div>
        <button type="button" id="sampleBtn" className="vn-button" style={{ width: '100%' }} disabled={uploadBusy} onClick={useSample}>Use the sample chapter</button>
        </>}
        {uploadView === 'photos' && <>
        <p className="sub">Choose up to 5 photos of readable pages or notes.</p>
        <div className="photo-upload">
          <button type="button" className={`dropzone${dragOver ? ' drag-over' : ''}`} disabled={uploadBusy || photos.length >= 5} onClick={() => photoPick.current?.click()}
            onDragOver={e => { e.preventDefault(); if (!uploadBusy && photos.length < 5) setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => { e.preventDefault(); setDragOver(false); addPhotos(Array.from(e.dataTransfer.files)) }}>Drop photos here, or choose photos</button>
          <input ref={photoPick} id="photoPick" type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" multiple hidden
            onChange={e => { addPhotos(Array.from(e.target.files ?? [])); e.target.value = '' }} />
          <p className="sub">JPEG, PNG, or static WebP. 10 MiB each, 20 MiB total. Selection order becomes page order.</p>
          {photos.length > 0 && <>
            <ol className="photo-list" aria-label="Selected photo pages">
              {photos.map((photo, index) => <li key={`${index}-${photo.name}`}><span>{photo.name}</span>
                <button type="button" className="vn-quiet" disabled={uploadBusy} aria-label={`Remove photo ${index + 1}`} onClick={() => setPhotos(items => items.filter((_, i) => i !== index))}>Remove</button>
              </li>)}
            </ol>
            <button type="button" className="vn-button" disabled={uploadBusy} onClick={() => void uploadPhotos()}>{uploadBusy ? 'Uploading…' : 'Create lesson from photos'}</button>
          </>}
        </div>
        </>}
        {uploadErr !== '' && <p className="form-error" role="alert">{uploadErr}</p>}
        <div className="row-end">{uploadView !== 'choose' && <button type="button" className="vn-quiet" disabled={uploadBusy} onClick={() => changeUploadView('choose')}>Back</button>}<button type="button" className="vn-quiet" disabled={uploadBusy} onClick={e => e.currentTarget.closest('dialog')?.close()}>Cancel</button></div>
      </div>
    </dialog>

    <dialog ref={learnDlg} id="learnDlg" className="vn-menu-dialog" aria-labelledby="learnTitle" onClose={onDialogClose}
      onClick={e => { if (e.target === e.currentTarget) e.currentTarget.close() }}>
      <div className="modal">
        <h2 id="learnTitle">Episodes</h2>
        <p className="sub">Generated lessons from your documents. Episode 1 plays; the rest stay as outlines until it proves itself.</p>
        {(shelf !== null || shelfNote !== '') && <section className="shelf" aria-label="Saved in this browser">
          <div className="shelf-head">
            <p className="shelf-title">On this browser</p>
            {shelf !== null && shelf.length > 0 && <button type="button" className="vn-quiet shelf-clear" onClick={() => void clearAll()}>Clear browser copies</button>}
          </div>
          {shelfNote !== '' && <p className="form-error shelf-note" role="alert"><span>{shelfNote}</span><button type="button" className="vn-quiet" onClick={() => setShelfNote('')}>Dismiss</button></p>}
          {shelf !== null && shelf.length === 0 && <p className="ep-empty shelf-empty">Nothing saved in this browser yet. Finish an episode and it waits here.</p>}
          {shelf !== null && shelf.length > 0 && <ol className="ep-rows">
            {shelf.map(rec => <li className="ep ready" key={rec.documentId}>
              <span className="ep-meta">
                <span className="ep-title">{rec.episodeTitle || rec.docName}</span>
                <span className="ep-status">{rec.docName} · saved {new Date(rec.savedAt).toLocaleDateString()}</span>
              </span>
              <button type="button" className="vn-button" disabled={playingId !== null} onClick={() => void play(rec.episodeId)}>{playingId === rec.episodeId ? 'Starting…' : 'Play'}</button>
              <button type="button" className="vn-quiet shelf-remove" onClick={() => setConfirming(rec)}>Remove</button>
            </li>)}
          </ol>}
        </section>}
        {docs === null && !learnErr && <p className="ep-empty">Loading your episodes…</p>}
        {learnErr !== '' && <p className="form-error" role="alert">{learnErr}</p>}
        {docs !== null && docs.length === 0 && !learnErr && <p className="ep-empty">No episodes yet — upload a document and I'll plan your first one.</p>}
        {docs !== null && docs.length > 0 && <ol className="ep-list">
          {docs.filter(doc => doc.rows.length > 0).map(doc => {
            const [first, ...rest] = doc.rows
            return <li className="ep-group" key={`doc-${doc.name}`}>
              <p className="ep-doc">{doc.name}</p>
              <ol className="ep-rows">{renderRow(doc, first)}</ol>
              {rest.length > 0 && <details className="ep-more">
                <summary>{rest.length} more planned {rest.length === 1 ? 'outline' : 'outlines'}</summary>
                <ol className="ep-rows">{rest.map(row => renderRow(doc, row))}</ol>
              </details>}
            </li>
          })}
        </ol>}
        <div className="row-end"><button type="button" className="vn-quiet" onClick={e => e.currentTarget.closest('dialog')?.close()}>Close</button></div>
        <dialog ref={removeDlg} className="bl-warn" aria-labelledby="shelfWarnTitle" onKeyDown={onMenuKeyDown} onClose={() => setConfirming(null)}>
          <h3 id="shelfWarnTitle">Delete this saved copy?</h3>
          <p className="bl-warn-copy">Removes the PDF and episode saved for {confirming?.docName ?? 'this document'} from this browser. The server keeps its own copies.</p>
          <div className="bl-warn-actions">
            <button ref={keepBtn} type="button" className="vn-quiet" onClick={() => removeDlg.current?.close()}>Keep it</button>
            <button type="button" className="vn-button" onClick={() => void confirmRemove()}>Delete</button>
          </div>
        </dialog>
      </div>
    </dialog>

    <dialog ref={menuDlg} id="menuDlg" className="vn-menu-dialog" aria-labelledby="menuTitle" onKeyDown={onMenuKeyDown}
      onClose={e => { onDialogClose(e); if (!aboutDlg.current?.open && !learnDlg.current?.open && !uploadDlg.current?.open) menuTrigger.current?.focus({ preventScroll: true }) }}
      onClick={e => { if (e.target === e.currentTarget) e.currentTarget.close() }}>
      <div className="vn-menu-heading"><h2 id="menuTitle">Menu</h2><button type="button" className="vn-quiet" onClick={e => e.currentTarget.closest('dialog')?.close()}>Close</button></div>
      <MotionToggle />
      <button type="button" className="vn-motion vn-menu-about" onClick={() => { openDialog(aboutDlg); menuDlg.current?.close() }}>
        <span>About</span><span aria-hidden="true">i</span>
      </button>
    </dialog>

    <dialog ref={aboutDlg} id="aboutDlg" className="vn-menu-dialog" aria-labelledby="aboutTitle" onClose={onDialogClose}
      onClick={e => { if (e.target === e.currentTarget) e.currentTarget.close() }}>
      <div className="modal">
        <h2 id="aboutTitle">About Meet Mita</h2>
        <p className="about-p"><b>Meet Mita turns a document into a playable lesson.</b> Upload a PDF and it plans a learning roadmap, generates a visual-novel episode, and checks your understanding inside the story, with a tutor you can raise your hand for at any point.</p>
        <p className="about-p">Mita is the in-app guide: she narrates, teaches, and keeps you company between sessions.</p>
        <p className="about-p">React and Vite in front of a FastAPI pipeline. Episodes are generated once from your document, then played back without per-line model calls.</p>
        <div className="row-end"><button type="button" className="vn-quiet" onClick={e => e.currentTarget.closest('dialog')?.close()}>Close</button></div>
      </div>
    </dialog>
  </main>
}

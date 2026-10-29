import { useEffect, useRef, useState, type FormEvent } from 'react'
import '@fontsource-variable/nunito'
import { api, ApiError, type Job, type Roadmap } from './learnerApi'
import VisualNovelPlayer from './player/VisualNovelPlayer'
import './App.css'

const sessionParam = () => new URLSearchParams(location.search).get('session') || ''
function setSessionParam(id: string, push: boolean) {
  const url = new URL(location.href)
  if (id) url.searchParams.set('session', id); else url.searchParams.delete('session')
  history[push ? 'pushState' : 'replaceState'](null, '', url)
}

const ACTIVE = new Set(['queued', 'running'])
// Stages at which a roadmap can already exist; a failed job that reached
// one of these may have a confirmed roadmap the learner can resume.
const PLANNED_STAGES = new Set(['plan', 'generate', 'validate'])

const STAGE_LABEL: Record<string, string> = {
  extract: 'Reading your pages',
  index: 'Indexing your document',
  analyze: 'Mapping the ideas',
  plan: 'Planning your episodes',
  generate: 'Writing Episode 1',
  validate: 'Checking the lesson',
}

export default function App() {
  const [file, setFile] = useState<File | null>(null)
  const [jobId, setJobId] = useState(() => new URLSearchParams(location.search).get('job') || '')
  const [documentId, setDocumentId] = useState('')
  const [job, setJob] = useState<Job | null>(null)
  const [roadmap, setRoadmap] = useState<Roadmap | null>(null)
  const [ready, setReady] = useState('')
  const [readyEpisodeId, setReadyEpisodeId] = useState('')
  const [sessionId, setSessionId] = useState(sessionParam)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [running, setRunning] = useState(false)
  const [wake, setWake] = useState(0)
  const generation = useRef(0)
  const runLock = useRef(false)
  const refreshSequence = useRef(0)
  const errorSource = useRef<'poll' | 'action' | null>(null)
  const jobRef = useRef(jobId)
  useEffect(() => { jobRef.current = jobId }, [jobId])
  useEffect(() => {
    const onPop = () => setSessionId(sessionParam())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  function actionError(e: unknown, fallback: string) {
    errorSource.current = 'action'
    setError(e instanceof Error ? e.message : fallback)
  }

  async function refresh(id: string, token: number): Promise<Job | null> {
    const sequence = ++refreshSequence.current
    const current = await api.job(id)
    if (token !== generation.current || sequence !== refreshSequence.current) return null
    setJob(current)
    if (errorSource.current === 'poll') { errorSource.current = null; setError('') }
    const wantsRoadmap = current.execution_state === 'awaiting_review'
      || (current.execution_state === 'partial_complete' && current.stage === 'plan')
      || current.execution_state === 'complete'
      || (current.execution_state === 'failed' && current.stage !== null && PLANNED_STAGES.has(current.stage))
    if (wantsRoadmap) {
      let saved: Roadmap | null = null
      try { saved = await api.roadmap(current.document_id) } catch (e) { if (!(e instanceof ApiError && e.status === 404)) throw e }
      if (token !== generation.current || sequence !== refreshSequence.current) return null
      if (saved) setRoadmap(saved)
      if (current.execution_state === 'complete' && saved) {
        const episodeId = saved.episodes[0]?.episode_id
        if (episodeId) {
          const episode = await api.episode(episodeId)
          if (token === generation.current && sequence === refreshSequence.current && episode.status === 'ready') { setReady(episode.title); setReadyEpisodeId(episodeId) }
        }
      }
    }
    return current
  }

  useEffect(() => {
    if (!jobId) return
    const token = ++generation.current
    let timer: number | undefined
    const poll = async () => {
      try {
        const current = await refresh(jobId, token)
        if (token !== generation.current) return
        // Poll only while the job is in flight; parked and terminal states
        // re-arm when a learner action (Start, Retry) wakes the effect.
        if (current && ACTIVE.has(current.execution_state ?? '')) timer = window.setTimeout(poll, 3000)
      } catch (e) {
        if (token !== generation.current) return
        if (errorSource.current !== 'action') {
          errorSource.current = 'poll'
          setError(e instanceof Error ? e.message : 'Could not load status.')
        }
        timer = window.setTimeout(poll, 4000)
      }
    }
    void poll()
    return () => { if (generation.current === token) generation.current = token + 1; window.clearTimeout(timer) }
  }, [jobId, wake])

  async function run(id: string) {
    if (runLock.current) return
    runLock.current = true
    setRunning(true)
    setWake(w => w + 1)
    try {
      await api.run(id)
      if (jobRef.current === id) await refresh(id, generation.current)
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        if (jobRef.current === id) await refresh(id, generation.current).catch(() => {})
      } else actionError(e, 'Preparation failed.')
    } finally { runLock.current = false; setRunning(false) }
  }

  async function upload(e: FormEvent) {
    e.preventDefault()
    if (!file) return
    setBusy(true); errorSource.current = 'action'; setError(''); setReady(''); setRoadmap(null); setJob(null)
    try {
      const result = await api.upload(file)
      history.replaceState(null, '', `?job=${encodeURIComponent(result.job_id)}`)
      setJobId(result.job_id)
      // The run starts now; polling begins independently after the render.
      void run(result.job_id)
    } catch (e) { actionError(e, 'Upload failed.') }
    finally { setBusy(false) }
  }

  async function start() {
    if (!job || !roadmap) return
    setBusy(true); errorSource.current = 'action'; setError('')
    try {
      if (!roadmap.confirmed) {
        refreshSequence.current++
        const confirmed = await api.confirm(job.document_id, roadmap.revision)
        refreshSequence.current++
        setRoadmap(confirmed)
      }
      const current = await api.job(job.job_id)
      setJob(current)
      if (current.can_run) void run(current.job_id)
      else {
        setWake(w => w + 1)
        if (current.execution_state !== 'running') setError('Preparation cannot start yet. Refresh the status and try again.')
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        await api.roadmap(job.document_id).then(setRoadmap).catch(() => {})
        setError('The roadmap changed. Review the refreshed roadmap and try again.')
      } else actionError(e, 'Could not start the episode.')
    } finally { setBusy(false) }
  }

  async function openExisting(e: FormEvent) {
    e.preventDefault()
    const trimmed = documentId.trim()
    if (!trimmed) return
    generation.current++; setJobId(''); setJob(null); setRoadmap(null); setReady(''); errorSource.current = 'action'; setError(''); setBusy(true)
    history.replaceState(null, '', location.pathname)
    const token = generation.current
    try {
      const saved = await api.roadmap(trimmed)
      const first = saved.episodes[0]?.episode_id
      if (!first) throw new Error('No episode outline is saved for this document yet.')
      const episode = await api.episode(first)
      if (episode.status !== 'ready') throw new Error('This episode is not ready yet.')
      if (token === generation.current) { setRoadmap(saved); setReady(episode.title); setReadyEpisodeId(first) }
    } catch (e) { if (token === generation.current) setError(e instanceof Error ? e.message : 'Could not open this document.') }
    finally { if (token === generation.current) setBusy(false) }
  }

  async function play() {
    if (!readyEpisodeId) return
    setBusy(true); errorSource.current = 'action'; setError('')
    try {
      const session = await api.createSession(readyEpisodeId)
      setSessionParam(session.sessionId, true)
      setSessionId(session.sessionId)
    } catch (e) { actionError(e, 'Could not start the episode.') }
    finally { setBusy(false) }
  }

  function leavePlayer() { setSessionParam('', false); setSessionId('') }

  if (sessionId) return <VisualNovelPlayer key={sessionId} sessionId={sessionId} onExit={leavePlayer} />

  return <main className="learner">
    <header className="learner-header"><span className="brand">JustMaya</span><span>Your learning story</span></header>
    <section className="intro"><p className="chapter">Your document, your story</p><h1>Turn your notes into a lesson.</h1><p>Choose a PDF and we’ll prepare an episode around its ideas.</p></section>
    <div className="flow">
      <section className="panel upload"><h2>Choose your PDF</h2><p>Your document is the starting point for your learning roadmap.</p><form onSubmit={upload}><label htmlFor="pdf">PDF document</label><input id="pdf" type="file" accept="application/pdf,.pdf" onChange={e => setFile(e.target.files?.[0] || null)} required />{file && <p className="file-name">Selected: {file.name}</p>}<button className="primary" disabled={!file || busy || running}>Prepare my lesson</button></form>
      <details><summary>Open a prepared document</summary><form onSubmit={openExisting}><label htmlFor="document">Document ID</label><input id="document" value={documentId} onChange={e => setDocumentId(e.target.value)} placeholder="Paste a document ID" /><button disabled={busy || running || !documentId.trim()}>Open document</button></form></details></section>
      {(job || running) && !ready && <section className="panel progress" aria-live="polite"><p className="chapter">Preparing your lesson</p><h2>{job?.stage ? (STAGE_LABEL[job.stage] ?? `Stage: ${job.stage}`) : 'Starting preparation'}</h2><p>{job?.status === 'failed' ? 'Preparation stopped.' : 'Working on your document'}</p>{job?.error && <p className="job-error" role="alert">{job.error}</p>}{job?.can_run && !running && !roadmap && <button onClick={() => void run(job.job_id)}>{job.status === 'queued' ? 'Start preparation' : 'Retry preparation'}</button>}</section>}
      {error && <div className="notice" role="alert">{error}{jobId && <button onClick={() => { errorSource.current = null; setError(''); setWake(w => w + 1) }}>Refresh status</button>}</div>}
      {roadmap && !ready && <section className="panel roadmap"><p className="chapter">Your roadmap</p><h2>Here’s what we’ll cover.</h2><div className="episodes">{roadmap.episodes.map((ep, index) => <article className={ep.status === 'selected' ? 'episode first' : 'episode'} key={ep.episode_id}><span className="episode-tag">{index === 0 ? 'Episode 1' : `Episode ${index + 1}`}{ep.status === 'planned_only' ? ' · Planned' : ''}</span><h3>{ep.title}</h3><p className="episode-time">About {Math.round(ep.estimated_minutes)} min</p>{ep.objective_ids.map(id => <p key={id}>{roadmap.objectives.find(o => o.id === id)?.description || id}</p>)}{ep.warnings?.length > 0 && <p className="episode-warning">{ep.warnings.join(' ')}</p>}</article>)}</div>{roadmap.uncovered_concept_ids.length > 0 && <div className="uncovered"><h3>Topics outside this roadmap</h3><ul>{roadmap.uncovered_concept_ids.map(id => <li key={id}>{roadmap.concepts.find(c => c.id === id)?.title || id}{roadmap.uncovered_reasons[id] ? `: ${roadmap.uncovered_reasons[id]}` : ''}</li>)}</ul></div>}{job && (job.can_run || !roadmap.confirmed) && <button className="primary" disabled={busy || running} onClick={() => void start()}>{roadmap.confirmed ? 'Resume Episode 1 preparation' : 'Start Episode 1'}</button>}</section>}
      {ready && <section className="panel ready" role="status"><p className="chapter">Episode ready</p><h2>{ready}</h2><p>Play through the lesson one line at a time. Your place is saved as you go.</p><button className="on-dark" disabled={busy || !readyEpisodeId} onClick={() => void play()}>Play Episode 1</button></section>}
    </div>
  </main>
}

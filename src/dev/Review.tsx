import { useEffect, useState, type FormEvent } from 'react'
import './review.css'

type Ordered = { concept_id: string; basis: string; explanation: string; uncertainty: string[] }
type Episode = { episode_id: string; title: string; objective_ids: string[]; concepts: Ordered[]; dialogue_words: number; words_per_minute: number; interaction_minutes: number; estimate_stale: boolean; estimated_minutes: number; warnings: string[] }
type Roadmap = { revision: number; confirmed: boolean; episodes: Episode[]; concepts: { id: string; title: string; uncertainty: string[] }[]; objectives: { id: string; description: string }[]; uncovered_concept_ids: string[]; uncovered_reasons: Record<string, string> }
type Job = { job_id: string; document_id: string; status: string; stage: string | null; execution_state: string; error: string | null; can_run: boolean; token_usage: { total_tokens: number } }
type StageData = { pages?: { page_number: number; text: string; flags: string[] }[]; sections?: unknown[]; ids?: string[]; documents?: string[]; metadatas?: unknown[]; concepts?: { id: string; title: string }[]; learning_objectives?: unknown[]; prerequisite_edges?: unknown[]; coverage?: unknown[]; supplements?: unknown[]; uncertainty?: unknown[]; title?: string; status?: string; estimatedMinutes?: number; scenes?: { sceneId: string; kind: string; title?: string; lines?: { speaker: string; emotion: string; text: string }[]; question?: { prompt: string; options: { optionId: string; text: string }[]; correctOptionId: string } }[]; validation?: string | null }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  const data = await response.json()
  if (!response.ok) throw new Error(data.error?.message || `Request failed (${response.status})`)
  return data as T
}

export default function Review() {
  const [jobId, setJobId] = useState(() => new URLSearchParams(location.search).get('job') || '')
  const [jobInput, setJobInput] = useState(jobId)
  const [job, setJob] = useState<Job | null>(null)
  const [roadmap, setRoadmap] = useState<Roadmap | null>(null)
  const [stage, setStage] = useState('extraction')
  const [output, setOutput] = useState<StageData | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [running, setRunning] = useState(false)
  const [dirty, setDirty] = useState(false)

  async function refresh(id = jobId) {
    if (!id) return
    try {
      const next = await request<Job>(`/api/jobs/${encodeURIComponent(id)}`)
      setJob(next)
      if (next.execution_state === 'awaiting_review' || (next.execution_state === 'partial_complete' && next.stage === 'plan')) {
        setRoadmap(await request<Roadmap>(`/api/documents/${next.document_id}/curriculum`))
        setDirty(false)
      }
      setMessage('')
    } catch (error) { setMessage(String(error)) }
  }

  useEffect(() => {
    if (!jobId) return
    let active = true
    void request<Job>(`/api/jobs/${encodeURIComponent(jobId)}`).then(async next => {
      const saved = (next.execution_state === 'awaiting_review' || (next.execution_state === 'partial_complete' && next.stage === 'plan'))
        ? await request<Roadmap>(`/api/documents/${next.document_id}/curriculum`) : null
      if (active) { setJob(next); setRoadmap(saved); setDirty(false); setMessage('') }
    }).catch(error => { if (active) setMessage(String(error)) })
    return () => { active = false }
  }, [jobId])

  useEffect(() => {
    if (!jobId || dirty || (!running && job?.execution_state !== 'running')) return
    const timer = window.setInterval(() => { void refresh(jobId) }, 3000)
    return () => window.clearInterval(timer)
  }, [jobId, running, dirty, job?.execution_state])

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    setBusy(true)
    try {
      const result = await request<{ job_id: string }>('/api/documents', { method: 'POST', body: new FormData(form) })
      history.replaceState(null, '', `?job=${encodeURIComponent(result.job_id)}`)
      setRoadmap(null); setOutput(null); setJobInput(result.job_id); setJobId(result.job_id)
    } catch (error) { setMessage(String(error)) } finally { setBusy(false) }
  }

  async function run() {
    setRunning(true)
    try { await request(`/api/jobs/${encodeURIComponent(jobId)}/run`, { method: 'POST' }); await refresh() }
    catch (error) { setMessage(String(error)); await refresh() } finally { setRunning(false) }
  }

  async function inspect() {
    if (!job) return
    try {
      const data = await request<StageData>(`/api/documents/${job.document_id}/inspection/${stage}`)
      setOutput(data)
      setMessage(stage === 'index' && data.ids?.length === 0 ? 'No indexed chunks are available.' : '')
    }
    catch (error) { setOutput(null); setMessage(String(error)) }
  }

  function updateEpisode(index: number, change: (episode: Episode) => Episode) {
    setRoadmap(current => current && { ...current, episodes: current.episodes.map((episode, i) => i === index ? change(episode) : episode) })
    setDirty(true)
  }

  async function save() {
    if (!roadmap || !job) return
    setBusy(true)
    try {
      const episodes = roadmap.episodes.map(e => ({ episode_id: e.episode_id, concept_ids: e.concepts.map(c => c.concept_id), words_per_minute: e.words_per_minute, interaction_minutes: e.interaction_minutes }))
      setRoadmap(await request<Roadmap>(`/api/documents/${job.document_id}/curriculum`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expected_revision: roadmap.revision, episodes }) }))
      setDirty(false); setMessage('Changes saved.')
    } catch (error) { setMessage(`${String(error)} Reload the saved version if another review changed it.`) } finally { setBusy(false) }
  }

  async function confirm() {
    if (!roadmap || !job) return
    setBusy(true)
    try {
      setRoadmap(await request<Roadmap>(`/api/documents/${job.document_id}/curriculum/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expected_revision: roadmap.revision }) }))
      await refresh(); setMessage('Episode 1 confirmed.')
    } catch (error) { setMessage(String(error)) } finally { setBusy(false) }
  }

  const assigned = new Set(roadmap?.episodes.flatMap(e => e.concepts.map(c => c.concept_id)))
  return <main className="review-root">
    <header><p className="review-kicker">JustMaya / development tool</p><h1>Pipeline review</h1><p>Inspect saved outputs and confirm the first lesson.</p></header>
    <section><h2>Document</h2><form onSubmit={upload}><label>PDF file <input name="file" type="file" accept="application/pdf" required /></label><button disabled={busy || dirty}>Upload PDF</button></form>
      <form onSubmit={e => { e.preventDefault(); history.replaceState(null, '', `?job=${encodeURIComponent(jobInput)}`); setRoadmap(null); setOutput(null); if (jobInput === jobId) void refresh(); else setJobId(jobInput) }}><label>Existing job ID <input value={jobInput} onChange={e => setJobInput(e.target.value)} /></label><button disabled={!jobInput || busy || dirty}>Load job</button></form>
      {job && <div><p>Status: <strong>{job.status}</strong> / {job.execution_state} | Tokens: {job.token_usage.total_tokens}</p>{job.error && <p role="alert">{job.error}</p>}
        <div className="actions"><button type="button" onClick={() => void refresh()} disabled={busy || dirty}>Refresh status</button>{job.can_run && <button type="button" onClick={() => void run()} disabled={busy || running}>Run pipeline</button>}</div>{running && <p>Pipeline running; status refreshes automatically.</p>}</div>}
    </section>
    {message && <p role="status" className="notice">{message}</p>}
    {job && <section><h2>Stage output</h2><div className="actions"><label>Stage <select value={stage} onChange={e => { setStage(e.target.value); setOutput(null) }}><option value="extraction">Extraction</option><option value="index">Index</option><option value="analysis">Concept analysis</option><option value="episode">Episode script</option><option value="validation">Validation report</option></select></label><button onClick={() => void inspect()}>Load saved output</button></div>
      {output && stage === 'extraction' && output.pages?.map(page => <details key={page.page_number}><summary>Page {page.page_number}{page.flags.length ? ` (${page.flags.join(', ')})` : ''}</summary><pre tabIndex={0}>{page.text || 'No extracted text.'}</pre></details>)}
      {output && stage === 'extraction' && <details><summary>Detected sections</summary><pre tabIndex={0}>{JSON.stringify(output.sections, null, 2)}</pre></details>}
      {output && stage === 'index' && output.ids?.map((id, i) => <details key={id}><summary>Chunk {i + 1}: {id}</summary><pre tabIndex={0}>{output.documents?.[i]}</pre><pre tabIndex={0}>{JSON.stringify(output.metadatas?.[i], null, 2)}</pre></details>)}
      {output && stage === 'analysis' && <><h3>Concepts</h3>{output.concepts?.map(concept => <details key={concept.id}><summary>{concept.title}</summary><pre tabIndex={0}>{JSON.stringify(concept, null, 2)}</pre></details>)}{(['learning_objectives', 'prerequisite_edges', 'coverage', 'supplements', 'uncertainty'] as const).map(key => <details key={key}><summary>{key.replaceAll('_', ' ')}</summary><pre tabIndex={0}>{JSON.stringify(output[key], null, 2)}</pre></details>)}</>}
      {output && stage === 'episode' && <><h3>{output.title}</h3><p>Status: <strong>{output.status}</strong> | Estimated {output.estimatedMinutes ?? '—'} minutes</p>{output.scenes?.map(scene => <details key={scene.sceneId}><summary>{scene.kind}: {scene.sceneId}{scene.title ? ` — ${scene.title}` : ''}</summary>{scene.lines?.map((line, i) => <p key={i}><strong>{line.speaker}</strong> ({line.emotion}): {line.text}</p>)}{scene.question && <div><p><strong>Checkpoint:</strong> {scene.question.prompt}</p><ol>{scene.question.options.map(o => <li key={o.optionId}>{o.text}{o.optionId === scene.question?.correctOptionId && ' ✓'}</li>)}</ol></div>}<details><summary>Raw scene</summary><pre tabIndex={0}>{JSON.stringify(scene, null, 2)}</pre></details></details>)}</>}
      {output && stage === 'validation' && <><h3>Validation</h3><p>Episode status: <strong>{output.status}</strong></p>{output.validation ? <pre tabIndex={0}>{JSON.stringify(JSON.parse(output.validation), null, 2)}</pre> : <p>No validation report recorded yet.</p>}</>}
    </section>}
    {roadmap && <section><h2>Roadmap {roadmap.confirmed ? '(confirmed)' : '(draft)'}</h2><p>Revision {roadmap.revision}. Time estimates are provisional.</p>
      {roadmap.episodes.map((episode, i) => <article key={episode.episode_id}><h3>Episode {i + 1}: {episode.title}</h3><p>{episode.objective_ids.map(id => roadmap.objectives.find(o => o.id === id)?.description || id).join('; ') || 'No supported objective'}</p>
        <ol>{episode.concepts.map((concept, j) => <li key={concept.concept_id}><strong>{roadmap.concepts.find(c => c.id === concept.concept_id)?.title || concept.concept_id}</strong><p>{concept.basis}: {concept.explanation}</p>{[...concept.uncertainty, ...(roadmap.concepts.find(c => c.id === concept.concept_id)?.uncertainty || [])].map((u, n) => <p key={`${n}-${u}`}>{u}</p>)}
          {!roadmap.confirmed && <div className="actions"><button disabled={j === 0} onClick={() => updateEpisode(i, e => { const list = [...e.concepts]; [list[j - 1], list[j]] = [list[j], list[j - 1]]; return { ...e, concepts: list } })}>Move up</button><button disabled={j === episode.concepts.length - 1} onClick={() => updateEpisode(i, e => { const list = [...e.concepts]; [list[j], list[j + 1]] = [list[j + 1], list[j]]; return { ...e, concepts: list } })}>Move down</button><button onClick={() => updateEpisode(i, e => ({ ...e, concepts: e.concepts.filter(c => c.concept_id !== concept.concept_id), estimate_stale: true }))}>Remove</button></div>}</li>)}</ol>
        {!roadmap.confirmed && <label>Add concept <select value="" onChange={event => { const id = event.target.value; if (id) updateEpisode(i, e => ({ ...e, concepts: [...e.concepts, { concept_id: id, basis: 'user', explanation: 'Added during review', uncertainty: [] }], estimate_stale: true })) }}><option value="">Choose a concept</option>{roadmap.concepts.filter(c => !episode.concepts.some(item => item.concept_id === c.id)).map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label>}
        <div className="timing"><label>Dialogue words <input type="number" value={episode.dialogue_words} readOnly /></label><label>Words per minute <input type="number" min="1" value={episode.words_per_minute} disabled={roadmap.confirmed} onChange={e => updateEpisode(i, ep => ({ ...ep, words_per_minute: Number(e.target.value) }))} /></label><label>Interaction minutes <input type="number" min="0" step="0.5" value={episode.interaction_minutes} disabled={roadmap.confirmed} onChange={e => updateEpisode(i, ep => ({ ...ep, interaction_minutes: Number(e.target.value) }))} /></label></div>
        <p>Estimated time: {episode.words_per_minute > 0 ? (episode.dialogue_words / episode.words_per_minute + episode.interaction_minutes).toFixed(1) : '—'} minutes {episode.estimate_stale && '(word estimate is stale)'}</p>{episode.words_per_minute > 0 && episode.dialogue_words / episode.words_per_minute + episode.interaction_minutes > 10 && <p>This episode may be too broad for its target duration.</p>}</article>)}
      <h3>Not included</h3><ul>{roadmap.concepts.filter(c => !assigned.has(c.id)).map(c => <li key={c.id}>{c.title}{roadmap.uncovered_reasons[c.id] && ` — ${roadmap.uncovered_reasons[c.id]}`}</li>)}</ul>{!roadmap.concepts.some(c => !assigned.has(c.id)) && <p>All concepts are included.</p>}
      {!roadmap.confirmed && <div className="actions"><button onClick={() => void save()} disabled={busy || !dirty}>Save changes</button><button onClick={() => void confirm()} disabled={busy || dirty}>Confirm episode 1</button><button onClick={() => void refresh()} disabled={busy}>Reload saved version</button></div>}{dirty && <p>Save changes before confirming.</p>}
    </section>}
  </main>
}

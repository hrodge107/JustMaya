import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api, ApiError, type Emotion, type Episode, type Scene, type Session } from '../learnerApi'
import MascotStage from './MascotStage'
import './player.css'

const SPEAKER: Record<string, string> = { mascot: 'Instructor', narrator: 'Narrator' }
const REVEAL_MS = 18

const motionQuery = '(prefers-reduced-motion: reduce)'
const subscribeMotion = (cb: () => void) => { const m = matchMedia(motionQuery); m.addEventListener('change', cb); return () => m.removeEventListener('change', cb) }
const useReducedMotion = () => useSyncExternalStore(subscribeMotion, () => matchMedia(motionQuery).matches)

// Linear scene order from startSceneId; the server owns transitions, this is display only.
function sceneOrder(episode: Episode): Scene[] {
  const byId = new Map(episode.scenes.map(s => [s.sceneId, s]))
  const order: Scene[] = []
  for (let s = byId.get(episode.startSceneId); s && !order.includes(s); s = s.nextSceneId ? byId.get(s.nextSceneId) : undefined) order.push(s)
  return order
}

// Monotonic count of happy lines reached so far: changes only on arriving at one.
function happyLinesReached(order: Scene[], session: Session): number {
  let n = 0
  for (const s of order) {
    for (const [i, l] of s.dialogue.entries()) {
      if (l.emotion === 'happy') n++
      if (s.sceneId === session.sceneId && i === session.dialogueIndex) return n
    }
  }
  return n
}

function DialogueText({ id, text, revealed, onRevealed }: { id: string; text: string; revealed: boolean; onRevealed(id: string): void }) {
  const [count, setCount] = useState(0)
  useEffect(() => {
    if (revealed) return
    const timer = window.setInterval(() => setCount(c => Math.min(c + 1, text.length)), REVEAL_MS)
    return () => window.clearInterval(timer)
  }, [revealed, text])
  useEffect(() => { if (!revealed && count >= text.length) onRevealed(id) }, [count, revealed, text, id, onRevealed])
  const shown = revealed ? text : text.slice(0, count)
  // The animated copy is hidden from AT; the live region carries the whole line once.
  return <span className="vn-text" aria-hidden="true">{shown}<span className="vn-text-rest">{revealed ? '' : text.slice(count)}</span></span>
}

export default function VisualNovelPlayer({ sessionId, onExit }: { sessionId: string; onExit(): void }) {
  const [session, setSession] = useState<Session | null>(null)
  const [episode, setEpisode] = useState<Episode | null>(null)
  const [loadError, setLoadError] = useState<{ message: string; notFound: boolean } | null>(null)
  const [pending, setPending] = useState(false)
  const [advanceError, setAdvanceError] = useState('')
  const [revealedLine, setRevealedLine] = useState('')
  const requestId = useRef<string | null>(null)
  const reloadRequired = useRef(false)
  const alive = useRef(true)
  const continueRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const advancing = useRef(false)
  const reduced = useReducedMotion()

  useEffect(() => {
    alive.current = true
    ;(async () => {
      try {
        const s = await api.session(sessionId)
        const e = await api.episode(s.episodeId)
        if (alive.current) { setSession(s); setEpisode(e) }
      } catch (err) {
        if (alive.current) setLoadError({ message: err instanceof Error ? err.message : 'Could not load this lesson.', notFound: err instanceof ApiError && err.status === 404 })
      }
    })()
    return () => { alive.current = false }
  }, [sessionId])

  const order = episode ? sceneOrder(episode) : []
  const scene = order.find(s => s.sceneId === session?.sceneId) ?? episode?.scenes.find(s => s.sceneId === session?.sceneId)
  const line = scene?.dialogue[session?.dialogueIndex ?? 0]
  const mode = session?.mode
  const revealed = reduced || (line !== undefined && revealedLine === line.lineId)
  const nodTrigger = session && line?.emotion === 'happy' ? happyLinesReached(order, session) : 0

  useEffect(() => { if (session && mode === 'playing' && !dialogRef.current?.open) continueRef.current?.focus({ preventScroll: true }) }, [session, mode])

  function openMenu() {
    dialogRef.current?.showModal()
    closeRef.current?.focus({ preventScroll: true })
  }

  async function reload() {
    const s = await api.session(sessionId)
    if (alive.current) setSession(s)
  }

  async function advance() {
    if (!session || !line || mode !== 'playing') return
    if (!revealed) { setRevealedLine(line.lineId); return }
    if (advancing.current) return
    advancing.current = true
    if (reloadRequired.current) {
      setPending(true); setAdvanceError('')
      try { await reload(); reloadRequired.current = false }
      catch { if (alive.current) setAdvanceError('Could not reload your place in the lesson. Try again.') }
      finally { advancing.current = false; if (alive.current) setPending(false) }
      return
    }
    // One id per step until the server acknowledges it: a retry of a request
    // that actually landed is deduplicated, never applied twice.
    requestId.current ??= crypto.randomUUID()
    setPending(true); setAdvanceError('')
    try {
      const next = await api.advance(sessionId, { request_id: requestId.current, expected_version: session.version })
      requestId.current = null
      if (alive.current) setSession(next)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        requestId.current = null
        reloadRequired.current = true
        await reload().then(() => { reloadRequired.current = false }).catch(() => { if (alive.current) setAdvanceError('Could not reload your place in the lesson. Try again.') })
      } else if (alive.current) setAdvanceError(err instanceof Error ? err.message : 'Could not continue.')
    } finally { advancing.current = false; if (alive.current) setPending(false) }
  }

  if (loadError) return <main className="player"><div className="player-message" role="alert"><h1>{loadError.notFound ? 'This lesson session was not found.' : 'This lesson could not be loaded.'}</h1><p>{loadError.notFound ? 'It may have been started on another device or removed. Go back and press Play to start again.' : loadError.message}</p><button className="vn-button" onClick={onExit}>Back to your lesson</button></div></main>
  if (!session || !episode || !scene) return <main className="player"><p className="player-message" role="status">Loading your lesson…</p></main>

  const sceneNumber = order.indexOf(scene) + 1
  const emotion: Emotion = mode === 'checkpoint' ? 'thinking' : mode === 'completed' ? 'happy' : line?.emotion ?? 'idle'
  const isSpeaking = mode === 'playing' && !revealed && line?.speaker === 'mascot'
  const speaker = line ? SPEAKER[line.speaker] ?? line.speaker : ''

  return <main className="player">
    <div className={`vn-frame mode-${mode}`}>
      <header className="player-header">
        <span className="brand">JustMaya</span><span className="player-title">{episode.title}</span>
        <div className="vn-progress">
          <span>Scene {sceneNumber} of {order.length}</span>
          <ol aria-hidden="true">{order.map((s, i) => <li key={s.sceneId} className={i + 1 < sceneNumber ? 'done' : i + 1 === sceneNumber ? 'current' : ''} />)}</ol>
        </div>
      </header>
      <section className="vn-scene" aria-label="Scene">
        <div className="vn-stage">
          <MascotStage emotion={emotion} isSpeaking={isSpeaking} nodTrigger={nodTrigger} customAnimationTrigger={null} lookTargetOffset={emotion === 'thinking' ? { x: 0.7, y: -0.7 } : null} enablePointerTracking={mode === 'playing'} />
          {mode === 'checkpoint' && scene.question && <div className="vn-prompt"><p className="vn-prompt-label">Checkpoint</p><p className="vn-prompt-text">{scene.question.prompt}</p></div>}
          {mode === 'completed' && <div className="vn-prompt"><p className="vn-prompt-label">Episode complete</p><p className="vn-prompt-text">{episode.title}</p></div>}
        </div>
      </section>
      <section className="vn-dialogue" aria-label="Dialogue">
        {mode === 'playing' && line ? <>
          <button ref={continueRef} type="button" className="vn-dialogue-target" aria-label={advanceError ? 'Retry advancing dialogue' : 'Reveal or advance dialogue'} aria-busy={pending || undefined} aria-disabled={pending || undefined} onClick={() => void advance()}>
            <span className="vn-speaker">{speaker}</span>
            <DialogueText key={line.lineId} id={line.lineId} text={line.text} revealed={revealed} onRevealed={setRevealedLine} />
            {advanceError && <span className="vn-error" role="alert">{advanceError} Activate the dialogue to try again.</span>}
            <span className="vn-advance-cue" aria-hidden="true">{pending ? '…' : '◆'}</span>
          </button>
          <p className="sr-only" aria-live="polite">{speaker}: {line.text}</p>
        </> : <>
          {line && <><p className="vn-speaker">{speaker}</p><p className="vn-text">{line.text}</p></>}
          <div className="vn-controls">
            {mode === 'checkpoint' && <p className="vn-note">You can answer this checkpoint once that part of the lesson is ready. Your place is saved here.</p>}
            {mode === 'completed' && <button className="vn-button" onClick={onExit}>Back to your lesson</button>}
            {mode !== 'checkpoint' && mode !== 'completed' && <p className="vn-note">This session is in {mode} mode, which this player cannot show yet.</p>}
          </div>
        </>}
      </section>
      <div className="vn-menu-rail">
        <button ref={menuRef} type="button" className="vn-menu-trigger" aria-haspopup="dialog" aria-controls="episode-menu" onClick={openMenu}>
          <span className="vn-menu-icon" aria-hidden="true"><span /><span /><span /></span>
          Menu
        </button>
      </div>
    </div>
    <dialog ref={dialogRef} id="episode-menu" className="vn-menu-dialog" aria-labelledby="episode-menu-title" onClose={() => menuRef.current?.focus({ preventScroll: true })} onKeyDown={event => {
      if (event.key !== 'Tab') return
      const buttons = event.currentTarget.querySelectorAll('button')
      const first = buttons[0], last = buttons[buttons.length - 1]
      // Keep boundary tabs in the menu rather than moving to browser chrome.
      if (event.shiftKey ? document.activeElement === first : document.activeElement === last) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      }
    }}>
      <div className="vn-menu-heading"><h2 id="episode-menu-title">Episode menu</h2><button ref={closeRef} type="button" className="vn-quiet" onClick={() => dialogRef.current?.close()}>Close</button></div>
      <button type="button" className="vn-button vn-menu-leave" onClick={onExit}>Leave episode</button>
    </dialog>
  </main>
}

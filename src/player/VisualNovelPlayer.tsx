import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api, ApiError, type AnswerRequest, type Emotion, type Episode, type Scene, type Session } from '../learnerApi'
import MascotStage from './MascotStage'
import RecallCheckpoint from './RecallCheckpoint'
import useReadingAdvance from './useReadingAdvance'
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
    if (s.sceneId === session.sceneId) return n
  }
  return n
}

function DialogueText({ id, text, revealed, onRevealed, onRevealProgress }: { id: string; text: string; revealed: boolean; onRevealed(id: string): void; onRevealProgress(marker: HTMLSpanElement | null): void }) {
  const [count, setCount] = useState(0)
  const revealBoundaryRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (revealed) return
    const timer = window.setInterval(() => setCount(c => Math.min(c + 1, text.length)), REVEAL_MS)
    return () => window.clearInterval(timer)
  }, [revealed, text])
  useLayoutEffect(() => { if (!revealed) onRevealProgress(revealBoundaryRef.current) }, [count, onRevealProgress, revealed])
  useEffect(() => { if (!revealed && count >= text.length) onRevealed(id) }, [count, revealed, text, id, onRevealed])
  const shown = revealed ? text : text.slice(0, count)
  // The animated copy is hidden from AT; the live region carries the whole line once.
  return <span className="vn-text" aria-hidden="true">{shown}<span ref={revealBoundaryRef} className="vn-reveal-boundary" /><span className="vn-text-rest">{revealed ? '' : text.slice(count)}</span></span>
}

export default function VisualNovelPlayer({ sessionId, onExit }: { sessionId: string; onExit(): void }) {
  const [session, setSession] = useState<Session | null>(null)
  const [episode, setEpisode] = useState<Episode | null>(null)
  const [loadError, setLoadError] = useState<{ message: string; notFound: boolean } | null>(null)
  const [pending, setPending] = useState(false)
  const [advanceError, setAdvanceError] = useState('')
  const [answerError, setAnswerError] = useState('')
  const [submittedOptionId, setSubmittedOptionId] = useState<string | null>(null)
  const [needsReload, setNeedsReload] = useState(false)
  const [nodTrigger, setNodTrigger] = useState(0)
  const observedNods = useRef(0)
  const latestVersion = useRef(0)
  const answerRequest = useRef<AnswerRequest | null>(null)
  const [revealedLine, setRevealedLine] = useState('')
  const [restoredTurn, setRestoredTurn] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [readingReset, setReadingReset] = useState(0)
  const advanceRequest = useRef<{ request_id: string; expected_version: number } | null>(null)
  const reloadRequired = useRef(false)
  const alive = useRef(true)
  const continueRef = useRef<HTMLButtonElement>(null)
  const dialogueScrollRef = useRef<HTMLSpanElement>(null)
  const revealBoundaryRef = useRef<HTMLSpanElement>(null)
  const followLatestRef = useRef(true)
  const autoScrollTopRef = useRef<number | null>(null)
  const menuRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const advancing = useRef(false)
  const reduced = useReducedMotion()

  useEffect(() => {
    let active = true
    alive.current = true
    ;(async () => {
      try {
        const s = await api.session(sessionId)
        const e = await api.episode(s.episodeId)
        if (active) {
          latestVersion.current = s.version
          observedNods.current = happyLinesReached(sceneOrder(e), s) + (s.quizAttempts ?? []).filter(a => a.correct).length
          if (s.mode === 'checkpoint' && s.checkpoint?.feedback) setRestoredTurn(`${s.sceneId}:${s.checkpoint.questionId}:${s.checkpoint.attemptsUsed}`)
          setSession(s); setEpisode(e)
        }
      } catch (err) {
        if (active) setLoadError({ message: err instanceof Error ? err.message : 'Could not load this lesson.', notFound: err instanceof ApiError && err.status === 404 })
      }
    })()
    return () => { active = false; alive.current = false }
  }, [sessionId])

  const order = episode ? sceneOrder(episode) : []
  const scene = order.find(s => s.sceneId === session?.sceneId) ?? episode?.scenes.find(s => s.sceneId === session?.sceneId)
  const line = scene?.dialogue[session?.dialogueIndex ?? 0]
  const mode = session?.mode
  const checkpoint = mode === 'checkpoint' ? session?.checkpoint : null
  const question = mode === 'checkpoint' ? scene?.question : null
  const turnId = question ? `${scene?.sceneId}:${question.questionId}:${checkpoint?.attemptsUsed ?? 0}` : line?.lineId ?? ''
  const text = question ? checkpoint?.feedback ?? question.prompt : line?.text ?? ''
  const revealed = reduced || revealedLine === turnId || restoredTurn === turnId
  const dialogueError = answerError || advanceError
  const readingDelay = Math.max(3000, text.trim().split(/\s+/u).filter(Boolean).length * 300)

  useLayoutEffect(() => {
    followLatestRef.current = true
    autoScrollTopRef.current = null
    const target = dialogueScrollRef.current
    if (target && target.scrollTop !== 0) {
      autoScrollTopRef.current = 0
      target.scrollTop = 0
    }
  }, [turnId])

  const onRevealProgress = useCallback((marker: HTMLSpanElement | null) => {
    revealBoundaryRef.current = marker
    if (!marker || !followLatestRef.current) return
    const target = dialogueScrollRef.current
    if (!target) return

    const targetRect = target.getBoundingClientRect()
    const viewTop = targetRect.top + target.clientTop
    const nameplateBottom = target.querySelector<HTMLElement>('.vn-speaker')?.getBoundingClientRect().bottom ?? viewTop
    const readingTop = Math.max(viewTop, nameplateBottom + 8)
    const readingBottom = viewTop + target.clientHeight - 8
    const markerRect = marker.getBoundingClientRect()
    let nextScrollTop = target.scrollTop
    if (markerRect.bottom > readingBottom) nextScrollTop += markerRect.bottom - readingBottom
    else if (markerRect.top < readingTop) nextScrollTop -= readingTop - markerRect.top

    if (Math.abs(nextScrollTop - target.scrollTop) > 1) {
      nextScrollTop = Math.max(0, nextScrollTop)
      autoScrollTopRef.current = nextScrollTop
      target.scrollTop = nextScrollTop
    }
  }, [])

  function handleDialogueScroll(target: HTMLSpanElement, fromUserInput = false) {
    const expectedAutoScrollTop = autoScrollTopRef.current
    if (!fromUserInput && expectedAutoScrollTop !== null && Math.abs(target.scrollTop - expectedAutoScrollTop) < 1) {
      autoScrollTopRef.current = null
      return
    }
    autoScrollTopRef.current = null
    if (checkpoint?.checkpointCompleted && !fromUserInput) setReadingReset(n => n + 1)

    const marker = revealBoundaryRef.current
    if (!marker) return
    const targetRect = target.getBoundingClientRect()
    const viewTop = targetRect.top + target.clientTop
    const nameplateBottom = target.querySelector<HTMLElement>('.vn-speaker')?.getBoundingClientRect().bottom ?? viewTop
    const readingTop = Math.max(viewTop, nameplateBottom + 8)
    const readingBottom = viewTop + target.clientHeight - 8
    const markerRect = marker.getBoundingClientRect()
    followLatestRef.current = markerRect.top >= readingTop - 1 && markerRect.bottom <= readingBottom + 1
  }

  function handleManualScrollIntent(target: HTMLSpanElement, resetReading = true) {
    followLatestRef.current = false
    if (checkpoint?.checkpointCompleted && resetReading) setReadingReset(n => n + 1)
    window.requestAnimationFrame(() => handleDialogueScroll(target, true))
  }

  useEffect(() => { if (session && (mode === 'playing' || checkpoint?.checkpointCompleted) && !dialogRef.current?.open) continueRef.current?.focus({ preventScroll: true }) }, [session, mode, checkpoint?.checkpointCompleted])

  function openMenu() {
    setMenuOpen(true)
    dialogRef.current?.showModal()
    closeRef.current?.focus({ preventScroll: true })
  }

  async function reload() {
    const s = await api.session(sessionId)
    acceptSession(s)
  }

  function acceptSession(next: Session) {
    if (!alive.current || next.version < latestVersion.current) return
    latestVersion.current = next.version
    const count = happyLinesReached(order, next) + (next.quizAttempts ?? []).filter(a => a.correct).length
    const increment = count - observedNods.current
    if (increment > 0) setNodTrigger(n => n + increment)
    observedNods.current = count
    setSession(next)
  }

  async function recover() {
    if (advancing.current) return
    advancing.current = true; setPending(true)
    try { await reload(); reloadRequired.current = false; setNeedsReload(false); setAnswerError(''); setAdvanceError(''); setReadingReset(n => n + 1) }
    catch { if (alive.current) setAnswerError('Could not reload your place. Try again.') }
    finally { advancing.current = false; if (alive.current) setPending(false) }
  }

  async function advance() {
    if (!session || !(mode === 'playing' && line || mode === 'checkpoint' && session.checkpoint?.checkpointCompleted)) return
    if (mode === 'playing' && line && !revealed) { setRevealedLine(line.lineId); return }
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
    advanceRequest.current ??= { request_id: crypto.randomUUID(), expected_version: session.version }
    setPending(true); setAdvanceError('')
    try {
      const next = await api.advance(sessionId, advanceRequest.current)
      advanceRequest.current = null
      acceptSession(next)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        advanceRequest.current = null
        reloadRequired.current = true
        await reload().then(() => { reloadRequired.current = false }).catch(() => { if (alive.current) { setNeedsReload(true); setAdvanceError('Could not reload your place in the lesson. Try again.') } })
      } else if (alive.current) setAdvanceError(err instanceof Error ? err.message : 'Could not continue.')
    } finally { advancing.current = false; if (alive.current) setPending(false) }
  }

  async function submitAnswer(optionId: string) {
    if (!session || !scene?.question || mode !== 'checkpoint' || advancing.current || session.checkpoint?.checkpointCompleted || reloadRequired.current) return
    advancing.current = true
    answerRequest.current ??= { questionId: scene.question.questionId, optionId, request_id: crypto.randomUUID(), expected_version: session.version }
    setSubmittedOptionId(answerRequest.current.optionId)
    setPending(true); setAnswerError('')
    try {
      const next = await api.answer(sessionId, answerRequest.current)
      answerRequest.current = null
      if (alive.current) { acceptSession(next); setSubmittedOptionId(null) }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        answerRequest.current = null
        if (alive.current) setSubmittedOptionId(null)
        reloadRequired.current = true
        await reload().then(() => { reloadRequired.current = false }).catch(() => { if (alive.current) { setNeedsReload(true); setAnswerError('Could not reload your checkpoint. Try again.') } })
      } else if (err instanceof ApiError && err.status === 422) {
        answerRequest.current = null
        if (alive.current) { setSubmittedOptionId(null); setAnswerError(err.message) }
      } else if (alive.current) setAnswerError(err instanceof Error ? err.message : 'Could not submit your answer.')
    } finally { advancing.current = false; if (alive.current) setPending(false) }
  }

  useReadingAdvance(turnId, readingDelay, !!checkpoint?.checkpointCompleted && revealed && !pending && !dialogueError && !needsReload, menuOpen, readingReset, () => { void advance() })

  function activateDialogue() {
    if (pending) return
    if (mode !== 'checkpoint') { void advance(); return }
    if (needsReload) { void recover(); return }
    if (answerError) { if (submittedOptionId) void submitAnswer(submittedOptionId); else void recover(); return }
    if (advanceError) { void advance(); return }
    if (!revealed) { setRevealedLine(turnId); return }
    if (checkpoint?.checkpointCompleted) void advance()
  }

  if (loadError) return <main className="player"><div className="player-message" role="alert"><h1>{loadError.notFound ? 'This lesson session was not found.' : 'This lesson could not be loaded.'}</h1><p>{loadError.notFound ? 'It may have been started on another device or removed. Go back and press Play to start again.' : loadError.message}</p><button className="vn-button" onClick={onExit}>Back to your lesson</button></div></main>
  if (!session || !episode || !scene) return <main className="player"><p className="player-message" role="status">Loading your lesson…</p></main>

  const sceneNumber = order.indexOf(scene) + 1
  const emotion: Emotion = mode === 'checkpoint' ? session.checkpoint?.isCorrect === true ? 'happy' : session.checkpoint?.isCorrect === false ? 'confused' : 'thinking' : mode === 'completed' ? 'happy' : line?.emotion ?? 'idle'
  const isSpeaking = !revealed && (!!question || mode === 'playing' && line?.speaker === 'mascot')
  const speaker = question ? 'Instructor' : line ? SPEAKER[line.speaker] ?? line.speaker : ''
  const mascot = <MascotStage emotion={emotion} isSpeaking={isSpeaking} nodTrigger={nodTrigger} customAnimationTrigger={null} lookTargetOffset={emotion === 'thinking' ? { x: 0.7, y: -0.7 } : null} enablePointerTracking={mode === 'playing'} />

  return <main className="player">
    <div className={`vn-frame mode-${mode}`}>
      <header className="player-header">
        <span className="brand">JustMaya</span><span className="player-title">{episode.title}</span>
        <div className="vn-progress">
          <span>Scene {sceneNumber} of {order.length}</span>
          <ol aria-hidden="true">{order.map((s, i) => <li key={s.sceneId} className={i + 1 < sceneNumber ? 'done' : i + 1 === sceneNumber ? 'current' : ''} />)}</ol>
        </div>
      </header>
      <section className={`vn-scene${question ? ' vn-checkpoint-scene' : ''}`} aria-label="Scene">
        <div className="vn-stage">
          {mascot}
          {mode === 'completed' && <div className="vn-prompt"><p className="vn-prompt-label">Episode complete</p><p className="vn-prompt-text">{episode.title}</p></div>}
        </div>
        {question && <RecallCheckpoint key={scene.sceneId} question={question} state={checkpoint ?? null} pending={pending}
          submittedOptionId={submittedOptionId} reloadRequired={needsReload} onAnswer={optionId => void submitAnswer(optionId)} />}
      </section>
      <section className="vn-dialogue" aria-label="Dialogue">
        {(mode === 'playing' && line) || question ? <>
          <button ref={continueRef} type="button" className="vn-dialogue-target" aria-label={dialogueError || needsReload ? question ? 'Retry lesson connection' : 'Retry advancing dialogue' : question ? checkpoint?.checkpointCompleted && revealed ? 'Advance dialogue' : 'Reveal dialogue' : 'Reveal or advance dialogue'} aria-busy={pending || undefined} aria-disabled={pending || undefined} onClick={activateDialogue} onKeyDown={event => {
            if (event.altKey || event.ctrlKey || event.metaKey) return
            const target = dialogueScrollRef.current
            if (!target) return
            if (target.scrollHeight <= target.clientHeight + 1) return
            const lineStep = parseFloat(getComputedStyle(target).fontSize) * 3
            let nextScrollTop: number | null = null
            if (event.key === 'ArrowDown') nextScrollTop = target.scrollTop + lineStep
            else if (event.key === 'ArrowUp') nextScrollTop = target.scrollTop - lineStep
            else if (event.key === 'PageDown') nextScrollTop = target.scrollTop + target.clientHeight * .8
            else if (event.key === 'PageUp') nextScrollTop = target.scrollTop - target.clientHeight * .8
            else if (event.key === 'Home') nextScrollTop = 0
            else if (event.key === 'End') nextScrollTop = target.scrollHeight
            if (nextScrollTop !== null) {
              event.preventDefault()
              if (checkpoint?.checkpointCompleted) setReadingReset(n => n + 1)
              target.scrollTop = Math.max(0, Math.min(nextScrollTop, target.scrollHeight))
              handleDialogueScroll(target, true)
            }
          }}>
            <span ref={dialogueScrollRef} className="vn-dialogue-scroll-area" onScroll={event => handleDialogueScroll(event.currentTarget)} onWheel={event => handleManualScrollIntent(event.currentTarget)} onTouchMove={event => handleManualScrollIntent(event.currentTarget)} onPointerDown={event => handleManualScrollIntent(event.currentTarget, false)}>
              <span className="vn-speaker">{speaker}</span>
              <DialogueText key={turnId} id={turnId} text={text} revealed={revealed} onRevealed={setRevealedLine} onRevealProgress={onRevealProgress} />
              {dialogueError && <span className="vn-error" role="alert">{dialogueError} Activate the dialogue to try again.</span>}
            </span>
            <span className="vn-advance-cue" aria-hidden="true">{pending || question && !checkpoint?.checkpointCompleted && !dialogueError && revealed ? '…' : '◆'}</span>
          </button>
          <p className="sr-only" aria-live="polite" aria-atomic="true">{speaker}: {text}</p>
          {pending && <p className="sr-only" role="status">Saving your progress…</p>}
        </> : <>
          {line && <><p className="vn-speaker">{speaker}</p><p className="vn-text">{line.text}</p></>}
          <div className="vn-controls">
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
    <dialog ref={dialogRef} id="episode-menu" className="vn-menu-dialog" aria-labelledby="episode-menu-title" onClose={() => { setMenuOpen(false); menuRef.current?.focus({ preventScroll: true }) }} onKeyDown={event => {
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

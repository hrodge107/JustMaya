import '@fontsource-variable/nunito'
import { useCallback, useEffect, useState } from 'react'
import Home from './home/Home'
import VisualNovelPlayer from './player/VisualNovelPlayer'
import { useReducedMotion } from './motionPreference'
import type { Background } from './StudyHeader'

const backgrounds: Background[] = ['bedroom', 'study', 'none']

// Session deep links: ?session=<id> resumes a lesson directly. Playing an
// episode from Learn writes the same param, so a reload returns to the
// episode, not the lobby. Sessions remain server-authoritative.
const sessionParam = () => new URLSearchParams(window.location.search).get('session')
function setSessionParam(id: string, push: boolean) {
  const url = new URL(window.location.href)
  if (id) url.searchParams.set('session', id)
  else url.searchParams.delete('session')
  if (push) window.history.pushState({}, '', url)
  else window.history.replaceState({}, '', url)
}

// Surface-swap veil: covers the Home<->Player change with the shared stage
// gradient, swaps underneath, then reveals. Player-bound covers hold until the
// episode data lands (or a cap), so the veil doubles as the loading splash.
const COVER_MS = 200
const REVEAL_MS = 320
const VEIL_CAP_MS = 9000

export default function App() {
  const [background, setBackground] = useState<Background>(() => {
    try { const value = localStorage.getItem('meet-mita:background'); return backgrounds.find(item => item === value) ?? 'bedroom' } catch { return 'bedroom' }
  })
  function cycleBackground() {
    setBackground(current => backgrounds[(backgrounds.indexOf(current) + 1) % backgrounds.length])
  }
  useEffect(() => { try { localStorage.setItem('meet-mita:background', background) } catch { /* Keep the selection for this visit. */ } }, [background])
  const [sessionId, setSessionId] = useState<string | null>(sessionParam)
  const [shownId, setShownId] = useState(sessionId)
  const [covered, setCovered] = useState(false)
  const [settled, setSettled] = useState(false)
  const reduced = useReducedMotion()
  const playerReady = useCallback(() => setSettled(true), [])

  useEffect(() => {
    const onPop = () => setSessionId(sessionParam())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // Reduced motion swaps instantly; MotionToggle stays the only dial.
  useEffect(() => {
    if (shownId === sessionId) return
    // eslint-disable-next-line react/set-state-in-effect -- navigation is external state; the veil is a timed reaction to it
    if (reduced) { setShownId(sessionId); return }
    setSettled(false)
    setCovered(true)
    const swap = window.setTimeout(() => setShownId(sessionId), COVER_MS)
    return () => window.clearTimeout(swap)
  }, [sessionId, shownId, reduced])

  // Home mounts instantly; the player reports when its session+episode land.
  // The cap guarantees the veil lifts even if that load stalls.
  useEffect(() => {
    if (!covered || shownId !== sessionId) return
    const reveal = window.setTimeout(() => setCovered(false), shownId === null || settled ? REVEAL_MS : VEIL_CAP_MS)
    return () => window.clearTimeout(reveal)
  }, [covered, shownId, sessionId, settled])

  function leavePlayer() {
    setSessionParam('', true)
    setSessionId(null)
  }

  return <>
    {shownId
      ? <VisualNovelPlayer key={shownId} sessionId={shownId} onExit={leavePlayer} onReady={playerReady} background={background} onBackground={cycleBackground} />
      : <Home background={background} onBackground={cycleBackground} onPlay={session => { setSessionParam(session, true); setSessionId(session) }} />}
    <div className={`app-veil${covered ? ' is-covered' : ''}`} aria-hidden="true">
      <span className="app-veil-brand">Meet Mita</span>
      <span className="app-veil-cue">▾</span>
    </div>
  </>
}

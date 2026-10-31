import '@fontsource-variable/nunito'
import { useEffect, useState } from 'react'
import Home from './home/Home'
import VisualNovelPlayer from './player/VisualNovelPlayer'

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

export default function App() {
  const [sessionId, setSessionId] = useState<string | null>(sessionParam)

  useEffect(() => {
    const onPop = () => setSessionId(sessionParam())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  function leavePlayer() {
    setSessionParam('', true)
    setSessionId(null)
  }

  if (sessionId) return <VisualNovelPlayer key={sessionId} sessionId={sessionId} onExit={leavePlayer} />
  return <Home onPlay={session => { setSessionParam(session, true); setSessionId(session) }} />
}

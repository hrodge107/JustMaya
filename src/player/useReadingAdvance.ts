import { useEffect, useLayoutEffect, useRef } from 'react'

export default function useReadingAdvance(turnId: string, delay: number, ready: boolean, paused: boolean, readingReset: number, onAdvance: () => void) {
  const advance = useRef(onAdvance)
  const clock = useRef({ key: '', remaining: delay })
  useLayoutEffect(() => { advance.current = onAdvance })

  useEffect(() => {
    const key = `${turnId}:${readingReset}`
    if (clock.current.key !== key) clock.current = { key, remaining: delay }
    const current = clock.current
    if (!ready || paused) return
    let started: number | null = null
    let timer: number | undefined
    function stop() {
      window.clearTimeout(timer)
      if (started !== null) current.remaining = Math.max(0, current.remaining - (performance.now() - started))
      started = null
    }
    function syncVisibility() {
      stop()
      if (document.hidden) return
      started = performance.now()
      timer = window.setTimeout(() => { stop(); advance.current() }, current.remaining)
    }
    syncVisibility()
    document.addEventListener('visibilitychange', syncVisibility)
    return () => { stop(); document.removeEventListener('visibilitychange', syncVisibility) }
  }, [turnId, delay, ready, paused, readingReset])
}

import { useEffect, useRef } from 'react'
import type { Emotion } from '../learnerApi'

// Replaceable presentation adapter. The player and tutor depend only on these
// props; the priority-23 VRM stage must accept the same contract.
export type MascotStageProps = {
  emotion: Emotion
  isSpeaking: boolean
  nodTrigger: number
  customAnimationTrigger: string | null
  lookTargetOffset: { x: number; y: number } | null
  enablePointerTracking: boolean
}

const clamp = (v: number) => Math.max(-1, Math.min(1, v))

export default function MascotStage({ emotion, isSpeaking, nodTrigger, customAnimationTrigger, lookTargetOffset, enablePointerTracking }: MascotStageProps) {
  const ref = useRef<HTMLElement>(null)
  const lookX = lookTargetOffset?.x
  const lookY = lookTargetOffset?.y

  // Gaze goes straight to CSS variables: pointer moves never re-render React.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const look = (x: number, y: number) => { el.style.setProperty('--gx', String(clamp(x))); el.style.setProperty('--gy', String(clamp(y))) }
    if (lookX !== undefined && lookY !== undefined) { look(lookX, lookY); return }
    look(0, 0)
    if (!enablePointerTracking) return
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect()
      look((e.clientX - (r.left + r.width / 2)) / (window.innerWidth / 2), (e.clientY - (r.top + r.height / 2)) / (window.innerHeight / 2))
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    return () => window.removeEventListener('pointermove', onMove)
  }, [lookX, lookY, enablePointerTracking])

  return <figure className="mascot" ref={ref} data-emotion={emotion} data-speaking={isSpeaking || undefined} aria-label={`Instructor stand-in, ${emotion}${isSpeaking ? ', speaking' : ''}`}>
    {/* Remounting on nodTrigger replays the one-shot nod; 0 means "never nodded". */}
    <div className={nodTrigger > 0 ? 'mascot-body nod' : 'mascot-body'} key={nodTrigger} aria-hidden="true">
      <div className="mascot-face">
        <span className="brow" />
        <span className="eye left" /><span className="eye right" />
        <span className="mouth" />
      </div>
      <span className="mascot-mark" />
    </div>
    <figcaption className="mascot-state">
      <span className="mascot-emotion">{emotion}</span>
      {isSpeaking && <span> · speaking</span>}
      {customAnimationTrigger && <span> · {customAnimationTrigger}</span>}
      <span className="mascot-standin">Stand-in character</span>
    </figcaption>
  </figure>
}

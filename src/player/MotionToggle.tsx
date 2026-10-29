import { setMotionOverride, useMotionOverride, useReducedMotion } from '../motionPreference'

// Episode-menu motion control. The whole row is the switch so its label stays
// the hit target; a forced value offers a way back to the device setting.
export default function MotionToggle() {
  const reduced = useReducedMotion()
  const override = useMotionOverride()
  return <div className="vn-menu-motion">
    <button type="button" role="switch" aria-checked={reduced} className="vn-motion" onClick={() => setMotionOverride(reduced ? 'full' : 'reduce')}>
      <span>Reduce motion</span>
      <span className="vn-switch" aria-hidden="true"><span className="vn-switch-thumb" /></span>
    </button>
    {override !== null && <button type="button" className="vn-motion-reset" onClick={() => setMotionOverride(null)}>Use device setting</button>}
  </div>
}

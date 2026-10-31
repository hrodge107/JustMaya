import { useSyncExternalStore } from 'react'

// Single owner of the effective motion setting: the device media query unless
// the learner forces a value from the episode menu. A forced value persists
// on-device and is mirrored to <html data-motion> so CSS follows it too.
export type MotionOverride = 'reduce' | 'full' | null

const QUERY = '(prefers-reduced-motion: reduce)'
const STORAGE_KEY = 'justmaya:motion'
const media = matchMedia(QUERY)
const listeners = new Set<() => void>()

let override: MotionOverride = (() => {
  try { const saved = localStorage.getItem(STORAGE_KEY); return saved === 'reduce' || saved === 'full' ? saved : null }
  catch { return null }
})()

const effective = () => (override ? override === 'reduce' : media.matches)

function notify() {
  document.documentElement.dataset.motion = effective() ? 'reduce' : 'full'
  for (const listener of listeners) listener()
}

media.addEventListener('change', notify)
notify()

export const reducedMotion = () => effective()
export const getMotionOverride = () => override
export function setMotionOverride(next: MotionOverride) {
  override = next
  try { if (next === null) localStorage.removeItem(STORAGE_KEY); else localStorage.setItem(STORAGE_KEY, next) } catch { /* storage unavailable */ }
  notify()
}
export function subscribeMotion(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export const useReducedMotion = () => useSyncExternalStore(subscribeMotion, reducedMotion)
export const useMotionOverride = () => useSyncExternalStore(subscribeMotion, getMotionOverride)

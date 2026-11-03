import { Component, lazy, Suspense, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useReducedMotion } from '../motionPreference'
import MascotPlaceholder from './MascotPlaceholder'
import type { MascotStageProps } from './MascotPlaceholder'
import { resolveMascotModel } from './mascotModels'

class RenderBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? this.props.fallback : this.props.children }
}

export type { MascotStageProps } from './MascotPlaceholder'
const VRMCanvas = lazy(() => import('./VRMCanvas'))
const model = resolveMascotModel()

const VRM_ENABLED = true

export default function MascotStage(props: MascotStageProps) {
  const reduce = useReducedMotion()
  const [failed, setFailed] = useState(false)
  // The VRM figure is position:fixed — a viewport overlay, not stage content.
  // Rendering it under the stage's DOM ancestors (.maya-wrap/.vn-scene) lets
  // Blink associate its compositor clip with the scene rect; that clip has
  // been observed going stale and cutting the avatar at the scene's bottom
  // edge. Mount it on the surface root instead so the only ancestor bounds
  // are the viewport-sized ones. The stand-in stays in place: it IS stage
  // content and needs .maya-wrap/.vn-stage for layout.
  const anchor = useRef<HTMLSpanElement>(null)
  const [surface, setSurface] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => { setSurface(el => el ?? anchor.current?.closest('.player, .home') ?? anchor.current?.parentElement ?? null) }, [])
  const fallback = <MascotPlaceholder {...props} />
  if (!VRM_ENABLED || !model || reduce || failed) return fallback
  // While the chunk/model loads the stage stays empty — the stand-in is the
  // failure path, never a loading state (its cache-dependent flash reads as a
  // boot glitch once the VRM pops in over it).
  const vrm = <RenderBoundary fallback={fallback}><Suspense fallback={null}>
    <VRMCanvas {...props} modelUrl={model.url} idleUrl={model.idleUrl} expressions={model.expressions} outlineFactor={model.outlineFactor} restPose={model.restPose} onError={() => setFailed(true)} />
  </Suspense></RenderBoundary>
  return <><span ref={anchor} hidden />{surface ? createPortal(vrm, surface) : null}</>
}

import { Component, lazy, Suspense, useState, type ReactNode } from 'react'
import defaultModelUrl from '../../vroid_models/meta_chan.vrm?url'
import { useReducedMotion } from '../motionPreference'
import MascotPlaceholder from './MascotPlaceholder'
import type { MascotStageProps } from './MascotPlaceholder'

class RenderBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? this.props.fallback : this.props.children }
}

export type { MascotStageProps } from './MascotPlaceholder'
const VRMCanvas = lazy(() => import('./VRMCanvas'))
const modelUrl = import.meta.env.VITE_MASCOT_VRM_URL?.trim() || defaultModelUrl
const idleUrl = import.meta.env.VITE_MASCOT_IDLE_URL?.trim()

export default function MascotStage(props: MascotStageProps) {
  const reduce = useReducedMotion()
  const [failed, setFailed] = useState(false)
  const fallback = <MascotPlaceholder {...props} />
  if (!modelUrl || reduce || failed) return fallback
  return <RenderBoundary fallback={fallback}><Suspense fallback={fallback}>
    <VRMCanvas {...props} modelUrl={modelUrl} idleUrl={idleUrl} fallback={fallback} onError={() => setFailed(true)} />
  </Suspense></RenderBoundary>
}

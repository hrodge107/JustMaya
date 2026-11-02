import { Component, lazy, Suspense, useState, type ReactNode } from 'react'
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
  const fallback = <MascotPlaceholder {...props} />
  if (!VRM_ENABLED || !model || reduce || failed) return fallback
  return <RenderBoundary fallback={fallback}><Suspense fallback={fallback}>
    <VRMCanvas {...props} modelUrl={model.url} idleUrl={model.idleUrl} expressions={model.expressions} outlineFactor={model.outlineFactor} restPose={model.restPose} fallback={fallback} onError={() => setFailed(true)} />
  </Suspense></RenderBoundary>
}

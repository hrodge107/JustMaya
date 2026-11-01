import { useEffect, useRef, useState, type ReactNode } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm'
import { retargetAnimationFromUrl, type VRMHumanBoneName } from 'vrm-mixamo-retarget'
import type { MascotStageProps } from './MascotStage'
import { expressionCandidates, type MascotExpressionKey, type MascotModel } from './mascotModels'
import { fetchVRM } from './vrmCache'

type Props = MascotStageProps & {
  modelUrl: string
  idleUrl?: string
  /** Per-model tuning — see MascotModel in mascotModels.ts */
  expressions?: MascotModel['expressions']
  outlineFactor?: number
  restPose?: boolean
  fallback: ReactNode
  onError: () => void
}

// Arms-down rest stance for models without an idle clip — without it a VRM0
// model renders its bind pose (the T-pose). Z signs are for a post-rotateVRM0
// normalized rig (adapted from ai-smash's VRMCanvas).
const REST_POSE: Partial<Record<VRMHumanBoneName, [number, number, number]>> = {
  leftUpperArm: [0.12, 0.05, 1.25],
  rightUpperArm: [0.12, -0.05, -1.25],
  leftLowerArm: [0, -0.22, 0.1],
  rightLowerArm: [0, 0.22, -0.1],
}
// Emotions that hold the eyes closed — minimum blink-expression weight.
const EYE_CLOSE: Partial<Record<string, number>> = { thinking: 0.95 }

export default function VRMCanvas(props: Props) {
  const host = useRef<HTMLDivElement>(null)
  const current = useRef(props)
  useEffect(() => { current.current = props }, [props])
  const [ready, setReady] = useState(false)
  const [idlePlaying, setIdlePlaying] = useState(false)

  useEffect(() => {
    const container = host.current
    if (!container) return
    let disposed = false
    let frame = 0
    let renderer: THREE.WebGLRenderer | undefined
    let vrm: VRM | undefined
    let mixer: THREE.AnimationMixer | undefined
    let observer: ResizeObserver | undefined
    let nodStart = -1
    let previousNod = current.current.nodTrigger
    let pointerX = 0, pointerY = 0
    let blinkAt = 2 + Math.random() * 3
    let saccadeAt = 0, saccadeX = 0, saccadeY = 0
    let elapsed = 0, last = 0
    const weights = { happy: 0, relaxed: 0, sad: 0, surprised: 0, aa: 0, blink: 0 }
    let resolved: Record<MascotExpressionKey, string> | undefined // logical key -> registered expression on this model
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(30, 1, .01, 100)
    camera.position.set(0, 1.3, 3.2)
    camera.lookAt(0, 1.2, 0)
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8596a9, .7))
    const addLight = (color: number, intensity: number, x: number, y: number, z: number) => {
      const light = new THREE.DirectionalLight(color, intensity)
      light.position.set(x, y, z); scene.add(light)
    }
    addLight(0xffffff, 1.1, 2, 3, 3)
    addLight(0xcbdfff, .55, -3, 2, 2)
    addLight(0xffffff, .65, 0, 3, -3)
    const resize = () => {
      if (!renderer) return
      const width = Math.max(container.clientWidth, 1), height = Math.max(container.clientHeight, 1)
      renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix()
    }
    const pointer = (event: PointerEvent) => {
      const rect = container.getBoundingClientRect()
      pointerX = THREE.MathUtils.clamp((event.clientX - rect.left - rect.width / 2) / (window.innerWidth / 2), -1, 1)
      pointerY = THREE.MathUtils.clamp((event.clientY - rect.top - rect.height / 2) / (window.innerHeight / 2), -1, 1)
    }
    const lost = (event: Event) => { event.preventDefault(); if (!disposed) current.current.onError() }
    const tick = (now: number) => {
      frame = 0
      if (disposed || document.hidden || !renderer || !vrm) return
      const dt = last ? Math.min((now - last) / 1000, .05) : 0
      last = now; elapsed += dt
      const p = current.current
      if (p.nodTrigger > previousNod) nodStart = elapsed
      previousNod = p.nodTrigger
      const mood = p.emotion
      const target = {
        happy: mood === 'happy' ? .8 : 0,
        relaxed: mood === 'listening' || mood === 'reading' ? .35 : 0,
        sad: mood === 'confused' ? .35 : 0,
        surprised: mood === 'thinking' ? .2 : 0,
        aa: p.isSpeaking ? .12 + .22 * (1 + Math.sin(elapsed * 11)) / 2 : 0,
        blink: Math.max(EYE_CLOSE[mood] ?? 0, elapsed >= blinkAt && elapsed < blinkAt + .16 ? Math.sin(Math.PI * (elapsed - blinkAt) / .16) : 0),
      }
      if (elapsed > blinkAt + .16) blinkAt = elapsed + 2.5 + Math.random() * 3
      const exp = vrm.expressionManager
      for (const key of Object.keys(weights) as (keyof typeof weights)[]) {
        weights[key] = THREE.MathUtils.damp(weights[key], target[key], key === 'blink' ? 35 : 8, dt)
        const name = resolved?.[key]
        if (name) exp?.setValue(name, weights[key])
      }
      if (elapsed > saccadeAt) { saccadeAt = elapsed + 1 + Math.random() * 2; saccadeX = (Math.random() - .5) * .06; saccadeY = (Math.random() - .5) * .04 }
      const lookX = p.lookTargetOffset?.x ?? (p.enablePointerTracking ? pointerX : 0)
      const lookY = p.lookTargetOffset?.y ?? (p.enablePointerTracking ? pointerY : 0)
      const nod = nodStart >= 0 && elapsed - nodStart < .45 ? Math.sin((elapsed - nodStart) / .45 * Math.PI) * .2 : 0
      mixer?.update(dt)
      const head = vrm.humanoid.getNormalizedBoneNode('head')
      if (head) {
        // Normalized-bone forward is -Z (verified on a VRM0 rig via the
        // prototype probe): +rotation.y turns the nose screen-left, +rotation.x
        // tips it up — so cursor directions and look-down poses are negative.
        head.rotation.y = THREE.MathUtils.damp(head.rotation.y, -lookX * .3 + saccadeX, 5, dt)
        head.rotation.x = THREE.MathUtils.damp(head.rotation.x, -lookY * .2 + saccadeY - nod - (mood === 'reading' ? .15 : 0), 5, dt)
      }
      if (vrm.lookAt) {
        vrm.lookAt.yaw = THREE.MathUtils.damp(vrm.lookAt.yaw, -lookX * 10 + saccadeX * 35, 6, dt)
        vrm.lookAt.pitch = THREE.MathUtils.damp(vrm.lookAt.pitch, -lookY * 8 + saccadeY * 35, 6, dt)
      }
      vrm.update(dt)
      renderer.render(scene, camera)
      frame = requestAnimationFrame(tick)
    }
    const visibility = () => {
      if (document.hidden) { cancelAnimationFrame(frame); frame = 0; last = 0 }
      else if (!frame && vrm && !disposed) frame = requestAnimationFrame(tick)
    }
    const start = async () => {
      try {
        renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
        renderer.domElement.addEventListener('webglcontextlost', lost)
        container.appendChild(renderer.domElement)
        observer = new ResizeObserver(resize); observer.observe(container); resize()
        window.addEventListener('pointermove', pointer, { passive: true })
        document.addEventListener('visibilitychange', visibility)
        const buffer = await fetchVRM(props.modelUrl)
        if (disposed) return
        const loader = new GLTFLoader()
        loader.register(parser => new VRMLoaderPlugin(parser))
        const gltf = await loader.parseAsync(buffer, new URL('.', new URL(props.modelUrl, location.href)).href)
        const loaded = gltf.userData.vrm as VRM | undefined
        if (!loaded) { VRMUtils.deepDispose(gltf.scene); throw new Error('Model is not a VRM') }
        if (disposed) { VRMUtils.deepDispose(loaded.scene); return }
        vrm = loaded
        VRMUtils.rotateVRM0(vrm)
        scene.add(vrm.scene)
        // Morph-driven meshes must not be culled against their bind-pose bounds.
        // outlineFactor (per model spec) converts authored world-space MToon
        // outlines to a constant screen-space width.
        const outlineFactor = props.outlineFactor
        vrm.scene.traverse(obj => {
          obj.frustumCulled = false
          if (outlineFactor && (obj as THREE.Mesh).isMesh) {
            const mats = Array.isArray((obj as THREE.Mesh).material) ? (obj as THREE.Mesh).material : [(obj as THREE.Mesh).material]
            for (const m of mats as { isMToonMaterial?: boolean; outlineWidthFactor?: number; outlineWidthMode?: string; needsUpdate?: boolean }[]) {
              if (m?.isMToonMaterial && m.outlineWidthFactor && m.outlineWidthMode !== 'none') {
                m.outlineWidthMode = 'screenCoordinates'; m.outlineWidthFactor = outlineFactor; m.needsUpdate = true
              }
            }
          }
        })
        // Resolve logical emotion keys to names this model actually registers
        // (spec candidates first, then the cross-exporter defaults).
        const candidates = expressionCandidates(props)
        resolved = {} as Record<MascotExpressionKey, string>
        for (const key of Object.keys(candidates) as MascotExpressionKey[]) {
          resolved[key] = candidates[key].find(n => loaded.expressionManager?.expressionMap[n]) ?? candidates[key][0]
        }
        if (vrm.lookAt) vrm.lookAt.autoUpdate = false
        mixer = new THREE.AnimationMixer(vrm.scene)
        setReady(true)
        if (!document.hidden) frame = requestAnimationFrame(tick)
        let idleStarted = false
        if (props.idleUrl) {
          try {
            const clip = await retargetAnimationFromUrl(props.idleUrl, vrm, { logWarnings: false })
            if (disposed) return
            if (clip) {
              const head = vrm.humanoid.getNormalizedBoneNode('head')?.name
              const neck = vrm.humanoid.getNormalizedBoneNode('neck')?.name
              clip.tracks = clip.tracks.filter(track => ![head, neck].some(name => name && track.name.startsWith(`${name}.`)))
              for (const track of clip.tracks) if (track.name.endsWith('.position')) {
                const x = track.values[0], z = track.values[2]
                for (let i = 0; i < track.values.length; i += 3) { track.values[i] = (track.values[i] - x) * .25; track.values[i + 2] = (track.values[i + 2] - z) * .25 }
              }
              if (clip.tracks.length) { mixer.clipAction(clip).play(); idleStarted = true; setIdlePlaying(true) }
            }
          } catch { /* optional idle animation */ }
        }
        // No clip (or clip failed to load) — apply the rest stance so the model
        // doesn't render in bind pose. An active clip drives these bones itself.
        if (!idleStarted && props.restPose !== false) {
          for (const [name, [x, y, z]] of Object.entries(REST_POSE)) {
            vrm.humanoid.getNormalizedBoneNode(name as VRMHumanBoneName)?.rotation.set(x, y, z)
          }
        }
      } catch { if (!disposed) current.current.onError() }
    }
    void start()
    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', pointer)
      document.removeEventListener('visibilitychange', visibility)
      observer?.disconnect()
      mixer?.stopAllAction()
      if (vrm) VRMUtils.deepDispose(vrm.scene)
      if (renderer) { renderer.domElement.removeEventListener('webglcontextlost', lost); renderer.dispose(); renderer.domElement.remove() }
    }
  }, [props.modelUrl, props.idleUrl])

  return <>
    {!ready && props.fallback}
    <figure className="mascot vrm-mascot" data-emotion={props.emotion} data-speaking={props.isSpeaking || undefined} data-nod-trigger={props.nodTrigger} data-idle-playing={idlePlaying || undefined} hidden={!ready} aria-label={`Mita, ${props.emotion}${props.isSpeaking ? ', speaking' : ''}`}>
      <div className="vrm-viewport" ref={host} />
    </figure>
  </>
}

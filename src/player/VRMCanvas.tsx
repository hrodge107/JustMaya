import { useEffect, useRef, useState, type ReactNode } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm'
import { retargetAnimationFromUrl } from 'vrm-mixamo-retarget'
import type { MascotStageProps } from './MascotStage'
import { fetchVRM } from './vrmCache'

type Props = MascotStageProps & { modelUrl: string; idleUrl?: string; fallback: ReactNode; onError: () => void }

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
        blink: elapsed >= blinkAt && elapsed < blinkAt + .16 ? Math.sin(Math.PI * (elapsed - blinkAt) / .16) : 0,
      }
      if (elapsed > blinkAt + .16) blinkAt = elapsed + 2.5 + Math.random() * 3
      const exp = vrm.expressionManager
      for (const key of Object.keys(weights) as (keyof typeof weights)[]) {
        weights[key] = THREE.MathUtils.damp(weights[key], target[key], key === 'blink' ? 35 : 8, dt)
        exp?.setValue(key, weights[key])
      }
      if (elapsed > saccadeAt) { saccadeAt = elapsed + 1 + Math.random() * 2; saccadeX = (Math.random() - .5) * .06; saccadeY = (Math.random() - .5) * .04 }
      const lookX = p.lookTargetOffset?.x ?? (p.enablePointerTracking ? pointerX : 0)
      const lookY = p.lookTargetOffset?.y ?? (p.enablePointerTracking ? pointerY : 0)
      const nod = nodStart >= 0 && elapsed - nodStart < .45 ? Math.sin((elapsed - nodStart) / .45 * Math.PI) * .2 : 0
      mixer?.update(dt)
      const head = vrm.humanoid.getNormalizedBoneNode('head')
      if (head) {
        head.rotation.y = THREE.MathUtils.damp(head.rotation.y, -lookX * .3 + saccadeX, 5, dt)
        head.rotation.x = THREE.MathUtils.damp(head.rotation.x, lookY * .2 + saccadeY + nod + (mood === 'reading' ? .15 : 0), 5, dt)
      }
      if (vrm.lookAt) {
        vrm.lookAt.yaw = THREE.MathUtils.damp(vrm.lookAt.yaw, lookX * 10 + saccadeX * 35, 6, dt)
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
        if (vrm.lookAt) vrm.lookAt.autoUpdate = false
        mixer = new THREE.AnimationMixer(vrm.scene)
        setReady(true)
        if (!document.hidden) frame = requestAnimationFrame(tick)
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
              if (clip.tracks.length) { mixer.clipAction(clip).play(); setIdlePlaying(true) }
            }
          } catch { /* optional idle animation */ }
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

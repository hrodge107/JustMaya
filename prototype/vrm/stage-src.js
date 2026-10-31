// PROTOTYPE — VRM stage source. Throwaway; not part of src/.
// Vanilla port of src/player/VRMCanvas.tsx (the shipped adapter): same camera,
// light rig, expression weights, blink/saccade cadence, gaze, nod, speaking
// mouth. Bundled to stage.js (IIFE -> window.MitaVRM) by rolldown:
//   ./node_modules/.bin/rolldown prototype/vrm/stage-src.js -f iife -n MitaVRM -o prototype/vrm/stage.js -p browser
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'

const { damp, clamp } = THREE.MathUtils

// Logical emotion key -> candidate expression names. This sample (VRM 0.0,
// UniGLTF-1.28) ships presets joy/angry/sorrow/fun plus a custom 'Surprised'
// group exported under the v0 'unknown' preset, so several casings are tried.
const CANDIDATES = {
  happy: ['happy', 'joy', 'Joy'],
  relaxed: ['relaxed', 'fun', 'Fun'],
  sad: ['sad', 'sorrow', 'Sorrow'],
  surprised: ['surprised', 'Surprised', 'unknown'],
  angry: ['angry', 'Angry'],
  aa: ['aa', 'a', 'A'],
  blink: ['blink', 'Blink'],
}

export function mount(container, opts = {}) {
  const props = Object.assign(
    {
      emotion: 'idle',
      isSpeaking: false,
      lookTargetOffset: null,
      enablePointerTracking: true,
      reduced: false,
    },
    opts.props,
  )

  let disposed = false
  let frame = 0
  let renderer, vrm, observer
  let nodStart = -1
  let pointerX = 0, pointerY = 0
  let blinkAt = 2 + Math.random() * 3
  let saccadeAt = 0, saccadeX = 0, saccadeY = 0
  let elapsed = 0, last = 0
  const weights = { happy: 0, relaxed: 0, sad: 0, surprised: 0, aa: 0, blink: 0 }
  const pins = {} // raw expression pins driven by the lab sliders: name -> 0..1
  let resolved = {} // logical key -> registered expression name on this model

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100)
  camera.position.set(0, 1.32, 2.35) // chest-up: the face is what carries states
  camera.lookAt(0, 1.28, 0)
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8596a9, 0.7))
  const addLight = (color, intensity, x, y, z) => {
    const light = new THREE.DirectionalLight(color, intensity)
    light.position.set(x, y, z)
    scene.add(light)
  }
  addLight(0xffffff, 1.1, 2, 3, 3)
  addLight(0xcbdfff, 0.55, -3, 2, 2)
  addLight(0xffffff, 0.65, 0, 3, -3)

  const resize = () => {
    if (!renderer) return
    const width = Math.max(container.clientWidth, 1)
    const height = Math.max(container.clientHeight, 1)
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
  }
  const pointer = (event) => {
    const rect = container.getBoundingClientRect()
    pointerX = clamp((event.clientX - rect.left - rect.width / 2) / (window.innerWidth / 2), -1, 1)
    pointerY = clamp((event.clientY - rect.top - rect.height / 2) / (window.innerHeight / 2), -1, 1)
  }
  const lost = (event) => {
    event.preventDefault()
    if (!disposed) ctl.error(new Error('WebGL context lost'))
  }

  const setWeight = (key, w) => {
    const name = resolved[key]
    if (name && vrm?.expressionManager) vrm.expressionManager.setValue(name, w)
  }
  const tick = (now) => {
    frame = 0
    if (disposed || document.hidden || !renderer || !vrm) return
    const dt = last ? Math.min((now - last) / 1000, 0.05) : 0
    last = now
    elapsed += dt
    const mood = props.emotion
    const speed = props.reduced ? 40 : 8 // near-instant snaps under forced reduce
    const target = {
      happy: mood === 'happy' ? 0.8 : 0,
      relaxed: mood === 'listening' || mood === 'reading' ? 0.35 : 0,
      sad: mood === 'confused' ? 0.35 : 0,
      surprised: mood === 'thinking' ? 0.2 : 0,
      aa: props.isSpeaking ? 0.12 + (0.22 * (1 + Math.sin(elapsed * 11))) / 2 : 0,
      blink: !props.reduced && elapsed >= blinkAt && elapsed < blinkAt + 0.16
        ? Math.sin((Math.PI * (elapsed - blinkAt)) / 0.16)
        : 0,
    }
    if (elapsed > blinkAt + 0.16) blinkAt = elapsed + 2.5 + Math.random() * 3
    for (const key of Object.keys(weights)) {
      weights[key] = damp(weights[key], target[key], key === 'blink' ? 35 : speed, dt)
      setWeight(key, weights[key])
    }
    // Lab sliders: pinned raw expression weights win over the emotion map.
    const exp = vrm.expressionManager
    if (exp) for (const name of Object.keys(pins)) exp.setValue(name, pins[name])

    if (elapsed > saccadeAt) {
      saccadeAt = elapsed + 1 + Math.random() * 2
      saccadeX = (Math.random() - 0.5) * 0.06
      saccadeY = (Math.random() - 0.5) * 0.04
    }
    const lookX = props.lookTargetOffset?.x ?? (props.enablePointerTracking ? pointerX : 0)
    const lookY = props.lookTargetOffset?.y ?? (props.enablePointerTracking ? pointerY : 0)
    const nod = !props.reduced && nodStart >= 0 && elapsed - nodStart < 0.45
      ? Math.sin(((elapsed - nodStart) / 0.45) * Math.PI) * 0.2
      : 0
    const head = vrm.humanoid?.getNormalizedBoneNode('head')
    if (head) {
      head.rotation.y = damp(head.rotation.y, -lookX * 0.3 + saccadeX, speed, dt)
      head.rotation.x = damp(
        head.rotation.x,
        lookY * 0.2 + saccadeY + nod + (mood === 'reading' ? 0.15 : 0),
        speed,
        dt,
      )
    }
    if (vrm.lookAt) {
      vrm.lookAt.yaw = damp(vrm.lookAt.yaw, lookX * 10 + saccadeX * 35, 6, dt)
      vrm.lookAt.pitch = damp(vrm.lookAt.pitch, -lookY * 8 + saccadeY * 35, 6, dt)
    }
    vrm.update(dt)
    renderer.render(scene, camera)
    frame = requestAnimationFrame(tick)
  }
  const visibility = () => {
    if (document.hidden) {
      cancelAnimationFrame(frame)
      frame = 0
      last = 0
    } else if (!frame && vrm && !disposed) frame = requestAnimationFrame(tick)
  }

  const ctl = {
    ready: false,
    setProps(p) {
      Object.assign(props, p || {})
    },
    nod() {
      nodStart = elapsed
    },
    expressions() {
      return vrm?.expressionManager ? Object.keys(vrm.expressionManager.expressionMap) : []
    },
    pin(name, w) {
      if (w == null) delete pins[name]
      else pins[name] = clamp(w, 0, 1)
    },
    clearPins() {
      for (const k of Object.keys(pins)) delete pins[k]
    },
    pins,
    error(err) {
      opts.onError?.(err)
    },
    dispose() {
      cleanup()
    },
  }

  const cleanup = () => {
    disposed = true
    cancelAnimationFrame(frame)
    window.removeEventListener('pointermove', pointer)
    document.removeEventListener('visibilitychange', visibility)
    observer?.disconnect()
    if (vrm) VRMUtils.deepDispose(vrm.scene)
    if (renderer) {
      renderer.domElement.removeEventListener('webglcontextlost', lost)
      renderer.dispose()
      renderer.domElement.remove()
    }
  }

  const start = async () => {
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
      renderer.domElement.addEventListener('webglcontextlost', lost)
      container.appendChild(renderer.domElement)
      observer = new ResizeObserver(resize)
      observer.observe(container)
      resize()
      window.addEventListener('pointermove', pointer, { passive: true })
      document.addEventListener('visibilitychange', visibility)
      const buffer = await opts.getBuffer()
      if (disposed) return
      const loader = new GLTFLoader()
      loader.register((parser) => new VRMLoaderPlugin(parser))
      const gltf = await loader.parseAsync(buffer, '')
      const loaded = gltf.userData.vrm
      if (!loaded) {
        VRMUtils.deepDispose(gltf.scene)
        throw new Error('GLB parses but is not a VRM')
      }
      if (disposed) {
        VRMUtils.deepDispose(loaded.scene)
        return
      }
      vrm = loaded
      VRMUtils.rotateVRM0(vrm)
      scene.add(vrm.scene)
      // Morph-driven meshes must not be culled against their bind-pose bounds.
      vrm.scene.traverse((obj) => { obj.frustumCulled = false })
      // Resting arm stance (adapted from ai-smash's VRMCanvas; Z signs flipped
      // because rotateVRM0 turns the model to face the camera — the reference's
      // unrotated axes would raise the arms here): without an idle clip a VRM0
      // model renders in bind pose — the T-pose.
      const humanoid = vrm.humanoid
      if (humanoid) {
        const bone = (n) => humanoid.getNormalizedBoneNode(n)
        bone('leftUpperArm')?.rotation.set(0.12, 0.05, 1.25)
        bone('rightUpperArm')?.rotation.set(0.12, -0.05, -1.25)
        bone('leftLowerArm')?.rotation.set(0, -0.22, 0.1)
        bone('rightLowerArm')?.rotation.set(0, 0.22, -0.1)
      }
      if (vrm.lookAt) vrm.lookAt.autoUpdate = false
      const names = ctl.expressions()
      resolved = Object.fromEntries(
        Object.keys(CANDIDATES).map((key) => [
          key,
          CANDIDATES[key].find((c) => names.includes(c)) || null,
        ]),
      )
      ctl.ready = true
      opts.onReady?.({
        expressions: names,
        resolved,
        meta: vrm.meta || {},
        spec: vrm.meta?.metaVersion === '0' ? '0.0' : '1.0',
      })
      if (!document.hidden) frame = requestAnimationFrame(tick)
    } catch (err) {
      if (!disposed) ctl.error(err instanceof Error ? err : new Error(String(err)))
    }
  }
  void start()
  return ctl
}

// PROTOTYPE — VRM stage source. Throwaway; not part of src/.
// Vanilla port of src/player/VRMCanvas.tsx (the shipped adapter): same camera,
// light rig, expression weights, blink/saccade cadence, gaze, nod, speaking
// mouth. Bundled to stage.js (IIFE -> window.MitaVRM) by rolldown:
//   ./node_modules/.bin/rolldown prototype/vrm/stage-src.js -f iife -n MitaVRM -o prototype/vrm/stage.js -p browser
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'
import { retargetAnimation } from 'vrm-mixamo-retarget'

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

// Resting stance (adapted from ai-smash's VRMCanvas; Z signs flipped because
// rotateVRM0 turns VRM0 models to face the camera — the reference's unrotated
// axes would raise the arms here). Without an idle clip a VRM0 model renders
// in bind pose — the T-pose.
const REST = {
  leftUpperArm: [0.12, 0.05, 1.25],
  rightUpperArm: [0.12, -0.05, -1.25],
  leftLowerArm: [0, -0.22, 0.1],
  rightLowerArm: [0, 0.22, -0.1],
  leftHand: [0, 0, 0],
  rightHand: [0, 0, 0],
}
// Per-emotion overrides on top of REST: bones -> euler [x,y,z], plus `pitch`
// added to the head's look-down target. Values tuned visually via probe.cjs.
const POSES = {
  thinking: {
    pitch: 0.28, // look down — chin meets the raised right hand
    eyes: 0.95, // eyes closed in thought (drives the blink expression)
    bones: {
      rightUpperArm: [0.6, 0.5, -0.95],
      rightLowerArm: [0, 1.75, 0],
      rightHand: [0.35, 0.1, 0.45],
    },
  },
  reading: {
    pitch: 0.2,
    bones: {
      leftUpperArm: [0.4, -0.4, 1.0],
      leftLowerArm: [0, -1.45, 0],
      leftHand: [0.2, 0, 0.3],
      rightUpperArm: [0.4, 0.4, -1.0],
      rightLowerArm: [0, 1.45, 0],
      rightHand: [0.2, 0, -0.3],
    },
  },
  listening: { pitch: 0.05, bones: {} },
  confused: {
    bones: {
      leftUpperArm: [0.35, -0.2, 1.1],
      leftLowerArm: [0, -1.0, 0.4],
      leftHand: [0.3, 0, 0.3],
    },
  },
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
  let renderer, vrm, observer, mixer
  let nodStart = -1
  let pointerX = 0, pointerY = 0
  let blinkAt = 2 + Math.random() * 3
  let saccadeAt = 0, saccadeX = 0, saccadeY = 0
  let elapsed = 0, last = 0
  const weights = { happy: 0, relaxed: 0, sad: 0, surprised: 0, aa: 0, blink: 0 }
  const pins = {} // raw expression pins driven by the lab sliders: name -> 0..1
  const poseBones = {} // resolved normalized bone nodes: name -> Object3D
  const probe = {} // dev-only live overrides: boneName -> [x,y,z]
  window.__vrmProbe = probe
  let resolved = {} // logical key -> registered expression name on this model

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100)
  let camDist = 2.35, panX = 0, panY = 0 // wheel zoom + drag pan (lab viewport)
  const applyView = () => {
    camera.position.set(panX, 1.32 + panY, camDist)
    camera.lookAt(panX, 1.28 + panY, 0)
  }
  applyView() // chest-up base framing: the face is what carries states
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
  // Viewport interaction: wheel zooms, drag repositions the subject in frame.
  const wheel = (event) => {
    event.preventDefault()
    camDist = clamp(camDist + event.deltaY * 0.0022, 0.7, 6)
    applyView()
  }
  let dragging = false, dragX = 0, dragY = 0
  const dragDown = (event) => { dragging = true; dragX = event.clientX; dragY = event.clientY }
  const dragMove = (event) => {
    if (!dragging) return
    panX = clamp(panX - (event.clientX - dragX) * 0.0016, -1.2, 1.2)
    panY = clamp(panY + (event.clientY - dragY) * 0.0016, -0.8, 0.9)
    dragX = event.clientX; dragY = event.clientY
    applyView()
  }
  const dragUp = () => { dragging = false }

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
      blink: Math.max(
        POSES[mood]?.eyes ?? 0,
        !props.reduced && elapsed >= blinkAt && elapsed < blinkAt + 0.16
          ? Math.sin((Math.PI * (elapsed - blinkAt)) / 0.16)
          : 0,
      ),
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
      // Normalized-bone forward is -Z (verified via probe-gaze.cjs on this VRM0
      // rig): +rotation.y turns the nose screen-LEFT, +rotation.x tips it UP.
      // So cursor directions negate, and "look down" poses are negative x.
      head.rotation.y = damp(head.rotation.y, -lookX * 0.3 + saccadeX, speed, dt)
      head.rotation.x = damp(
        head.rotation.x,
        -lookY * 0.2 + saccadeY - nod - (POSES[mood]?.pitch ?? 0),
        speed,
        dt,
      )
    }
    // Upper-body pose: every managed bone damps toward its emotion override
    // (or the resting stance); __vrmProbe wins for dev iteration.
    const pose = POSES[mood]?.bones || {}
    for (const name of Object.keys(REST)) {
      const bone = poseBones[name]
      if (!bone) continue
      const target = probe[name] || pose[name] || REST[name]
      bone.rotation.x = damp(bone.rotation.x, target[0], speed, dt)
      bone.rotation.y = damp(bone.rotation.y, target[1], speed, dt)
      bone.rotation.z = damp(bone.rotation.z, target[2], speed, dt)
    }
    if (vrm.lookAt) {
      // Same -Z convention: positive yaw/pitch steer the pupils left/up.
      vrm.lookAt.yaw = damp(vrm.lookAt.yaw, -lookX * 10 + saccadeX * 35, 6, dt)
      vrm.lookAt.pitch = damp(vrm.lookAt.pitch, -lookY * 8 + saccadeY * 35, 6, dt)
    }
    // Live gaze trace — surfaced in the lab readout and via __vrmCtl.look.
    const L = ctl.look
    L.x = lookX; L.y = lookY
    if (head) { L.headX = head.rotation.x; L.headY = head.rotation.y }
    if (vrm.lookAt) { L.eyeYaw = vrm.lookAt.yaw; L.eyePitch = vrm.lookAt.pitch }
    mixer?.update(dt) // idle clip writes hips/spine/legs; arms+head stay procedural
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
    idlePlaying: false,
    // live gaze trace for debugging: {x,y} target + applied head/lookAt values
    look: { x: 0, y: 0, headX: 0, headY: 0, eyeYaw: 0, eyePitch: 0 },
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
  window.__vrmCtl = ctl // dev/test hook (setProps, nod, look trace)

  const cleanup = () => {
    disposed = true
    cancelAnimationFrame(frame)
    window.removeEventListener('pointermove', pointer)
    window.removeEventListener('pointermove', dragMove)
    window.removeEventListener('pointerup', dragUp)
    window.removeEventListener('pointercancel', dragUp)
    document.removeEventListener('visibilitychange', visibility)
    observer?.disconnect()
    mixer?.stopAllAction()
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
      renderer.domElement.addEventListener('wheel', wheel, { passive: false })
      renderer.domElement.addEventListener('pointerdown', dragDown)
      window.addEventListener('pointermove', dragMove, { passive: true })
      window.addEventListener('pointerup', dragUp)
      window.addEventListener('pointercancel', dragUp)
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
      // VRoid exports world-space outlines — at this chest-up camera distance
      // they read too thick, so switch to a small screen-space factor instead.
      vrm.scene.traverse((obj) => {
        obj.frustumCulled = false
        if (obj.isMesh || obj.isSkinnedMesh) {
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
          for (const m of mats) {
            if (m?.isMToonMaterial && m.outlineWidthFactor > 0 && m.outlineWidthMode !== 'none') {
              m.outlineWidthMode = 'screenCoordinates'
              m.outlineWidthFactor = 0.004
              m.needsUpdate = true
            }
          }
        }
      })
      // Resting arm stance — see REST for the rationale (without an idle clip a
      // VRM0 model renders in bind pose: the T-pose). Bones resolve once here
      // and are damped toward pose targets each frame.
      const humanoid = vrm.humanoid
      if (humanoid) {
        for (const name of Object.keys(REST)) {
          const bone = humanoid.getNormalizedBoneNode(name)
          if (bone) {
            poseBones[name] = bone
            bone.rotation.set(...REST[name])
          }
        }
      }
      if (vrm.lookAt) vrm.lookAt.autoUpdate = false
      // Optional Mixamo idle clip (same path as the shipped adapter): the
      // retargeted clip drives hips/spine/legs only — head, neck, shoulders,
      // arms and hands are filtered out so the pose table, gaze and nod stay
      // fully procedural and can't be fought by the animation.
      try {
        const animBuf = await opts.getAnimBuffer?.()
        if (animBuf && !disposed) {
          const fbx = new FBXLoader().parse(animBuf, '')
          const clip = retargetAnimation(fbx, vrm, { logWarnings: false })
          if (clip) {
            const drop = ['head', 'neck', 'leftShoulder', 'rightShoulder', ...Object.keys(REST)]
              .map((n) => vrm.humanoid?.getNormalizedBoneNode(n)?.name)
              .filter(Boolean)
            clip.tracks = clip.tracks.filter((t) => !drop.some((n) => t.name.startsWith(`${n}.`)))
            for (const track of clip.tracks) if (track.name.endsWith('.position')) {
              const x = track.values[0], z = track.values[2]
              for (let i = 0; i < track.values.length; i += 3) {
                track.values[i] = (track.values[i] - x) * 0.25
                track.values[i + 2] = (track.values[i + 2] - z) * 0.25
              }
            }
            if (clip.tracks.length) {
              mixer = new THREE.AnimationMixer(vrm.scene)
              mixer.clipAction(clip).play()
              ctl.idlePlaying = true
            }
          }
        }
      } catch { /* optional idle animation */ }
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

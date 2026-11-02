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

// Arms-down rest stance — without it a VRM0 model renders its bind pose
// (the T-pose). Z signs are for a post-rotateVRM0 normalized rig (adapted
// from ai-smash's VRMCanvas). Arms/hands stay procedural: the idle clip's
// matching tracks are filtered so it can never fight these channels.
const REST_POSE: Partial<Record<VRMHumanBoneName, [number, number, number]>> = {
  leftUpperArm: [0.12, 0.05, 1.25],
  rightUpperArm: [0.12, -0.05, -1.25],
  leftLowerArm: [0, -0.22, 0.1],
  rightLowerArm: [0, 0.22, -0.1],
}
// A brief conversational hand raise, blended in and released — bounded,
// never a held pose.
const GESTURE_POSE: Partial<Record<VRMHumanBoneName, [number, number, number]>> = {
  rightUpperArm: [0.55, 0.35, -0.75],
  rightLowerArm: [0, 1.15, 0.15],
  rightHand: [0.25, 0.05, 0.2],
}
const GESTURE_SECONDS = 1.6
const REST_POSE_ENTRIES = Object.entries(REST_POSE) as [VRMHumanBoneName, [number, number, number]][]
// Emotions that hold the eyes closed — minimum blink-expression weight.
const EYE_CLOSE: Partial<Record<string, number>> = { thinking: 0.95 }
const EXPR_KEYS = ['happy', 'relaxed', 'sad', 'surprised', 'aa', 'blink'] as const
// Pointer-follow reach: <1 keeps her mostly front-facing (glance, not crane).
const GAZE_TRACK = 0.65
// ponytail: fixed budgets; add adaptive quality only after device measurements.
const MAX_AVATAR_PIXELS = 1920 * 1080
const MAX_SOFTWARE_PIXELS = 960 * 540

// Verification seam: per-frame state snapshot for browser probes (directional
// gaze, first-pose, lifecycle and perf checks in scripts/verify-vrm.cjs). Read
// only — writes happen inside the render loop and never feed back into it.
type VrmDebug = {
  ready: boolean
  modelParsedAt: number
  preparedAt: number
  firstFrameAt: number
  parallelCompile: boolean
  frames: number
  draws: number
  triangles: number
  geometries: number
  textures: number
  programs: number
  pointerX: number
  pointerY: number
  lookX: number
  lookY: number
  headYaw: number
  headPitch: number
  eyeYaw: number
  eyePitch: number
  /** Face-forward point projected to NDC — direction she looks on screen. */
  faceNdc: [number, number]
  /** Head bone origin projected to NDC. */
  headNdc: [number, number]
  /** Top-center of the model bounds projected to NDC for framing checks. */
  crownNdc: [number, number]
  /** World-space gaze targets applied to the head (radians, yaw then pitch). */
  gazeYaw: number
  gazePitch: number
  /** Camera position — locked at load; probes assert it never drifts. */
  camX: number
  camY: number
  camZ: number
  /** Rendered seconds (dt-clamped sim time) — probes measure deadlines in
   * units of active rendering, matching the spec's "one second of active
   * rendering" language under slow software GL. */
  elapsed: number
  pixelRatio: number
  bufferWidth: number
  bufferHeight: number
  softwareRenderer: boolean
  /** Left upper-arm local Z — ~1.25 resting, ~0 is a bind-pose T-pose. */
  armZ: number
  /** Conversational gesture blend weight, 0..1 (ease in, release). */
  gestureW: number
  /** Test hook: set true to trigger a gesture on the next frame. */
  gestureNow?: boolean
  /** Whether the retargeted idle clip is driving hips/spine/legs. */
  idleOn: boolean
  /** Verification probes set this to hold saccade noise at zero (task 1.4). */
  quiet?: boolean
}
declare global {
  interface Window { __mitaVrm?: VrmDebug }
}

export default function VRMCanvas(props: Props) {
  const host = useRef<HTMLDivElement>(null)
  const current = useRef(props)
  useEffect(() => { current.current = props }, [props])
  const [ready, setReady] = useState(false)
  const [idlePlaying, setIdlePlaying] = useState(false)

  useEffect(() => {
    const container = host.current
    if (!container) return
    const initialProps = current.current
    let disposed = false
    let contextLost = false
    let prepared = false
    let firstFrameDone: (() => void) | undefined
    const stopped = () => disposed || contextLost
    let frame = 0
    let renderer: THREE.WebGLRenderer | undefined
    let softwareRenderer = false
    let vrm: VRM | undefined
    let mixer: THREE.AnimationMixer | undefined
    let observer: ResizeObserver | undefined
    let nodStart = -1
    let previousNod = current.current.nodTrigger
    let pointerX = 0, pointerY = 0
    // Touch tap lifecycle: the pending press position/time and whether it
    // has moved into a scroll. Only a completed tap establishes a glance.
    let tapX = 0, tapY = 0, tapUntil = 0, tapPending = false
    let tapDownX = 0, tapDownY = 0, tapDownAt = 0, tapMoved = false
    let blinkAt = 2 + Math.random() * 3
    let saccadeAt = 0, saccadeX = 0, saccadeY = 0
    let elapsed = 0, last = 0
    let headBone: THREE.Object3D | null | undefined
    let headParent: THREE.Object3D | null | undefined
    const poseBones: Partial<Record<VRMHumanBoneName, THREE.Object3D | null>> = {}
    let chestBone: THREE.Object3D | null | undefined
    let idleClip = false
    let gestureAt = 7 + Math.random() * 8
    let gestureStart = -1
    let gestureW = 0
    const headRestWorld = new THREE.Quaternion()
    const parentWorldQuat = new THREE.Quaternion()
    const targetWorldQuat = new THREE.Quaternion()
    const desiredLocalQuat = new THREE.Quaternion()
    const gazeQuat = new THREE.Quaternion()
    const gazeEuler = new THREE.Euler()
    const debug: VrmDebug = {
      ready: false, modelParsedAt: 0, preparedAt: 0, firstFrameAt: 0, parallelCompile: false,
      frames: 0, draws: 0, triangles: 0,
      geometries: 0, textures: 0, programs: 0,
      pointerX: 0, pointerY: 0, lookX: 0, lookY: 0,
      headYaw: 0, headPitch: 0, eyeYaw: 0, eyePitch: 0,
      faceNdc: [0, 0], headNdc: [0, 0], crownNdc: [0, 0],
      gazeYaw: 0, gazePitch: 0,
      camX: 0, camY: 0, camZ: 0, elapsed: 0,
      pixelRatio: 0, bufferWidth: 0, bufferHeight: 0, softwareRenderer: false,
      armZ: 0, gestureW: 0, idleOn: false,
    }
    window.__mitaVrm = debug
    const probePos = new THREE.Vector3()
    const probeNdc = new THREE.Vector3()
    const probeQuat = new THREE.Quaternion()
    const probeForward = new THREE.Vector3()
    const crownPosition = new THREE.Vector3()
    const weights = { happy: 0, relaxed: 0, sad: 0, surprised: 0, aa: 0, blink: 0 }
    const target = { happy: 0, relaxed: 0, sad: 0, surprised: 0, aa: 0, blink: 0 }
    let resolved: Record<MascotExpressionKey, string> | undefined // logical key -> registered expression on this model
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(30, 1, .01, 100)
    camera.position.set(0, 1.3, 3.2)
    camera.lookAt(0, 1.2, 0)
    // Locked framing is recomputed on load and resize from the model bounds —
    // the upper-body crop (crown ~10% below the canvas top, chest centered)
    // stays fixed no matter how the viewport changes.
    let frameAimY = 0, frameHeight = 0
    const applyFraming = () => {
      if (!frameHeight) return
      // Short screens (landscape phones) get a wider crop so the crown and
      // face keep breathing room instead of filling the frame edge-to-edge.
      const width = Math.max(container.clientWidth, 1), height = Math.max(container.clientHeight, 1)
      // ponytail: interpolate the two supplied portrait/landscape crops; add another point only with a new reference.
      const aspectScale = height < 520 ? 1 : THREE.MathUtils.clamp(1.28 - (width / height - .55) * .33, .88, 1.35)
      const span = frameHeight * .62 * THREE.MathUtils.clamp(520 / height, 1, 1.6) * aspectScale
      camera.position.set(0, frameAimY, span / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov * .5)))
      camera.lookAt(0, frameAimY, 0)
    }
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
      clearInput()
      const width = Math.max(container.clientWidth, 1), height = Math.max(container.clientHeight, 1)
      const pixelBudget = softwareRenderer ? MAX_SOFTWARE_PIXELS : MAX_AVATAR_PIXELS
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1, Math.sqrt(pixelBudget / (width * height))))
      renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix()
      debug.pixelRatio = renderer.getPixelRatio()
      debug.bufferWidth = renderer.domElement.width; debug.bufferHeight = renderer.domElement.height
      applyFraming()
    }
    const track = (event: PointerEvent) => {
      // Touch moves belong to taps/scrolls, not persistent cursor tracking —
      // moving past the slop marks the pending tap as a scroll instead.
      if (event.pointerType === 'touch') {
        if (tapDownAt && Math.hypot(event.clientX - tapDownX, event.clientY - tapDownY) > 12) tapMoved = true
        return
      }
      const rect = container.getBoundingClientRect()
      pointerX = THREE.MathUtils.clamp((event.clientX - rect.left - rect.width / 2) / (rect.width / 2), -1, 1)
      pointerY = THREE.MathUtils.clamp((event.clientY - rect.top - rect.height / 2) / (rect.height / 2), -1, 1)
    }
    // Touch taps glance toward the tapped point for a beat, then release.
    // A glance starts only on a COMPLETED tap — a quick release without
    // scrolling — so long presses, scrolls, and canceled gestures leave
    // no gaze target behind. Control and modal touches stay isolated.
    const tapStart = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') return
      pointerX = 0; pointerY = 0
      tapPending = false; tapUntil = 0
      if ((event.target as Element | null)?.closest?.('button,[role="button"],a,input,select,textarea,label,dialog,[role="dialog"]')) { tapDownAt = 0; return }
      tapDownX = event.clientX; tapDownY = event.clientY; tapDownAt = performance.now(); tapMoved = false
    }
    const tapEnd = (event: PointerEvent) => {
      if (event.pointerType !== 'touch' || !tapDownAt) return
      const quick = performance.now() - tapDownAt <= 500; tapDownAt = 0
      if (!quick || tapMoved) return
      const rect = container.getBoundingClientRect()
      tapX = THREE.MathUtils.clamp((tapDownX - rect.left - rect.width / 2) / (rect.width / 2), -1, 1)
      tapY = THREE.MathUtils.clamp((tapDownY - rect.top - rect.height / 2) / (rect.height / 2), -1, 1)
      // Queue until the next rendered frame so slow software GL cannot miss
      // the whole glance between tap release and the next animation tick.
      tapPending = true
    }
    const tapCancel = (event: PointerEvent) => { if (event.pointerType === 'touch') { pointerX = 0; pointerY = 0; tapDownAt = 0; tapUntil = 0; tapPending = false } }
    const clearInput = () => { pointerX = 0; pointerY = 0; tapUntil = 0; tapPending = false; tapDownAt = 0 }
    // Pointer leaving the document entirely — relatedTarget is null.
    const away = (event: PointerEvent) => { if (event.pointerType !== 'touch' && !event.relatedTarget) clearInput() }
    const lost = (event: Event) => {
      event.preventDefault()
      if (stopped()) return
      contextLost = true
      cancelAnimationFrame(frame); frame = 0
      firstFrameDone?.()
      current.current.onError()
    }
    const tick = (now: number) => {
      frame = 0
      if (stopped() || !prepared || document.hidden || !renderer || !vrm) return
      const wallDt = last ? Math.max((now - last) / 1000, 0) : 0
      const dt = Math.min(wallDt, .05)
      // Gaze follows elapsed time; physics, gestures, and animation keep the 50ms clamp.
      last = now; elapsed += dt
      const p = current.current
      if (p.nodTrigger > previousNod) nodStart = elapsed
      previousNod = p.nodTrigger
      const mood = p.emotion
      target.happy = mood === 'happy' ? .8 : 0
      target.relaxed = mood === 'listening' || mood === 'reading' ? .35 : 0
      target.sad = mood === 'confused' ? .35 : 0
      target.surprised = mood === 'thinking' ? .2 : 0
      target.aa = p.isSpeaking ? .12 + .22 * (1 + Math.sin(elapsed * 11)) / 2 : 0
      target.blink = Math.max(EYE_CLOSE[mood] ?? 0, elapsed >= blinkAt && elapsed < blinkAt + .16 ? Math.sin(Math.PI * (elapsed - blinkAt) / .16) : 0)
      if (elapsed > blinkAt + .16) blinkAt = elapsed + 2.5 + Math.random() * 3
      const exp = vrm.expressionManager
      for (const key of EXPR_KEYS) {
        weights[key] = THREE.MathUtils.damp(weights[key], target[key], key === 'blink' ? 35 : 8, dt)
        const name = resolved?.[key]
        if (name) exp?.setValue(name, weights[key])
      }
      if (elapsed > saccadeAt) { saccadeAt = elapsed + 1 + Math.random() * 2; saccadeX = (Math.random() - .5) * .06; saccadeY = (Math.random() - .5) * .04 }
      // Probe-only noise gate — statically dropped from production builds.
      if (import.meta.env.DEV && debug.quiet) { saccadeX = 0; saccadeY = 0 }
      // Pointer tracking is attenuated: she glances toward the cursor but
      // stays mostly monitor-facing instead of craning to screen corners.
      // Authored lookTargetOffset poses keep their full authored range.
      if (tapPending) { tapPending = false; tapUntil = now + 600 }
      const glance = now < tapUntil
      const lookX = p.lookTargetOffset?.x ?? (p.enablePointerTracking ? (glance ? tapX : pointerX) * GAZE_TRACK : 0)
      const lookY = p.lookTargetOffset?.y ?? (p.enablePointerTracking ? (glance ? tapY : pointerY) * GAZE_TRACK : 0)
      const nod = nodStart >= 0 && elapsed - nodStart < .45 ? Math.sin((elapsed - nodStart) / .45 * Math.PI) * .2 : 0
      mixer?.update(dt)
      const head = headBone
      if (head && headParent) {
        // Servo the head's WORLD orientation: target = bind-pose forward
        // rotated by yaw/pitch, expressed in the parent's space each frame.
        // Verified via lookAt.getLookAtWorldDirection (scripts/vrm-gaze-
        // probe.cjs): +yaw turns the nose screen-right, +pitch tips it down.
        // Working in world space means torso sway from the idle clip can
        // never tilt the gaze — no euler drift bookkeeping to get wrong.
        const yaw = lookX * .3 + saccadeX
        // Reading is a brief deviation (spec): she dips toward the page for
        // ~1.4s, returns to the viewer, and repeats — never a parked gaze.
        const readDip = mood === 'reading' ? Math.max(0, Math.sin((elapsed % 5.5) * Math.PI / 1.4)) * .15 : 0
        const pitch = lookY * .2 + saccadeY + nod + readDip
        gazeEuler.set(pitch, yaw, 0, 'YXZ')
        targetWorldQuat.copy(headRestWorld).multiply(gazeQuat.setFromEuler(gazeEuler))
        headParent.getWorldQuaternion(parentWorldQuat)
        desiredLocalQuat.copy(parentWorldQuat).invert().multiply(targetWorldQuat)
        head.quaternion.slerp(desiredLocalQuat, 1 - Math.exp(-5 * wallDt))
        debug.gazeYaw = yaw; debug.gazePitch = pitch
      }
      // Conversational hand gesture: a brief right-hand rise while she talks
      // or reacts, blended in and released — bounded, never a held pose.
      const gestural = p.isSpeaking || mood === 'talking' || mood === 'happy' || mood === 'listening'
      if (gestureStart < 0 && gestural && (elapsed > gestureAt || (import.meta.env.DEV && debug.gestureNow))) { gestureStart = elapsed; debug.gestureNow = false }
      if (elapsed > gestureAt) gestureAt = elapsed + 7 + Math.random() * 9
      if (gestureStart >= 0 && elapsed - gestureStart >= GESTURE_SECONDS) gestureStart = -1
      gestureW = THREE.MathUtils.damp(gestureW, gestureStart >= 0 ? 1 : 0, 6, dt)
      debug.gestureW = gestureW
      for (const [name, rest] of REST_POSE_ENTRIES) {
        const bone = poseBones[name]
        if (!bone) continue
        const g = GESTURE_POSE[name]
        bone.rotation.x = THREE.MathUtils.damp(bone.rotation.x, rest[0] + (g ? (g[0] - rest[0]) * gestureW : 0), 8, dt)
        bone.rotation.y = THREE.MathUtils.damp(bone.rotation.y, rest[1] + (g ? (g[1] - rest[1]) * gestureW : 0), 8, dt)
        bone.rotation.z = THREE.MathUtils.damp(bone.rotation.z, rest[2] + (g ? (g[2] - rest[2]) * gestureW : 0), 8, dt)
      }
      const hand = poseBones.rightHand, gh = GESTURE_POSE.rightHand
      if (hand && gh) {
        hand.rotation.x = THREE.MathUtils.damp(hand.rotation.x, gh[0] * gestureW, 8, dt)
        hand.rotation.y = THREE.MathUtils.damp(hand.rotation.y, gh[1] * gestureW, 8, dt)
        hand.rotation.z = THREE.MathUtils.damp(hand.rotation.z, gh[2] * gestureW, 8, dt)
      }
      debug.armZ = poseBones.leftUpperArm?.rotation.z ?? 0
      // Breathing is procedural only when the idle clip is absent — the clip
      // owns the chest track when it plays (no duplicate channels).
      if (chestBone && !idleClip) chestBone.rotation.x = THREE.MathUtils.damp(chestBone.rotation.x, .012 + Math.sin(elapsed * 1.5) * .012, 4, dt)
      if (vrm.lookAt) {
        vrm.lookAt.yaw = THREE.MathUtils.damp(vrm.lookAt.yaw, lookX * 10 + saccadeX * 35, 6, wallDt)
        vrm.lookAt.pitch = THREE.MathUtils.damp(vrm.lookAt.pitch, lookY * 8 + saccadeY * 35, 6, wallDt)
      }
      vrm.update(dt)
      try { renderer.render(scene, camera) }
      catch {
        contextLost = true
        firstFrameDone?.()
        current.current.onError()
        return
      }
      if (stopped()) return
      if (!debug.ready) {
        debug.firstFrameAt = performance.now()
        debug.ready = true
        setReady(true)
        firstFrameDone?.(); firstFrameDone = undefined
      }
      debug.frames++
      debug.pointerX = pointerX; debug.pointerY = pointerY
      debug.lookX = lookX; debug.lookY = lookY
      if (head) {
        debug.headYaw = head.rotation.y; debug.headPitch = head.rotation.x
        head.getWorldPosition(probePos)
        probeNdc.copy(probePos).project(camera)
        debug.headNdc[0] = probeNdc.x; debug.headNdc[1] = probeNdc.y
        if (vrm.lookAt) vrm.lookAt.getLookAtWorldDirection(probeForward)
        else probeForward.set(0, 0, 1).applyQuaternion(head.getWorldQuaternion(probeQuat))
        probeNdc.copy(probePos).addScaledVector(probeForward, .2).project(camera)
        debug.faceNdc[0] = probeNdc.x; debug.faceNdc[1] = probeNdc.y
      }
      probeNdc.copy(crownPosition).project(camera)
      debug.crownNdc[0] = probeNdc.x; debug.crownNdc[1] = probeNdc.y
      debug.eyeYaw = vrm.lookAt?.yaw ?? 0
      debug.eyePitch = vrm.lookAt?.pitch ?? 0
      debug.camX = camera.position.x; debug.camY = camera.position.y; debug.camZ = camera.position.z
      debug.draws = renderer.info.render.calls
      debug.triangles = renderer.info.render.triangles
      debug.geometries = renderer.info.memory.geometries
      debug.textures = renderer.info.memory.textures
      debug.programs = renderer.info.programs?.length ?? 0
      debug.elapsed = elapsed
      frame = requestAnimationFrame(tick)
    }
    const visibility = () => {
      clearInput()
      if (document.hidden) { cancelAnimationFrame(frame); frame = 0; last = 0 }
      else if (!frame && prepared && vrm && !stopped()) frame = requestAnimationFrame(tick)
    }
    const start = async () => {
      try {
        setReady(false)
        setIdlePlaying(false)
        renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
        const gl = renderer.getContext()
        debug.parallelCompile = !!gl.getExtension('KHR_parallel_shader_compile')
        const debugInfo = gl.getExtension('WEBGL_debug_renderer_info')
        softwareRenderer = !!debugInfo && /swiftshader|llvmpipe|software/i.test(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL))
        debug.softwareRenderer = softwareRenderer
        renderer.domElement.addEventListener('webglcontextlost', lost)
        container.appendChild(renderer.domElement)
        observer = new ResizeObserver(resize); observer.observe(container); resize()
        window.addEventListener('pointermove', track, { passive: true })
        window.addEventListener('pointerdown', tapStart, { passive: true })
        window.addEventListener('pointerup', tapEnd, { passive: true })
        window.addEventListener('pointercancel', tapCancel, { passive: true })
        document.addEventListener('pointerout', away, { passive: true })
        window.addEventListener('blur', clearInput)
        window.addEventListener('scroll', clearInput, { passive: true, capture: true })
        document.addEventListener('visibilitychange', visibility)
        const buffer = await fetchVRM(initialProps.modelUrl)
        if (stopped()) return
        const loader = new GLTFLoader()
        loader.register(parser => new VRMLoaderPlugin(parser))
        const gltf = await loader.parseAsync(buffer, new URL('.', new URL(initialProps.modelUrl, location.href)).href)
        const loaded = gltf.userData.vrm as VRM | undefined
        if (!loaded) { VRMUtils.deepDispose(gltf.scene); throw new Error('Model is not a VRM') }
        if (stopped()) { VRMUtils.deepDispose(loaded.scene); return }
        vrm = loaded
        debug.modelParsedAt = performance.now()
        VRMUtils.rotateVRM0(vrm)
        scene.add(vrm.scene)
        vrm.scene.updateMatrixWorld(true)
        // Upper-body composition from the reference frames: crown ~10% below
        // the canvas top, chest centered, torso continuing past the bottom
        // edge behind the dialogue. Distance derives from the model's real
        // bounds (native scale), never a hand-tuned offset; applyFraming
        // re-locks it on every resize.
        const bounds = new THREE.Box3().setFromObject(vrm.scene)
        // Culling is disabled below; sorting only needs a conservative sphere.
        // Reuse the posed bounds instead of skinning every vertex a second time.
        vrm.scene.traverse(obj => {
          if ((obj as THREE.SkinnedMesh).isSkinnedMesh) {
            const mesh = obj as THREE.SkinnedMesh
            if (mesh.boundingBox) mesh.boundingSphere = mesh.boundingBox.getBoundingSphere(new THREE.Sphere())
          }
        })
        frameHeight = bounds.max.y - bounds.min.y
        crownPosition.set((bounds.min.x + bounds.max.x) / 2, bounds.max.y, (bounds.min.z + bounds.max.z) / 2)
        frameAimY = bounds.max.y - frameHeight * .26
        applyFraming()
        headBone = vrm.humanoid.getNormalizedBoneNode('head')
        headParent = headBone?.parent
        headBone?.getWorldQuaternion(headRestWorld)
        chestBone = vrm.humanoid.getNormalizedBoneNode('chest')
        // Rest stance lands BEFORE the first visible frame — a VRM0 bind pose
        // is a T-pose and must never flash while the optional idle loads.
        for (const [name, rest] of REST_POSE_ENTRIES) {
          poseBones[name] = vrm.humanoid.getNormalizedBoneNode(name)
          if (initialProps.restPose !== false) poseBones[name]?.rotation.set(...rest)
        }
        poseBones.rightHand = vrm.humanoid.getNormalizedBoneNode('rightHand')
        // Morph-driven meshes must not be culled against their bind-pose bounds.
        // outlineFactor (per model spec) converts authored world-space MToon
        // outlines to a constant screen-space width.
        const outlineFactor = initialProps.outlineFactor
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
        const candidates = expressionCandidates(initialProps)
        resolved = {} as Record<MascotExpressionKey, string>
        for (const key of Object.keys(candidates) as MascotExpressionKey[]) {
          resolved[key] = candidates[key].find(n => loaded.expressionManager?.expressionMap[n]) ?? candidates[key][0]
        }
        if (vrm.lookAt) vrm.lookAt.autoUpdate = false
        mixer = new THREE.AnimationMixer(vrm.scene)
        vrm.update(0)
        const textures = new Set<THREE.Texture>()
        vrm.scene.traverse(obj => {
          if (!(obj as THREE.Mesh).isMesh) return
          const material = (obj as THREE.Mesh).material
          for (const m of Array.isArray(material) ? material : [material]) {
            for (const value of Object.values(m)) if (value?.isTexture) textures.add(value)
            if (m instanceof THREE.ShaderMaterial) {
              for (const uniform of Object.values(m.uniforms)) {
                if (uniform.value?.isTexture) textures.add(uniform.value)
              }
            }
          }
        })
        let batchStart = performance.now()
        for (const texture of textures) {
          if (stopped()) return
          renderer.initTexture(texture)
          if (performance.now() - batchStart >= 8) {
            await new Promise<void>(resolve => setTimeout(resolve, 0))
            if (stopped()) return
            batchStart = performance.now()
          }
        }
        await renderer.compileAsync(scene, camera)
        if (stopped()) return
        // First use also uploads skin/morph buffers and initializes shader uniforms.
        // Warm one mesh at a time behind the hidden figure, including nested meshes.
        const meshes: { mesh: THREE.Mesh; mask: number }[] = []
        vrm.scene.traverseVisible(obj => {
          if ((obj as THREE.Mesh).isMesh && obj.layers.test(camera.layers)) {
            meshes.push({ mesh: obj as THREE.Mesh, mask: obj.layers.mask })
          }
        })
        for (const { mesh } of meshes) mesh.layers.mask = 0
        try {
          for (const { mesh, mask } of meshes) {
            if (stopped()) return
            mesh.layers.mask = mask
            renderer.render(scene, camera)
            mesh.layers.mask = 0
            await new Promise<void>(resolve => setTimeout(resolve, 0))
            if (stopped()) return
          }
        } finally {
          for (const { mesh, mask } of meshes) mesh.layers.mask = mask
        }
        debug.preparedAt = performance.now()
        prepared = true
        await new Promise<void>(resolve => {
          firstFrameDone = resolve
          if (!document.hidden && !frame) frame = requestAnimationFrame(tick)
        })
        if (stopped()) return
        // Optional idle clip: retargeted tracks drive hips/spine/legs only —
        // head, neck, shoulders, arms and hands are filtered out so the gaze
        // servo, rest stance and gestures keep their channels uncontested.
        if (initialProps.idleUrl) {
          const model = vrm
          try {
            const clip = await retargetAnimationFromUrl(initialProps.idleUrl, model, { logWarnings: false })
            if (stopped()) return
            if (clip) {
              const drop = ['head', 'neck', 'leftShoulder', 'rightShoulder', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftHand', 'rightHand']
                .map(n => model.humanoid.getNormalizedBoneNode(n as VRMHumanBoneName)?.name).filter(Boolean)
              clip.tracks = clip.tracks.filter(track => !drop.some(name => track.name.startsWith(`${name}.`)))
              for (const track of clip.tracks) if (track.name.endsWith('.position')) {
                const x = track.values[0], z = track.values[2]
                for (let i = 0; i < track.values.length; i += 3) { track.values[i] = (track.values[i] - x) * .25; track.values[i + 2] = (track.values[i + 2] - z) * .25 }
              }
              // fadeIn blends the clip in over the relaxed first pose instead
              // of snapping — no competing channels.
              if (clip.tracks.length) { mixer.clipAction(clip).reset().fadeIn(.5).play(); idleClip = true; debug.idleOn = true; setIdlePlaying(true) }
            }
          } catch { /* optional idle animation */ }
        }
      } catch { if (!stopped()) current.current.onError() }
    }
    void start()
    return () => {
      disposed = true
      firstFrameDone?.()
      cancelAnimationFrame(frame)
      if (window.__mitaVrm === debug) delete window.__mitaVrm
      window.removeEventListener('pointermove', track)
      window.removeEventListener('pointerdown', tapStart)
      window.removeEventListener('pointerup', tapEnd)
      window.removeEventListener('pointercancel', tapCancel)
      document.removeEventListener('pointerout', away)
      window.removeEventListener('blur', clearInput)
      window.removeEventListener('scroll', clearInput, { capture: true })
      document.removeEventListener('visibilitychange', visibility)
      observer?.disconnect()
      mixer?.stopAllAction()
      if (vrm) VRMUtils.deepDispose(vrm.scene)
      if (renderer) { renderer.domElement.removeEventListener('webglcontextlost', lost); renderer.dispose(); renderer.domElement.remove() }
    }
  }, [props.modelUrl, props.idleUrl])

  return <>
    {!ready && props.fallback}
    <figure className="mascot vrm-mascot" data-emotion={props.emotion} data-speaking={props.isSpeaking || undefined} data-nod-trigger={props.nodTrigger} data-idle-playing={idlePlaying || undefined} style={{ visibility: ready ? 'visible' : 'hidden' }} aria-hidden={!ready} aria-label={`Mita, ${props.emotion}${props.isSpeaking ? ', speaking' : ''}`}>
      <div className="vrm-viewport" ref={host} />
    </figure>
  </>
}

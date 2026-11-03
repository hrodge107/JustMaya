// Mascot model registry — the single place VRM model selection lives.
//
// Three ways to pick a model, highest precedence first:
//   1. VITE_MASCOT_VRM_URL — an explicit URL (any host/path); VITE_MASCOT_IDLE_URL
//      still applies. This is the escape hatch for one-off testing.
//   2. VITE_MASCOT_MODEL — a registry key. Drop the file at
//      vroid_models/<id>.vrm (plus optional <id>-idle.fbx Mixamo clip) and set
//      the env var; no code changes needed. Add a MASCOT_MODELS entry only when
//      the model needs non-convention URLs or per-model tuning.
//   3. Nothing set → DEFAULT_MODEL_ID.
//
// VRM binaries under vroid_models/ are gitignored — models are local/deployed
// assets, not repo payload. They're imported through the glob below (rather
// than a public/ drop zone) so URLs resolve in both dev and bundled builds.

/** Logical expression keys the stage drives per emotion. */
export type MascotExpressionKey = 'happy' | 'relaxed' | 'sad' | 'surprised' | 'aa' | 'blink'

/** Default name candidates per logical key — covers VRM1 presets, common VRM0
 * names, and casings seen across exporters. First match in the model's
 * expressionMap wins; spec `expressions` entries are tried before these. */
export const DEFAULT_EXPRESSIONS: Record<MascotExpressionKey, string[]> = {
  happy: ['happy', 'joy', 'Joy'],
  relaxed: ['relaxed', 'fun', 'Fun'],
  sad: ['sad', 'sorrow', 'Sorrow'],
  surprised: ['surprised', 'Surprised'],
  aa: ['aa', 'a', 'A'],
  blink: ['blink', 'Blink'],
}

export interface MascotModel {
  id: string
  /** GLB/VRM URL — public path, remote URL, or VITE_MASCOT_VRM_URL passthrough */
  url: string
  /** Optional Mixamo FBX idle clip (retargeted via vrm-mixamo-retarget) */
  idleUrl?: string
  /** Per-model name candidates tried BEFORE DEFAULT_EXPRESSIONS — e.g. custom
   * groups like this sample's 'Surprised' (v0 'unknown' preset). */
  expressions?: Partial<Record<MascotExpressionKey, string[]>>
  /** If set, MToon outlines are converted to screen-space at this factor
   * (~0.004 ≈ 1.5px) so thickness stays constant regardless of camera/model
   * scale. Unset keeps the authored (usually world-space) outline. */
  outlineFactor?: number
  /** Apply the arms-down rest stance when no idle clip is playing. Without it
   * a clip-free model renders its bind pose — the T-pose. Default true. */
  restPose?: boolean
  /** Attribution string surfaced for models whose license requires credit. */
  credit?: string
}

/** Files dropped in vroid_models/, filename → served URL. Dev serves them at
 * their root-relative path; build emits hashed assets. Missing files fall back
 * to the root-relative path so dev still picks them up once dropped in. */
const MODEL_ASSETS: Record<string, string> = {}
for (const [path, url] of Object.entries(
  import.meta.glob('../../vroid_models/*.{vrm,fbx}', { eager: true, query: '?url', import: 'default' }),
)) {
  MODEL_ASSETS[path.split('/').pop()!] = url as string
}
const assetUrl = (file: string) => MODEL_ASSETS[file] ?? `/vroid_models/${file}`

/** Registry key used when neither env var is set. */
export const DEFAULT_MODEL_ID = 'meta_chan'

/** Model-specific tuning lives here. Convention-only models (vroid_models/<id>.vrm)
 * do not need an entry. */
export const MASCOT_MODELS: Record<string, MascotModel> = {
  // Default mascot — the VRoid export drops in as vroid_models/meta_chan.vrm.
  meta_chan: {
    id: 'meta_chan',
    url: assetUrl('meta_chan.vrm'),
    idleUrl: MODEL_ASSETS['meta_chan-idle.fbx'],
    outlineFactor: 0.004,
  },
  // The VRoid sample used by the prototype lab (formerly 'sample'). Its custom
  // 'Surprised' group registers under that name (v0 'unknown' is unmapped).
  cyber: {
    id: 'cyber',
    url: assetUrl('cyber.vrm'),
    idleUrl: MODEL_ASSETS['cyber-idle.fbx'],
    expressions: { surprised: ['Surprised'] },
    outlineFactor: 0.004,
    credit: 'VRoid sample — redistribution requires credit; modification is not permitted by its license',
  },
}

/** Resolve which model the stage should load, or null → placeholder. */
export function resolveMascotModel(): MascotModel | null {
  const env = import.meta.env as Record<string, string | undefined>
  const url = env.VITE_MASCOT_VRM_URL?.trim()
  if (url) return { id: 'custom', url, idleUrl: env.VITE_MASCOT_IDLE_URL?.trim() }
  const id = env.VITE_MASCOT_MODEL?.trim() || DEFAULT_MODEL_ID
  return (
    MASCOT_MODELS[id] ?? {
      // Convention fallback: the env var names a file dropped in vroid_models/.
      id,
      url: assetUrl(`${id}.vrm`),
      idleUrl: MODEL_ASSETS[`${id}-idle.fbx`],
    }
  )
}

/** Merge spec candidates ahead of the defaults. */
export function expressionCandidates(spec: Pick<MascotModel, 'expressions'>): Record<MascotExpressionKey, string[]> {
  const out = {} as Record<MascotExpressionKey, string[]>
  for (const key of Object.keys(DEFAULT_EXPRESSIONS) as MascotExpressionKey[]) {
    out[key] = [...(spec.expressions?.[key] ?? []), ...DEFAULT_EXPRESSIONS[key]]
  }
  return out
}

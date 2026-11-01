// Mascot model registry — the single place VRM model selection lives.
//
// Three ways to pick a model, highest precedence first:
//   1. VITE_MASCOT_VRM_URL — an explicit URL (any host/path); VITE_MASCOT_IDLE_URL
//      still applies. This is the escape hatch for one-off testing.
//   2. VITE_MASCOT_MODEL — a registry key. Drop the file at
//      public/mascot/<id>.vrm (plus optional <id>-idle.fbx Mixamo clip) and set
//      the env var; no code changes needed. Add a MASCOT_MODELS entry only when
//      the model needs non-convention URLs or per-model tuning.
//   3. Nothing set → MascotStage renders the placeholder (unchanged contract).
//
// VRM binaries under public/mascot/ are gitignored — models are local/deployed
// assets, not repo payload.

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

/** Model-specific tuning lives here. Convention-only models (public/mascot/<id>.vrm)
 * do not need an entry. */
export const MASCOT_MODELS: Record<string, MascotModel> = {
  // The VRoid sample used by the prototype lab: copy the file to
  // public/mascot/sample.vrm (optionally sample-idle.fbx for the Mixamo idle)
  // and set VITE_MASCOT_MODEL=sample. Its custom 'Surprised' group registers
  // under that name (v0 'unknown' is unmapped).
  sample: {
    id: 'sample',
    url: '/mascot/sample.vrm',
    idleUrl: '/mascot/sample-idle.fbx',
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
  const id = env.VITE_MASCOT_MODEL?.trim()
  if (!id) return null
  return (
    MASCOT_MODELS[id] ?? {
      // Convention fallback: the env var names a file dropped in public/mascot/.
      id,
      url: `/mascot/${id}.vrm`,
      idleUrl: `/mascot/${id}-idle.fbx`,
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

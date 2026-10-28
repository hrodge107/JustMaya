export type Job = { job_id: string; document_id: string; status: string; stage: string | null; execution_state: string | null; error: string | null; can_run: boolean }
export type EpisodeOutline = { episode_id: string; title: string; objective_ids: string[]; status: 'selected' | 'planned_only'; estimated_minutes: number; warnings: string[] }
export type Roadmap = { revision: number; confirmed: boolean; episodes: EpisodeOutline[]; objectives: { id: string; description: string }[]; concepts: { id: string; title: string; uncertainty?: string[] }[]; uncovered_concept_ids: string[]; uncovered_reasons: Record<string, string> }
export type Episode = { title: string; status: string }

export class ApiError extends Error {
  status: number
  code: string
  constructor(message: string, status: number, code = '') { super(message); this.status = status; this.code = code }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const envelope = data?.error
    throw new ApiError(envelope?.message || `Request failed (${response.status})`, response.status, envelope?.code)
  }
  return data as T
}
const id = (value: string) => encodeURIComponent(value)
export const api = {
  upload: (file: File) => { const body = new FormData(); body.append('file', file); return request<{ job_id: string; document_id: string }>('/api/documents', { method: 'POST', body }) },
  job: (job: string) => request<Job>(`/api/jobs/${id(job)}`),
  run: (job: string) => request<Job>(`/api/jobs/${id(job)}/run`, { method: 'POST' }),
  roadmap: (document: string) => request<Roadmap>(`/api/documents/${id(document)}/curriculum`),
  confirm: (document: string, revision: number) => request<Roadmap>(`/api/documents/${id(document)}/curriculum/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expected_revision: revision }) }),
  episode: (episode: string) => request<Episode>(`/api/episodes/${id(episode)}`),
}

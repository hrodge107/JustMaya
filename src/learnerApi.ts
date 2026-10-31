export type Job = { job_id: string; document_id: string; status: string; stage: string | null; execution_state: string | null; error: string | null; can_run: boolean }
export type EpisodeOutline = { episode_id: string; title: string; objective_ids: string[]; status: 'selected' | 'planned_only'; estimated_minutes: number; warnings: string[] }
export type Roadmap = { revision: number; confirmed: boolean; episodes: EpisodeOutline[]; objectives: { id: string; description: string }[]; concepts: { id: string; title: string; uncertainty?: string[] }[]; uncovered_concept_ids: string[]; uncovered_reasons: Record<string, string> }
export type Emotion = 'idle' | 'talking' | 'thinking' | 'happy' | 'confused' | 'listening'
// Refs are typed so the wire shape is honest; the player never renders them.
export type Line = { lineId: string; speaker: 'mascot' | 'narrator'; text: string; emotion: Emotion; sourceRefs?: unknown[]; webRefs?: unknown[] }
// Learner projection: the server strips answer keys and grading feedback.
export type Question = { questionId: string; prompt: string; objectiveId: string; options: { optionId: string; label: string }[] }
export type Checkpoint = { questionId: string; attemptsUsed: number; isCorrect: boolean | null; checkpointCompleted: boolean; selectedOptionId: string | null; feedback: string | null; correctOptionId?: string }
export type AnswerRequest = { questionId: string; optionId: string; request_id: string; expected_version: number }
export type Scene = { sceneId: string; kind: 'dialogue' | 'checkpoint' | 'ending'; dialogue: Line[]; question: Question | null; nextSceneId: string | null }
export type Episode = { episodeId: string; title: string; status: string; startSceneId: string; scenes: Scene[]; learningObjectives: string[]; estimatedMinutes: number }
export type SessionMode = 'playing' | 'checkpoint' | 'question' | 'completed' | 'discussion' | 'error'
// Tutor turns may carry citations; scripted VN dialogue never exposes them.
export type SourceRef = { chunkId: string; documentId: string; pageStart: number; pageEnd: number; sectionId: string | null }
export type HelpMode = 'explain' | 'hint'
export type TutorMove = 'explain' | 'clarify' | 'diagnose' | 'hint' | 'foundation' | 'unsupported' | 'resolved'
export type AwaitingKind = 'none' | 'attempt' | 'reflection' | 'clarification'
// Server-owned dialogue metadata; absent on pre-flow interactions.
export type TutorFlow = { threadId: string; topicQuestion: string; replyToInteractionId: string | null; helpMode: HelpMode; move: TutorMove; hintLevel: number | null; reflection: string | null; awaiting: AwaitingKind }
export type TutorInteraction = { interactionId: string; kind: 'raise_hand' | 'discussion'; userMessage: string; answer: string; lines?: string[]; sourceRefs: SourceRef[]; createdAt: string; groundingStatus: 'supported' | 'partial' | 'unsupported' | null; requestId: string | null; flow?: TutorFlow | null }
export type QuestionBody = { question: string; request_id: string; expected_version: number; help_mode?: HelpMode; reply_to_interaction_id?: string | null; reflection?: string | null }
export type QuestionResponse = { interaction: TutorInteraction; session: Session }
export type Session = { sessionId: string; episodeId: string; mode: SessionMode; sceneId: string; dialogueIndex: number; version: number; status: 'active' | 'completed' | 'abandoned'; updatedAt: string; checkpoint?: Checkpoint | null; resumeSnapshot?: { sceneId: string; dialogueIndex: number; mode: SessionMode } | null; interactions?: TutorInteraction[]; learningNotes?: string[]; tutorThreadId?: string | null; quizAttempts: { questionId: string; selectedOptionId: string; correct: boolean; attemptNumber: number; timestamp: string }[] }

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
  documents: () => request<{ documents: { document_id: string; filename: string; page_count: number; created_at: string }[] }>('/api/documents'),
  job: (job: string) => request<Job>(`/api/jobs/${id(job)}`),
  run: (job: string) => request<Job>(`/api/jobs/${id(job)}/run`, { method: 'POST' }),
  roadmap: (document: string) => request<Roadmap>(`/api/documents/${id(document)}/curriculum`),
  confirm: (document: string, revision: number) => request<Roadmap>(`/api/documents/${id(document)}/curriculum/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expected_revision: revision }) }),
  episode: (episode: string) => request<Episode>(`/api/episodes/${id(episode)}`),
  createSession: (episode: string) => request<Session>(`/api/episodes/${id(episode)}/sessions`, { method: 'POST' }),
  session: (session: string) => request<Session>(`/api/sessions/${id(session)}`),
  advance: (session: string, body: { request_id: string; expected_version: number }) => request<Session>(`/api/sessions/${id(session)}/advance`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  answer: (session: string, body: AnswerRequest) => request<Session>(`/api/sessions/${id(session)}/answers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  raiseHand: (session: string, body: { request_id: string; expected_version: number }) => request<Session>(`/api/sessions/${id(session)}/raise-hand`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  askQuestion: (session: string, body: QuestionBody) => request<QuestionResponse>(`/api/sessions/${id(session)}/questions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  resume: (session: string, body: { request_id: string; expected_version: number }) => request<Session>(`/api/sessions/${id(session)}/resume`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
}

// Compile-time guard: the learner Question and its options must never grow
// grading fields — per-option mistake responses are server-only too.
type _NoAnswerKey = Extract<'correctOptionId' | 'correctExplanation' | 'incorrectExplanation' | 'feedback' | 'mistakeResponse' | 'maxAttempts', keyof Question | keyof Question['options'][number]> extends never ? true : never
export const _learnerProjectionGuard: _NoAnswerKey = true

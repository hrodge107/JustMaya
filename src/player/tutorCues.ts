// Conversational cue copy for raise-hand turns. Frontend-composed and never
// persisted: model answers and session state stay cue-free so downstream
// consumers (question history, episode recap) see plain text.

export const ASK_MORE = [
  'Anything else you want to ask?',
  'What else is on your mind?',
  'Got another one for me?',
  'Anything else bugging you?',
  'Want me to go deeper on any of that?',
]

export const BACK_TO_LESSON = [
  "Okay, let's get back to the lesson.",
  'Right, back to where we left off.',
  'Shall we pick the story back up?',
  'Good question. Ready to keep going?',
]

// Button-fit resume labels. Kept disjoint from BACK_TO_LESSON so the strip
// label and the spoken return beat can never show the same line.
export const STRIP_LABEL = [
  'Back to the lesson.',
  'Continue the lesson.',
  "Let's jump back in.",
]

// Deterministic hash draw: stable per key across re-renders and reloads,
// random-feeling across keys. verify-raise-hand.cjs mirrors these pools.
export function drawCue(key: string, pool: string[]): string {
  let hash = 0
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return pool[hash % pool.length]
}

// The closing beat invites follow-ups on the first answer of a session and
// starts nudging home once the learner has asked more than one question.
export function closingCue(interactionId: string, turnCount: number): string {
  const pool = turnCount <= 1 ? ASK_MORE : [...ASK_MORE, ...BACK_TO_LESSON]
  return drawCue(interactionId, pool)
}

// B03 raise-hand panel: the vn-choice-styled question strip plus the
// Resume Lesson option. Presentation only — the player owns session state.
// Sending is click/tap on the strip (Enter/Space reach it through native
// button semantics on the focused strip); typing Enter in the input does not.
import { useEffect, useRef } from 'react'

export type AskPhase = 'compose' | 'pending' | 'answered'

export default function RaiseHandPanel({ phase, draft, sentQuestion, hasAsked, busy, error, onDraft, onSend, onEdit, onResume }: {
  phase: AskPhase
  draft: string
  sentQuestion: string
  hasAsked: boolean
  busy: boolean
  error: string
  onDraft(text: string): void
  onSend(): void
  onEdit(): void
  onResume(): void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const canSend = phase === 'compose' && !busy && draft.trim().length > 0

  useEffect(() => {
    if (phase === 'compose') inputRef.current?.focus({ preventScroll: true })
  }, [phase])

  // Empty strip clicks focus the input; non-empty strip clicks send.
  function activate(event: { preventDefault(): void }) {
    if (busy) return
    if (canSend) { event.preventDefault(); onSend() }
    else inputRef.current?.focus({ preventScroll: true })
  }

  return <div className="vn-choice-overlay vn-ask-overlay">
    <div className="vn-choices">
      {phase === 'compose' ? (
        <div className="vn-choice vn-ask-strip" role="button" tabIndex={0}
          aria-disabled={busy || undefined}
          aria-label={canSend ? 'Send your question' : 'Type a question, then select this strip to send it'}
          onClick={activate}
          onKeyDown={event => {
            if (event.target !== event.currentTarget) return
            if (event.key === 'Enter' || event.key === ' ') activate(event)
          }}>
          <input ref={inputRef} className="vn-ask-input" value={draft} maxLength={500}
            placeholder="Type your question" aria-label="Your question" disabled={busy}
            onChange={event => onDraft(event.target.value)}
            onClick={event => event.stopPropagation()} />
          {canSend && <span className="vn-ask-send" aria-hidden="true">Send</span>}
        </div>
      ) : (
        <div className="vn-choice vn-ask-strip vn-ask-sent" aria-busy={phase === 'pending' || undefined}>
          <span className="vn-ask-text">{sentQuestion}</span>
          {phase === 'answered' && (
            <button type="button" className="vn-ask-edit" aria-label="Edit this question" disabled={busy} onClick={onEdit}>✎</button>
          )}
        </div>
      )}
      {error && <p className="vn-error" role="alert">{error}</p>}
      {hasAsked && <button type="button" className="vn-choice vn-ask-resume" disabled={busy} onClick={onResume}>Resume Lesson</button>}
    </div>
  </div>
}

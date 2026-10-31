// B03 raise-hand panel: the vn-choice-styled question strip plus the
// Resume Lesson option. Presentation only — the player owns session state.
// Sending is click/tap on the strip (Enter/Space reach it through native
// button semantics on the focused strip); typing Enter in the input does not.
// The Explain/Hint selector and New question control compose the next
// send's help mode, anchor and reflection — they never mutate persisted
// dialogue state until a send succeeds.
import { useEffect, useRef } from 'react'
import type { AwaitingKind, HelpMode } from '../learnerApi'

export type AskPhase = 'compose' | 'pending' | 'answered'

const PLACEHOLDER: Record<AwaitingKind, string> = {
  none: 'Type your question',
  attempt: 'What have you tried so far?',
  reflection: 'What did that tell you?',
  clarification: 'Answer the question above',
}

export default function RaiseHandPanel({ phase, draft, hasAsked, turnComplete, resumeLabel, busy, error, helpMode, anchored, awaiting, onDraft, onSend, onResume, onHelpMode, onNewTopic }: {
  phase: AskPhase
  draft: string
  hasAsked: boolean
  turnComplete: boolean
  resumeLabel: string
  busy: boolean
  error: string
  helpMode: HelpMode
  anchored: boolean
  awaiting: AwaitingKind
  onDraft(text: string): void
  onSend(): void
  onResume(): void
  onHelpMode(mode: HelpMode): void
  onNewTopic(): void
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
      {phase === 'compose' && <>
        <div className="vn-ask-modes" role="group" aria-label="How should the tutor answer?">
          <button type="button" className={`vn-ask-mode${helpMode === 'explain' ? ' on' : ''}`}
            aria-pressed={helpMode === 'explain'} disabled={busy}
            onClick={() => onHelpMode('explain')}>Explain</button>
          <button type="button" className={`vn-ask-mode${helpMode === 'hint' ? ' on' : ''}`}
            aria-pressed={helpMode === 'hint'} disabled={busy}
            onClick={() => onHelpMode('hint')}>Hint</button>
          {anchored && <button type="button" className="vn-ask-mode vn-ask-new" disabled={busy}
            onClick={onNewTopic}>New question</button>}
        </div>
        <div className="vn-choice vn-ask-strip" role="button" tabIndex={0}
          aria-disabled={busy || undefined}
          aria-label={canSend ? (anchored ? 'Send your reply' : 'Send your question') : 'Type a message, then select this strip to send it'}
          onClick={activate}
          onKeyDown={event => {
            if (event.target !== event.currentTarget) return
            if (event.key === 'Enter' || event.key === ' ') activate(event)
          }}>
          <input ref={inputRef} className="vn-ask-input" value={draft} maxLength={500}
            placeholder={PLACEHOLDER[awaiting]} aria-label="Your message" disabled={busy}
            enterKeyHint="done"
            onChange={event => onDraft(event.target.value)}
            onClick={event => event.stopPropagation()} />
          {canSend && <button type="button" className="vn-ask-send"
            aria-label={anchored ? 'Send your reply' : 'Send your question'}
            onClick={event => { event.stopPropagation(); onSend() }}>Send</button>}
        </div>
      </>}
      {error && <p className="vn-error" role="alert">{error}</p>}
      {phase === 'compose' && hasAsked && turnComplete && <button type="button" className="vn-choice vn-ask-resume" disabled={busy} onClick={onResume}>{resumeLabel}</button>}
    </div>
  </div>
}

import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Checkpoint, Question } from '../learnerApi'

type Props = {
  question: Question
  state: Checkpoint | null
  mascot: ReactNode
  pending: boolean
  error: string
  submittedOptionId: string | null
  reloadRequired: boolean
  onAnswer(optionId: string): void
  onContinue(): void
  onReload(): void
}

export default function RecallCheckpoint({ question, state, mascot, pending, error, submittedOptionId, reloadRequired, onAnswer, onContinue, onReload }: Props) {
  const [retriedAttempt, setRetriedAttempt] = useState(-1)
  const firstChoice = useRef<HTMLButtonElement>(null)
  const feedback = useRef<HTMLDivElement>(null)
  const choices = useRef<HTMLDivElement>(null)
  const outcomeId = state?.attemptsUsed ? `${state.questionId}:${state.attemptsUsed}` : ''
  const observedOutcome = useRef(outcomeId)
  const complete = state?.checkpointCompleted ?? false
  const choicesOpen = !complete && (!state?.attemptsUsed || retriedAttempt === state.attemptsUsed)
  const showOutcome = !!state?.attemptsUsed && !choicesOpen && submittedOptionId === null
  useEffect(() => {
    const fresh = outcomeId && outcomeId !== observedOutcome.current
    observedOutcome.current = outcomeId
    if (!fresh || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const selected = choices.current?.querySelector<HTMLElement>('[data-selected]')
    const animation = selected?.animate([
      { transform: 'scale(.985)' },
      { transform: `scale(${state?.isCorrect ? 1.025 : 1.01})`, offset: .5 },
      { transform: 'scale(1)' },
    ], { duration: 320, easing: 'cubic-bezier(.22, .8, .3, 1)' })
    return () => animation?.cancel()
  }, [outcomeId, state?.isCorrect, choicesOpen])
  useEffect(() => {
    if (document.querySelector('.vn-menu-dialog[open]')) return
    if (choicesOpen) firstChoice.current?.focus({ preventScroll: true })
    else feedback.current?.focus({ preventScroll: true })
  }, [choicesOpen])
  const correctLabel = complete ? question.options.find(o => o.optionId === state?.correctOptionId)?.label : null

  return <>
    <section className="vn-scene vn-checkpoint-scene" aria-label="Checkpoint choices">
      <div className="vn-stage">{mascot}</div>
      <div className="vn-choice-overlay">
        <div ref={choices} className="vn-choices" role="group" aria-labelledby="checkpoint-prompt" aria-busy={pending || undefined}>
          {question.options.map((option, index) => <button
            ref={index === 0 ? firstChoice : undefined} type="button" key={option.optionId}
            className="vn-choice" disabled={!choicesOpen || pending || submittedOptionId !== null || reloadRequired}
            data-selected={option.optionId === (submittedOptionId ?? state?.selectedOptionId) || undefined}
            data-correct={showOutcome && (complete && option.optionId === state?.correctOptionId || state?.isCorrect && option.optionId === state.selectedOptionId) || undefined}
            data-incorrect={showOutcome && state?.isCorrect === false && option.optionId === state.selectedOptionId || undefined}
            onClick={() => onAnswer(option.optionId)}>
            <span>{option.label}</span>
            {showOutcome && complete && option.optionId === state?.correctOptionId && <span className="vn-choice-status">Correct answer</span>}
            {showOutcome && state?.isCorrect === false && option.optionId === state.selectedOptionId && <span className="vn-choice-status">Incorrect answer</span>}
          </button>)}
        </div>
      </div>
    </section>
    <section className="vn-dialogue vn-checkpoint-dialogue" aria-label="Checkpoint question and feedback">
      <div className="vn-checkpoint-heading">
        <p className="vn-prompt-label">Checkpoint{state ? ` · ${state.attemptsUsed} of 2 attempts used` : ''}</p>
        <h2 id="checkpoint-prompt">{question.prompt}</h2>
      </div>
      <div className="vn-checkpoint-reading">
        <div ref={feedback} tabIndex={-1} className="vn-feedback" role="status" aria-live="polite" aria-atomic="true">
          {state?.feedback && <><p className="vn-feedback-outcome">{state.isCorrect ? 'Correct.' : complete ? 'Let’s review this one.' : 'Not quite. Here’s a hint.'}</p><p>{state.feedback}</p></>}
          {correctLabel && !state?.isCorrect && <p><strong>Correct answer:</strong> {correctLabel}</p>}
        </div>
        {submittedOptionId && <p className="vn-note">Selected: {question.options.find(o => o.optionId === submittedOptionId)?.label}</p>}
        {error && <p className="vn-error" role="alert">{error}</p>}
      </div>
      <div className="vn-checkpoint-actions">
        {pending && <p className="vn-note" role="status">Saving your progress…</p>}
        {reloadRequired ? <button type="button" className="vn-button" disabled={pending} onClick={onReload}>Reload checkpoint</button>
          : submittedOptionId ? <button type="button" className="vn-button" disabled={pending} onClick={() => onAnswer(submittedOptionId)}>Retry submission</button>
          : complete ? <button type="button" className="vn-button" disabled={pending} onClick={onContinue}>Continue</button>
          : state?.attemptsUsed && !choicesOpen ? <button type="button" className="vn-button" disabled={pending} onClick={() => setRetriedAttempt(state.attemptsUsed)}>Retry</button>
          : <p className="vn-note">Choose an answer above.</p>}
      </div>
    </section>
  </>
}

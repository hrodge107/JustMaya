import { useEffect, useRef } from 'react'
import type { Checkpoint, Question } from '../learnerApi'
import { reducedMotion } from '../motionPreference'

type Props = {
  question: Question
  state: Checkpoint | null
  pending: boolean
  submittedOptionId: string | null
  eliminated: ReadonlySet<string>
  reloadRequired: boolean
  onAnswer(optionId: string): void
}

export default function RecallCheckpoint({ question, state, pending, submittedOptionId, eliminated, reloadRequired, onAnswer }: Props) {
  const firstChoice = useRef<HTMLButtonElement>(null)
  const choices = useRef<HTMLDivElement>(null)
  const outcomeId = state?.attemptsUsed ? `${state.questionId}:${state.attemptsUsed}` : ''
  const observedOutcome = useRef(outcomeId)
  const complete = state?.checkpointCompleted ?? false
  const choicesOpen = !complete
  const showOutcome = !!state?.attemptsUsed && !pending && submittedOptionId === null
  const firstSelectable = question.options.findIndex(o => !eliminated.has(o.optionId))
  useEffect(() => {
    const fresh = outcomeId && outcomeId !== observedOutcome.current
    observedOutcome.current = outcomeId
    if (!fresh || reducedMotion()) return
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
  }, [choicesOpen, outcomeId])

  return <div className="vn-choice-overlay">
    <div ref={choices} className="vn-choices" role="group" aria-label={question.prompt} aria-busy={pending || undefined}>
      {question.options.map((option, index) => {
        const burned = eliminated.has(option.optionId)
        return <button
          ref={index === firstSelectable ? firstChoice : undefined} type="button" key={option.optionId}
          className="vn-choice" disabled={!choicesOpen || burned || pending || submittedOptionId !== null || reloadRequired}
          data-selected={option.optionId === (submittedOptionId ?? state?.selectedOptionId) || undefined}
          data-correct={showOutcome && complete && option.optionId === state?.correctOptionId || undefined}
          data-incorrect={burned || undefined}
          onClick={() => onAnswer(option.optionId)}>
          <span>{option.label}</span>
          {showOutcome && complete && option.optionId === state?.correctOptionId && <span className="vn-choice-status">Correct answer</span>}
          {burned && <span className="vn-choice-status">Incorrect answer</span>}
        </button>
      })}
    </div>
  </div>
}

import type { ReactNode } from 'react'

export type Background = 'bedroom' | 'study' | 'none'

export default function StudyHeader({ background, onBackground, children }: { background: Background; onBackground(): void; children?: ReactNode }) {
  const names = { bedroom: 'Bedroom', study: 'Study center', none: 'None' }
  return <header className={`study-header${children ? ' player-header' : ''}`}>
    <button type="button" className="study-background" onClick={onBackground} aria-label={`Background: ${names[background]}. Change background`} title={`Background: ${names[background]}`}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="8" cy="9" r="1.5" /><path d="m4 18 5-5 3 3 3-4 5 6" /></svg>
    </button>
    <span className="study-brand"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 8c-4-4-8-4-12-3v18c4-1 8-1 12 3m0-18c4-4 8-4 12-3v18c-4-1-8-1-12 3m0-18v18M1.5 8v18c5-1 10-1 14.5 2 4.5-3 9.5-3 14.5-2V8" /></svg><strong>Meet Mita</strong></span>
    {children || <span className="study-tagline">Your AI Study Companion</span>}
  </header>
}

import { useEffect, useState, type ReactNode } from 'react'
import { SpeechController } from './controller'
import { SpeechContext, useSpeech } from './useSpeech'
import './speech.css'

export function SpeechProvider({ children }: { children: ReactNode }) {
  const [controller] = useState(() => new SpeechController())
  useEffect(() => controller.mount(), [controller])
  return <SpeechContext.Provider value={controller}>{children}</SpeechContext.Provider>
}

export function VoiceToggle() {
  const speech = useSpeech()
  return <button type="button" role="switch" aria-checked={speech.enabled} className="vn-motion" onClick={() => speech.controller.setEnabled(!speech.enabled)}>
    <span>Mita’s voice</span><span className="vn-switch" aria-hidden="true"><span className="vn-switch-thumb" /></span>
  </button>
}

export function VoiceStatus() {
  const speech = useSpeech()
  if (!speech.enabled || !['loading', 'blocked', 'error'].includes(speech.status)) return null
  return <aside className="vn-voice-status" aria-label="Mita’s voice">
    <span role="status">{speech.status === 'loading' ? 'Preparing voice…' : speech.status === 'blocked' ? 'Voice needs a tap to play.' : 'Voice unavailable. You can keep reading.'}</span>
    {speech.status !== 'loading' && <button type="button" className="vn-quiet" onClick={speech.controller.retry}>{speech.status === 'blocked' ? 'Play voice' : 'Retry voice'}</button>}
  </aside>
}

import { createContext, useContext, useSyncExternalStore } from 'react'
import type { SpeechController } from './controller'

export const SpeechContext = createContext<SpeechController | null>(null)

export function useSpeechController() {
  const controller = useContext(SpeechContext)
  if (!controller) throw new Error('SpeechProvider is missing')
  return controller
}

export function useSpeech() {
  const controller = useSpeechController()
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  return { controller, ...snapshot }
}

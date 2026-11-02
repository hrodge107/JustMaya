import { api } from '../learnerApi'

type Status = 'off' | 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'blocked' | 'error'
export type SpeechSnapshot = { enabled: boolean; status: Status; turnId: string; paused: boolean }
type Turn = { id: string; text: string; next: string[] }
const key = (text: string) => `af_heart\0${text}`

export class SpeechController {
  private snap: SpeechSnapshot = { enabled: false, status: 'off', turnId: '', paused: false }
  private listeners = new Set<() => void>()
  private current: Turn | null = null
  private cache = new Map<string, string>()
  private failed = new Set<string>()
  private request: { key: string; abort: AbortController } | null = null
  private audio: HTMLAudioElement | null = null
  private externalPause = false
  private hidden = false
  private terminal = false
  private unhealthy = false
  private epoch = 0

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getSnapshot = () => this.snap
  private update(patch: Partial<SpeechSnapshot>) {
    const next = { ...this.snap, ...patch }
    if (next.enabled === this.snap.enabled && next.status === this.snap.status && next.turnId === this.snap.turnId && next.paused === this.snap.paused) return
    this.snap = next
    for (const listener of this.listeners) listener()
  }

  mount() {
    this.audio = new Audio()
    this.audio.preload = 'auto'
    const visibility = () => { this.hidden = document.hidden; this.syncPause() }
    visibility()
    document.addEventListener('visibilitychange', visibility)
    return () => {
      document.removeEventListener('visibilitychange', visibility)
      this.clear()
      this.audio = null
      this.current = null
      this.externalPause = false
      this.update({ enabled: false, status: 'off', turnId: '', paused: false })
    }
  }

  setEnabled(enabled: boolean) {
    this.clear()
    this.unhealthy = false
    this.terminal = false
    this.update({ enabled, status: enabled ? 'idle' : 'off' })
    this.prepare()
  }

  setTurn(id: string, text: string, next: string[] = []) {
    const normalized = text.trim()
    if (this.current?.id !== id || this.current.text !== normalized) {
      this.stopAudio()
      this.terminal = false
      this.current = { id, text: normalized, next: [] }
      this.update({ turnId: id, status: !this.snap.enabled ? 'off' : this.unhealthy ? 'error' : 'idle' })
    }
    this.current.next = next.map(line => line.trim()).filter(Boolean).slice(0, 3)
    this.prepare()
  }

  release(id: string) {
    if (this.current?.id !== id) return
    this.clear()
    this.current = null
    this.terminal = true
    this.setPaused(false)
    this.update({ turnId: '', status: this.snap.enabled ? this.unhealthy ? 'error' : 'idle' : 'off' })
  }

  setPaused(paused: boolean) { this.externalPause = paused; this.syncPause() }
  private syncPause() {
    const paused = this.externalPause || this.hidden
    if (paused) {
      this.audio?.pause()
      this.update({ paused, status: this.snap.status === 'playing' ? 'paused' : this.snap.status })
    } else {
      this.update({ paused })
      this.prepare()
    }
  }

  skip() {
    this.terminal = true
    this.stopAudio()
    if (this.current && this.request?.key === key(this.current.text)) {
      this.request.abort.abort()
      this.request = null
    }
    this.update({ status: this.snap.enabled ? this.unhealthy ? 'error' : 'ended' : 'off' })
  }

  retry = () => {
    this.unhealthy = false
    this.terminal = false
    this.failed.clear()
    this.update({ status: 'idle' })
    // A cached blocked clip is played synchronously from the user's gesture.
    this.prepare()
  }

  isWaiting(id: string) {
    return this.snap.turnId === id && this.snap.enabled && !!this.current?.text && !this.terminal && !this.unhealthy && this.snap.status !== 'blocked'
  }

  waitForDone(id: string): Promise<void> {
    return new Promise(resolve => {
      const check = () => {
        if (this.snap.turnId !== id || !this.isWaiting(id) && !this.snap.paused) { unsubscribe(); resolve() }
      }
      const unsubscribe = this.subscribe(check)
      check()
    })
  }

  private stopAudio() {
    this.epoch++
    if (!this.audio) return
    this.audio.onended = this.audio.onerror = this.audio.onplaying = null
    this.audio.pause()
    this.audio.removeAttribute('src')
    this.audio.load()
  }

  private clear() {
    this.stopAudio()
    this.request?.abort.abort()
    this.request = null
    for (const url of this.cache.values()) URL.revokeObjectURL(url)
    this.cache.clear()
    this.failed.clear()
  }

  private wanted() {
    return this.current?.text ? [this.current.text, ...this.current.next] : []
  }

  private prepare() {
    const wanted = this.wanted()
    const keys = new Set(wanted.map(key))
    const currentKey = key(this.current?.text ?? '')
    if (this.request && (!keys.has(this.request.key) || !this.terminal && !this.cache.has(currentKey) && this.request.key !== currentKey)) {
      this.request.abort.abort(); this.request = null
    }
    for (const [cachedKey, url] of this.cache) {
      if (!keys.has(cachedKey)) { URL.revokeObjectURL(url); this.cache.delete(cachedKey) }
    }
    for (const failedKey of this.failed) if (!keys.has(failedKey)) this.failed.delete(failedKey)
    if (!this.snap.enabled || this.unhealthy || !this.current?.text) return
    if (!this.terminal && this.failed.has(currentKey)) { this.fail(); return }
    if (!this.terminal && this.cache.has(currentKey)) {
      if (this.snap.paused) this.update({ status: 'paused' })
      else this.play(this.cache.get(currentKey)!)
    }
    if (!this.terminal && !this.cache.has(currentKey)) this.update({ status: 'loading' })
    if (this.request || this.snap.paused && (this.terminal || this.cache.has(currentKey))) return
    const text = wanted.find((line, index) => !(this.terminal && index === 0) && !this.cache.has(key(line)) && !this.failed.has(key(line)))
    if (!text) return
    const request = { key: key(text), abort: new AbortController() }
    this.request = request
    void api.speech(text, AbortSignal.any([request.abort.signal, AbortSignal.timeout(30000)]))
      .then(blob => {
        if (request.abort.signal.aborted || this.request !== request) return
        this.cache.set(request.key, URL.createObjectURL(blob))
      })
      .catch(() => {
        if (request.abort.signal.aborted || this.request !== request) return
        this.failed.add(request.key)
      })
      .finally(() => {
        if (this.request !== request) return
        this.request = null
        this.prepare()
      })
  }

  private play(url: string) {
    const audio = this.audio
    if (!audio || this.terminal || this.snap.status === 'blocked' || audio.src === url && !audio.paused) return
    const epoch = this.epoch
    if (audio.src !== url) audio.src = url
    audio.onplaying = () => { if (epoch === this.epoch) this.update({ status: 'playing' }) }
    audio.onended = () => { if (epoch === this.epoch) { this.terminal = true; this.update({ status: 'ended' }) } }
    audio.onerror = () => { if (epoch === this.epoch) this.fail() }
    void audio.play().catch(error => {
      if (epoch !== this.epoch || this.snap.paused) return
      if (error instanceof DOMException && error.name === 'NotAllowedError') this.update({ status: 'blocked' })
      else this.fail()
    })
  }

  private fail() {
    this.unhealthy = true
    this.stopAudio()
    const currentKey = key(this.current?.text ?? '')
    const url = this.cache.get(currentKey)
    if (url) { URL.revokeObjectURL(url); this.cache.delete(currentKey) }
    this.request?.abort.abort()
    this.request = null
    this.update({ status: 'error' })
  }
}

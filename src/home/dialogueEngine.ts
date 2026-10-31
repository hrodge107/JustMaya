// Homepage dialogue engine: a faithful port of the prototype's behavior.
// Mita talks through a small async state machine: typewriter lines, player
// clicks that finish-then-advance, a single auto-advance timeout while a
// line is holding, an ambient loop, the Talk overlay flow, and a rotating
// narration loop keyed to the real upload job's stage. React subscribes to
// a snapshot; the engine never owns DOM or network state.
import { reducedMotion } from '../motionPreference'
import { FALLBACKS, GREETING, IDLE, INTENTS, READ_STEPS, TALK_END, TALK_INTRO, pick, type HomeEmotion, type Turn } from './script'

export const ADVANCE_MS = 10000
export type HomeMode = 'greet' | 'idle' | 'talk' | 'read' | 'modal'

export type HomeSnap = {
  speaker: 'Mita' | 'You'
  /** Full committed line, set once per say() for the aria-live region. */
  line: string
  text: string
  typing: boolean
  cue: boolean
  emotion: HomeEmotion
  speaking: boolean
  dimmed: boolean
  askOpen: boolean
  mode: HomeMode
}

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export default class HomeDialogue {
  private seq = 0
  private snap: HomeSnap = { speaker: 'Mita', line: '', text: '', typing: false, cue: false, emotion: 'idle', speaking: false, dimmed: false, askOpen: false, mode: 'greet' }
  private listeners = new Set<() => void>()
  private typing = false
  private typer: ReturnType<typeof setInterval> | null = null
  private fullText = ''
  private sayResolve: (() => void) | null = null
  private holdRelease: (() => void) | null = null
  private holdSeq = 0
  private misses = 0
  private idleBag: Turn[] = []
  private rotStop: (() => void) | null = null

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  getSnap = () => this.snap

  private set(patch: Partial<HomeSnap>) {
    this.snap = { ...this.snap, ...patch }
    for (const listener of this.listeners) listener()
  }

  dispose() {
    this.seq++
    if (this.typer) clearInterval(this.typer)
    this.typing = false
    this.sayResolve?.()
    this.holdRelease?.()
    this.rotStop?.()
  }

  // The dialogue surface click: while typing, finish the line and release any
  // pending hold so the next beat starts; while holding, advance.
  activate() {
    if (this.typing) { this.finishType(); this.holdRelease?.(); return }
    this.holdRelease?.()
  }

  async start() {
    const t = this.seq
    this.set({ mode: 'greet' })
    for (const line of GREETING) {
      await this.say(line)
      if (t !== this.seq) return
      if (!await this.hold(ADVANCE_MS, t)) return
    }
    if (t !== this.seq) return
    this.set({ mode: 'idle', emotion: 'idle' })
    void this.ambient(t)
  }

  private async ambient(t: number) {
    while (t === this.seq) {
      const line = this.nextIdle()
      await this.say(line)
      if (t !== this.seq) return
      if (!await this.hold(ADVANCE_MS, t)) return
    }
  }

  private nextIdle(): Turn {
    if (!this.idleBag.length) this.idleBag = [...IDLE].sort(() => Math.random() - 0.5)
    return this.idleBag.pop()!
  }

  // --- Talk / Raise-Hand-style overlay ---
  async startTalk() {
    if (this.snap.mode === 'read') return
    this.seq++
    const t = this.seq
    this.misses = 0
    this.set({ mode: 'talk' })
    await this.say(pick(TALK_INTRO), 'listening')
    if (t !== this.seq) return
    this.set({ emotion: 'listening', askOpen: true, dimmed: true })
  }

  // Returns 'send' | 'focus' | 'closed' so Home knows whether to focus the
  // empty input. Mirrors the prototype's strip click semantics.
  askActivate(question: string): 'send' | 'focus' | 'closed' {
    if (this.snap.mode !== 'talk') return 'closed'
    if (!question.trim()) return 'focus'
    void this.sendAsk(question.trim())
    return 'send'
  }

  private async sendAsk(question: string) {
    this.set({ askOpen: false, dimmed: false })
    const t = this.seq
    await this.say(`"${question}"`, 'listening', 'You')
    if (t !== this.seq) return
    await wait(reducedMotion() ? 120 : 500)
    if (t !== this.seq) return
    this.set({ emotion: 'thinking' })
    await wait(reducedMotion() ? 120 : 650)
    if (t !== this.seq) return
    const answer = this.route(question)
    this.set({ mode: 'idle' })
    await this.say(answer, answer.fallback ? 'confused' : 'talking')
    if (t !== this.seq) return
    if (!await this.hold(ADVANCE_MS, t)) return
    this.set({ emotion: 'idle' })
    void this.ambient(this.seq)
  }

  async askNothing() {
    this.set({ askOpen: false, dimmed: false })
    this.seq++
    const t = this.seq
    this.set({ mode: 'idle' })
    await this.say(pick(TALK_END))
    if (t !== this.seq) return
    if (!await this.hold(ADVANCE_MS, t)) return
    this.set({ emotion: 'idle' })
    void this.ambient(this.seq)
  }

  private route(question: string): { t: string; fallback?: boolean } {
    for (const intent of INTENTS) {
      if (intent.re.test(question)) { this.misses = 0; return { t: pick(intent.lines) } }
    }
    this.misses++
    const fallback = FALLBACKS[Math.min(this.misses - 1, FALLBACKS.length - 1)]
    if (this.misses >= FALLBACKS.length) this.misses = 0
    return { t: fallback, fallback: true }
  }

  // --- Modals: pause ambient/talk (never the read narration) ---
  beginModal(): number {
    if (this.snap.mode === 'read') return 0
    this.seq++
    this.set({ mode: 'modal', askOpen: false, dimmed: false })
    return this.seq
  }

  endModal(token: number) {
    if (!token || token !== this.seq) return
    this.set({ mode: 'idle', emotion: 'idle' })
    void this.ambient(this.seq)
  }

  // --- Upload narration: rotator pools keyed to the live job stage ---
  beginRead() {
    this.seq++
    this.misses = 0
    this.set({ mode: 'read', askOpen: false, dimmed: false, emotion: 'reading' })
  }

  readStep(stepIndex: number) {
    const step = READ_STEPS[Math.max(0, Math.min(stepIndex, READ_STEPS.length - 1))]
    this.rotStop?.()
    const t = this.seq
    const bag: string[] = []
    let stopped = false
    this.rotStop = () => { stopped = true }
    const next = () => {
      if (!bag.length) bag.push(...[...step.lines].sort(() => Math.random() - 0.5))
      return bag.pop()!
    }
    void (async () => {
      while (!stopped && t === this.seq) {
        await this.say(next(), 'reading')
        if (stopped || t !== this.seq) return
        await wait(reducedMotion() ? 150 : 700 + Math.random() * 600)
      }
    })()
  }

  async endRead(turns: Turn[]) {
    this.rotStop?.()
    const t = this.seq
    for (const [i, turn] of turns.entries()) {
      await this.say(turn)
      if (t !== this.seq) return
      if (!await this.hold(i < turns.length - 1 ? 1500 + Math.random() * 600 : 2000, t)) return
    }
    this.set({ emotion: 'idle', mode: 'idle' })
    void this.ambient(this.seq)
  }

  async failRead(turn: Turn) {
    this.rotStop?.()
    const t = this.seq
    await this.say(turn)
    if (t !== this.seq) return
    if (!await this.hold(ADVANCE_MS, t)) return
    this.set({ emotion: 'idle', mode: 'idle' })
    void this.ambient(this.seq)
  }

  private finishType() {
    if (!this.typing) return
    if (this.typer) clearInterval(this.typer)
    this.typing = false
    this.typer = null
    this.set({ text: this.fullText, typing: false, speaking: false })
    const resolve = this.sayResolve
    this.sayResolve = null
    resolve?.()
  }

  private say(line: Turn | string, emotion?: HomeEmotion, speaker: 'Mita' | 'You' = 'Mita'): Promise<number> {
    const t = this.seq
    const text = typeof line === 'string' ? line : line.t
    const mood = emotion ?? (typeof line === 'string' ? 'talking' : line.e ?? 'talking')
    this.fullText = text
    this.finishType()
    this.set({ speaker, emotion: mood, cue: false, line: text })
    return new Promise(res => {
      if (reducedMotion()) {
        this.set({ text, typing: false, speaking: false })
        res(t)
        return
      }
      this.typing = true
      this.sayResolve = () => res(t)
      this.set({ text: '', typing: true, speaking: true })
      let i = 0
      this.typer = setInterval(() => {
        if (t !== this.seq) {
          if (this.typer) clearInterval(this.typer)
          this.typing = false
          this.typer = null
          this.sayResolve = null
          this.set({ speaking: false })
          res(t)
          return
        }
        i++
        this.set({ text: text.slice(0, i) })
        if (i >= text.length) this.finishType()
      }, 26)
    })
  }

  private hold(ms: number, t: number): Promise<boolean> {
    const h = ++this.holdSeq
    this.set({ cue: true })
    return new Promise(res => {
      const done = () => {
        if (h === this.holdSeq) { this.set({ cue: false }); this.holdRelease = null }
        res(t === this.seq)
      }
      const timeout = setTimeout(done, ms)
      this.holdRelease = () => { clearTimeout(timeout); done() }
    })
  }
}

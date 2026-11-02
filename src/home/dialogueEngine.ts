// Homepage dialogue engine: a faithful port of the prototype's behavior.
// Mita talks through a small async state machine: typewriter lines, player
// clicks that finish-then-advance, a single auto-advance timeout while a
// line is holding, an ambient loop, the Talk overlay flow, and a rotating
// narration loop keyed to the real upload job's stage. React subscribes to
// a snapshot; the engine never owns DOM or network state.
import { reducedMotion } from '../motionPreference'
import { api } from '../learnerApi'
import type { SpeechController } from '../speech/controller'
import { FALLBACKS, GREETING, IDLE, INTENTS, PLAY_ASK, PLAY_NO_MITA, PLAY_NO_YOU, PLAY_YES_MITA, PLAY_YES_YOU, READ_STEPS, TALK_END, TALK_INTRO, pick, type HomeEmotion, type Turn } from './script'

export const ADVANCE_MS = 10000
export type HomeMode = 'greet' | 'idle' | 'talk' | 'read' | 'modal' | 'offer'

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
  offerOpen: boolean
  mode: HomeMode
}

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export default class HomeDialogue {
  private seq = 0
  private snap: HomeSnap = { speaker: 'Mita', line: '', text: '', typing: false, cue: false, emotion: 'idle', speaking: false, dimmed: false, askOpen: false, offerOpen: false, mode: 'greet' }
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
  private voiceTurn = 0
  private get voiceId() { return `home:${this.voiceTurn}` }

  constructor(speech: SpeechController) { this.speech = speech }
  private speech: SpeechController

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
    this.speech.release(this.voiceId)
  }

  // The dialogue surface click: while typing, finish the line and release any
  // pending hold so the next beat starts; while holding, advance.
  activate() {
    if (this.typing) { this.finishType(); this.holdRelease?.(); return }
    this.speech.skip()
    this.holdRelease?.()
  }

  async start() {
    const t = this.seq
    this.set({ mode: 'greet' })
    for (const [i, line] of GREETING.entries()) {
      await this.say(line, undefined, 'Mita', GREETING.slice(i + 1, i + 4).map(turn => turn.t))
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
    if (this.snap.mode === 'read' || this.snap.mode === 'offer') return
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
    const lines = await this.askMascot(question)
    if (t !== this.seq) return
    this.set({ mode: 'idle' })
    if (lines) {
      // Model answer: each returned line is its own spoken beat.
      for (const [i, line] of lines.entries()) {
        await this.say({ t: line }, undefined, 'Mita', lines.slice(i + 1, i + 4))
        if (t !== this.seq) return
        if (i < lines.length - 1 && !await this.hold(1600, t)) return
      }
    } else {
      // Degraded path: mascot chat unreachable or timed out — the local
      // intent router still answers app questions offline.
      const answer = this.route(question)
      await this.say(answer, answer.fallback ? 'confused' : 'talking')
    }
    if (t !== this.seq) return
    if (!await this.hold(ADVANCE_MS, t)) return
    this.set({ emotion: 'idle' })
    void this.ambient(this.seq)
  }

  // Talk is LLM-first: /api/mascot/chat answers in Mita's voice. Any failure
  // (offline, 404/429/503, slow upstream) returns null and drops to INTENTS.
  private async askMascot(question: string): Promise<string[] | null> {
    try {
      const { interaction } = await api.mascotChat(
        { question, request_id: crypto.randomUUID() },
        AbortSignal.timeout(20000),
      )
      const lines = interaction.lines?.map(line => line.trim()).filter(Boolean)
      return lines?.length ? lines : null
    } catch {
      return null
    }
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

  // --- Modals: pause ambient/talk (never the read narration or a live offer) ---
  beginModal(): number {
    if (this.snap.mode === 'read' || this.snap.mode === 'offer') return 0
    this.seq++
    this.set({ mode: 'modal', askOpen: false, dimmed: false })
    return this.seq
  }

  endModal(token: number) {
    if (!token || token !== this.seq) return
    this.set({ mode: 'idle', emotion: 'idle' })
    if (this.speech.getSnapshot().enabled) {
      // Keep the displayed line when enabling voice in Menu; replacing it
      // here would waste its in-flight synthesis and speak a different line.
      this.speech.setTurn(this.voiceId, this.snap.speaker === 'Mita' ? this.snap.line : '')
      void this.hold(ADVANCE_MS, token).then(current => { if (current) void this.ambient(token) })
      return
    }
    void this.ambient(this.seq)
  }

  // --- Upload narration: rotator pools keyed to the live job stage ---
  beginRead() {
    this.seq++
    this.misses = 0
    this.set({ mode: 'read', askOpen: false, offerOpen: false, dimmed: false, emotion: 'reading' })
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
        if (!await this.hold(reducedMotion() ? 150 : 700 + Math.random() * 600, t)) return
      }
    })()
  }

  // askToPlay keeps the completed episode attached: after the done turns Mita
  // asks whether to play now and the offer overlay holds for a Yes/No instead
  // of sinking back into ambient chatter.
  async endRead(turns: Turn[], askToPlay = false) {
    this.rotStop?.()
    const t = this.seq
    for (const [i, turn] of turns.entries()) {
      await this.say(turn, undefined, 'Mita', turns.slice(i + 1, i + 4).map(line => line.t))
      if (t !== this.seq) return
      if (!await this.hold(i < turns.length - 1 ? 1500 + Math.random() * 600 : 2000, t)) return
    }
    if (askToPlay) {
      this.set({ mode: 'offer', emotion: 'listening' })
      await this.say(pick(PLAY_ASK))
      if (t !== this.seq) return
      this.set({ offerOpen: true, dimmed: true })
      return
    }
    this.set({ emotion: 'idle', mode: 'idle' })
    void this.ambient(this.seq)
  }

  // The offer's Yes branch: a quick You/Mita handoff beat, then ambient. Home
  // mounts the player as soon as this resolves, so ambient rarely gets heard.
  async offerYes() {
    if (this.snap.mode !== 'offer') return
    const t = this.seq
    this.set({ offerOpen: false, dimmed: false })
    await this.say(pick(PLAY_YES_YOU), 'listening', 'You')
    if (t !== this.seq) return
    await wait(reducedMotion() ? 100 : 420)
    if (t !== this.seq) return
    await this.say(pick(PLAY_YES_MITA))
    await this.speech.waitForDone(this.voiceId)
    if (t !== this.seq) return
    this.set({ emotion: 'idle', mode: 'idle' })
    void this.ambient(t)
  }

  // The offer's No branch: the learner's rotating filler, then Mita's "it's
  // fine" plus where the episode waits (the corner card and Learn).
  async offerNo() {
    if (this.snap.mode !== 'offer') return
    const t = this.seq
    this.set({ offerOpen: false, dimmed: false })
    await this.say(pick(PLAY_NO_YOU), 'listening', 'You')
    if (t !== this.seq) return
    await wait(reducedMotion() ? 120 : 500)
    if (t !== this.seq) return
    await this.say(pick(PLAY_NO_MITA))
    if (t !== this.seq) return
    if (!await this.hold(ADVANCE_MS, t)) return
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

  private say(line: Turn | string, emotion?: HomeEmotion, speaker: 'Mita' | 'You' = 'Mita', next: string[] = []): Promise<number> {
    const t = this.seq
    const text = typeof line === 'string' ? line : line.t
    const mood = emotion ?? (typeof line === 'string' ? 'talking' : line.e ?? 'talking')
    this.fullText = text
    this.finishType()
    this.set({ speaker, emotion: mood, cue: false, line: text })
    this.voiceTurn++
    this.speech.setTurn(this.voiceId, speaker === 'Mita' ? text : '', next)
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
      let finished = false
      let remaining = ms
      let started: number | null = null
      let timeout: ReturnType<typeof setTimeout> | undefined
      const stopClock = () => {
        clearTimeout(timeout)
        if (started !== null) remaining = Math.max(0, remaining - (performance.now() - started))
        started = null
      }
      const done = () => {
        if (finished) return
        finished = true
        stopClock()
        unsubscribe()
        if (h === this.holdSeq) { this.set({ cue: false }); this.holdRelease = null }
        res(t === this.seq)
      }
      const sync = () => {
        stopClock()
        if (t !== this.seq || h !== this.holdSeq) { done(); return }
        if (this.speech.getSnapshot().paused) return
        if (remaining <= 0) { if (!this.speech.isWaiting(this.voiceId)) done(); return }
        started = performance.now()
        timeout = setTimeout(() => { stopClock(); sync() }, remaining)
      }
      const unsubscribe = this.speech.subscribe(sync)
      this.holdRelease = done
      sync()
    })
  }
}

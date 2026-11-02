// Native audio/network fakes exercise races without an inference model or browser.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { stripTypeScriptTypes } = require('node:module')
const requests = [], revoked = [], audio = []
global.document = new EventTarget()
document.hidden = false
global.Audio = class {
  src = ''; paused = true; onended = null; onplaying = null; onerror = null
  constructor() { audio.push(this) }
  play() { if (this.blocked) return Promise.reject(new DOMException('gesture', 'NotAllowedError')); this.paused = false; this.onplaying?.(); return Promise.resolve() }
  pause() { this.paused = true }
  removeAttribute() { this.src = '' }
  load() {}
  end() { this.paused = true; this.onended?.() }
}
let url = 0
URL.createObjectURL = () => `blob:fixture-${++url}`
URL.revokeObjectURL = value => revoked.push(value)
const compiled = stripTypeScriptTypes(fs.readFileSync('src/speech/controller.ts', 'utf8')).replace("import { api } from '../learnerApi'", '').replace('export class SpeechController', 'class SpeechController')
const SpeechController = new Function('api', `${compiled}; return SpeechController`)({ speech: (text, signal) => new Promise((resolve, reject) => requests.push({ text, signal, resolve, reject })) })
const tick = () => new Promise(resolve => setImmediate(resolve))
const resolve = async request => { request.resolve(new Blob(['audio'], { type: 'audio/mpeg' })); await tick() }

async function run() {
  const c = new SpeechController(), unmount = c.mount()
  c.setTurn('a', 'A', ['B', 'C', 'D', 'E'])
  assert.equal(requests.length, 0, 'voice is opt-in')
  c.setEnabled(true)
  assert.equal(requests[0].text, 'A', 'current first')
  c.setTurn('a', 'A', ['B', 'C', 'D'])
  assert.equal(requests.length, 1, 'pending dedup')
  await resolve(requests[0]); assert.equal(c.getSnapshot().status, 'playing')
  await resolve(requests[1]); await resolve(requests[2]); await resolve(requests[3])
  assert.deepEqual(requests.map(r => r.text), ['A', 'B', 'C', 'D'], 'three-line lookahead')
  let done = false
  void c.waitForDone('a').then(() => { done = true })
  await tick(); assert.equal(done, false)
  c.setPaused(true); assert.equal(audio[0].paused, true)
  c.setPaused(false); assert.equal(audio[0].paused, false)
  document.hidden = true; document.dispatchEvent(new Event('visibilitychange')); assert.equal(audio[0].paused, true)
  document.hidden = false; document.dispatchEvent(new Event('visibilitychange')); assert.equal(audio[0].paused, false)
  audio[0].end(); await tick(); assert.equal(done, true)
  const before = requests.length
  c.setTurn('b', 'B', ['C', 'D']); assert.equal(requests.length, before, 'prefetched line reused')
  assert.equal(revoked.length, 1, 'old clip released')
  c.skip(); assert.equal(c.isWaiting('b'), false); assert.equal(audio[0].paused, true)
  c.setTurn('you', ''); assert.equal(requests.length, before, 'learner echo is silent')
  c.setTurn('slow', 'Old'); const old = requests.at(-1)
  c.setTurn('new', 'New'); const fresh = requests.at(-1)
  assert.equal(old.signal.aborted, true)
  await resolve(old); assert.equal(audio[0].src, '', 'late stale clip never plays')
  await resolve(fresh); assert.equal(c.getSnapshot().status, 'playing')
  c.setTurn('fail', 'Failure'); requests.at(-1).reject(new Error('offline')); await tick()
  assert.equal(c.getSnapshot().status, 'error'); assert.equal(c.isWaiting('fail'), false)
  c.retry(); await resolve(requests.at(-1)); assert.equal(c.getSnapshot().status, 'playing')
  c.setTurn('blocked', 'Blocked'); audio[0].blocked = true; await resolve(requests.at(-1)); await tick()
  assert.equal(c.getSnapshot().status, 'blocked'); assert.equal(c.isWaiting('blocked'), false)
  audio[0].blocked = false; c.retry(); assert.equal(c.getSnapshot().status, 'playing')
  const corrupt = audio[0].src
  audio[0].onerror(); assert.equal(c.getSnapshot().status, 'error')
  assert.ok(revoked.includes(corrupt), 'decode failures evict the broken clip')
  c.retry(); await resolve(requests.at(-1)); assert.equal(c.getSnapshot().status, 'playing')
  c.setTurn('skipped-pending', 'Skipped pending'); const skipped = requests.at(-1)
  c.skip(); assert.equal(skipped.signal.aborted, true, 'manual skip aborts pending synthesis')
  c.setTurn('priority', 'Priority', ['Later']); await resolve(requests.at(-1))
  const later = requests.at(-1)
  c.setTurn('jump', 'Jump', ['Later'])
  assert.equal(later.signal.aborted, true, 'uncached current supersedes a lookahead request')
  await resolve(requests.at(-1))
  c.setEnabled(false); assert.equal(c.getSnapshot().status, 'off'); assert.equal(audio[0].src, '')
  assert.equal(revoked.length, url, 'all created URLs revoked on mute')
  c.setEnabled(true); const pending = requests.at(-1)
  unmount(); assert.equal(pending.signal.aborted, true)
  await resolve(pending); assert.equal(revoked.length, url, 'no URL created after teardown')
  console.log('PASS speech: opt-in, current-first, lookahead, dedup, reuse/eviction, timing, pause/visibility, skip, silent echo, stale response, failure/retry, autoplay block, mute and teardown')
}
run().catch(error => { console.error(error); process.exitCode = 1 })

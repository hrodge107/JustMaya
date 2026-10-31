// Throwaway: scene card and encountered-notes Gallery. ENERGY 2 / RHYTHM 1 / MOTION 2.
/* oxlint-disable react/only-export-components -- Standalone HTML entry owns its root. */
import { useLayoutEffect, useRef, useState, type SyntheticEvent } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/nunito'
import '../index.css'
import './player.css'
import './picture-note-prototype.css'
import MascotStage from './MascotStage'
import { useReducedMotion } from '../motionPreference'
import type { PictureCard } from '../learnerApi'
import riversImage from './picture-note-prototype-page-2.png'
import surplusImage from './picture-note-prototype-page-3.png'

const params = new URLSearchParams(location.search)
const notes: PictureCard[] = [
  { title: 'Why rivers mattered', description: 'Each year, floods spread a thin layer of silt across the surrounding plain. That silt was rich in minerals washed down from distant mountains, so fields near a river stayed fertile season after season.', sourceRefs: [{ chunkId: 'prototype-page-2', documentId: 'sample-chapter', pageStart: 2, pageEnd: 2, sectionId: '1.1' }], image: { imageUrl: riversImage, filePageUrl: '/sample-chapter.pdf#page=2', title: 'Sample chapter, page 2', author: '', license: '', licenseUrl: '', changes: 'Page rendered as a sample image.' } },
  { title: 'From surplus to specialists', description: 'When the same farmer grows more than the household needs, the extra grain frees other people to specialize. Specialization is the deep root of cities: it produces crafts, trade, taxes, armies, and writing.', sourceRefs: [{ chunkId: 'prototype-page-3', documentId: 'sample-chapter', pageStart: 3, pageEnd: 3, sectionId: '1.2' }], image: { imageUrl: surplusImage, filePageUrl: '/sample-chapter.pdf#page=3', title: 'Sample chapter, page 3', author: '', license: '', licenseUrl: '', changes: 'Page rendered as a sample image.' } },
]
const lines = [
  'Let’s follow how rivers helped settlements grow. Picture notes will collect in your Gallery as we encounter them.',
  'Rivers gave early settlements more than water. Their floods left behind fertile silt, helping people grow food in the same place year after year.',
  'Extra grain meant some people could take up other work. These specialists helped settlements become cities.',
]
type View = 'gallery' | 'detail' | 'menu'

function NoteImage({ card }: { card: PictureCard }) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const simulation = params.get('images')
  return <div className="pn-image">
    {status !== 'ready' && <span role="status">{status === 'error' ? 'Image unavailable' : 'Loading image…'}</span>}
    <img width="612" height="792" src={simulation === 'broken' ? 'data:image/png;base64,invalid' : card.image.imageUrl} alt={`Sample image: ${card.image.title}`} hidden={status !== 'ready'} onLoad={() => { if (simulation !== 'loading') setStatus('ready') }} onError={() => setStatus('error')} />
  </div>
}

function Prototype() {
  useReducedMotion()
  const [scene, setScene] = useState(0)
  const [encountered, setEncountered] = useState<number[]>([])
  const [dismissed, setDismissed] = useState<number[]>([])
  const [view, setView] = useState<View | null>(null)
  const [selected, setSelected] = useState(0)
  const [fromGallery, setFromGallery] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const galleryTrigger = useRef<HTMLButtonElement>(null)
  const galleryScroll = useRef(0)
  const galleryReturn = useRef(false)
  const card = scene > 0 ? notes[scene - 1] : null

  useLayoutEffect(() => {
    if (!view) return
    const element = dialog.current!
    if (!element.open) element.showModal()
    if (galleryReturn.current && view === 'gallery') {
      element.querySelector<HTMLElement>(`[data-note="${selected}"]`)?.focus({ preventScroll: true })
      element.scrollTop = galleryScroll.current
      galleryReturn.current = false
    } else {
      element.scrollTop = 0
      element.querySelector<HTMLElement>('[data-initial-focus]')?.focus()
    }
  }, [view, selected])

  function go(next: number) {
    if (view) return
    setScene(next)
    if (next > 0) setEncountered(current => current.includes(next - 1) ? current : [...current, next - 1])
  }
  function open(next: View, event: SyntheticEvent<HTMLElement>) {
    opener.current = event.currentTarget
    setFromGallery(false)
    if (next === 'detail') setSelected(scene - 1)
    setView(next)
  }
  function reset() {
    dialog.current?.close()
    setScene(0); setEncountered([]); setDismissed([])
  }
  function close() { dialog.current?.close() }
  function onClose() {
    setView(null)
    const target = opener.current?.isConnected ? opener.current : galleryTrigger.current
    target?.focus({ preventScroll: true })
  }
  const note = notes[selected]
  return <main className="player pn-prototype">
    <div className="vn-frame mode-playing">
      <header className="player-header">
        <span className="brand">Meet Mita</span><h1 className="player-title">From Rivers to Settled Farming and Early Government</h1>
        <div className="vn-progress"><span>Scene {scene + 1} of {lines.length}</span><ol aria-hidden="true">{lines.map((_, i) => <li key={i} className={i < scene ? 'done' : i === scene ? 'current' : ''} />)}</ol></div>
      </header>
      <section className="vn-scene" aria-label="Scene"><div className="vn-stage">
        <MascotStage emotion={scene ? 'talking' : 'idle'} isSpeaking={false} nodTrigger={0} customAnimationTrigger={null} lookTargetOffset={null} enablePointerTracking={!view} />
        {card && !dismissed.includes(scene - 1) && <aside className="pn-scene-card" aria-label={`Picture note: ${card.title}`}>
          <button type="button" className="pn-front" onClick={event => open('detail', event)} aria-haspopup="dialog"><NoteImage key={scene} card={card} /><span>{card.title}</span></button>
          <button type="button" className="vn-quiet pn-dismiss" aria-label={`Dismiss ${card.title}`} onClick={() => { setDismissed(current => [...current, scene - 1]); galleryTrigger.current?.focus() }}>×</button>
        </aside>}
      </div></section>
      <section className="vn-dialogue" aria-label="Dialogue">
        <button type="button" className="vn-dialogue-target" aria-label={scene === 2 ? 'Return to the first sample scene' : 'Advance sample dialogue'} onClick={() => go((scene + 1) % lines.length)}>
          <span className="vn-dialogue-scroll-area"><span className="vn-speaker">Mita</span><span className="vn-text">{lines[scene]}</span></span><span className="vn-advance-cue" aria-hidden="true">▾</span>
        </button>
      </section>
      <div className="vn-menu-rail">
        <button ref={galleryTrigger} type="button" className="vn-menu-trigger" aria-haspopup="dialog" onClick={event => open('gallery', event)}>Gallery</button>
        <button type="button" className="vn-menu-trigger" aria-haspopup="dialog" onClick={event => open('menu', event)}><span className="vn-menu-icon" aria-hidden="true"><span /><span /><span /></span>Menu</button>
      </div>
    </div>
    <dialog ref={dialog} className={`vn-menu-dialog pn-dialog ${view === 'menu' ? 'pn-menu' : ''}`} aria-labelledby="pn-title" onClose={onClose} onKeyDown={event => {
      if (event.key !== 'Tab') return
      const targets = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]')]
      const first = targets[0], last = targets.at(-1)
      if (event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last) { event.preventDefault(); (event.shiftKey ? last : first)?.focus() }
    }}>
      <div className="vn-menu-heading"><h2 id="pn-title">{view === 'menu' ? 'Menu' : view === 'gallery' ? 'Gallery' : note.title}</h2><button type="button" className="vn-quiet" data-initial-focus onClick={close}>Close</button></div>
      {view === 'gallery' && (encountered.length ? <div className="pn-grid">{encountered.map(index => <button type="button" className="pn-front" data-note={index} key={index} aria-label={`Open ${notes[index].title}`} onClick={() => { galleryScroll.current = dialog.current!.scrollTop; setSelected(index); setFromGallery(true); setView('detail') }}><NoteImage card={notes[index]} /><span>{notes[index].title}</span></button>)}</div> : <div className="pn-empty"><p>No picture notes yet.</p><p>Notes collect here as you reach them in the lesson.</p><button type="button" className="vn-button" onClick={close}>Return to lesson</button></div>)}
      {view === 'detail' && <article className="pn-detail">
        {fromGallery && <button type="button" className="vn-quiet pn-back" onClick={() => { galleryReturn.current = true; setView('gallery') }}>Back to Gallery</button>}
        <NoteImage key={selected} card={note} />
        <h3>Description</h3><p>{params.has('long') ? Array(12).fill(note.description).join(' ') : note.description}</p>
        <h3>PDF citations</h3><p>{note.sourceRefs.map(ref => <a key={ref.chunkId} href={`/sample-chapter.pdf#page=${ref.pageStart}`} target="_blank" rel="noreferrer">Sample chapter · Page {ref.pageStart}{ref.pageEnd !== ref.pageStart ? `–${ref.pageEnd}` : ''}</a>)}</p>
        <h3>Image credit</h3><p>Sample image: a rendered page from the bundled chapter. This stands in for a sourced illustration in this prototype.</p><a href={note.image.filePageUrl} target="_blank" rel="noreferrer">{note.image.title}</a>
      </article>}
      {view === 'menu' && <><p>Picture notes prototype. Sample scenes and Gallery are held in memory.</p><button type="button" className="vn-button vn-menu-leave" onClick={reset}>Reset demo</button></>}
    </dialog>
    <footer className="pn-demo"><span>Prototype · sample chapter</span><div><button type="button" className="vn-quiet" disabled={scene === 0 || !!view} onClick={() => go(scene - 1)}>Previous scene</button><button type="button" className="vn-quiet" disabled={scene === 2 || !!view} onClick={() => go(scene + 1)}>Next scene</button></div><p role="status">Scene {scene + 1} · {encountered.length} collected · {dismissed.length} dismissed{view ? ` · ${view} open` : ''}</p></footer>
  </main>
}

createRoot(document.getElementById('root')!).render(<Prototype />)

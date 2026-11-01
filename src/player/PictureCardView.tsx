import { useState, type RefObject } from 'react'
import type { PictureCard } from '../learnerApi'

export type EncounteredPictureNote = { key: string; sceneId: string; card: PictureCard }
export type PictureNoteView = 'gallery' | 'detail' | null

function PictureNoteImage({ card, className, decorative = false }: { card: PictureCard; className?: string; decorative?: boolean }) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  return <span className={`vn-picture-image${className ? ` ${className}` : ''}`}>
    {status !== 'ready' && <span className="vn-picture-unavailable" role="status">{status === 'error' ? 'Image unavailable' : 'Loading image…'}</span>}
    {status !== 'error' && <img width="320" height="200" loading="lazy" src={card.image.imageUrl} alt={decorative ? '' : (card.image.alt || card.title)} onLoad={() => setStatus('ready')} onError={() => setStatus('error')} />}
  </span>
}

export function PictureCardView({ note, onOpen, onDismiss }: { note: EncounteredPictureNote; onOpen(trigger: HTMLButtonElement): void; onDismiss(): void }) {
  return <aside className="vn-picture" aria-label={`Picture note: ${note.card.title}`}>
    <button type="button" className="vn-picture-front" aria-haspopup="dialog" onClick={event => onOpen(event.currentTarget)}>
      <PictureNoteImage card={note.card} decorative />
      <span className="vn-picture-title">{note.card.title}</span>
    </button>
    <button type="button" className="vn-quiet vn-picture-dismiss" aria-label={`Dismiss ${note.card.title}`} onClick={onDismiss}>×</button>
  </aside>
}

export function GalleryButton({ buttonRef, onOpen }: { buttonRef: RefObject<HTMLButtonElement | null>; onOpen(trigger: HTMLButtonElement): void }) {
  return <button ref={buttonRef} type="button" className="vn-menu-trigger vn-gallery-trigger" aria-label="Gallery" title="Gallery" aria-haspopup="dialog" onClick={event => onOpen(event.currentTarget)}>
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M6.5 3.75h8l4 4v12.5h-12z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M14.5 3.75v4h4m-9 4h6m-6 3.5h6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  </button>
}

export function PictureNotesDialog({ dialogRef, title, view, notes, selected, fromGallery, onClose, onSelect, onBack, closeRef, returnTargetRef, galleryScrollRef }: {
  dialogRef: RefObject<HTMLDialogElement | null>
  title: string
  view: PictureNoteView
  notes: EncounteredPictureNote[]
  selected: EncounteredPictureNote | null
  fromGallery: boolean
  onClose(): void
  onSelect(note: EncounteredPictureNote, trigger: HTMLButtonElement): void
  onBack(): void
  closeRef: RefObject<HTMLButtonElement | null>
  returnTargetRef: RefObject<HTMLButtonElement | null>
  galleryScrollRef: RefObject<HTMLDivElement | null>
}) {
  return <dialog ref={dialogRef} className="vn-menu-dialog vn-picture-dialog" aria-labelledby="picture-dialog-title" onClose={onClose} onKeyDown={event => {
    if (event.key !== 'Tab') return
    const buttons = event.currentTarget.querySelectorAll('button')
    const first = buttons[0], last = buttons[buttons.length - 1]
    if (event.shiftKey ? document.activeElement === first : document.activeElement === last) {
      event.preventDefault()
      ;(event.shiftKey ? last : first).focus()
    }
  }}>
    <div className="vn-menu-heading"><h2 id="picture-dialog-title">{view === 'gallery' ? 'Gallery' : title}</h2><button ref={closeRef} type="button" className="vn-quiet" onClick={() => dialogRef.current?.close()}>Close</button></div>
    {view === 'gallery' && <div ref={galleryScrollRef} className="vn-picture-gallery">
      {notes.length ? <div className="vn-picture-grid">{notes.map(note => <button ref={note.key === selected?.key ? returnTargetRef : null} type="button" className="vn-picture-front" key={note.key} aria-haspopup="dialog" aria-label={`Open ${note.card.title}`} onClick={event => onSelect(note, event.currentTarget)}>
        <PictureNoteImage card={note.card} decorative /><span className="vn-picture-title">{note.card.title}</span>
      </button>)}</div> : <div className="vn-picture-empty"><p>No picture notes yet.</p><p>Notes collect here as you reach them in the lesson.</p></div>}
    </div>}
    {view === 'detail' && selected && <div className="vn-picture-detail-page">
      {fromGallery && <button type="button" className="vn-quiet vn-picture-back" onClick={onBack}>Back to Gallery</button>}
      <PictureNoteImage card={selected.card} className="vn-picture-detail-image" />
      <h3>Description</h3><p>{selected.card.description}</p>
      <h3>Source citations</h3><ul>{[...new Set(selected.card.sourceRefs.map(ref => `${ref.pageStart}:${ref.pageEnd}`))].map(range => {
        const [start, end] = range.split(':')
        return <li key={range}><span>Page {start}{start !== end ? `–${end}` : ''}</span></li>
      })}</ul>
      <h3>Image credit</h3><p>{selected.card.image.credit}</p>
    </div>}
  </dialog>
}

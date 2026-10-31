import { useState } from 'react'
import type { PictureCard } from '../learnerApi'

export function PictureCardView({ card }: { card: PictureCard }) {
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState(false)
  if (failed) return null
  const pages = [...new Set(card.sourceRefs.map(ref => ref.pageStart === ref.pageEnd ? `${ref.pageStart}` : `${ref.pageStart}–${ref.pageEnd}`))]
  return <aside className="vn-picture" aria-label={`Picture: ${card.title}`}>
    <img src={card.image.imageUrl} alt={`Image of ${card.title}`} onError={() => setFailed(true)} />
    <button type="button" className="vn-quiet" aria-expanded={open} onClick={() => setOpen(!open)}>{card.title} {open ? '−' : '+'}</button>
    {open && <div className="vn-picture-detail"><p>{card.description}</p><p>PDF: {pages.map(page => `Page ${page}`).join(', ')}</p></div>}
    <p className="vn-picture-credit">Image: <a href={card.image.filePageUrl} target="_blank" rel="noreferrer">{card.image.title}</a> by {card.image.author}, <a href={card.image.licenseUrl} target="_blank" rel="noreferrer">{card.image.license}</a>. {card.image.changes === 'None' ? 'No changes.' : card.image.changes}</p>
  </aside>
}

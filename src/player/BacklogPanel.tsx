import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

// One row of the backlog: a mascot turn, a learner echo, or a stage note.
// `anchor` is the script position a jump would rewind to; null means the
// entry cannot anchor (pre-anchor sessions) and offers no jump.
export type BacklogEntry = {
  key: string
  role: 'mita' | 'you' | 'note'
  text: string
  sceneChip: string | null
  anchor: { sceneId: string; dialogueIndex: number } | null
  current: boolean
}

type Props = {
  open: boolean
  entries: BacklogEntry[]
  canJump: boolean
  busy: boolean
  error: string
  onClose(): void
  onJump(entry: BacklogEntry): void
}

function trapTabs(event: KeyboardEvent<HTMLDialogElement>) {
  if (event.key !== 'Tab') return
  // A nested dialog handles its own keys; the outer list of buttons would
  // otherwise swallow the inner dialog's boundary tabs.
  if (event.target instanceof Element && event.target.closest('dialog') !== event.currentTarget) return
  const buttons = event.currentTarget.querySelectorAll('button')
  const first = buttons[0], last = buttons[buttons.length - 1]
  if (event.shiftKey ? document.activeElement === first : document.activeElement === last) {
    event.preventDefault()
    ;(event.shiftKey ? last : first).focus()
  }
}

function Avatar({ role }: { role: 'mita' | 'you' }) {
  if (role === 'mita') {
    return <span className="bl-avatar bl-av-mita" aria-hidden="true"><span className="bl-av-eye" /><span className="bl-av-eye" /><span className="bl-av-mouth" /></span>
  }
  return <span className="bl-avatar bl-av-you" aria-hidden="true">
    <svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" fill="currentColor" /><path d="M4 20c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" fill="currentColor" /></svg>
  </span>
}

function Row({ entry, interactive, busy, onPick }: { entry: BacklogEntry; interactive: boolean; busy: boolean; onPick(entry: BacklogEntry): void }) {
  const body = <>
    {entry.role !== 'note' && <Avatar role={entry.role} />}
    <span className="bl-main">
      <span className="bl-name">{entry.role === 'you' ? 'You' : entry.role === 'mita' ? 'Mita' : ''}</span>
      <span className={`bl-bubble${entry.role === 'note' ? ' bl-note' : ''}`}>{entry.text}</span>
    </span>
    {entry.current && <span className="bl-here">Here</span>}
    {interactive && <span className="bl-jump" aria-hidden="true">Jump</span>}
    {interactive && <span className="sr-only">Jump back to this line</span>}
  </>
  return <li className={`bl-row bl-${entry.role}${entry.current ? ' current' : ''}`}>
    {entry.sceneChip && <span className="bl-chip" aria-hidden="true">{entry.sceneChip}</span>}
    {interactive
      ? <button type="button" className="bl-hit" disabled={busy || undefined} onClick={() => onPick(entry)}>{body}</button>
      : <div className="bl-hit">{body}</div>}
  </li>
}

export default function BacklogPanel({ open, entries, canJump, busy, error, onClose, onJump }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const warnRef = useRef<HTMLDialogElement>(null)
  const stayRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLOListElement>(null)
  const [confirming, setConfirming] = useState<BacklogEntry | null>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      dialog.showModal()
      const list = listRef.current
      if (list) list.scrollTop = list.scrollHeight
      const rows = dialog.querySelectorAll<HTMLElement>('.bl-hit')
      ;(rows[rows.length - 1] ?? dialog.querySelector<HTMLElement>('.bl-close'))?.focus({ preventScroll: true })
    } else if (!open && dialog.open) {
      warnRef.current?.close()
      dialog.close()
    }
  }, [open])

  useEffect(() => {
    const warn = warnRef.current
    if (!warn) return
    if (confirming && !warn.open) {
      warn.showModal()
      stayRef.current?.focus({ preventScroll: true })
    } else if (!confirming && warn.open) warn.close()
  }, [confirming])

  return <dialog ref={dialogRef} className="bl-dialog" aria-labelledby="bl-title"
    // React propagates the nested warn dialog's close to this handler, so
    // only the outer dialog's own close counts as a dismissal.
    onClose={event => { if (event.target !== dialogRef.current) return; setConfirming(null); onClose() }}
    onKeyDown={trapTabs}>
    <div className="bl-head">
      <h2 id="bl-title">Backlog</h2>
      <button type="button" className="vn-quiet bl-close" onClick={() => dialogRef.current?.close()}>Close</button>
    </div>
    <ol ref={listRef} className="bl-list">
      {entries.map(entry => (
        <Row key={entry.key} entry={entry} busy={busy}
          interactive={canJump && !!entry.anchor && !entry.current}
          onPick={setConfirming} />
      ))}
      {entries.length === 0 && <li className="bl-empty">Nothing in the log yet. Play the lesson to fill it.</li>}
    </ol>
    {error && <p className="bl-error" role="alert">{error}</p>}
    <dialog ref={warnRef} className="bl-warn" aria-labelledby="bl-warn-title"
      onClose={() => setConfirming(null)} onKeyDown={trapTabs}>
      <h3 id="bl-warn-title">Jump back to this line?</h3>
      <p className="bl-warn-copy">Rewinds progress and clears later log entries.</p>
      <div className="bl-warn-actions">
        <button ref={stayRef} type="button" className="vn-quiet" onClick={() => warnRef.current?.close()}>Stay here</button>
        <button type="button" className="vn-button" disabled={busy || undefined}
          onClick={() => { const entry = confirming; setConfirming(null); if (entry) onJump(entry) }}>Jump back</button>
      </div>
    </dialog>
  </dialog>
}

// Hackathon PoC browser shelf: one IndexedDB record per document processed in
// this browser, keeping the source PDF bytes (when still in memory) and the
// generated Episode 1 JSON. Pure cache — generation, sessions, and playback
// stay server-side; stored PDFs get no reopen surface.
import type { Episode } from '../learnerApi'

export type ShelfRecord = {
  documentId: string
  docName: string
  episodeId: string
  episodeTitle: string
  episode: Episode
  pdf: Blob | null
  savedAt: number
}

const DB_NAME = 'meet-mita'
const STORE = 'docs'

let dbPromise: Promise<IDBDatabase> | null = null

function openShelf(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: 'documentId' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => { dbPromise = null; reject(request.error) }
    request.onblocked = () => { dbPromise = null; reject(request.error ?? new Error('IndexedDB open blocked')) }
  })
  return dbPromise
}

function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openShelf().then(db => new Promise<T>((resolve, reject) => {
    const request = run(db.transaction(STORE, mode).objectStore(STORE))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  }))
}

export async function putShelf(record: ShelfRecord): Promise<void> {
  await withStore('readwrite', store => store.put(record))
}

export async function listShelf(): Promise<ShelfRecord[]> {
  const records = await withStore('readonly', store => store.getAll() as IDBRequest<ShelfRecord[]>)
  return records.sort((a, b) => b.savedAt - a.savedAt)
}

export async function removeShelf(documentId: string): Promise<void> {
  await withStore('readwrite', store => store.delete(documentId))
}

export async function clearShelf(): Promise<void> {
  await withStore('readwrite', store => store.clear())
}

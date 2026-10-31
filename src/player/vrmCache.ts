const memory = new Map<string, ArrayBuffer>()
const inFlight = new Map<string, Promise<ArrayBuffer>>()
const CACHE_NAME = 'meet-mita-vrm-v1'
const MAX_BYTES = 50 * 1024 * 1024

function valid(buffer: ArrayBuffer) {
  return buffer.byteLength >= 12 && buffer.byteLength <= MAX_BYTES && new DataView(buffer).getUint32(0, true) === 0x46546c67
}

export async function fetchVRM(url: string): Promise<ArrayBuffer> {
  const cached = memory.get(url)
  if (cached) return cached.slice(0)
  let pending = inFlight.get(url)
  if (!pending) {
    pending = (async () => {
      let cache: Cache | undefined
      try { cache = await globalThis.caches?.open(CACHE_NAME) } catch { /* cache unavailable */ }
      try {
        const stored = await cache?.match(url)
        if (stored) {
          const buffer = await stored.arrayBuffer()
          if (valid(buffer)) { memory.set(url, buffer); return buffer }
          await cache?.delete(url)
        }
      } catch { /* fetch normally if cache access fails */ }
      const response = await fetch(url)
      if (!response.ok || Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('VRM download failed')
      const buffer = await response.arrayBuffer()
      if (!valid(buffer)) throw new Error('Invalid VRM file')
      memory.set(url, buffer)
      try { await cache?.put(url, new Response(buffer.slice(0))) } catch { /* cache is optional */ }
      return buffer
    })()
    inFlight.set(url, pending)
    void pending.finally(() => inFlight.delete(url)).catch(() => {})
  }
  return (await pending).slice(0)
}

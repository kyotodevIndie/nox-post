import { ProviderError } from '../lib/errors'
import { pfetch } from './http'

// Leitura das mídias que os providers precisam enviar em bytes (LinkedIn, YouTube, TikTok). Meta (Facebook e
// Instagram) busca sozinha pela URL pública, por isso as URLs precisam ser acessíveis de fora (PUBLIC_URL).

export const isVideo = (m: { url: string; type?: string }) => m.type === 'video' || /\.(mp4|mov|m4v|webm)(\?|$)/i.test(m.url)

export async function mediaSize(url: string): Promise<number> {
  const head = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(30_000) }).catch(() => null)
  const len = Number(head?.headers.get('content-length'))
  if (head?.ok && len > 0) return len
  return (await mediaBuffer(url)).length
}

export async function mediaBuffer(url: string): Promise<Buffer> {
  const res = await pfetch(url, { label: 'baixar mídia', signal: AbortSignal.timeout(300_000) })
  return Buffer.from(await res.arrayBuffer())
}

/** Bytes [start, end] (inclusivo). Usa Range quando o servidor aceita; senão baixa tudo e recorta. */
export async function mediaChunk(url: string, start: number, end: number, cache?: { buf?: Buffer }): Promise<Buffer> {
  if (cache?.buf) return cache.buf.subarray(start, end + 1)
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal: AbortSignal.timeout(300_000) })
  if (res.status === 206) return Buffer.from(await res.arrayBuffer())
  if (!res.ok) throw new ProviderError('transient', `baixar mídia: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (cache) cache.buf = buf
  return buf.subarray(start, end + 1)
}

const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/mp4', webm: 'video/webm' }

export function fileName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.split('/').pop() || 'arquivo')
}

export function mimeOf(m: { url: string; type?: string }): string {
  const ext = fileName(m.url).split('.').pop()?.toLowerCase() ?? ''
  return MIME[ext] ?? (isVideo(m) ? 'video/mp4' : 'image/jpeg')
}

/** Baixa a mídia como Blob (para multipart). */
export async function mediaBlob(m: { url: string; type?: string }): Promise<Blob> {
  return new Blob([new Uint8Array(await mediaBuffer(m.url))], { type: mimeOf(m) })
}

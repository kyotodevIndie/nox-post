import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Db } from '../lib/db'
import { AppError } from '../lib/errors'

// Mídia enviada pelos tenants. Fica em disco (MEDIA_DIR) e é servida em PUBLIC_URL/media/<id>/<nome>:
// a Meta busca imagens e vídeos pela URL, então o endereço precisa ser público. O id (UUID) é o que protege.

export const mediaDir = () => process.env.MEDIA_DIR ?? join(process.cwd(), 'storage', 'media')
export const maxMediaBytes = () => Number(process.env.MEDIA_MAX_MB ?? 1024) * 1024 * 1024

const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/mp4', webm: 'video/webm', pdf: 'application/pdf',
}

export function safeFilename(name: string): { filename: string; mime: string } {
  const clean = name.normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(-120) || 'arquivo'
  const ext = clean.split('.').pop()?.toLowerCase() ?? ''
  const mime = MIME[ext]
  if (!mime) throw new AppError(415, 'MEDIA_TYPE_UNSUPPORTED', `extensão não suportada: .${ext} (use ${Object.keys(MIME).join(', ')})`)
  return { filename: clean, mime }
}

export const publicMediaUrl = (m: { id: string; filename: string }) =>
  `${(process.env.PUBLIC_URL ?? '').replace(/\/$/, '')}/media/${m.id}/${encodeURIComponent(m.filename)}`

export const mediaView = (m: any) => ({
  id: m.id, filename: m.filename, mime: m.mime, size: m.size, url: publicMediaUrl(m),
  type: m.mime.startsWith('video/') ? 'video' : 'image', createdAt: m.created_at,
})

export async function saveMedia(db: Db, tenantId: string, name: string, body: NodeJS.ReadableStream) {
  const { filename, mime } = safeFilename(name)
  const row = (await db.query(`INSERT INTO media (tenant_id, filename, mime, size) VALUES ($1, $2, $3, 0) RETURNING *`, [tenantId, filename, mime])).rows[0]
  const path = join(mediaDir(), row.id)
  await mkdir(mediaDir(), { recursive: true })
  let size = 0
  const limit = maxMediaBytes()
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length
      if (size > limit) return cb(new AppError(413, 'MEDIA_TOO_LARGE', `arquivo passa de ${process.env.MEDIA_MAX_MB ?? 1024} MB`))
      cb(null, chunk)
    },
  })
  try {
    await pipeline(body, counter, createWriteStream(path))
    if (!size) throw new AppError(400, 'MEDIA_EMPTY', 'arquivo vazio')
  } catch (e) {
    await rm(path, { force: true })
    await db.query('DELETE FROM media WHERE id = $1', [row.id])
    throw e
  }
  const saved = (await db.query('UPDATE media SET size = $2 WHERE id = $1 RETURNING *', [row.id, size])).rows[0]
  return mediaView(saved)
}

export async function deleteMedia(db: Db, tenantId: string, id: string) {
  const row = (await db.query('DELETE FROM media WHERE id = $1 AND tenant_id = $2 RETURNING id', [id, tenantId])).rows[0]
  if (!row) throw new AppError(404, 'MEDIA_NOT_FOUND', 'mídia não encontrada')
  await rm(join(mediaDir(), id), { force: true })
}

/** Arquivo para servir, com suporte a Range (LinkedIn, YouTube e TikTok baixam em partes). */
export async function mediaFile(db: Db, id: string) {
  const row = (await db.query('SELECT * FROM media WHERE id = $1', [id])).rows[0]
  if (!row) return null
  const path = join(mediaDir(), id)
  const st = await stat(path).catch(() => null)
  if (!st) return null
  return { row, path, size: st.size, stream: (start?: number, end?: number) => createReadStream(path, { start, end }) }
}

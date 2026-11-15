import { z } from 'zod'
import type { Db } from '../lib/db'
import { AppError } from '../lib/errors'
import { getProvider } from '../providers'
import { postView } from './views'

export const mediaSchema = z.object({
  url: z.url().max(2000),
  type: z.enum(['image', 'video']),
  thumbnail: z.url().max(2000).optional(),
  alt: z.string().max(1000).optional(),
})

export const createPostSchema = z.object({
  channelId: z.uuid(),
  text: z.string().max(70_000).default(''),
  media: z.array(mediaSchema).max(20).default([]),
  settings: z.record(z.string(), z.any()).default({}),
  scheduledAt: z.iso.datetime({ offset: true }).optional(),
  externalRef: z.string().min(1).max(200).optional(),
})

export const updatePostSchema = createPostSchema.omit({ channelId: true, externalRef: true }).partial()

async function channelOf(db: Db, tenantId: string, channelId: string) {
  const ch = (await db.query('SELECT * FROM channels WHERE id = $1 AND tenant_id = $2', [channelId, tenantId])).rows[0]
  if (!ch) throw new AppError(404, 'CHANNEL_NOT_FOUND', 'canal não encontrado')
  if (ch.status === 'disabled') throw new AppError(409, 'CHANNEL_DISABLED', 'canal desconectado')
  return ch
}

function validateFor(network: string, post: { text: string; media: any[]; settings: Record<string, any> }) {
  const msg = getProvider(network)?.validate(post)
  if (msg) throw new AppError(422, 'POST_INVALID', msg)
}

export async function createPost(db: Db, tenantId: string, input: z.infer<typeof createPostSchema>) {
  if (input.externalRef) {
    const existing = (await db.query('SELECT * FROM posts WHERE tenant_id = $1 AND external_ref = $2', [tenantId, input.externalRef])).rows[0]
    if (existing) return { post: postView(existing), created: false }
  }
  const ch = await channelOf(db, tenantId, input.channelId)
  validateFor(ch.network, input)
  const row = (await db.query(
    `INSERT INTO posts (tenant_id, channel_id, external_ref, text, media, settings, scheduled_at)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()))
     ON CONFLICT (tenant_id, external_ref) WHERE external_ref IS NOT NULL DO NOTHING
     RETURNING *`,
    [tenantId, ch.id, input.externalRef ?? null, input.text, JSON.stringify(input.media), JSON.stringify(input.settings), input.scheduledAt ?? null],
  )).rows[0]
  if (!row) {
    // Corrida com outra chamada de mesmo externalRef.
    const existing = (await db.query('SELECT * FROM posts WHERE tenant_id = $1 AND external_ref = $2', [tenantId, input.externalRef])).rows[0]
    return { post: postView(existing), created: false }
  }
  return { post: postView(row), created: true }
}

export async function getPost(db: Db, tenantId: string, id: string) {
  const row = (await db.query('SELECT * FROM posts WHERE id = $1 AND tenant_id = $2', [id, tenantId])).rows[0]
  if (!row) throw new AppError(404, 'POST_NOT_FOUND', 'post não encontrado')
  return row
}

export async function listPosts(db: Db, tenantId: string, q: { status?: string; channelId?: string; limit?: number; before?: string }) {
  const rows = (await db.query(
    `SELECT * FROM posts WHERE tenant_id = $1
        AND ($2::text IS NULL OR status = $2) AND ($3::uuid IS NULL OR channel_id = $3)
        AND ($4::timestamptz IS NULL OR created_at < $4)
      ORDER BY created_at DESC LIMIT $5`,
    [tenantId, q.status ?? null, q.channelId ?? null, q.before ?? null, Math.min(q.limit ?? 50, 200)],
  )).rows
  return rows.map(postView)
}

/** Só posts ainda agendados podem mudar. */
export async function updatePost(db: Db, tenantId: string, id: string, input: z.infer<typeof updatePostSchema>) {
  const cur = await getPost(db, tenantId, id)
  if (cur.status !== 'scheduled') throw new AppError(409, 'POST_NOT_EDITABLE', `post em ${cur.status} não pode ser alterado`)
  const ch = await channelOf(db, tenantId, cur.channel_id)
  const next = { text: input.text ?? cur.text, media: input.media ?? cur.media, settings: input.settings ?? cur.settings }
  validateFor(ch.network, next)
  const row = (await db.query(
    `UPDATE posts SET text = $3, media = $4, settings = $5, scheduled_at = COALESCE($6::timestamptz, scheduled_at), updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND status = 'scheduled' RETURNING *`,
    [id, tenantId, next.text, JSON.stringify(next.media), JSON.stringify(next.settings), input.scheduledAt ?? null],
  )).rows[0]
  if (!row) throw new AppError(409, 'POST_NOT_EDITABLE', 'o post começou a ser publicado')
  return postView(row)
}

export async function cancelPost(db: Db, tenantId: string, id: string) {
  const row = (await db.query(
    `UPDATE posts SET status = 'cancelled', updated_at = now() WHERE id = $1 AND tenant_id = $2 AND status = 'scheduled' RETURNING *`,
    [id, tenantId],
  )).rows[0]
  if (!row) {
    const cur = await getPost(db, tenantId, id)
    throw new AppError(409, 'POST_NOT_CANCELLABLE', `post em ${cur.status} não pode ser cancelado`)
  }
  return postView(row)
}

/** Post que falhou volta para a fila (na hora ou na data informada). */
export async function retryPost(db: Db, tenantId: string, id: string, scheduledAt?: string) {
  const row = (await db.query(
    `UPDATE posts SET status = 'scheduled', error = NULL, pending_data = NULL, checks = 0, next_check_at = NULL, started_at = NULL,
            scheduled_at = COALESCE($3::timestamptz, now()), updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND status = 'failed' RETURNING *`,
    [id, tenantId, scheduledAt ?? null],
  )).rows[0]
  if (!row) {
    const cur = await getPost(db, tenantId, id)
    throw new AppError(409, 'POST_NOT_RETRYABLE', `post em ${cur.status} não pode ser reenviado`)
  }
  return postView(row)
}

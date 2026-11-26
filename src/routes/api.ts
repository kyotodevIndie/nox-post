import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { UUID_RE } from '../lib/db'
import { AppError } from '../lib/errors'
import { requireTenant } from '../middlewares'
import { enabledProviders } from '../providers'
import { connectWithCredentials, startConnect } from '../services/channels'
import { deleteMedia, saveMedia } from '../services/media'
import { cancelPost, createPost, createPostSchema, getPost, listPosts, retryPost, updatePost, updatePostSchema } from '../services/posts'
import { channelView, postView } from '../services/views'

// API dos tenants (contrato em docs/API.md). Tudo exige Authorization: Bearer <chave do tenant>.

const idParam = (raw: unknown) => {
  const id = (raw as any)?.id
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new AppError(404, 'NOT_FOUND', 'id inválido')
  return id
}

const connectSchema = z.object({
  network: z.string().min(1).max(40),
  returnUrl: z.url().max(2000).optional(),
  ref: z.string().max(200).optional(),
  /** Redes que conectam por credenciais (veja `credentialFields` em /v1/networks). */
  credentials: z.record(z.string(), z.string().max(4000)).optional(),
})

const listPostsSchema = z.object({
  status: z.enum(['scheduled', 'publishing', 'processing', 'published', 'failed', 'cancelled']).optional(),
  channelId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  before: z.iso.datetime({ offset: true }).optional(),
})

export default async function apiRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireTenant)

  app.get('/v1/networks', async () => ({
    networks: enabledProviders().map((p) => ({
      network: p.network, label: p.label, connect: p.connectWith ? 'credentials' : 'oauth',
      ...(p.credentialFields && { credentialFields: p.credentialFields }),
    })),
  }))

  // ---- canais
  app.post('/v1/channels/connect', async (req, reply) => {
    const body = connectSchema.parse(req.body ?? {})
    if (body.credentials) {
      const channels = await connectWithCredentials(app.db, req.tenant.id, { network: body.network, credentials: body.credentials, ref: body.ref })
      return reply.status(201).send({ channels })
    }
    const { url } = await startConnect(app.db, req.tenant.id, body)
    return { url }
  })

  app.get('/v1/channels', async (req) => {
    const q = z.object({ network: z.string().optional(), ref: z.string().optional(), status: z.string().optional() }).parse(req.query ?? {})
    const rows = (await app.db.query(
      `SELECT * FROM channels WHERE tenant_id = $1 AND status <> 'disabled'
          AND ($2::text IS NULL OR network = $2) AND ($3::text IS NULL OR ref = $3) AND ($4::text IS NULL OR status = $4)
        ORDER BY created_at`,
      [req.tenant.id, q.network ?? null, q.ref ?? null, q.status ?? null],
    )).rows
    return { channels: rows.map(channelView) }
  })

  app.get('/v1/channels/:id', async (req) => {
    const row = (await app.db.query('SELECT * FROM channels WHERE id = $1 AND tenant_id = $2', [idParam(req.params), req.tenant.id])).rows[0]
    if (!row) throw new AppError(404, 'CHANNEL_NOT_FOUND', 'canal não encontrado')
    return { channel: channelView(row) }
  })

  app.patch('/v1/channels/:id', async (req) => {
    const body = z.object({ ref: z.string().max(200).nullable() }).parse(req.body ?? {})
    const row = (await app.db.query('UPDATE channels SET ref = $3, updated_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING *',
      [idParam(req.params), req.tenant.id, body.ref])).rows[0]
    if (!row) throw new AppError(404, 'CHANNEL_NOT_FOUND', 'canal não encontrado')
    return { channel: channelView(row) }
  })

  /** Desconecta: apaga as credenciais e cancela os posts agendados do canal. */
  app.delete('/v1/channels/:id', async (req) => {
    const id = idParam(req.params)
    const row = (await app.db.query(
      `UPDATE channels SET status = 'disabled', credentials_enc = 'v0', expires_at = NULL, updated_at = now()
        WHERE id = $1 AND tenant_id = $2 RETURNING *`, [id, req.tenant.id])).rows[0]
    if (!row) throw new AppError(404, 'CHANNEL_NOT_FOUND', 'canal não encontrado')
    const cancelled = (await app.db.query(`UPDATE posts SET status = 'cancelled', updated_at = now() WHERE channel_id = $1 AND status = 'scheduled'`, [id])).rowCount
    return { channel: channelView(row), cancelledPosts: cancelled }
  })

  // ---- mídia: PUT /v1/media?filename=video.mp4 com o arquivo cru no corpo
  app.put('/v1/media', async (req, reply) => {
    const { filename } = z.object({ filename: z.string().min(1).max(200) }).parse(req.query ?? {})
    const media = await saveMedia(app.db, req.tenant.id, filename, req.raw)
    return reply.status(201).send({ media })
  })

  app.delete('/v1/media/:id', async (req, reply) => {
    await deleteMedia(app.db, req.tenant.id, idParam(req.params))
    return reply.status(204).send()
  })

  // ---- posts
  app.post('/v1/posts', async (req, reply) => {
    const { post, created } = await createPost(app.db, req.tenant.id, createPostSchema.parse(req.body ?? {}))
    return reply.status(created ? 201 : 200).send({ post })
  })

  app.get('/v1/posts', async (req) => ({ posts: await listPosts(app.db, req.tenant.id, listPostsSchema.parse(req.query ?? {})) }))

  app.get('/v1/posts/:id', async (req) => ({ post: postView(await getPost(app.db, req.tenant.id, idParam(req.params))) }))

  app.patch('/v1/posts/:id', async (req) => ({ post: await updatePost(app.db, req.tenant.id, idParam(req.params), updatePostSchema.parse(req.body ?? {})) }))

  app.delete('/v1/posts/:id', async (req) => ({ post: await cancelPost(app.db, req.tenant.id, idParam(req.params)) }))

  app.post('/v1/posts/:id/retry', async (req) => {
    const body = z.object({ scheduledAt: z.iso.datetime({ offset: true }).optional() }).parse(req.body ?? {})
    return { post: await retryPost(app.db, req.tenant.id, idParam(req.params), body.scheduledAt) }
  })
}

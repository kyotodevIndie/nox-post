import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { UUID_RE } from '../lib/db'
import { AppError } from '../lib/errors'
import { requireAdmin } from '../middlewares'
import { requeueEvent } from '../services/outbox'
import { createTenant, rotateTenant, tenantView, updateTenant } from '../services/tenants'

// Administração: criar e gerenciar tenants, ver e reenviar webhooks mortos. Authorization: Bearer <ADMIN_TOKEN>.

const id = (raw: unknown) => {
  const v = (raw as any)?.id
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new AppError(404, 'NOT_FOUND', 'id inválido')
  return v
}

const tenantSchema = z.object({
  name: z.string().min(1).max(100),
  webhookUrl: z.url().max(2000).nullable().optional(),
  oauthReturnUrl: z.url().max(2000).nullable().optional(),
})

export default async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  app.post('/admin/tenants', async (req, reply) => reply.status(201).send(await createTenant(app.db, tenantSchema.parse(req.body ?? {}))))

  app.get('/admin/tenants', async () => ({ tenants: (await app.db.query('SELECT * FROM tenants ORDER BY created_at')).rows.map(tenantView) }))

  app.patch('/admin/tenants/:id', async (req) => ({
    tenant: await updateTenant(app.db, id(req.params), tenantSchema.partial().extend({ active: z.boolean().optional() }).parse(req.body ?? {})),
  }))

  app.post('/admin/tenants/:id/rotate', async (req) =>
    rotateTenant(app.db, id(req.params), z.object({ webhookSecret: z.boolean().optional() }).parse(req.body ?? {})))

  app.get('/admin/events', async (req) => {
    const q = z.object({ status: z.enum(['pending', 'delivered', 'dead']).optional(), tenantId: z.uuid().optional() }).parse(req.query ?? {})
    const rows = (await app.db.query(
      `SELECT id, tenant_id, type, status, attempts, next_attempt_at, last_status_code, last_error, created_at, delivered_at
         FROM outbound_events WHERE ($1::text IS NULL OR status = $1) AND ($2::uuid IS NULL OR tenant_id = $2)
        ORDER BY created_at DESC LIMIT 200`, [q.status ?? null, q.tenantId ?? null])).rows
    return { events: rows }
  })

  app.post('/admin/events/:id/requeue', async (req) => {
    if (!(await requeueEvent(app.db, id(req.params)))) throw new AppError(404, 'EVENT_NOT_FOUND', 'evento não encontrado ou já entregue')
    return { ok: true }
  })
}

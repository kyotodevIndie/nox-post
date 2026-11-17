import type { FastifyReply, FastifyRequest } from 'fastify'
import { AppError } from './lib/errors'
import { safeEqual } from './security/signature'
import { tenantByKey } from './services/tenants'

declare module 'fastify' {
  interface FastifyRequest { tenant: any }
}

const bearer = (req: FastifyRequest) => {
  const h = req.headers.authorization
  return typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7).trim() : undefined
}

/** Authorization: Bearer pnox_... (chave do tenant). */
export async function requireTenant(req: FastifyRequest, _reply: FastifyReply) {
  const key = bearer(req)
  const tenant = key ? await tenantByKey(req.server.db, key) : null
  if (!tenant) throw new AppError(401, 'UNAUTHORIZED', 'chave de API inválida')
  req.tenant = tenant
}

/** Authorization: Bearer <ADMIN_TOKEN> (só para criar e gerenciar tenants). */
export async function requireAdmin(req: FastifyRequest, _reply: FastifyReply) {
  const token = process.env.ADMIN_TOKEN
  if (!token || token.length < 32) throw new AppError(503, 'ADMIN_DISABLED', 'ADMIN_TOKEN não configurado')
  if (!safeEqual(token, bearer(req))) throw new AppError(401, 'UNAUTHORIZED', 'token de admin inválido')
}

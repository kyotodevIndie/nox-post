import { randomUUID } from 'node:crypto'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { createPool, type Pool } from './lib/db'
import { AppError } from './lib/errors'
import adminRoutes from './routes/admin'
import apiRoutes from './routes/api'
import publicRoutes from './routes/public'

declare module 'fastify' {
  interface FastifyInstance { db: Pool }
}

export interface BuildOptions { pool?: Pool; logger?: boolean }

/** Monta o app sem escutar porta (server.ts sobe; os testes usam inject). */
export async function buildApp(opts: BuildOptions = {}): Promise<FastifyInstance> {
  const isProd = process.env.NODE_ENV === 'production'
  const app = Fastify({
    trustProxy: process.env.TRUST_PROXY === '1',
    genReqId: () => randomUUID(),
    bodyLimit: 1024 * 1024,
    logger: opts.logger === false ? false : isProd ? { level: 'warn' } : { level: process.env.LOG_LEVEL ?? 'info' },
  })

  // Upload de mídia chega cru (qualquer content-type que não seja JSON): a rota lê o stream direto.
  app.addContentTypeParser('*', (_req, _payload, done) => done(null))

  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } })
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' })

  const pool = opts.pool ?? createPool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.PG_POOL_MAX ?? 10) }, app.log)
  app.decorate('db', pool)
  if (!opts.pool) app.addHook('onClose', async () => { await pool.end() })

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } })
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: 'VALIDATION', message: 'dados inválidos', details: { issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } } })
    }
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: { code: err.code ?? 'BAD_REQUEST', message: err.message } })
    req.log.error({ err }, 'erro interno')
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'erro interno' } })
  })

  await app.register(publicRoutes)
  await app.register(adminRoutes)
  await app.register(apiRoutes)
  return app
}

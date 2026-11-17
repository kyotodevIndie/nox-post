import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { UUID_RE } from '../lib/db'
import { AppError } from '../lib/errors'
import { allNetworks } from '../providers'
import { finishConnect } from '../services/channels'
import { mediaFile } from '../services/media'

// Rotas sem chave: retorno do OAuth das redes, arquivos de mídia, saúde e a marca (logo e favicon).

const BRAND_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../assets/brand')
const BRAND_FILES = ['nox-post.png', 'nox-simbolo.png', 'favicon.png', 'apple-touch-icon.png'] as const
const brand = Object.fromEntries(BRAND_FILES.map((f) => [f, readFileSync(join(BRAND_DIR, f))])) as Record<(typeof BRAND_FILES)[number], Buffer>

function withParams(url: string, params: Record<string, string>) {
  const u = new URL(url)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  return u.toString()
}

const page = (title: string, msg: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · nox-post</title>` +
  `<link rel="icon" href="/favicon.png" type="image/png"><link rel="apple-touch-icon" href="/apple-touch-icon.png">` +
  `<body style="font-family:system-ui;max-width:32rem;margin:0 auto;padding:0 1rem;color:#16161d">` +
  `<header style="background:#1c1c24;margin:0 -1rem 2rem;padding:1.25rem 1rem;border-radius:0 0 12px 12px"><img src="/brand/nox-post.png" alt="nox-post" style="height:44px"></header>` +
  `<h1>${title}</h1><p>${msg.replace(/</g, '&lt;')}</p></body>`

export default async function publicRoutes(app: FastifyInstance) {
  const sendBrand = (name: (typeof BRAND_FILES)[number]) => async (_req: unknown, reply: any) =>
    reply.type('image/png').header('cache-control', 'public, max-age=86400').send(brand[name])
  app.get('/favicon.png', sendBrand('favicon.png'))
  app.get('/favicon.ico', sendBrand('favicon.png'))
  app.get('/apple-touch-icon.png', sendBrand('apple-touch-icon.png'))
  app.get('/brand/nox-post.png', sendBrand('nox-post.png'))
  app.get('/brand/nox-simbolo.png', sendBrand('nox-simbolo.png'))

  app.get('/health/ready', async () => {
    await app.db.query('SELECT 1')
    return { ok: true }
  })

  app.get('/oauth/:network/callback', async (req, reply) => {
    const { network } = req.params as { network: string }
    if (!allNetworks().includes(network as any)) throw new AppError(404, 'NETWORK_NOT_FOUND', 'rede desconhecida')
    let result
    try {
      result = await finishConnect(app.db, network, req.query as any)
    } catch (e) {
      if (e instanceof AppError) return reply.status(e.status).type('text/html').send(page('Não deu para conectar', e.message))
      throw e
    }
    const params: Record<string, string> = result.error
      ? { status: 'error', network, error: result.error }
      : { status: 'ok', network, channels: result.channels.map((c) => c.id).join(',') }
    if (result.ref) params.ref = result.ref
    if (result.returnUrl) return reply.redirect(withParams(result.returnUrl, params))
    return reply.type('text/html').send(result.error
      ? page('Não deu para conectar', result.error)
      : page('Conta conectada', `${result.channels.map((c) => c.name).join(', ')}. Pode fechar esta janela.`))
  })

  const serveMedia = async (req: any, reply: any) => {
    const { id } = req.params as { id: string }
    if (!UUID_RE.test(id)) return reply.status(404).send()
    const f = await mediaFile(app.db, id)
    if (!f) return reply.status(404).send()
    reply.header('Content-Type', f.row.mime).header('Accept-Ranges', 'bytes').header('Cache-Control', 'public, max-age=86400')
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''))
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : Math.max(0, f.size - Number(range[2]))
      let end = range[1] && range[2] ? Math.min(Number(range[2]), f.size - 1) : f.size - 1
      if (start > end || start >= f.size) return reply.status(416).header('Content-Range', `bytes */${f.size}`).send()
      reply.status(206).header('Content-Range', `bytes ${start}-${end}/${f.size}`).header('Content-Length', String(end - start + 1))
      return reply.send(f.stream(start, end))
    }
    reply.header('Content-Length', String(f.size))
    return reply.send(f.stream())
  }
  app.get('/media/:id/:name', serveMedia)
}

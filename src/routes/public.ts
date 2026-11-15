import type { FastifyInstance } from 'fastify'
import { UUID_RE } from '../lib/db'
import { AppError } from '../lib/errors'
import { allNetworks } from '../providers'
import { finishConnect } from '../services/channels'
import { mediaFile } from '../services/media'

// Rotas sem chave: retorno do OAuth das redes, arquivos de mídia e saúde.

function withParams(url: string, params: Record<string, string>) {
  const u = new URL(url)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  return u.toString()
}

const page = (title: string, msg: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
  `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>${title}</h1><p>${msg.replace(/</g, '&lt;')}</p></body>`

export default async function publicRoutes(app: FastifyInstance) {
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

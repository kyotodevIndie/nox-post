import 'dotenv/config'
import pg from 'pg'
import { Readable } from 'node:stream'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app'
import { ProviderError } from '../../src/lib/errors'
import { setProviders } from '../../src/providers'
import type { Provider } from '../../src/providers/types'
import { deliverDue } from '../../src/services/outbox'
import { checkProcessing, publishDue } from '../../src/services/publisher'
import { signWebhook } from '../../src/security/signature'

// Fluxo completo contra um Postgres de verdade (DATABASE_URL do .env; rode `docker compose up -d postgres` e
// `pnpm migrate`). Usa um provider falso no lugar das redes. Apaga os dados das tabelas antes de cada teste.

const ADMIN = 'test-admin-0123456789abcdef0123456789abcdef'
const log = { warn: () => {} }
const state: { publish: any[]; refreshCalls: number; failNextWithReauth: boolean; checks: number } = { publish: [], refreshCalls: 0, failNextWithReauth: false, checks: 0 }

const fake: Provider = {
  network: 'facebook',
  label: 'Falso',
  requiredEnv: [],
  authUrl: ({ state: s, redirectUri }) => ({ url: `https://rede.test/auth?state=${s}&redirect_uri=${encodeURIComponent(redirectUri)}`, codeVerifier: 'verif' }),
  async connect({ code, codeVerifier }) {
    if (codeVerifier !== 'verif') throw new Error('codeVerifier não voltou')
    return [
      { externalId: 'pg1', name: 'Página 1', credentials: { accessToken: `tok-${code}`, refreshToken: 'r1' }, expiresAt: new Date(Date.now() + 3600_000) },
      { externalId: 'pg2', name: 'Página 2', credentials: { accessToken: `tok-${code}` }, expiresAt: null },
    ]
  },
  async refresh(creds) {
    state.refreshCalls++
    return { credentials: { ...creds, accessToken: 'tok-renovado' }, expiresAt: new Date(Date.now() + 3600_000) }
  },
  validate: (p) => (p.text.includes('proibido') ? 'texto proibido' : null),
  async publish(_c, creds, post) {
    if (state.failNextWithReauth && creds.accessToken !== 'tok-renovado') throw new ProviderError('reauth', 'token velho')
    state.publish.push({ token: creds.accessToken, text: post.text })
    if (post.media.length) return { status: 'processing', pendingData: { step: 1 } }
    if (post.text === 'falha') throw new ProviderError('fatal', 'a rede recusou', '{"error":"x"}')
    return { status: 'published', remoteId: 'R1', remoteUrl: 'https://rede.test/p/R1' }
  },
  async check(_c, _creds, pending) {
    state.checks++
    if (pending.step < 2) return { status: 'processing', pendingData: { step: pending.step + 1 } }
    return { status: 'published', remoteId: 'R2', remoteUrl: null }
  },
}

let pool: pg.Pool
let app: Awaited<ReturnType<typeof buildApp>>
let apiKey: string
let webhookSecret: string
const auth = () => ({ authorization: `Bearer ${apiKey}` })

beforeAll(async () => {
  process.env.ADMIN_TOKEN = ADMIN
  process.env.SECRETS_KEY ??= 'test-0123456789abcdef0123456789abcdef'
  process.env.PUBLIC_URL = 'https://api.test'
  process.env.MEDIA_DIR = mkdtempSync(join(tmpdir(), 'nox-post-media-'))
  setProviders([fake])
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
  app = await buildApp({ pool, logger: false })
})

afterAll(async () => {
  await app.close()
  await pool.end()
})

beforeEach(async () => {
  await pool.query('TRUNCATE outbound_events, posts, media, channels, oauth_states, tenants CASCADE')
  Object.assign(state, { publish: [], refreshCalls: 0, failNextWithReauth: false, checks: 0 })
  const r = await app.inject({ method: 'POST', url: '/admin/tenants', headers: { authorization: `Bearer ${ADMIN}` },
    payload: { name: 'Suíte', webhookUrl: 'https://suite.test/hook', oauthReturnUrl: 'https://suite.test/canais' } })
  expect(r.statusCode).toBe(201)
  ;({ apiKey, webhookSecret } = r.json())
})

async function connect(ref = 'persona-1') {
  const start = await app.inject({ method: 'POST', url: '/v1/channels/connect', headers: auth(), payload: { network: 'facebook', ref } })
  expect(start.statusCode).toBe(200)
  const st = new URL(start.json().url).searchParams.get('state')!
  const cb = await app.inject({ method: 'GET', url: `/oauth/facebook/callback?code=abc&state=${st}` })
  return { cb, st }
}

describe('fluxo completo', () => {
  it('admin exige token e tenant exige chave', async () => {
    expect((await app.inject({ method: 'GET', url: '/admin/tenants' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/v1/channels', headers: { authorization: 'Bearer pnox_errada' } })).statusCode).toBe(401)
  })

  it('conecta canais pelo OAuth e redireciona com os ids e o ref', async () => {
    const { cb, st } = await connect()
    expect(cb.statusCode).toBe(302)
    const back = new URL(cb.headers.location as string)
    expect(back.origin + back.pathname).toBe('https://suite.test/canais')
    expect(back.searchParams.get('status')).toBe('ok')
    expect(back.searchParams.get('ref')).toBe('persona-1')
    expect(back.searchParams.get('channels')!.split(',')).toHaveLength(2)

    const list = (await app.inject({ method: 'GET', url: '/v1/channels?ref=persona-1', headers: auth() })).json()
    expect(list.channels.map((c: any) => c.name)).toEqual(['Página 1', 'Página 2'])
    expect(JSON.stringify(list)).not.toContain('tok-abc')

    // state é de uso único
    const reused = await app.inject({ method: 'GET', url: `/oauth/facebook/callback?code=abc&state=${st}` })
    expect(reused.statusCode).toBe(400)
    expect(reused.body).toContain('/brand/nox-post.png')
    for (const path of ['/favicon.png', '/apple-touch-icon.png', '/brand/nox-post.png', '/brand/nox-simbolo.png']) {
      const r = await app.inject({ method: 'GET', url: path })
      expect([r.statusCode, r.headers['content-type'], r.rawPayload.subarray(1, 4).toString()]).toEqual([200, 'image/png', 'PNG'])
    }
    const ev = (await pool.query(`SELECT type FROM outbound_events`)).rows
    expect(ev.map((e) => e.type)).toEqual(['channel.connected'])
  })

  it('publica na hora, emite post.published e entrega o webhook assinado', async () => {
    await connect()
    const ch = (await app.inject({ method: 'GET', url: '/v1/channels', headers: auth() })).json().channels.find((c: any) => c.name === 'Página 2')
    const created = await app.inject({ method: 'POST', url: '/v1/posts', headers: auth(), payload: { channelId: ch.id, text: 'olá', externalRef: 'p-1' } })
    expect(created.statusCode).toBe(201)
    // idempotente por externalRef
    const again = await app.inject({ method: 'POST', url: '/v1/posts', headers: auth(), payload: { channelId: ch.id, text: 'olá', externalRef: 'p-1' } })
    expect(again.statusCode).toBe(200)
    expect(again.json().post.id).toBe(created.json().post.id)

    expect(await publishDue(pool as any, log)).toBe(1)
    const post = (await app.inject({ method: 'GET', url: `/v1/posts/${created.json().post.id}`, headers: auth() })).json().post
    expect(post).toMatchObject({ status: 'published', remoteId: 'R1', remoteUrl: 'https://rede.test/p/R1' })

    const sent: any[] = []
    const r = await deliverDue(pool as any, { fetch: async (url, init) => { sent.push({ url, ...init }); return { status: 200, ok: true } } })
    expect(r.delivered).toBe(2)
    const hook = sent.find((s) => JSON.parse(s.body).type === 'post.published')
    expect(hook.url).toBe('https://suite.test/hook')
    expect(hook.headers['X-Nox-Signature']).toBe(signWebhook(webhookSecret, hook.headers['X-Nox-Timestamp'], hook.body))
    expect(JSON.parse(hook.body).data.post.externalRef).toBe('p-1')
  })

  it('post com mídia passa por processing até publicar', async () => {
    await connect()
    const ch = (await app.inject({ method: 'GET', url: '/v1/channels', headers: auth() })).json().channels[1]
    const id = (await app.inject({ method: 'POST', url: '/v1/posts', headers: auth(),
      payload: { channelId: ch.id, text: 'vídeo', media: [{ url: 'https://cdn.test/v.mp4', type: 'video' }] } })).json().post.id
    await publishDue(pool as any, log)
    expect((await pool.query('SELECT status FROM posts WHERE id = $1', [id])).rows[0].status).toBe('processing')
    for (let i = 0; i < 2; i++) {
      await pool.query(`UPDATE posts SET next_check_at = now() WHERE id = $1`, [id])
      await checkProcessing(pool as any, log)
    }
    expect((await pool.query('SELECT status, remote_id FROM posts WHERE id = $1', [id])).rows[0]).toEqual({ status: 'published', remote_id: 'R2' })
    expect(state.checks).toBe(2)
  })

  it('reauth: renova o token e tenta de novo uma vez', async () => {
    await connect()
    const ch = (await app.inject({ method: 'GET', url: '/v1/channels', headers: auth() })).json().channels.find((c: any) => c.name === 'Página 1')
    state.failNextWithReauth = true
    await app.inject({ method: 'POST', url: '/v1/posts', headers: auth(), payload: { channelId: ch.id, text: 'oi' } })
    await publishDue(pool as any, log)
    expect(state.refreshCalls).toBe(1)
    expect(state.publish).toEqual([{ token: 'tok-renovado', text: 'oi' }])
  })

  it('falha da rede vira post.failed com motivo; retry recoloca na fila', async () => {
    await connect()
    const ch = (await app.inject({ method: 'GET', url: '/v1/channels', headers: auth() })).json().channels[1]
    const id = (await app.inject({ method: 'POST', url: '/v1/posts', headers: auth(), payload: { channelId: ch.id, text: 'falha' } })).json().post.id
    await publishDue(pool as any, log)
    const failed = (await app.inject({ method: 'GET', url: `/v1/posts/${id}`, headers: auth() })).json().post
    expect(failed).toMatchObject({ status: 'failed', error: 'a rede recusou' })
    const ev = (await pool.query(`SELECT payload FROM outbound_events WHERE type = 'post.failed'`)).rows[0].payload
    expect(ev.data.reason).toBe('fatal')
    const retried = await app.inject({ method: 'POST', url: `/v1/posts/${id}/retry`, headers: auth(), payload: {} })
    expect(retried.json().post.status).toBe('scheduled')
  })

  it('valida pelo provider, agenda no futuro, edita e cancela', async () => {
    await connect()
    const ch = (await app.inject({ method: 'GET', url: '/v1/channels', headers: auth() })).json().channels[0]
    const bad = await app.inject({ method: 'POST', url: '/v1/posts', headers: auth(), payload: { channelId: ch.id, text: 'proibido' } })
    expect(bad.statusCode).toBe(422)
    const future = new Date(Date.now() + 86400_000).toISOString()
    const id = (await app.inject({ method: 'POST', url: '/v1/posts', headers: auth(), payload: { channelId: ch.id, text: 'amanhã', scheduledAt: future } })).json().post.id
    expect(await publishDue(pool as any, log)).toBe(0)
    const edited = await app.inject({ method: 'PATCH', url: `/v1/posts/${id}`, headers: auth(), payload: { text: 'amanhã cedo' } })
    expect(edited.json().post.text).toBe('amanhã cedo')
    expect((await app.inject({ method: 'DELETE', url: `/v1/posts/${id}`, headers: auth() })).json().post.status).toBe('cancelled')
    expect((await app.inject({ method: 'DELETE', url: `/v1/posts/${id}`, headers: auth() })).statusCode).toBe(409)
  })

  it('outro tenant não enxerga os canais', async () => {
    await connect()
    const other = (await app.inject({ method: 'POST', url: '/admin/tenants', headers: { authorization: `Bearer ${ADMIN}` }, payload: { name: 'DarkHub' } })).json()
    const list = (await app.inject({ method: 'GET', url: '/v1/channels', headers: { authorization: `Bearer ${other.apiKey}` } })).json()
    expect(list.channels).toEqual([])
  })

  it('upload de mídia e download com Range', async () => {
    const up = await app.inject({ method: 'PUT', url: '/v1/media?filename=teste.mp4', headers: { ...auth(), 'content-type': 'application/octet-stream' },
      payload: Readable.from([Buffer.from('0123456789')]) })
    expect(up.statusCode).toBe(201)
    const media = up.json().media
    expect(media).toMatchObject({ size: 10, type: 'video', mime: 'video/mp4' })
    const path = new URL(media.url).pathname
    const full = await app.inject({ method: 'GET', url: path })
    expect(full.body).toBe('0123456789')
    const part = await app.inject({ method: 'GET', url: path, headers: { range: 'bytes=2-5' } })
    expect(part.statusCode).toBe(206)
    expect(part.body).toBe('2345')
    expect(part.headers['content-range']).toBe('bytes 2-5/10')
    const head = await app.inject({ method: 'HEAD', url: path })
    expect(head.headers['content-length']).toBe('10')
    const bad = await app.inject({ method: 'PUT', url: '/v1/media?filename=x.exe', headers: { ...auth(), 'content-type': 'application/octet-stream' }, payload: 'x' })
    expect(bad.statusCode).toBe(415)
  })

  it('desconectar cancela os agendados', async () => {
    await connect()
    const ch = (await app.inject({ method: 'GET', url: '/v1/channels', headers: auth() })).json().channels[0]
    const future = new Date(Date.now() + 86400_000).toISOString()
    await app.inject({ method: 'POST', url: '/v1/posts', headers: auth(), payload: { channelId: ch.id, text: 'x', scheduledAt: future } })
    const del = (await app.inject({ method: 'DELETE', url: `/v1/channels/${ch.id}`, headers: auth() })).json()
    expect(del).toMatchObject({ channel: { status: 'disabled' }, cancelledPosts: 1 })
  })
})

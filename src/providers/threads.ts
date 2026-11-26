// Threads: texto, imagem, vídeo ou carrossel (2 a 20) pela Threads API (graph.threads.net), com containers como o
// Instagram: cria, espera ficar FINISHED (o worker repete o check) e publica. App próprio, separado do Facebook.
import { ProviderError } from '../lib/errors'
import type { Classify } from './http'
import { env, form, pjson, requireScopes } from './http'
import { isVideo } from './media'
import { rules } from './rules'
import type { ChannelCtx, Credentials, MediaItem, Provider, PublishOutcome } from './types'

const GRAPH = 'https://graph.threads.net'
const API = `${GRAPH}/v1.0`
const SCOPES = ['threads_basic', 'threads_content_publish']

const classify: Classify = (body) => {
  if (body.includes('"code":190') || body.includes('OAuthException')) return { kind: 'reauth', message: 'token do Threads vencido ou revogado' }
  if (body.includes('"code":4,') || body.includes('"code":613')) return { kind: 'retry', message: 'limite de chamadas do Threads' }
  return undefined
}

const call = (path: string, token: string, params: Record<string, string> = {}, method = 'GET') => {
  const q = form({ ...params, access_token: token })
  return pjson(method === 'GET' ? `${API}/${path}?${q}` : `${API}/${path}`, { method, ...(method !== 'GET' && { body: q }), classify, label: `threads: ${path.split('/').pop()}` })
}

const longLived = async (tok: any) => {
  const r = await pjson(`${GRAPH}/access_token?${form({ grant_type: 'th_exchange_token', client_secret: env('THREADS_APP_SECRET'), access_token: tok.access_token })}`,
    { classify, label: 'threads: token longo' })
  return { credentials: { accessToken: r.access_token }, expiresAt: new Date(Date.now() + (r.expires_in ?? 5_184_000) * 1000) }
}

interface Pending { children: string[]; carousel: boolean; parent?: string; text: string }

const itemParams = (m: MediaItem): Record<string, string> =>
  isVideo(m) ? { media_type: 'VIDEO', video_url: m.url } : { media_type: 'IMAGE', image_url: m.url, ...(m.alt && { alt_text: m.alt }) }

async function publishContainer(channel: ChannelCtx, token: string, id: string): Promise<PublishOutcome> {
  const pub = await call(`${channel.externalId}/threads_publish`, token, { creation_id: id }, 'POST')
  const info = await call(pub.id, token, { fields: 'permalink' }).catch(() => ({}))
  return { status: 'published', remoteId: pub.id, remoteUrl: (info as any).permalink ?? null }
}

export const threads: Provider = {
  network: 'threads',
  label: 'Threads',
  requiredEnv: ['THREADS_APP_ID', 'THREADS_APP_SECRET'],

  authUrl({ state, redirectUri }) {
    const url = new URL('https://threads.net/oauth/authorize')
    url.search = form({ client_id: env('THREADS_APP_ID'), redirect_uri: redirectUri, scope: SCOPES.join(','), response_type: 'code', state }).toString()
    return { url: url.toString() }
  },

  async connect({ code, redirectUri }) {
    const tok = await pjson(`${GRAPH}/oauth/access_token`, {
      method: 'POST', classify, label: 'threads: trocar code',
      body: form({ client_id: env('THREADS_APP_ID'), client_secret: env('THREADS_APP_SECRET'), grant_type: 'authorization_code', redirect_uri: redirectUri, code }),
    })
    if (tok.permissions) requireScopes(SCOPES, tok.permissions, 'threads')
    const creds = await longLived(tok)
    const me = await call('me', creds.credentials.accessToken, { fields: 'id,username,name,threads_profile_picture_url' })
    return [{ externalId: me.id, name: me.name || me.username, username: me.username, picture: me.threads_profile_picture_url, ...creds }]
  },

  async refresh(creds) {
    const r = await pjson(`${GRAPH}/refresh_access_token?${form({ grant_type: 'th_refresh_token', access_token: creds.accessToken })}`, { classify, label: 'threads: renovar token' })
    return { credentials: { accessToken: r.access_token }, expiresAt: new Date(Date.now() + (r.expires_in ?? 5_184_000) * 1000) }
  },

  validate: rules('Threads', { maxText: 500, maxMedia: 20 }),

  async publish(channel, creds, post) {
    const token = creds.accessToken
    const user = channel.externalId
    if (!post.media.length) {
      const c = await call(`${user}/threads`, token, { media_type: 'TEXT', text: post.text }, 'POST')
      return publishContainer(channel, token, c.id)
    }
    const carousel = post.media.length > 1
    const children: string[] = []
    for (const m of post.media) {
      const params = { ...itemParams(m), ...(carousel ? { is_carousel_item: 'true' } : { text: post.text }) }
      children.push((await call(`${user}/threads`, token, params, 'POST')).id)
    }
    return { status: 'processing', pendingData: { children, carousel, text: post.text } satisfies Pending }
  },

  async check(channel: ChannelCtx, creds: Credentials, p: Pending): Promise<PublishOutcome> {
    const token = creds.accessToken
    const waiting = p.parent ? [p.parent] : p.children
    for (const id of waiting) {
      const st = await call(id, token, { fields: 'status,error_message' })
      if (st.status === 'ERROR' || st.status === 'EXPIRED') throw new ProviderError('fatal', `threads: mídia recusada (${st.error_message ?? st.status})`)
      if (st.status !== 'FINISHED') return { status: 'processing', pendingData: p }
    }
    if (p.carousel && !p.parent) {
      const parent = await call(`${channel.externalId}/threads`, token, { media_type: 'CAROUSEL', children: p.children.join(','), text: p.text }, 'POST')
      return { status: 'processing', pendingData: { ...p, parent: parent.id } }
    }
    return publishContainer(channel, token, p.parent ?? p.children[0])
  },
}

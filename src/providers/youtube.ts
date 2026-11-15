// YouTube: upload de vídeo (normal ou Shorts, quem decide é o próprio YouTube pela proporção e duração).
// OAuth do Google com PKCE e upload resumível em partes, a partir do youtube-core.ts do PostGo; regras de
// erro e escolha de canal adaptadas de youtube.provider.ts do Postiz (gitroomhq/postiz-app, AGPL-3.0).
import { createHash, randomBytes } from 'node:crypto'
import { ProviderError } from '../lib/errors'
import type { Classify } from './http'
import { env, form, pjson, requireScopes, sleep } from './http'
import { isVideo, mediaChunk, mediaSize } from './media'
import type { Credentials, Provider } from './types'

const SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly']
// Partes múltiplas de 256 KiB, como o YouTube exige.
const CHUNK = 32 * 256 * 1024

const classify: Classify = (body) => {
  if (body.includes('invalid_grant')) return { kind: 'reauth', message: 'autorização do Google vencida ou revogada, reconecte o canal' }
  if (body.includes('youtubeSignupRequired')) return { kind: 'fatal', message: 'a conta Google não tem canal no YouTube' }
  if (body.includes('uploadLimitExceeded')) return { kind: 'fatal', message: 'limite diário de uploads do canal atingido' }
  if (body.includes('quotaExceeded')) return { kind: 'fatal', message: 'cota diária da API do YouTube esgotada; tenta amanhã ou pede aumento no Google Cloud' }
  if (body.includes('forbiddenPrivacySetting') || body.includes('invalidPrivacyStatus')) return { kind: 'fatal', message: 'privacidade inválida para este canal' }
  if (body.includes('The request cannot be completed because you have exceeded your')) return { kind: 'fatal', message: 'cota do YouTube excedida' }
  if (body.includes('invalidTitle')) return { kind: 'fatal', message: 'título inválido (vazio ou com caracteres proibidos como < >)' }
  if (body.includes('invalidDescription')) return { kind: 'fatal', message: 'descrição inválida' }
  if (body.includes('UNAUTHENTICATED') || body.includes('Invalid Credentials')) return { kind: 'reauth', message: 'token do Google recusado' }
  return undefined
}

const tokenToCreds = (tok: any, prev?: Credentials) => ({
  credentials: { accessToken: tok.access_token, refreshToken: tok.refresh_token ?? prev?.refreshToken },
  expiresAt: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000),
})

export const youtube: Provider = {
  network: 'youtube',
  label: 'YouTube',
  requiredEnv: ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET'],

  authUrl({ state, redirectUri }) {
    const codeVerifier = randomBytes(32).toString('base64url')
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    url.search = form({
      client_id: env('YOUTUBE_CLIENT_ID'), redirect_uri: redirectUri, response_type: 'code', scope: SCOPES.join(' '),
      access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'true', state,
      code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'), code_challenge_method: 'S256',
    }).toString()
    return { url: url.toString(), codeVerifier }
  },

  async connect({ code, codeVerifier, redirectUri }) {
    const tok = await pjson('https://oauth2.googleapis.com/token', {
      method: 'POST', label: 'youtube: trocar code', classify,
      body: form({
        code, client_id: env('YOUTUBE_CLIENT_ID'), client_secret: env('YOUTUBE_CLIENT_SECRET'), redirect_uri: redirectUri,
        grant_type: 'authorization_code', code_verifier: codeVerifier ?? '',
      }),
    })
    requireScopes(SCOPES, tok.scope, 'youtube')
    if (!tok.refresh_token) throw new ProviderError('fatal', 'youtube: o Google não devolveu refresh token; remova o acesso do app na conta Google e conecte de novo')
    const ch = await pjson('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
      headers: { Authorization: `Bearer ${tok.access_token}` }, classify, label: 'youtube: canal',
    })
    if (!ch.items?.length) throw new ProviderError('fatal', 'youtube: essa conta Google não tem canal')
    const creds = tokenToCreds(tok)
    return ch.items.map((c: any) => ({
      externalId: c.id, name: c.snippet.title, username: c.snippet.customUrl, picture: c.snippet.thumbnails?.default?.url, ...creds,
    }))
  },

  async refresh(creds) {
    if (!creds.refreshToken) throw new ProviderError('reauth', 'youtube: sem refresh token, reconecte o canal')
    const tok = await pjson('https://oauth2.googleapis.com/token', {
      method: 'POST', label: 'youtube: renovar token',
      classify: (body, status) => classify(body, status) ?? (status === 400 ? { kind: 'reauth', message: 'refresh token do Google recusado' } : undefined),
      body: form({ client_id: env('YOUTUBE_CLIENT_ID'), client_secret: env('YOUTUBE_CLIENT_SECRET'), refresh_token: creds.refreshToken, grant_type: 'refresh_token' }),
    })
    return tokenToCreds(tok, creds)
  },

  validate(post) {
    if (post.media.length !== 1 || !isVideo(post.media[0])) return 'YouTube: precisa de exatamente um vídeo'
    const title = String(post.settings.title ?? '').trim()
    if (!title) return 'YouTube: settings.title é obrigatório'
    if (title.length > 100) return 'YouTube: título passa de 100 caracteres'
    if (/[<>]/.test(title)) return 'YouTube: título não pode ter < ou >'
    if (post.text.length > 5000) return 'YouTube: descrição passa de 5.000 caracteres'
    if (post.settings.privacy && !['public', 'unlisted', 'private'].includes(post.settings.privacy)) return 'YouTube: privacy deve ser public, unlisted ou private'
    return null
  },

  async publish(_channel, creds, post) {
    const url = post.media[0].url
    const size = await mediaSize(url)
    const s = post.settings
    const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.accessToken}`, 'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(size), 'X-Upload-Content-Type': 'video/*',
      },
      body: JSON.stringify({
        snippet: { title: String(s.title).slice(0, 100), description: post.text.slice(0, 5000), tags: s.tags ?? [], categoryId: String(s.categoryId ?? '22') },
        status: { privacyStatus: s.privacy ?? 'public', selfDeclaredMadeForKids: !!s.madeForKids },
      }),
      signal: AbortSignal.timeout(60_000),
    })
    const location = init.headers.get('location')
    if (!init.ok || !location) {
      const body = await init.text()
      const known = classify(body, init.status)
      const kind = known?.kind === 'reauth' || init.status === 401 ? 'reauth' : init.status >= 500 ? 'transient' : 'fatal'
      throw new ProviderError(kind, `youtube: ${known?.message ?? `upload recusado (HTTP ${init.status})`}`, body.slice(0, 1000))
    }

    const cache: { buf?: Buffer } = {}
    for (let start = 0; start < size; start += CHUNK) {
      const end = Math.min(start + CHUNK, size) - 1
      const chunk = await mediaChunk(url, start, end, cache)
      let res: Response | null = null
      for (let attempt = 0; attempt < 4; attempt++) {
        res = await fetch(location, {
          method: 'PUT', headers: { 'Content-Length': String(chunk.length), 'Content-Range': `bytes ${start}-${end}/${size}` },
          body: new Uint8Array(chunk), signal: AbortSignal.timeout(300_000),
        }).catch(() => null)
        if (res && (res.status === 308 || res.ok)) break
        if (res && res.status < 500 && res.status !== 429) break
        await sleep(5_000)
      }
      if (!res) throw new ProviderError('transient', 'youtube: upload sem resposta')
      if (res.ok) {
        const video: any = await res.json()
        return { status: 'published', remoteId: video.id, remoteUrl: `https://youtu.be/${video.id}` }
      }
      if (res.status !== 308) {
        const body = await res.text()
        throw new ProviderError(res.status >= 500 ? 'transient' : 'fatal', `youtube: ${classify(body, res.status)?.message ?? `falha no upload (HTTP ${res.status})`}`, body.slice(0, 1000))
      }
    }
    throw new ProviderError('fatal', 'youtube: upload terminou sem confirmação do vídeo')
  },
}

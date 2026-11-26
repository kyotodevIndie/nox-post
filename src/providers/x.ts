// X (Twitter): texto e até 4 imagens pela API v2 (OAuth 2.0 com PKCE, POST /2/tweets e /2/media/upload).
// Vídeo fica de fora (exige upload em partes INIT/APPEND/FINALIZE).
import type { Classify } from './http'
import { pjson } from './http'
import { mediaBlob } from './media'
import type { OAuthCfg } from './oauth'
import { bearer, exchangeCode, jsonBearer, oauthUrl, refreshWith, tokenCreds } from './oauth'
import { rules } from './rules'
import type { Provider } from './types'

const API = 'https://api.x.com/2'

const classify: Classify = (body, status) => {
  if (body.includes('duplicate content')) return { kind: 'fatal', message: 'o X recusou: texto repetido' }
  if (status === 402 || body.includes('CreditsDepleted')) return { kind: 'fatal', message: 'o app do X ficou sem créditos da API' }
  if (status === 403) return { kind: 'fatal', message: 'o X recusou a publicação (permissão do app ou conteúdo)' }
  return undefined
}

const cfg: OAuthCfg = {
  network: 'x', authorize: 'https://x.com/i/oauth2/authorize', token: `${API}/oauth2/token`,
  idEnv: 'X_CLIENT_ID', secretEnv: 'X_CLIENT_SECRET', basic: true, pkce: true, classify,
  scopes: ['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access'],
}

export const x: Provider = {
  network: 'x',
  label: 'X',
  requiredEnv: ['X_CLIENT_ID', 'X_CLIENT_SECRET'],
  authUrl: (p) => oauthUrl(cfg, p),

  async connect(p) {
    const tok = await exchangeCode(cfg, p)
    const { data: u } = await pjson(`${API}/users/me?user.fields=profile_image_url`, { headers: bearer(tok.access_token), classify, label: 'x: perfil' })
    return [{ externalId: u.id, name: u.name, username: u.username, picture: u.profile_image_url, ...tokenCreds(cfg, tok) }]
  },

  refresh: (creds) => refreshWith(cfg, creds),

  validate: rules('X', { maxText: 280, media: 'images', maxMedia: 4 }),

  async publish(channel, creds, post) {
    const ids: string[] = []
    for (const m of post.media) {
      const body = new FormData()
      body.append('media', await mediaBlob(m))
      body.append('media_category', 'tweet_image')
      const up = await pjson(`${API}/media/upload`, { method: 'POST', headers: bearer(creds.accessToken), body, classify, label: 'x: enviar imagem' })
      ids.push(up.data?.id ?? up.media_id_string)
    }
    const { data } = await pjson(`${API}/tweets`, {
      method: 'POST', headers: jsonBearer(creds.accessToken), classify, label: 'x: publicar',
      body: JSON.stringify({ text: post.text, ...(ids.length && { media: { media_ids: ids } }) }),
    })
    return { status: 'published', remoteId: data.id, remoteUrl: `https://x.com/${channel.username ?? 'i'}/status/${data.id}` }
  },
}

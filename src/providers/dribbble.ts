// Dribbble: shot com uma imagem (POST /v2/shots, multipart). Exige settings.title. O Dribbble só aceita imagens
// em tamanhos fixos (400x300, 800x600, 1600x1200...) e conta de "player"; a recusa volta com a mensagem deles.
import { pfetch, pjson } from './http'
import { fileName, mediaBlob } from './media'
import type { OAuthCfg } from './oauth'
import { bearer, exchangeCode, oauthUrl, tokenCreds } from './oauth'
import { rules } from './rules'
import type { Provider } from './types'

const API = 'https://api.dribbble.com/v2'

const cfg: OAuthCfg = {
  network: 'dribbble', authorize: 'https://dribbble.com/oauth/authorize', token: 'https://dribbble.com/oauth/token',
  idEnv: 'DRIBBBLE_CLIENT_ID', secretEnv: 'DRIBBBLE_CLIENT_SECRET', scopes: ['public', 'upload'], defaultExpiresIn: null,
}

export const dribbble: Provider = {
  network: 'dribbble',
  label: 'Dribbble',
  requiredEnv: ['DRIBBBLE_CLIENT_ID', 'DRIBBBLE_CLIENT_SECRET'],
  authUrl: (p) => oauthUrl(cfg, p),

  async connect(p) {
    const tok = await exchangeCode(cfg, p)
    const u = await pjson(`${API}/user`, { headers: bearer(tok.access_token), label: 'dribbble: perfil' })
    // Token do Dribbble não vence.
    return [{ externalId: String(u.id), name: u.name, username: u.login, picture: u.avatar_url, ...tokenCreds(cfg, { access_token: tok.access_token }) }]
  },

  validate(post) {
    const msg = rules('Dribbble', { media: 'images', maxMedia: 1, settings: ['title'] })(post)
    if (msg) return msg
    return post.media.length ? null : 'Dribbble: precisa de uma imagem'
  },

  async publish(channel, creds, post) {
    const body = new FormData()
    body.append('image', await mediaBlob(post.media[0]), fileName(post.media[0].url))
    body.append('title', String(post.settings.title))
    if (post.text) body.append('description', post.text)
    for (const t of post.settings.tags ?? []) body.append('tags[]', String(t))
    // 202 Accepted: o shot é processado em segundo plano e o id vem no Location.
    const res = await pfetch(`${API}/shots`, { method: 'POST', headers: bearer(creds.accessToken), body, any2xx: true, label: 'dribbble: publicar' })
    const id = res.headers.get('location')?.split('/').pop() ?? ''
    return { status: 'published', remoteId: id || `shot-${Date.now()}`, remoteUrl: id ? `https://dribbble.com/shots/${id}` : channel.username ? `https://dribbble.com/${channel.username}` : null }
  },
}

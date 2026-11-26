// Tumblr: post de texto com imagens (formato NPF) em cada blog da conta. settings.tags vira as tags do post.
// Vídeo nativo fica de fora (exige upload multipart junto do post).
import { pjson } from './http'
import type { OAuthCfg } from './oauth'
import { bearer, exchangeCode, jsonBearer, oauthUrl, refreshWith, tokenCreds } from './oauth'
import { rules } from './rules'
import type { Provider } from './types'

const API = 'https://api.tumblr.com/v2'

const cfg: OAuthCfg = {
  network: 'tumblr', authorize: 'https://www.tumblr.com/oauth2/authorize', token: `${API}/oauth2/token`,
  idEnv: 'TUMBLR_CLIENT_ID', secretEnv: 'TUMBLR_CLIENT_SECRET', scopes: ['basic', 'write', 'offline_access'],
}

export const tumblr: Provider = {
  network: 'tumblr',
  label: 'Tumblr',
  requiredEnv: ['TUMBLR_CLIENT_ID', 'TUMBLR_CLIENT_SECRET'],
  authUrl: (p) => oauthUrl(cfg, p),

  async connect(p) {
    const tok = await exchangeCode(cfg, p)
    const { response } = await pjson(`${API}/user/info`, { headers: bearer(tok.access_token), label: 'tumblr: perfil' })
    const creds = tokenCreds(cfg, tok)
    return response.user.blogs.map((b: any) => ({
      externalId: b.uuid ?? b.name, name: b.title || b.name, username: b.name, picture: b.avatar?.[0]?.url, ...creds,
    }))
  },

  refresh: (creds) => refreshWith(cfg, creds),

  validate: rules('Tumblr', { media: 'images', maxMedia: 10 }),

  async publish(channel, creds, post) {
    const content = [
      ...(post.text ? [{ type: 'text', text: post.text }] : []),
      ...post.media.map((m) => ({ type: 'image', media: [{ url: m.url }], ...(m.alt && { alt_text: m.alt }) })),
    ]
    const tags = Array.isArray(post.settings.tags) ? post.settings.tags.join(',') : post.settings.tags
    const { response } = await pjson(`${API}/blog/${channel.username}/posts`, {
      method: 'POST', headers: jsonBearer(creds.accessToken), label: 'tumblr: publicar',
      body: JSON.stringify({ content, ...(tags && { tags }) }),
    })
    const id = String(response.id_string ?? response.id)
    return { status: 'published', remoteId: id, remoteUrl: `https://www.tumblr.com/${channel.username}/${id}` }
  },
}

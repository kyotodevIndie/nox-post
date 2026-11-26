// VK: post no mural (wall.post) com texto e até 10 imagens, login pelo VK ID (OAuth 2.1 com PKCE). settings.group_id
// publica no mural de uma comunidade que a pessoa administra (em nome da comunidade).
import { randomBytes } from 'node:crypto'
import { ProviderError } from '../lib/errors'
import { env, form, pjson } from './http'
import { fileName, mediaBlob } from './media'
import type { OAuthCfg } from './oauth'
import { oauthToken, oauthUrl, refreshWith, tokenCreds } from './oauth'
import { rules } from './rules'
import type { Provider } from './types'

const V = '5.199'

const cfg: OAuthCfg = {
  network: 'vk', authorize: 'https://id.vk.com/authorize', token: 'https://id.vk.com/oauth2/auth',
  idEnv: 'VK_CLIENT_ID', pkce: true, scopes: ['wall', 'photos'],
}

/** A API do VK responde 200 com { error } e o código diz o que houve (5 = autorização). */
async function api(method: string, token: string, params: Record<string, string> = {}) {
  const r = await pjson(`https://api.vk.com/method/${method}`, { method: 'POST', body: form({ ...params, access_token: token, v: V }), label: `vk: ${method}` })
  if (r.error) {
    const kind = r.error.error_code === 5 ? 'reauth' : r.error.error_code === 6 || r.error.error_code === 9 ? 'transient' : 'fatal'
    throw new ProviderError(kind, `vk: ${r.error.error_msg}`, JSON.stringify(r.error))
  }
  return r.response
}

export const vk: Provider = {
  network: 'vk',
  label: 'VK',
  requiredEnv: ['VK_CLIENT_ID'],
  authUrl: (p) => oauthUrl(cfg, p),

  async connect({ code, codeVerifier, redirectUri, query }) {
    const deviceId = query?.device_id
    if (!deviceId) throw new ProviderError('fatal', 'vk: o VK ID não devolveu device_id')
    const tok = await oauthToken(cfg, { grant_type: 'authorization_code', code, code_verifier: codeVerifier ?? '', device_id: deviceId, redirect_uri: redirectUri, state: query?.state ?? '' })
    const { user } = await pjson('https://id.vk.com/oauth2/user_info', { method: 'POST', body: form({ client_id: env('VK_CLIENT_ID'), access_token: tok.access_token }), label: 'vk: perfil' })
    const c = tokenCreds(cfg, tok)
    return [{
      externalId: String(user.user_id ?? tok.user_id), name: `${user.first_name} ${user.last_name}`.trim(), picture: user.avatar,
      credentials: { ...c.credentials, deviceId }, expiresAt: c.expiresAt,
    }]
  },

  refresh: (creds) => refreshWith(cfg, creds, { device_id: String(creds.deviceId), state: randomBytes(16).toString('hex') }),

  validate(post) {
    const msg = rules('VK', { maxText: 16_000, media: 'images', maxMedia: 10 })(post)
    if (msg) return msg
    return post.text || post.media.length ? null : 'VK: mande texto ou imagem'
  },

  async publish(channel, creds, post) {
    const token = creds.accessToken
    const group = post.settings.group_id ? String(post.settings.group_id).replace(/^-/, '') : undefined
    const attachments: string[] = []
    for (const m of post.media) {
      const { upload_url } = await api('photos.getWallUploadServer', token, group ? { group_id: group } : {})
      const body = new FormData()
      body.append('photo', await mediaBlob(m), fileName(m.url))
      const up = await pjson(upload_url, { method: 'POST', body, label: 'vk: enviar imagem' })
      const [photo] = await api('photos.saveWallPhoto', token, { server: String(up.server), photo: up.photo, hash: up.hash, ...(group && { group_id: group }) })
      attachments.push(`photo${photo.owner_id}_${photo.id}`)
    }
    const owner = group ? `-${group}` : channel.externalId
    const r = await api('wall.post', token, {
      owner_id: owner, message: post.text, ...(group && { from_group: '1' }), ...(attachments.length && { attachments: attachments.join(',') }),
    })
    return { status: 'published', remoteId: `${owner}_${r.post_id}`, remoteUrl: `https://vk.com/wall${owner}_${r.post_id}` }
  },
}

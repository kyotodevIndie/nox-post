// Kick: mensagem no chat do próprio canal (API pública, OAuth 2.1 com PKCE). Só texto, até 500 caracteres.
import { ProviderError } from '../lib/errors'
import { pjson } from './http'
import type { OAuthCfg } from './oauth'
import { bearer, exchangeCode, jsonBearer, oauthUrl, refreshWith, tokenCreds } from './oauth'
import { rules } from './rules'
import type { Provider } from './types'

const API = 'https://api.kick.com/public/v1'

const cfg: OAuthCfg = {
  network: 'kick', authorize: 'https://id.kick.com/oauth/authorize', token: 'https://id.kick.com/oauth/token',
  idEnv: 'KICK_CLIENT_ID', secretEnv: 'KICK_CLIENT_SECRET', pkce: true, scopes: ['user:read', 'chat:write'],
}

export const kick: Provider = {
  network: 'kick',
  label: 'Kick',
  requiredEnv: ['KICK_CLIENT_ID', 'KICK_CLIENT_SECRET'],
  authUrl: (p) => oauthUrl(cfg, p),

  async connect(p) {
    const tok = await exchangeCode(cfg, p)
    const { data: [u] } = await pjson(`${API}/users`, { headers: bearer(tok.access_token), label: 'kick: perfil' })
    return [{ externalId: String(u.user_id), name: u.name, username: u.name, picture: u.profile_picture, ...tokenCreds(cfg, tok) }]
  },

  refresh: (creds) => refreshWith(cfg, creds),

  validate: rules('Kick', { text: true, maxText: 500, media: 'none' }),

  async publish(channel, creds, post) {
    const { data } = await pjson(`${API}/chat`, {
      method: 'POST', headers: jsonBearer(creds.accessToken), label: 'kick: enviar mensagem',
      body: JSON.stringify({ type: 'user', broadcaster_user_id: Number(channel.externalId), content: post.text }),
    })
    if (!data?.is_sent) throw new ProviderError('fatal', 'kick: a mensagem não foi enviada (chat fechado ou modo restrito)')
    return { status: 'published', remoteId: data.message_id, remoteUrl: channel.username ? `https://kick.com/${channel.username}` : null }
  },
}

// Twitch: mensagem no chat do próprio canal (Helix POST /chat/messages). Só texto, até 500 caracteres.
import { ProviderError } from '../lib/errors'
import { env, pjson } from './http'
import type { OAuthCfg } from './oauth'
import { bearer, exchangeCode, oauthUrl, refreshWith, tokenCreds } from './oauth'
import { rules } from './rules'
import type { Provider } from './types'

const API = 'https://api.twitch.tv/helix'

const cfg: OAuthCfg = {
  network: 'twitch', authorize: 'https://id.twitch.tv/oauth2/authorize', token: 'https://id.twitch.tv/oauth2/token',
  idEnv: 'TWITCH_CLIENT_ID', secretEnv: 'TWITCH_CLIENT_SECRET', scopes: ['user:write:chat'],
}

const helix = (token: string) => bearer(token, { 'Client-Id': env('TWITCH_CLIENT_ID'), 'Content-Type': 'application/json' })

export const twitch: Provider = {
  network: 'twitch',
  label: 'Twitch',
  requiredEnv: ['TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET'],
  authUrl: (p) => oauthUrl(cfg, p),

  async connect(p) {
    const tok = await exchangeCode(cfg, p)
    const { data: [u] } = await pjson(`${API}/users`, { headers: helix(tok.access_token), label: 'twitch: perfil' })
    return [{ externalId: u.id, name: u.display_name, username: u.login, picture: u.profile_image_url, ...tokenCreds(cfg, tok) }]
  },

  refresh: (creds) => refreshWith(cfg, creds),

  validate: rules('Twitch', { text: true, maxText: 500, media: 'none' }),

  async publish(channel, creds, post) {
    const { data: [m] } = await pjson(`${API}/chat/messages`, {
      method: 'POST', headers: helix(creds.accessToken), label: 'twitch: enviar mensagem',
      body: JSON.stringify({ broadcaster_id: channel.externalId, sender_id: channel.externalId, message: post.text }),
    })
    if (!m?.is_sent) throw new ProviderError('fatal', `twitch: mensagem barrada (${m?.drop_reason?.message ?? 'sem motivo'})`)
    return { status: 'published', remoteId: m.message_id, remoteUrl: channel.username ? `https://www.twitch.tv/${channel.username}` : null }
  },
}

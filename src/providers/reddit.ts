// Reddit: post de texto ou de link num subreddit (POST /api/submit). Exige settings.subreddit e settings.title;
// settings.url transforma em post de link. Upload de imagem/vídeo nativo fica de fora (fluxo de assets + websocket).
import { ProviderError } from '../lib/errors'
import { form, pjson } from './http'
import type { OAuthCfg } from './oauth'
import { bearer, exchangeCode, oauthUrl, refreshWith, tokenCreds } from './oauth'
import { rules } from './rules'
import type { Provider } from './types'

const API = 'https://oauth.reddit.com'
// O Reddit bloqueia chamadas sem User-Agent próprio.
const UA = { 'User-Agent': 'nox-post/1.0 (+https://post.noxlabs.com.br)' }

const cfg: OAuthCfg = {
  network: 'reddit', authorize: 'https://www.reddit.com/api/v1/authorize', token: 'https://www.reddit.com/api/v1/access_token',
  idEnv: 'REDDIT_CLIENT_ID', secretEnv: 'REDDIT_CLIENT_SECRET', basic: true, scopes: ['identity', 'submit'], extraAuth: { duration: 'permanent' }, tokenHeaders: UA,
}

export const reddit: Provider = {
  network: 'reddit',
  label: 'Reddit',
  requiredEnv: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET'],
  authUrl: (p) => oauthUrl(cfg, p),

  async connect(p) {
    const tok = await exchangeCode(cfg, p)
    const me = await pjson(`${API}/api/v1/me`, { headers: bearer(tok.access_token, UA), label: 'reddit: perfil' })
    return [{ externalId: me.id, name: me.name, username: me.name, picture: me.icon_img?.split('?')[0], ...tokenCreds(cfg, tok) }]
  },

  refresh: (creds) => refreshWith(cfg, creds),

  validate(post) {
    const msg = rules('Reddit', { maxText: 40_000, media: 'none', settings: ['subreddit', 'title'] })(post)
    if (msg) return msg
    if (String(post.settings.title).length > 300) return 'Reddit: settings.title passa de 300 caracteres'
    return null
  },

  async publish(_channel, creds, post) {
    const s = post.settings
    const r = await pjson(`${API}/api/submit`, {
      method: 'POST', headers: bearer(creds.accessToken, UA), label: 'reddit: publicar',
      body: form({
        api_type: 'json', sr: String(s.subreddit).replace(/^\/?r\//, ''), title: String(s.title), resubmit: 'true',
        ...(s.url ? { kind: 'link', url: String(s.url) } : { kind: 'self', text: post.text }),
        ...(s.flair_id && { flair_id: String(s.flair_id) }), ...(s.nsfw && { nsfw: 'true' }),
      }),
    })
    const errors = r.json?.errors ?? []
    if (errors.length) throw new ProviderError('fatal', `reddit: ${errors.map((e: any[]) => e.slice(0, 2).join(' ')).join('; ')}`, JSON.stringify(errors))
    return { status: 'published', remoteId: r.json.data.name ?? r.json.data.id, remoteUrl: r.json.data.url ?? null }
  },
}

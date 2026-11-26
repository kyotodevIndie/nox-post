// Google Business Profile (Google Meu Negócio): post de novidade (localPosts) em cada local da conta, com até uma
// foto e botão opcional. Uma conexão traz todos os locais que a pessoa administra. A API do Business Profile
// exige pedir acesso ao Google para o projeto do Cloud.
import { ProviderError } from '../lib/errors'
import type { Classify } from './http'
import { pjson } from './http'
import type { OAuthCfg } from './oauth'
import { bearer, exchangeCode, jsonBearer, oauthUrl, refreshWith, tokenCreds } from './oauth'
import { rules } from './rules'
import type { Provider } from './types'

const classify: Classify = (body) => {
  if (body.includes('invalid_grant')) return { kind: 'reauth', message: 'autorização do Google vencida ou revogada' }
  if (body.includes('SERVICE_DISABLED') || body.includes('has not been used in project')) return { kind: 'fatal', message: 'APIs do Business Profile não ativadas no projeto do Google Cloud' }
  return undefined
}

const cfg: OAuthCfg = {
  network: 'gmb', authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token',
  idEnv: 'GMB_CLIENT_ID', secretEnv: 'GMB_CLIENT_SECRET', pkce: true, classify,
  scopes: ['https://www.googleapis.com/auth/business.manage'],
  extraAuth: { access_type: 'offline', prompt: 'consent select_account' },
}

const CTA = ['BOOK', 'ORDER', 'SHOP', 'LEARN_MORE', 'SIGN_UP', 'CALL']

export const gmb: Provider = {
  network: 'gmb',
  label: 'Google Business Profile',
  requiredEnv: ['GMB_CLIENT_ID', 'GMB_CLIENT_SECRET'],
  authUrl: (p) => oauthUrl(cfg, p),

  async connect(p) {
    const tok = await exchangeCode(cfg, p)
    if (!tok.refresh_token) throw new ProviderError('fatal', 'gmb: o Google não devolveu refresh token; remova o acesso do app na conta Google e conecte de novo')
    const h = { headers: bearer(tok.access_token), classify }
    const { accounts = [] } = await pjson('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', { ...h, label: 'gmb: contas' })
    const creds = tokenCreds(cfg, tok)
    const out = []
    for (const a of accounts) {
      const { locations = [] } = await pjson(`https://mybusinessbusinessinformation.googleapis.com/v1/${a.name}/locations?readMask=name,title&pageSize=100`, { ...h, label: 'gmb: locais' })
      for (const l of locations) out.push({ externalId: l.name, name: l.title, ...creds, meta: { account: a.name } })
    }
    if (!out.length) throw new ProviderError('fatal', 'gmb: nenhum local do Business Profile nessa conta Google')
    return out
  },

  refresh: (creds) => refreshWith(cfg, creds),

  validate(post) {
    const msg = rules('Google Business', { text: true, maxText: 1500, media: 'images', maxMedia: 1 })(post)
    if (msg) return msg
    const { cta_type, cta_url } = post.settings
    if (cta_type && !CTA.includes(cta_type)) return `Google Business: settings.cta_type deve ser ${CTA.join(', ')}`
    if (cta_type && cta_type !== 'CALL' && !cta_url) return 'Google Business: settings.cta_url é obrigatório com o botão'
    return null
  },

  async publish(channel, creds, post) {
    const { cta_type, cta_url } = post.settings
    const r = await pjson(`https://mybusiness.googleapis.com/v4/${channel.meta.account}/${channel.externalId}/localPosts`, {
      method: 'POST', headers: jsonBearer(creds.accessToken), classify, label: 'gmb: publicar',
      body: JSON.stringify({
        languageCode: post.settings.language ?? 'pt-BR', summary: post.text, topicType: 'STANDARD',
        ...(post.media.length && { media: [{ mediaFormat: 'PHOTO', sourceUrl: post.media[0].url }] }),
        ...(cta_type && { callToAction: { actionType: cta_type, ...(cta_url && { url: cta_url }) } }),
      }),
    })
    return { status: 'published', remoteId: r.name, remoteUrl: r.searchUrl ?? null }
  },
}

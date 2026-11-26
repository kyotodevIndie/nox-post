// Lemmy: post numa comunidade (API v3). credentials { instance, username, password }; contas com 2FA não servem.
// Exige settings.community (nome, ou nome@instância para comunidade federada) e settings.title. A primeira mídia
// (ou settings.url) vira o link do post.
import { ProviderError } from '../lib/errors'
import { httpsBase, pjson } from './http'
import { bearer, jsonBearer } from './oauth'
import { rules } from './rules'
import type { Credentials, Provider } from './types'

async function login(instance: string, username: string, password: string): Promise<string> {
  const r = await pjson(`${instance}/api/v3/user/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, label: 'lemmy: login',
    body: JSON.stringify({ username_or_email: username, password }),
    classify: (body) => /incorrect_login|password_incorrect|missing_totp/.test(body) ? { kind: 'reauth', message: 'usuário ou senha do Lemmy recusados (2FA não é suportado)' } : undefined,
  })
  if (!r.jwt) throw new ProviderError('fatal', 'lemmy: login sem token (conta não verificada ou aguardando aprovação)')
  return r.jwt
}

const loginWith = (c: Credentials) => login(String(c.instance), String(c.username), c.accessToken)

export const lemmy: Provider = {
  network: 'lemmy',
  label: 'Lemmy',
  requiredEnv: [],
  credentialFields: ['instance', 'username', 'password'],

  async connectWith({ instance, username, password }) {
    const base = httpsBase(instance, 'instance')
    const jwt = await login(base, username.trim(), password)
    const site = await pjson(`${base}/api/v3/site`, { headers: bearer(jwt), label: 'lemmy: perfil' })
    const person = site.my_user?.local_user_view?.person
    if (!person) throw new ProviderError('fatal', 'lemmy: a instância não devolveu o perfil')
    const host = new URL(base).host
    return [{
      externalId: `${person.id}@${host}`, name: person.display_name || person.name, username: `${person.name}@${host}`, picture: person.avatar,
      credentials: { accessToken: password, username: username.trim(), instance: base }, expiresAt: null,
    }]
  },

  validate(post) {
    const msg = rules('Lemmy', { maxText: 50_000, maxMedia: 1, settings: ['community', 'title'] })(post)
    if (msg) return msg
    return String(post.settings.title).length > 200 ? 'Lemmy: settings.title passa de 200 caracteres' : null
  },

  async publish(_channel, creds, post) {
    const jwt = await loginWith(creds)
    const instance = String(creds.instance)
    const c = await pjson(`${instance}/api/v3/community?name=${encodeURIComponent(String(post.settings.community).replace(/^!/, ''))}`, {
      headers: bearer(jwt), label: 'lemmy: comunidade',
      classify: (body) => body.includes('couldnt_find_community') ? { kind: 'fatal', message: `comunidade ${post.settings.community} não encontrada` } : undefined,
    })
    const url = post.settings.url ?? post.media[0]?.url
    const r = await pjson(`${instance}/api/v3/post`, {
      method: 'POST', headers: jsonBearer(jwt), label: 'lemmy: publicar',
      body: JSON.stringify({
        name: String(post.settings.title), community_id: c.community_view.community.id,
        ...(post.text && { body: post.text }), ...(url && { url }), ...(post.settings.nsfw && { nsfw: true }),
      }),
    })
    const p = r.post_view.post
    return { status: 'published', remoteId: String(p.id), remoteUrl: p.ap_id ?? `${instance}/post/${p.id}` }
  },
}

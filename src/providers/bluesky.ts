// Bluesky (AT Protocol): post com até 4 imagens. credentials { identifier, appPassword, service? } com uma senha de
// app (Configurações → Privacidade e segurança → Senhas de app), nunca a senha da conta. A sessão é aberta a cada
// publicação, então não há token para renovar. Links viram clicáveis (facets). Vídeo fica de fora.
import { ProviderError } from '../lib/errors'
import { httpsBase, pjson } from './http'
import { mediaBuffer, mimeOf } from './media'
import { bearer, jsonBearer } from './oauth'
import { rules } from './rules'
import type { Credentials, Provider } from './types'

const MAX_GRAPHEMES = 300
const graphemes = (s: string) => [...new Intl.Segmenter().segment(s)].length

async function session(c: { service: string; identifier: string; password: string }) {
  return pjson(`${c.service}/xrpc/com.atproto.server.createSession`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, label: 'bluesky: login',
    body: JSON.stringify({ identifier: c.identifier, password: c.password }),
    classify: (body, status) => status === 401 || body.includes('AuthenticationRequired') ? { kind: 'reauth', message: 'usuário ou senha de app do Bluesky recusados' } : undefined,
  })
}

/** Facets de link: o Bluesky não deixa URL clicável sozinho e mede as posições em bytes UTF-8. */
export function linkFacets(text: string) {
  const enc = new TextEncoder()
  return [...text.matchAll(/https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]]/g)].map((m) => {
    const byteStart = enc.encode(text.slice(0, m.index)).length
    return { index: { byteStart, byteEnd: byteStart + enc.encode(m[0]).length }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: m[0] }] }
  })
}

const sessionOf = (creds: Credentials) => session({ service: String(creds.service), identifier: String(creds.identifier), password: creds.accessToken })

export const bluesky: Provider = {
  network: 'bluesky',
  label: 'Bluesky',
  requiredEnv: [],
  credentialFields: ['identifier', 'appPassword', 'service?'],

  async connectWith({ identifier, appPassword, service }) {
    const base = httpsBase(service || 'https://bsky.social', 'service')
    const s = await session({ service: base, identifier: identifier.trim().replace(/^@/, ''), password: appPassword.trim() })
    const profile = await pjson(`${base}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(s.did)}`, { headers: bearer(s.accessJwt), label: 'bluesky: perfil' }).catch(() => ({}))
    return [{
      externalId: s.did, name: (profile as any).displayName || s.handle, username: s.handle, picture: (profile as any).avatar,
      // accessToken guarda a senha de app (cifrada como os demais tokens).
      credentials: { accessToken: appPassword.trim(), identifier: s.did, service: base }, expiresAt: null,
    }]
  },

  validate(post) {
    if (graphemes(post.text) > MAX_GRAPHEMES) return `Bluesky: o texto passa de ${MAX_GRAPHEMES} caracteres`
    return rules('Bluesky', { media: 'images', maxMedia: 4 })(post) ?? (post.text || post.media.length ? null : 'Bluesky: mande texto ou imagem')
  },

  async publish(channel, creds, post) {
    const s = await sessionOf(creds)
    const service = String(creds.service)
    const images = []
    for (const m of post.media) {
      const up = await pjson(`${service}/xrpc/com.atproto.repo.uploadBlob`, {
        method: 'POST', headers: bearer(s.accessJwt, { 'Content-Type': mimeOf(m) }), body: new Uint8Array(await mediaBuffer(m.url)), label: 'bluesky: enviar imagem',
        classify: (body) => body.includes('BlobTooLarge') ? { kind: 'fatal', message: 'imagem passa do limite do Bluesky (~1 MB)' } : undefined,
      })
      images.push({ alt: m.alt ?? '', image: up.blob })
    }
    const facets = linkFacets(post.text)
    const r = await pjson(`${service}/xrpc/com.atproto.repo.createRecord`, {
      method: 'POST', headers: jsonBearer(s.accessJwt), label: 'bluesky: publicar',
      body: JSON.stringify({
        repo: s.did, collection: 'app.bsky.feed.post',
        record: {
          $type: 'app.bsky.feed.post', text: post.text, createdAt: new Date().toISOString(),
          ...(post.settings.langs && { langs: [].concat(post.settings.langs) }),
          ...(facets.length && { facets }),
          ...(images.length && { embed: { $type: 'app.bsky.embed.images', images } }),
        },
      }),
    })
    if (!r.uri) throw new ProviderError('fatal', 'bluesky: resposta sem uri')
    return { status: 'published', remoteId: r.uri, remoteUrl: `https://bsky.app/profile/${channel.username ?? s.handle}/post/${r.uri.split('/').pop()}` }
  },
}

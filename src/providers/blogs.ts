// Plataformas de artigo, todas por chave de API: DEV (dev.to), Medium, Hashnode e WordPress. O texto é o corpo
// em Markdown (WordPress: HTML), settings.title é obrigatório e a primeira imagem vira a capa quando a
// plataforma aceita. settings.tags (lista), settings.canonical_url e settings.draft valem para todas.
import { ProviderError } from '../lib/errors'
import { httpsBase, pjson } from './http'
import { fileName, mediaBuffer, mimeOf } from './media'
import { bearer, jsonBearer } from './oauth'
import { rules } from './rules'
import type { PostInput, Provider } from './types'

const article = (label: string) => rules(label, { text: true, media: 'images', maxMedia: 1, settings: ['title'] })
const tags = (post: PostInput, max: number): string[] => [].concat(post.settings.tags ?? []).slice(0, max).map(String)

// ---- DEV: credentials { apiKey } (Configurações → Extensões → DEV Community API Keys)
const DEV = 'https://dev.to/api'
const devHeaders = (key: string) => ({ 'api-key': key, Accept: 'application/vnd.forem.api-v1+json', 'Content-Type': 'application/json' })

export const devto: Provider = {
  network: 'devto',
  label: 'DEV',
  requiredEnv: [],
  credentialFields: ['apiKey'],

  async connectWith({ apiKey }) {
    const u = await pjson(`${DEV}/users/me`, { headers: devHeaders(apiKey.trim()), label: 'devto: perfil' })
    return [{ externalId: String(u.id), name: u.name, username: u.username, picture: u.profile_image, credentials: { accessToken: apiKey.trim() }, expiresAt: null }]
  },

  validate: article('DEV'),

  async publish(_channel, creds, post) {
    const s = post.settings
    const a = await pjson(`${DEV}/articles`, {
      method: 'POST', headers: devHeaders(creds.accessToken), label: 'devto: publicar',
      body: JSON.stringify({
        article: {
          title: s.title, body_markdown: post.text, published: !s.draft, tags: tags(post, 4),
          ...(post.media[0] && { main_image: post.media[0].url }), ...(s.canonical_url && { canonical_url: s.canonical_url }),
          ...(s.series && { series: s.series }), ...(s.organization_id && { organization_id: s.organization_id }),
        },
      }),
    })
    return { status: 'published', remoteId: String(a.id), remoteUrl: a.url ?? null }
  },
}

// ---- Medium: credentials { token }. O Medium não emite tokens de integração novos desde 2023: só serve para
// quem já tem um.
const MEDIUM = 'https://api.medium.com/v1'

export const medium: Provider = {
  network: 'medium',
  label: 'Medium',
  requiredEnv: [],
  credentialFields: ['token'],

  async connectWith({ token }) {
    const { data: u } = await pjson(`${MEDIUM}/me`, { headers: bearer(token.trim()), label: 'medium: perfil' })
    return [{ externalId: u.id, name: u.name, username: u.username, picture: u.imageUrl, credentials: { accessToken: token.trim() }, expiresAt: null }]
  },

  validate: (post) => rules('Medium', { text: true, media: 'none', settings: ['title'] })(post),

  async publish(channel, creds, post) {
    const s = post.settings
    const { data } = await pjson(`${MEDIUM}/users/${channel.externalId}/posts`, {
      method: 'POST', headers: jsonBearer(creds.accessToken), label: 'medium: publicar',
      body: JSON.stringify({
        title: s.title, contentFormat: 'markdown', content: `# ${s.title}\n\n${post.text}`, tags: tags(post, 5),
        publishStatus: s.draft ? 'draft' : 'public', ...(s.canonical_url && { canonicalUrl: s.canonical_url }),
      }),
    })
    return { status: 'published', remoteId: data.id, remoteUrl: data.url ?? null }
  },
}

// ---- Hashnode: credentials { token } (Configurações → Developer → Personal Access Token). Cada publicação
// (blog) da conta vira um canal.
async function gql(token: string, query: string, variables: Record<string, unknown> = {}) {
  const r = await pjson('https://gql.hashnode.com', {
    method: 'POST', headers: { Authorization: token, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }), label: 'hashnode',
  })
  if (r.errors?.length) {
    const unauth = r.errors.some((e: any) => e.extensions?.code === 'UNAUTHENTICATED')
    throw new ProviderError(unauth ? 'reauth' : 'fatal', `hashnode: ${r.errors.map((e: any) => e.message).join('; ')}`)
  }
  return r.data
}

export const hashnode: Provider = {
  network: 'hashnode',
  label: 'Hashnode',
  requiredEnv: [],
  credentialFields: ['token'],

  async connectWith({ token }) {
    const { me } = await gql(token.trim(), 'query { me { username profilePicture publications(first: 50) { edges { node { id title url } } } } }')
    const pubs = me.publications.edges.map((e: any) => e.node)
    if (!pubs.length) throw new ProviderError('fatal', 'hashnode: a conta não tem nenhum blog')
    return pubs.map((p: any) => ({
      externalId: p.id, name: p.title, username: me.username, picture: me.profilePicture,
      credentials: { accessToken: token.trim() }, expiresAt: null, meta: { url: p.url },
    }))
  },

  validate: article('Hashnode'),

  async publish(channel, creds, post) {
    const s = post.settings
    const input = {
      title: s.title, contentMarkdown: post.text, publicationId: channel.externalId,
      tags: tags(post, 5).map((t) => ({ slug: t.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name: t })),
      ...(post.media[0] && { coverImageOptions: { coverImageURL: post.media[0].url } }),
      ...(s.canonical_url && { originalArticleURL: s.canonical_url }),
    }
    if (s.draft) {
      const d = await gql(creds.accessToken, 'mutation($input: CreateDraftInput!) { createDraft(input: $input) { draft { id } } }', { input })
      return { status: 'published', remoteId: d.createDraft.draft.id, remoteUrl: null }
    }
    const d = await gql(creds.accessToken, 'mutation($input: PublishPostInput!) { publishPost(input: $input) { post { id url } } }', { input })
    return { status: 'published', remoteId: d.publishPost.post.id, remoteUrl: d.publishPost.post.url ?? null }
  },
}

// ---- WordPress (auto-hospedado, 5.6+): credentials { site, username, appPassword } com uma senha de aplicação
// (Usuários → Perfil → Senhas de aplicação). settings.status: publish (padrão), draft, private ou future.
const wpAuth = (user: string, pass: string) => ({ Authorization: `Basic ${Buffer.from(`${user}:${pass.replace(/\s+/g, '')}`).toString('base64')}` })

export const wordpress: Provider = {
  network: 'wordpress',
  label: 'WordPress',
  requiredEnv: [],
  credentialFields: ['site', 'username', 'appPassword'],

  async connectWith({ site, username, appPassword }) {
    const base = httpsBase(site, 'site')
    const auth = wpAuth(username.trim(), appPassword)
    const u = await pjson(`${base}/wp-json/wp/v2/users/me?context=edit`, { headers: auth, label: 'wordpress: perfil' })
    if (!u.capabilities?.publish_posts) throw new ProviderError('fatal', 'wordpress: o usuário não pode publicar posts')
    const info = await pjson(`${base}/wp-json`, { label: 'wordpress: site' }).catch(() => ({}))
    return [{
      externalId: `${new URL(base).host}:${u.id}`, name: (info as any).name || new URL(base).host, username: u.slug, picture: u.avatar_urls?.['96'],
      credentials: { accessToken: appPassword.replace(/\s+/g, ''), username: username.trim(), site: base }, expiresAt: null,
    }]
  },

  validate: article('WordPress'),

  async publish(_channel, creds, post) {
    const base = String(creds.site)
    const auth = wpAuth(String(creds.username), creds.accessToken)
    let featured: number | undefined
    if (post.media[0]) {
      const m = post.media[0]
      const up = await pjson(`${base}/wp-json/wp/v2/media`, {
        method: 'POST', label: 'wordpress: enviar imagem', body: new Uint8Array(await mediaBuffer(m.url)),
        headers: { ...auth, 'Content-Type': mimeOf(m), 'Content-Disposition': `attachment; filename="${fileName(m.url).replace(/"/g, '')}"` },
      })
      featured = up.id
    }
    const s = post.settings
    const p = await pjson(`${base}/wp-json/wp/v2/posts`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, label: 'wordpress: publicar',
      body: JSON.stringify({
        title: s.title, content: post.text, status: s.draft ? 'draft' : (s.status ?? 'publish'),
        ...(featured && { featured_media: featured }), ...(s.excerpt && { excerpt: s.excerpt }),
      }),
    })
    return { status: 'published', remoteId: String(p.id), remoteUrl: p.link ?? null }
  },
}

// LinkedIn: perfil pessoal (`linkedin`) e página de empresa (`linkedin-page`). Texto, imagens (uma ou várias) ou um vídeo.
// Adaptado de linkedin.provider.ts e linkedin.page.provider.ts do Postiz (gitroomhq/postiz-app, AGPL-3.0):
// OAuth, refresh, initializeUpload de imagem/vídeo, checagem de processamento, fixText e /rest/posts.
import { ProviderError } from '../lib/errors'
import type { Classify } from './http'
import { env, form, pfetch, pjson, requireScopes } from './http'
import { isVideo, mediaBuffer, mediaChunk, mediaSize } from './media'
import type { ChannelCtx, ConnectedAccount, Credentials, PostInput, Provider, PublishOutcome } from './types'

const VERSION = '202601'
const PERSONAL_SCOPES = ['openid', 'profile', 'w_member_social']
const PAGE_SCOPES = [...PERSONAL_SCOPES, 'r_organization_social', 'w_organization_social', 'rw_organization_admin']

const classify: Classify = (body) => {
  if (body.includes('Unable to obtain activity')) return { kind: 'retry', message: 'LinkedIn não encontrou a atividade' }
  if (body.includes('resource is forbidden') || body.includes('Service Unavailable')) return { kind: 'retry', message: 'LinkedIn indisponível' }
  if (body.includes('REVOKED_ACCESS_TOKEN') || body.includes('EXPIRED_ACCESS_TOKEN')) return { kind: 'reauth', message: 'token do LinkedIn vencido ou revogado' }
  return undefined
}

const rest = (token: string, extra: Record<string, string> = {}) => ({
  'X-Restli-Protocol-Version': '2.0.0', 'LinkedIn-Version': VERSION, Authorization: `Bearer ${token}`, ...extra,
})

/** O commentary do LinkedIn usa a sintaxe "little text": escapa os caracteres reservados, mantendo menções @[Nome](urn:li:organization:..). */
export function fixText(text: string): string {
  const pattern = /@\[.+?]\(urn:li:organization.+?\)/g
  const mentions = text.match(pattern) || []
  return text.split(pattern).map((part, i) => part.replace(/[\\<>#~_|[\]*(){}@]/g, (c) => `\\${c}`) + (mentions[i] ?? '')).join('')
}

function authUrl(scopes: string[]) {
  return ({ state, redirectUri }: { state: string; redirectUri: string }) => {
    const url = new URL('https://www.linkedin.com/oauth/v2/authorization')
    url.search = form({ response_type: 'code', client_id: env('LINKEDIN_CLIENT_ID'), redirect_uri: redirectUri, state, scope: scopes.join(' ') }).toString()
    return { url: url.toString() }
  }
}

async function exchange(code: string, redirectUri: string, scopes: string[]) {
  const tok = await pjson('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, label: 'linkedin: trocar code',
    body: form({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: env('LINKEDIN_CLIENT_ID'), client_secret: env('LINKEDIN_CLIENT_SECRET') }),
  })
  requireScopes(scopes, tok.scope, 'linkedin')
  const me = await pjson('https://api.linkedin.com/v2/userinfo', { headers: { Authorization: `Bearer ${tok.access_token}` }, label: 'linkedin: perfil' })
  return { tok, me }
}

const toCreds = (tok: any): { credentials: Credentials; expiresAt: Date | null } => ({
  credentials: { accessToken: tok.access_token, refreshToken: tok.refresh_token },
  // Sem refresh token (app sem esse recurso liberado) o canal precisa ser reconectado quando o token de 60 dias vencer.
  expiresAt: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000) : null,
})

async function refresh(creds: Credentials) {
  if (!creds.refreshToken) throw new ProviderError('reauth', 'linkedin: token vencido e sem refresh token, reconecte o canal')
  const tok = await pjson('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, label: 'linkedin: renovar token',
    classify: (body, status) => (status === 400 || status === 401 ? { kind: 'reauth', message: 'refresh token do LinkedIn recusado, reconecte o canal' } : undefined),
    body: form({ grant_type: 'refresh_token', refresh_token: creds.refreshToken, client_id: env('LINKEDIN_CLIENT_ID'), client_secret: env('LINKEDIN_CLIENT_SECRET') }),
  })
  const out = toCreds(tok)
  out.credentials.refreshToken ??= creds.refreshToken
  return out
}

type Poll = { urn: string; endpoint: 'videos' | 'images' }
interface Pending { author: string; message: string; mediaIds: string[]; poll: Poll[]; graceChecks: number; stalls?: number }

/** initializeUpload + PUT dos bytes (vídeo em partes, seguindo as uploadInstructions) + finalizeUpload. */
async function upload(token: string, owner: string, url: string, video: boolean): Promise<string> {
  const endpoint = video ? 'videos' : 'images'
  const size = video ? await mediaSize(url) : 0
  const init = await pjson(`https://api.linkedin.com/rest/${endpoint}?action=initializeUpload`, {
    method: 'POST', headers: rest(token, { 'Content-Type': 'application/json' }), classify, label: 'linkedin: iniciar upload',
    body: JSON.stringify({ initializeUploadRequest: { owner, ...(video ? { fileSizeBytes: size, uploadCaptions: false, uploadThumbnail: false } : {}) } }),
  })
  const v = init.value
  if (!video) {
    await pfetch(v.uploadUrl, { method: 'PUT', headers: rest(token), body: new Uint8Array(await mediaBuffer(url)), any2xx: true, classify, label: 'linkedin: enviar imagem' })
    return v.image
  }
  const etags: string[] = []
  const cache: { buf?: Buffer } = {}
  for (const ins of v.uploadInstructions ?? []) {
    const chunk = await mediaChunk(url, ins.firstByte, ins.lastByte, cache)
    const res = await pfetch(ins.uploadUrl, {
      method: 'PUT', headers: rest(token, { 'Content-Type': 'application/octet-stream' }), body: new Uint8Array(chunk), any2xx: true, classify, label: 'linkedin: enviar vídeo',
    })
    etags.push(res.headers.get('etag') ?? '')
  }
  await pfetch('https://api.linkedin.com/rest/videos?action=finalizeUpload', {
    method: 'POST', headers: rest(token, { 'Content-Type': 'application/json' }), any2xx: true, classify, label: 'linkedin: finalizar vídeo',
    body: JSON.stringify({ finalizeUploadRequest: { video: v.video, uploadToken: v.uploadToken ?? '', uploadedPartIds: etags } }),
  })
  return v.video
}

async function publish(owner: string, creds: Credentials, post: PostInput, company: boolean): Promise<PublishOutcome> {
  const mediaIds: string[] = []
  const poll: Poll[] = []
  let graceChecks = 0
  for (const m of post.media) {
    const video = isVideo(m)
    const id = await upload(creds.accessToken, owner, m.url, video)
    mediaIds.push(id)
    // Imagem de perfil pessoal não tem endpoint de status confiável: espera um ciclo antes de usar (igual ao Postiz).
    if (video || company) poll.push({ urn: id, endpoint: video ? 'videos' : 'images' })
    else graceChecks = 1
  }
  const pendingData: Pending = { author: owner, message: post.text, mediaIds, poll, graceChecks }
  if (!mediaIds.length) return createPost(creds.accessToken, pendingData)
  return { status: 'processing', pendingData }
}

async function createPost(token: string, p: Pending): Promise<PublishOutcome> {
  const content = !p.mediaIds.length ? {}
    : p.mediaIds.length === 1 ? { content: { media: { id: p.mediaIds[0] } } }
    : { content: { multiImage: { images: p.mediaIds.map((id) => ({ id })) } } }
  const res = await pfetch('https://api.linkedin.com/rest/posts', {
    method: 'POST', headers: rest(token, { 'Content-Type': 'application/json' }), classify, label: 'linkedin: publicar',
    body: JSON.stringify({
      author: p.author, commentary: fixText(p.message), visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      ...content, lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false,
    }),
  })
  const id = res.headers.get('x-restli-id') ?? ''
  return { status: 'published', remoteId: id, remoteUrl: id ? `https://www.linkedin.com/feed/update/${id}` : null }
}

async function check(_c: ChannelCtx, creds: Credentials, p: Pending): Promise<PublishOutcome> {
  const still: Poll[] = []
  for (const m of p.poll) {
    let st: any
    try {
      st = await pjson(`https://api.linkedin.com/rest/${m.endpoint}/${encodeURIComponent(m.urn)}`, { headers: rest(creds.accessToken), classify, label: 'linkedin: status da mídia' })
    } catch (e) {
      if (e instanceof ProviderError && e.kind === 'reauth') throw e
      if ((p.stalls ?? 0) >= 10) throw new ProviderError('fatal', 'linkedin: a checagem da mídia falhou várias vezes; nada foi publicado')
      return { status: 'processing', pendingData: { ...p, stalls: (p.stalls ?? 0) + 1 } }
    }
    if (st.status === 'PROCESSING_FAILED') throw new ProviderError('fatal', `linkedin: processamento da mídia falhou${st.processingFailureReason ? `: ${st.processingFailureReason}` : ''}`)
    if (st.status !== 'AVAILABLE') still.push(m)
  }
  if (still.length) return { status: 'processing', pendingData: { ...p, poll: still, stalls: 0 } }
  if (p.graceChecks > 0) return { status: 'processing', pendingData: { ...p, poll: [], graceChecks: p.graceChecks - 1 } }
  return createPost(creds.accessToken, p)
}

function validate(post: PostInput): string | null {
  const videos = post.media.filter(isVideo)
  if (videos.length && post.media.length > 1) return 'LinkedIn: um vídeo sozinho ou só imagens, sem misturar'
  if (post.media.length > 20) return 'LinkedIn: no máximo 20 imagens'
  if (post.text.length > 3000) return 'LinkedIn: texto passa de 3.000 caracteres'
  if (!post.text && !post.media.length) return 'LinkedIn: post vazio'
  return null
}

export const linkedin: Provider = {
  network: 'linkedin',
  label: 'LinkedIn (perfil)',
  requiredEnv: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
  authUrl: authUrl(PERSONAL_SCOPES),
  async connect({ code, redirectUri }) {
    const { tok, me } = await exchange(code, redirectUri, PERSONAL_SCOPES)
    return [{ externalId: me.sub, name: me.name, picture: me.picture, ...toCreds(tok) }]
  },
  refresh,
  validate,
  publish: (channel, creds, post) => publish(`urn:li:person:${channel.externalId}`, creds, post, false),
  check,
}

export const linkedinPage: Provider = {
  network: 'linkedin-page',
  label: 'LinkedIn (página de empresa)',
  requiredEnv: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
  authUrl: authUrl(PAGE_SCOPES),
  async connect({ code, redirectUri }) {
    const { tok } = await exchange(code, redirectUri, PAGE_SCOPES)
    const acl = await pjson(
      'https://api.linkedin.com/v2/organizationalEntityAcls?q=roleAssignee&state=APPROVED&projection=(elements*(role,organizationalTarget~(localizedName,vanityName,logoV2(original~:playableStreams))))',
      { headers: rest(tok.access_token), label: 'linkedin: listar páginas' },
    )
    const pages: ConnectedAccount[] = (acl.elements ?? [])
      .filter((e: any) => e['organizationalTarget~'] && ['ADMINISTRATOR', 'CONTENT_ADMINISTRATOR'].includes(e.role))
      .map((e: any) => ({
        externalId: String(e.organizationalTarget).split(':').pop()!,
        name: e['organizationalTarget~'].localizedName,
        username: e['organizationalTarget~'].vanityName,
        picture: e['organizationalTarget~'].logoV2?.['original~']?.elements?.[0]?.identifiers?.[0]?.identifier,
        ...toCreds(tok),
      }))
    if (!pages.length) throw new ProviderError('fatal', 'linkedin: a conta não administra nenhuma página de empresa')
    return pages
  },
  refresh,
  validate,
  publish: (channel, creds, post) => publish(`urn:li:organization:${channel.externalId}`, creds, post, true),
  check,
}

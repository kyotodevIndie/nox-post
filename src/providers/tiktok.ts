// TikTok: vídeo pela Content Posting API (upload direto em partes). Sem auditoria do app, o TikTok só aceita SELF_ONLY.
// Adaptado de tiktok.provider.ts do Postiz (gitroomhq/postiz-app, AGPL-3.0) e do tiktok.ts do PostGo:
// OAuth, refresh, creator_info, plano de partes, upload e status do publish_id.
import { ProviderError } from '../lib/errors'
import type { Classify } from './http'
import { env, form, pfetch, pjson, requireScopes } from './http'
import { isVideo, mediaChunk, mediaSize } from './media'
import type { ChannelCtx, Credentials, Provider, PublishOutcome } from './types'

const API = 'https://open.tiktokapis.com/v2'
const SCOPES = ['user.info.basic', 'user.info.profile', 'video.publish', 'video.upload']
const MAX_SINGLE_CHUNK = 64 * 1024 * 1024
const CHUNK = 10 * 1024 * 1024

const classify: Classify = (body) => {
  if (body.includes('access_token_invalid')) return { kind: 'reauth', message: 'token do TikTok inválido, reconecte o canal' }
  if (body.includes('scope_not_authorized') || body.includes('scope_permission_missed')) return { kind: 'reauth', message: 'faltam permissões do TikTok, reconecte e aceite todas' }
  if (body.includes('spam_risk_too_many_posts')) return { kind: 'fatal', message: 'o TikTok limitou: posts demais hoje' }
  if (body.includes('spam_risk_user_banned_from_posting')) return { kind: 'fatal', message: 'a conta está impedida de postar pelo TikTok' }
  if (body.includes('unaudited_client_can_only_post_to_private_accounts')) return { kind: 'fatal', message: 'app sem auditoria do TikTok: a conta precisa ser privada e o post SELF_ONLY' }
  if (body.includes('privacy_level_option_mismatch')) return { kind: 'fatal', message: 'privacidade não permitida para esta conta' }
  if (body.includes('rate_limit_exceeded')) return { kind: 'retry', message: 'limite de chamadas do TikTok' }
  return undefined
}

const json = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' })

const toCreds = (tok: any) => ({
  credentials: { accessToken: tok.access_token, refreshToken: tok.refresh_token },
  expiresAt: new Date(Date.now() + (tok.expires_in ?? 86_400) * 1000),
})

interface Pending { publishId: string; checks?: number }

/** O TikTok devolve publicaly_available_post_id como int64; JSON.parse arredonda acima de 2^53, então lê os dígitos do texto. */
export function postIdFromRaw(raw: string): string | undefined {
  return raw.match(/"publicaly_available_post_id"\s*:\s*\[\s*"?(\d+)/)?.[1]
}

export const tiktok: Provider = {
  network: 'tiktok',
  label: 'TikTok',
  requiredEnv: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'],

  authUrl({ state, redirectUri }) {
    const url = new URL('https://www.tiktok.com/v2/auth/authorize/')
    url.search = form({ client_key: env('TIKTOK_CLIENT_KEY'), redirect_uri: redirectUri, state, response_type: 'code', scope: SCOPES.join(',') }).toString()
    return { url: url.toString() }
  },

  async connect({ code, redirectUri }) {
    const tok = await pjson(`${API}/oauth/token/`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, classify, label: 'tiktok: trocar code',
      body: form({ client_key: env('TIKTOK_CLIENT_KEY'), client_secret: env('TIKTOK_CLIENT_SECRET'), code, grant_type: 'authorization_code', redirect_uri: redirectUri }),
    })
    if (tok.error) throw new ProviderError('fatal', `tiktok: ${tok.error_description ?? tok.error}`)
    requireScopes(SCOPES, tok.scope, 'tiktok')
    const info = await pjson(`${API}/user/info/?fields=open_id,display_name,avatar_url,username`, {
      headers: { Authorization: `Bearer ${tok.access_token}` }, classify, label: 'tiktok: perfil',
    })
    const u = info.data.user
    return [{ externalId: u.open_id ?? tok.open_id, name: u.display_name, username: u.username, picture: u.avatar_url, ...toCreds(tok) }]
  },

  async refresh(creds) {
    if (!creds.refreshToken) throw new ProviderError('reauth', 'tiktok: sem refresh token, reconecte o canal')
    const tok = await pjson(`${API}/oauth/token/`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, classify, label: 'tiktok: renovar token',
      body: form({ client_key: env('TIKTOK_CLIENT_KEY'), client_secret: env('TIKTOK_CLIENT_SECRET'), grant_type: 'refresh_token', refresh_token: creds.refreshToken }),
    })
    if (tok.error) throw new ProviderError('reauth', `tiktok: refresh recusado (${tok.error_description ?? tok.error}), reconecte o canal`)
    return toCreds(tok)
  },

  validate(post) {
    if (post.media.length !== 1 || !isVideo(post.media[0])) return 'TikTok: precisa de exatamente um vídeo'
    if (post.text.length > 2200) return 'TikTok: legenda passa de 2.200 caracteres'
    return null
  },

  async publish(_channel, creds, post) {
    const token = creds.accessToken
    // As diretrizes do TikTok exigem respeitar as opções de privacidade que a conta realmente permite.
    const info = (await pjson(`${API}/post/publish/creator_info/query/`, { method: 'POST', headers: json(token), body: '{}', classify, label: 'tiktok: creator_info' })).data
    const privacy = post.settings.privacy_level ?? 'SELF_ONLY'
    if (!(info.privacy_level_options ?? []).includes(privacy)) {
      throw new ProviderError('fatal', `tiktok: privacidade ${privacy} não permitida (permitidas: ${(info.privacy_level_options ?? []).join(', ')}). App sem auditoria só posta SELF_ONLY.`)
    }
    const url = post.media[0].url
    const size = await mediaSize(url)
    const chunkSize = size <= MAX_SINGLE_CHUNK ? size : CHUNK
    const count = size <= MAX_SINGLE_CHUNK ? 1 : Math.floor(size / CHUNK)

    const init = await pjson(`${API}/post/publish/video/init/`, {
      method: 'POST', headers: json(token), classify, label: 'tiktok: iniciar post',
      body: JSON.stringify({
        post_info: {
          title: post.text.slice(0, 2200), privacy_level: privacy,
          disable_comment: !!(post.settings.disable_comment ?? info.comment_disabled),
          disable_duet: !!(post.settings.disable_duet ?? info.duet_disabled),
          disable_stitch: !!(post.settings.disable_stitch ?? info.stitch_disabled),
          brand_content_toggle: !!post.settings.brand_content_toggle,
          brand_organic_toggle: !!post.settings.brand_organic_toggle,
          is_aigc: !!post.settings.is_aigc,
        },
        source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunkSize, total_chunk_count: count },
      }),
    })
    const { publish_id, upload_url } = init.data

    const cache: { buf?: Buffer } = {}
    for (let i = 0; i < count; i++) {
      const start = i * chunkSize
      // A última parte leva o que sobrar do arquivo.
      const end = (i === count - 1 ? size : start + chunkSize) - 1
      await pfetch(upload_url, {
        method: 'PUT', any2xx: true, label: `tiktok: enviar parte ${i + 1}/${count}`,
        headers: { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${start}-${end}/${size}` },
        body: new Uint8Array(await mediaChunk(url, start, end, cache)),
      })
    }
    return { status: 'processing', pendingData: { publishId: publish_id } satisfies Pending }
  },

  async check(channel: ChannelCtx, creds: Credentials, p: Pending): Promise<PublishOutcome> {
    const res = await pfetch(`${API}/post/publish/status/fetch/`, {
      method: 'POST', headers: json(creds.accessToken), body: JSON.stringify({ publish_id: p.publishId }), classify, label: 'tiktok: status',
    })
    const raw = await res.text()
    const st = JSON.parse(raw).data ?? {}
    if (st.status === 'FAILED') throw new ProviderError('fatal', `tiktok: o vídeo foi recusado (${st.fail_reason ?? 'sem motivo'})`)
    if (st.status === 'PUBLISH_COMPLETE') {
      const postId = postIdFromRaw(raw)
      // Post SELF_ONLY não ganha id público: fica o publish_id.
      return {
        status: 'published', remoteId: postId ?? p.publishId,
        remoteUrl: postId && channel.username ? `https://www.tiktok.com/@${channel.username}/video/${postId}` : null,
      }
    }
    return { status: 'processing', pendingData: { ...p, checks: (p.checks ?? 0) + 1 } }
  },
}

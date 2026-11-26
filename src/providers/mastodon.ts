// Mastodon (e compatíveis, como GoToSocial): status com até 4 mídias em qualquer instância. O token sai de
// Preferências → Desenvolvimento → Nova aplicação, com os escopos read:accounts, write:statuses e write:media.
// credentials { instance, accessToken }. Vídeo é processado pela instância: o worker espera antes de postar.
import { randomUUID } from 'node:crypto'
import { httpsBase, pfetch, pjson } from './http'
import { fileName, mediaBlob } from './media'
import { bearer, jsonBearer } from './oauth'
import { rules } from './rules'
import type { ChannelCtx, Credentials, PostInput, Provider, PublishOutcome } from './types'

interface Pending { mediaIds: string[]; key: string; checks?: number }

async function postStatus(creds: Credentials, post: Pick<PostInput, 'text' | 'settings'>, p: Pending): Promise<PublishOutcome> {
  const s = await pjson(`${creds.instance}/api/v1/statuses`, {
    method: 'POST', label: 'mastodon: publicar',
    // A mesma chave em retentativas não duplica o status.
    headers: { ...jsonBearer(creds.accessToken), 'Idempotency-Key': p.key },
    body: JSON.stringify({
      status: post.text, media_ids: p.mediaIds, visibility: post.settings.visibility ?? 'public',
      ...(post.settings.spoiler_text && { spoiler_text: post.settings.spoiler_text, sensitive: true }),
      ...(post.settings.language && { language: post.settings.language }),
    }),
  })
  return { status: 'published', remoteId: s.id, remoteUrl: s.url ?? null }
}

/** Mídia ainda processando volta 206 (ou url nula). */
async function mediaReady(creds: Credentials, id: string) {
  const res = await pfetch(`${creds.instance}/api/v1/media/${id}`, { headers: bearer(creds.accessToken), any2xx: true, label: 'mastodon: mídia' })
  return res.status === 200 && ((await res.json()) as any).url != null
}

export const mastodon: Provider = {
  network: 'mastodon',
  label: 'Mastodon',
  requiredEnv: [],
  credentialFields: ['instance', 'accessToken'],

  async connectWith({ instance, accessToken }) {
    const base = httpsBase(instance, 'instance')
    const u = await pjson(`${base}/api/v1/accounts/verify_credentials`, { headers: bearer(accessToken.trim()), label: 'mastodon: perfil' })
    const host = new URL(base).host
    return [{
      externalId: `${u.id}@${host}`, name: u.display_name || u.username, username: `${u.username}@${host}`, picture: u.avatar,
      credentials: { accessToken: accessToken.trim(), instance: base }, expiresAt: null,
    }]
  },

  validate: (post) => rules('Mastodon', { maxText: 500, maxMedia: 4 })(post) ?? (post.text || post.media.length ? null : 'Mastodon: mande texto ou mídia'),

  async publish(_channel, creds, post) {
    const mediaIds: string[] = []
    let pending = false
    for (const m of post.media) {
      const body = new FormData()
      body.append('file', await mediaBlob(m), fileName(m.url))
      if (m.alt) body.append('description', m.alt)
      const res = await pfetch(`${creds.instance}/api/v2/media`, { method: 'POST', headers: bearer(creds.accessToken), body, any2xx: true, label: 'mastodon: enviar mídia' })
      const media: any = await res.json()
      mediaIds.push(media.id)
      if (res.status === 202 || media.url == null) pending = true
    }
    const p: Pending = { mediaIds, key: randomUUID() }
    if (pending) return { status: 'processing', pendingData: { ...p, text: post.text, settings: post.settings } }
    return postStatus(creds, post, p)
  },

  async check(_channel: ChannelCtx, creds: Credentials, p: Pending & Pick<PostInput, 'text' | 'settings'>): Promise<PublishOutcome> {
    for (const id of p.mediaIds) if (!(await mediaReady(creds, id))) return { status: 'processing', pendingData: { ...p, checks: (p.checks ?? 0) + 1 } }
    return postStatus(creds, p, p)
  },
}

// Instagram Profissional ligado a uma Página do Facebook: foto, carrossel (2 a 10), Reels e Stories.
// Adaptado de instagram.provider.ts do Postiz (gitroomhq/postiz-app, AGPL-3.0): containers de mídia,
// checagem de status_code, container de carrossel e media_publish (postPending / checkPostStatus / finalizePost).
import { ProviderError } from '../lib/errors'
import { pjson } from './http'
import { isVideo } from './media'
import { GRAPH, INSTAGRAM_RULES, classifyWith, metaAuthUrl, metaLongLivedToken, metaPages } from './meta'
import type { ChannelCtx, Credentials, Provider, PublishOutcome } from './types'

const SCOPES = ['instagram_basic', 'pages_show_list', 'pages_read_engagement', 'business_management', 'instagram_content_publish']
const classify = classifyWith(INSTAGRAM_RULES)

interface Pending {
  postType: 'single' | 'carousel' | 'stories'
  containers: string[]
  message: string
  carouselId?: string
  published?: string[]
}

async function containerStatus(id: string, token: string): Promise<string> {
  const r = await pjson(`${GRAPH}/${id}?fields=status_code,status&access_token=${token}`, { classify, label: 'instagram: status da mídia' })
  if (r.status_code === 'ERROR' || r.status_code === 'EXPIRED') {
    const known = classify(String(r.status ?? ''), 200)
    throw new ProviderError('fatal', `instagram: ${known?.message ?? r.status ?? 'o Instagram não conseguiu processar a mídia'}`, JSON.stringify(r))
  }
  return r.status_code
}

async function permalink(mediaId: string, token: string, channel: ChannelCtx): Promise<string> {
  try {
    const r = await pjson(`${GRAPH}/${mediaId}?fields=permalink&access_token=${token}`, { label: 'instagram: link' })
    return r.permalink
  } catch {
    return `https://www.instagram.com/${channel.username ?? ''}`
  }
}

async function mediaPublish(channel: ChannelCtx, token: string, creationId: string): Promise<string> {
  const r = await pjson(`${GRAPH}/${channel.externalId}/media_publish?creation_id=${creationId}&access_token=${token}`, {
    method: 'POST', classify, label: 'instagram: publicar',
  })
  return r.id
}

export const instagram: Provider = {
  network: 'instagram',
  label: 'Instagram (via Página do Facebook)',
  requiredEnv: ['FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET'],

  authUrl: ({ state, redirectUri }) => metaAuthUrl({ state, redirectUri, scopes: SCOPES }),

  async connect({ code, redirectUri }) {
    const userToken = await metaLongLivedToken({ code, redirectUri, scopes: SCOPES, label: 'instagram' })
    const pages = (await metaPages(userToken, 'id,name,access_token,instagram_business_account')).filter((p) => p.instagram_business_account)
    if (!pages.length) throw new ProviderError('fatal', 'instagram: nenhuma conta Profissional ligada a uma página autorizada foi encontrada')
    const out = []
    for (const p of pages) {
      const ig = await pjson(`${GRAPH}/${p.instagram_business_account.id}?fields=id,username,name,profile_picture_url&access_token=${p.access_token}`, {
        label: 'instagram: dados da conta',
      })
      out.push({
        externalId: String(ig.id), name: ig.name || ig.username, username: ig.username, picture: ig.profile_picture_url,
        credentials: { accessToken: p.access_token }, expiresAt: null, meta: { pageId: String(p.id) },
      })
    }
    return out
  },

  validate(post) {
    const story = post.settings.post_type === 'story'
    if (!post.media.length) return 'Instagram: precisa de pelo menos uma imagem ou vídeo'
    if (!story && post.media.length > 10) return 'Instagram: carrossel aceita no máximo 10 mídias'
    if (post.text.length > 2200) return 'Instagram: legenda passa de 2.200 caracteres'
    return null
  },

  async publish(_channel, creds, post) {
    const story = post.settings.post_type === 'story'
    const carousel = post.media.length > 1 && !story
    const containers: string[] = []
    for (const m of post.media) {
      const q = new URLSearchParams({ access_token: creds.accessToken })
      if (isVideo(m)) {
        q.set('video_url', m.url)
        q.set('media_type', story ? 'STORIES' : carousel ? 'VIDEO' : 'REELS')
        if (m.thumbnail && !story && !carousel) q.set('cover_url', m.thumbnail)
      } else {
        q.set('image_url', m.url)
        if (story) q.set('media_type', 'STORIES')
        if (m.alt && !story) q.set('alt_text', m.alt)
      }
      if (carousel) q.set('is_carousel_item', 'true')
      if (post.media.length === 1 && !story) q.set('caption', post.text)
      const r = await pjson(`${GRAPH}/${_channel.externalId}/media?${q}`, { method: 'POST', classify, label: 'instagram: criar mídia' })
      containers.push(r.id)
    }
    const pendingData: Pending = { postType: story ? 'stories' : carousel ? 'carousel' : 'single', containers, message: post.text }
    return { status: 'processing', pendingData }
  },

  async check(channel: ChannelCtx, creds: Credentials, p: Pending): Promise<PublishOutcome> {
    const token = creds.accessToken
    if (p.carouselId) {
      const st = await containerStatus(p.carouselId, token)
      if (st === 'IN_PROGRESS') return { status: 'processing', pendingData: p }
      const mediaId = await mediaPublish(channel, token, p.carouselId)
      return { status: 'published', remoteId: mediaId, remoteUrl: await permalink(mediaId, token, channel) }
    }

    for (const id of p.containers) {
      if (p.published?.includes(id)) continue
      if ((await containerStatus(id, token)) === 'IN_PROGRESS') return { status: 'processing', pendingData: p }
    }

    if (p.postType === 'carousel') {
      const q = new URLSearchParams({ media_type: 'CAROUSEL', children: p.containers.join(','), caption: p.message, access_token: token })
      const r = await pjson(`${GRAPH}/${channel.externalId}/media?${q}`, { method: 'POST', classify, label: 'instagram: criar carrossel' })
      return { status: 'processing', pendingData: { ...p, carouselId: r.id } }
    }

    if (p.postType === 'stories') {
      // Cada mídia vira um story. Guarda as já publicadas para uma nova checagem não repetir.
      const published = [...(p.published ?? [])]
      let last = ''
      for (const id of p.containers) {
        if (published.includes(id)) continue
        last = await mediaPublish(channel, token, id)
        published.push(id)
      }
      return { status: 'published', remoteId: last || p.containers.at(-1)!, remoteUrl: `https://www.instagram.com/stories/${channel.username ?? ''}` }
    }

    const mediaId = await mediaPublish(channel, token, p.containers[0])
    return { status: 'published', remoteId: mediaId, remoteUrl: await permalink(mediaId, token, channel) }
  },
}

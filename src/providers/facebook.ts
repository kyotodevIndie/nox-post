// Página do Facebook: texto, link, fotos (várias) ou um vídeo.
// Adaptado de facebook.provider.ts do Postiz (gitroomhq/postiz-app, AGPL-3.0): mesmo fluxo de OAuth, páginas,
// /photos não publicadas + /feed com attached_media, e /videos com file_url.
import { ProviderError } from '../lib/errors'
import { pjson } from './http'
import { isVideo } from './media'
import { FACEBOOK_RULES, GRAPH, classifyWith, metaAuthUrl, metaLongLivedToken, metaPages } from './meta'
import type { Provider } from './types'

const SCOPES = ['pages_show_list', 'business_management', 'pages_manage_posts', 'pages_read_engagement']
const classify = classifyWith(FACEBOOK_RULES)

export const facebook: Provider = {
  network: 'facebook',
  label: 'Página do Facebook',
  requiredEnv: ['FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET'],

  authUrl: ({ state, redirectUri }) => metaAuthUrl({ state, redirectUri, scopes: SCOPES }),

  async connect({ code, redirectUri }) {
    const userToken = await metaLongLivedToken({ code, redirectUri, scopes: SCOPES, label: 'facebook' })
    const pages = await metaPages(userToken, 'id,username,name,access_token,picture.type(large)')
    if (!pages.length) throw new ProviderError('fatal', 'facebook: nenhuma página com permissão de publicação foi autorizada')
    // Token de página obtido de um token de usuário longo não vence (só se a pessoa revogar ou trocar a senha).
    return pages.map((p) => ({
      externalId: String(p.id), name: p.name, username: p.username, picture: p.picture?.data?.url,
      credentials: { accessToken: p.access_token }, expiresAt: null,
    }))
  },

  validate(post) {
    const videos = post.media.filter(isVideo)
    if (videos.length > 1 || (videos.length && post.media.length > 1)) return 'Facebook: um vídeo sozinho ou só fotos, sem misturar'
    if (!post.text && !post.media.length && !post.settings.link) return 'Facebook: post vazio'
    return null
  },

  async publish(channel, creds, post) {
    const id = channel.externalId
    const token = creds.accessToken
    const json = { 'Content-Type': 'application/json' }

    if (post.media.length === 1 && isVideo(post.media[0])) {
      const v = await pjson(`${GRAPH}/${id}/videos?access_token=${token}&fields=id,permalink_url`, {
        method: 'POST', headers: json, classify, label: 'facebook: enviar vídeo',
        body: JSON.stringify({
          file_url: post.media[0].url, description: post.text, published: true,
          ...(post.settings.title ? { title: post.settings.title } : {}),
        }),
      })
      return { status: 'published', remoteId: v.id, remoteUrl: `https://www.facebook.com/reel/${v.id}` }
    }

    const photos = []
    for (const m of post.media) {
      const p = await pjson(`${GRAPH}/${id}/photos?access_token=${token}`, {
        method: 'POST', headers: json, classify, label: 'facebook: enviar foto',
        body: JSON.stringify({ url: m.url, published: false }),
      })
      photos.push({ media_fbid: p.id })
    }
    const feed = await pjson(`${GRAPH}/${id}/feed?access_token=${token}&fields=id,permalink_url`, {
      method: 'POST', headers: json, classify, label: 'facebook: publicar',
      body: JSON.stringify({
        message: post.text, published: true,
        ...(photos.length ? { attached_media: photos } : {}),
        ...(post.settings.link ? { link: post.settings.link } : {}),
      }),
    })
    return { status: 'published', remoteId: feed.id, remoteUrl: feed.permalink_url ?? null }
  },
}

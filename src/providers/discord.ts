// Discord: mensagem num canal por webhook (Configurações do canal → Integrações → Webhooks → Copiar URL).
// Sem bot e sem app: o tenant manda credentials { webhookUrl }. Imagens vão como embeds; vídeo, como link.
import { ProviderError } from '../lib/errors'
import { pjson } from './http'
import { isVideo } from './media'
import { rules } from './rules'
import type { Provider } from './types'

const HOOK = /^https:\/\/(?:ptb\.|canary\.)?(?:discord|discordapp)\.com\/api\/webhooks\/(\d+)\/([\w-]+)$/

export const discord: Provider = {
  network: 'discord',
  label: 'Discord',
  requiredEnv: [],
  credentialFields: ['webhookUrl'],

  async connectWith({ webhookUrl }) {
    const url = webhookUrl.trim()
    if (!HOOK.test(url)) throw new ProviderError('fatal', 'discord: webhookUrl inválido (esperado https://discord.com/api/webhooks/<id>/<token>)')
    const w = await pjson(url, { label: 'discord: webhook' })
    return [{
      externalId: w.id, name: w.name, picture: w.avatar ? `https://cdn.discordapp.com/avatars/${w.id}/${w.avatar}.png` : undefined,
      credentials: { accessToken: url }, expiresAt: null, meta: { guild: w.guild_id, channel: w.channel_id },
    }]
  },

  validate(post) {
    const msg = rules('Discord', { maxText: 2000, maxMedia: 10 })(post)
    if (msg) return msg
    return post.text || post.media.length ? null : 'Discord: mande texto ou mídia'
  },

  async publish(channel, creds, post) {
    const videos = post.media.filter(isVideo).map((m) => m.url)
    const embeds = post.media.filter((m) => !isVideo(m)).map((m) => ({ image: { url: m.url }, ...(m.alt && { description: m.alt }) }))
    const msg = await pjson(`${creds.accessToken}?wait=true`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, label: 'discord: publicar',
      // Webhook apagado responde 404 (Unknown Webhook): só cadastrando de novo.
      classify: (body, status) => status === 404 ? { kind: 'reauth', message: 'webhook do Discord apagado, conecte de novo' } : undefined,
      body: JSON.stringify({
        content: [post.text, ...videos].filter(Boolean).join('\n'), embeds,
        ...(post.settings.username && { username: post.settings.username }), ...(post.settings.avatar_url && { avatar_url: post.settings.avatar_url }),
      }),
    })
    const guild = channel.meta.guild
    return { status: 'published', remoteId: msg.id, remoteUrl: guild ? `https://discord.com/channels/${guild}/${msg.channel_id}/${msg.id}` : null }
  },
}

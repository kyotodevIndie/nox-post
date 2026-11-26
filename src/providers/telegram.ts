// Telegram: mensagem num canal ou grupo por um bot (crie no @BotFather e adicione como admin do canal).
// credentials { botToken, chatId } (chatId = @canal ou o id numérico). O Telegram baixa a mídia pela URL.
import { ProviderError } from '../lib/errors'
import type { Classify } from './http'
import { pjson } from './http'
import { isVideo } from './media'
import type { Credentials, Provider } from './types'

const classify: Classify = (body, status) => {
  if (status === 403 || body.includes('chat not found')) return { kind: 'reauth', message: 'o bot não tem mais acesso ao chat (removido ou sem permissão de admin)' }
  return undefined
}

async function bot(creds: Credentials, method: string, payload: Record<string, unknown>) {
  const r = await pjson(`https://api.telegram.org/bot${creds.accessToken}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), classify, label: `telegram: ${method}`,
  })
  if (!r.ok) throw new ProviderError('fatal', `telegram: ${r.description}`)
  return r.result
}

export const telegram: Provider = {
  network: 'telegram',
  label: 'Telegram',
  requiredEnv: [],
  credentialFields: ['botToken', 'chatId'],

  async connectWith({ botToken, chatId }) {
    if (!/^\d+:[\w-]+$/.test(botToken.trim())) throw new ProviderError('fatal', 'telegram: botToken inválido (formato 123456:ABC...)')
    const creds = { accessToken: botToken.trim(), chatId: chatId.trim() }
    const chat = await bot(creds, 'getChat', { chat_id: creds.chatId })
    return [{
      externalId: String(chat.id), name: chat.title ?? chat.first_name ?? chat.username, username: chat.username,
      credentials: { ...creds, chatId: String(chat.id) }, expiresAt: null,
    }]
  },

  validate(post) {
    const max = post.media.length ? 1024 : 4096
    if ([...post.text].length > max) return `Telegram: o texto passa de ${max.toLocaleString('pt-BR')} caracteres${post.media.length ? ' (legenda de mídia)' : ''}`
    if (post.media.length > 10) return 'Telegram: no máximo 10 mídias por post'
    return post.text || post.media.length ? null : 'Telegram: mande texto ou mídia'
  },

  async publish(channel, creds, post) {
    const base = {
      chat_id: creds.chatId, ...(post.settings.parse_mode && { parse_mode: post.settings.parse_mode }),
      ...(post.settings.disable_notification && { disable_notification: true }),
    }
    const [first] = post.media
    let msg: any
    if (!first) msg = await bot(creds, 'sendMessage', { ...base, text: post.text })
    else if (post.media.length === 1) {
      msg = isVideo(first)
        ? await bot(creds, 'sendVideo', { ...base, video: first.url, caption: post.text })
        : await bot(creds, 'sendPhoto', { ...base, photo: first.url, caption: post.text })
    } else {
      const media = post.media.map((m, i) => ({ type: isVideo(m) ? 'video' : 'photo', media: m.url, ...(i === 0 && { caption: post.text, ...(base.parse_mode && { parse_mode: base.parse_mode }) }) }))
      ;[msg] = await bot(creds, 'sendMediaGroup', { chat_id: base.chat_id, media })
    }
    return { status: 'published', remoteId: String(msg.message_id), remoteUrl: channel.username ? `https://t.me/${channel.username}/${msg.message_id}` : null }
  },
}

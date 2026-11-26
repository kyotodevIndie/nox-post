// Slack: mensagem num canal escolhido na tela de autorização (escopo incoming-webhook). Cada conexão vira um canal
// do Slack com o webhook dele; imagens vão como blocos de imagem (URL pública).
import { ProviderError } from '../lib/errors'
import { env, form, pfetch, pjson } from './http'
import { isVideo } from './media'
import { rules } from './rules'
import type { Provider } from './types'

export const slack: Provider = {
  network: 'slack',
  label: 'Slack',
  requiredEnv: ['SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET'],

  authUrl({ state, redirectUri }) {
    const url = new URL('https://slack.com/oauth/v2/authorize')
    url.search = form({ client_id: env('SLACK_CLIENT_ID'), scope: 'incoming-webhook', redirect_uri: redirectUri, state }).toString()
    return { url: url.toString() }
  },

  async connect({ code, redirectUri }) {
    const r = await pjson('https://slack.com/api/oauth.v2.access', {
      method: 'POST', label: 'slack: trocar code',
      body: form({ client_id: env('SLACK_CLIENT_ID'), client_secret: env('SLACK_CLIENT_SECRET'), code, redirect_uri: redirectUri }),
    })
    if (!r.ok) throw new ProviderError('fatal', `slack: ${r.error}`)
    const hook = r.incoming_webhook
    return [{
      externalId: `${r.team.id}:${hook.channel_id}`, name: `${r.team.name} ${hook.channel}`, username: hook.channel,
      credentials: { accessToken: r.access_token, webhookUrl: hook.url }, expiresAt: null, meta: { team: r.team.id, channel: hook.channel_id },
    }]
  },

  validate(post) {
    const msg = rules('Slack', { maxText: post.media.length ? 3000 : 40_000, maxMedia: 10 })(post)
    if (msg) return msg
    return post.text || post.media.length ? null : 'Slack: mande texto ou mídia'
  },

  async publish(channel, creds, post) {
    // Vídeo não tem bloco próprio: vai como link no texto.
    const videos = post.media.filter(isVideo).map((m) => m.url)
    const text = [post.text, ...videos].filter(Boolean).join('\n')
    const images = post.media.filter((m) => !isVideo(m))
    const blocks = images.length
      ? [...(text ? [{ type: 'section', text: { type: 'mrkdwn', text } }] : []), ...images.map((m) => ({ type: 'image', image_url: m.url, alt_text: m.alt || 'imagem' }))]
      : undefined
    const res = await pfetch(String(creds.webhookUrl), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, label: 'slack: publicar',
      body: JSON.stringify({ text: text || 'imagem', ...(blocks && { blocks }) }),
      // Webhook removido ou canal arquivado: só reconectando.
      classify: (body) => /no_service|channel_is_archived|invalid_token|no_team/.test(body) ? { kind: 'reauth', message: 'webhook do Slack removido, reconecte o canal' } : undefined,
    })
    await res.text()
    // O webhook não devolve o id da mensagem.
    return { status: 'published', remoteId: `${channel.meta.channel ?? channel.externalId}:${Date.now()}`, remoteUrl: null }
  },
}

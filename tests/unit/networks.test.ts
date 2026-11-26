import { schnorr } from '@noble/curves/secp256k1.js'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { devto, hashnode, medium, wordpress } from '../../src/providers/blogs'
import { bluesky, linkFacets } from '../../src/providers/bluesky'
import { discord } from '../../src/providers/discord'
import { dribbble } from '../../src/providers/dribbble'
import { farcaster } from '../../src/providers/farcaster'
import { gmb } from '../../src/providers/gmb'
import { httpsBase, setSleep } from '../../src/providers/http'
import { allNetworks, enabledProviders } from '../../src/providers/index'
import { kick } from '../../src/providers/kick'
import { lemmy } from '../../src/providers/lemmy'
import { mastodon } from '../../src/providers/mastodon'
import { bech32Decode, bech32Encode, nostr, signEvent } from '../../src/providers/nostr'
import { pinterest } from '../../src/providers/pinterest'
import { reddit } from '../../src/providers/reddit'
import { slack } from '../../src/providers/slack'
import { telegram } from '../../src/providers/telegram'
import { threads } from '../../src/providers/threads'
import { tumblr } from '../../src/providers/tumblr'
import { twitch } from '../../src/providers/twitch'
import type { ChannelCtx, PostInput } from '../../src/providers/types'
import { vk } from '../../src/providers/vk'
import { x } from '../../src/providers/x'

// Providers novos com HTTP falso: cada teste declara as rotas que a rede responde e confere as chamadas.

const ENV = ['X', 'THREADS_APP', 'PINTEREST', 'REDDIT', 'GMB', 'DRIBBBLE', 'TUMBLR', 'SLACK', 'KICK', 'TWITCH']
beforeAll(() => {
  setSleep(async () => {})
  for (const k of ENV) {
    const [id, secret] = k.endsWith('_APP') ? [`${k}_ID`, `${k}_SECRET`] : [`${k}_CLIENT_ID`, `${k}_CLIENT_SECRET`]
    process.env[id] = `${k.toLowerCase()}-id`
    process.env[secret] = `${k.toLowerCase()}-secret`
  }
  process.env.VK_CLIENT_ID = 'vk-id'
})
afterEach(() => vi.unstubAllGlobals())

const res = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })

interface Call { method: string; url: string; body: any; headers: Record<string, string> }
type Route = [string | RegExp, (c: Call) => Response]

/** fetch falso: a primeira rota que casa com "MÉTODO url" responde; o resto dá 404. Devolve as chamadas feitas. */
function mockFetch(routes: Route[]) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const b = init.body
    const body = typeof b === 'string' ? (b.startsWith('{') ? JSON.parse(b) : b) : b instanceof URLSearchParams ? Object.fromEntries(b) : b
    const c: Call = { method: init.method ?? 'GET', url: String(url), body, headers: Object.fromEntries(new Headers(init.headers as any)) }
    calls.push(c)
    const key = `${c.method} ${c.url}`
    const hit = routes.find(([m]) => (typeof m === 'string' ? key.startsWith(m) : m.test(key)))
    return hit ? hit[1](c) : res(404, `sem rota para ${key}`)
  }))
  return calls
}

const img = (n = 1) => ({ url: `https://cdn.test/${n}.jpg`, type: 'image' as const })
const vid = { url: 'https://cdn.test/v.mp4', type: 'video' as const }
const p = (o: Partial<PostInput> = {}): PostInput => ({ text: '', media: [], settings: {}, ...o })
const ch = (o: Partial<ChannelCtx> = {}): ChannelCtx => ({ externalId: '1', name: 'Conta', username: 'conta', meta: {}, ...o })
const IMG_ROUTE: Route = [/^GET https:\/\/cdn\.test\//, () => res(200, 'bytes')]

describe('registro', () => {
  it('redes por credenciais aparecem sempre; OAuth só com env', () => {
    const on = enabledProviders({}).map((p) => p.network)
    expect(on).toEqual(expect.arrayContaining(['discord', 'telegram', 'mastodon', 'bluesky', 'lemmy', 'farcaster', 'nostr', 'devto', 'medium', 'hashnode', 'wordpress']))
    expect(on).not.toContain('x')
    expect(enabledProviders({ X_CLIENT_ID: 'a', X_CLIENT_SECRET: 'b' }).map((p) => p.network)).toContain('x')
  })
  it('toda rede conecta por OAuth ou por credenciais', () => {
    expect(allNetworks()).toHaveLength(28)
    for (const n of enabledProviders({ ...process.env, FACEBOOK_APP_ID: 'a', FACEBOOK_APP_SECRET: 'b', LINKEDIN_CLIENT_ID: 'a', LINKEDIN_CLIENT_SECRET: 'b', YOUTUBE_CLIENT_ID: 'a', YOUTUBE_CLIENT_SECRET: 'b', TIKTOK_CLIENT_KEY: 'a', TIKTOK_CLIENT_SECRET: 'b' })) {
      expect(!!(n.authUrl && n.connect) !== !!(n.connectWith && n.credentialFields)).toBe(true)
    }
  })
  it('httpsBase só aceita HTTPS e tira a barra', () => {
    expect(httpsBase('mastodon.social/', 'instance')).toBe('https://mastodon.social')
    expect(() => httpsBase('http://x.test', 'instance')).toThrow(/HTTPS/)
  })
})

describe('x', () => {
  it('authUrl com PKCE e escopos', () => {
    const { url, codeVerifier } = x.authUrl!({ state: 's1', redirectUri: 'https://api.test/oauth/x/callback' })
    const u = new URL(url)
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.searchParams.get('scope')).toContain('offline.access')
    expect(codeVerifier).toBeTruthy()
  })
  it('connect usa Basic e lê o perfil', async () => {
    const calls = mockFetch([
      ['POST https://api.x.com/2/oauth2/token', () => res(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 7200 })],
      ['GET https://api.x.com/2/users/me', () => res(200, { data: { id: '42', name: 'Nox', username: 'nox' } })],
    ])
    const [a] = await x.connect!({ code: 'c', codeVerifier: 'v', redirectUri: 'https://api.test/cb' })
    expect(a).toMatchObject({ externalId: '42', username: 'nox', credentials: { accessToken: 'AT', refreshToken: 'RT' } })
    expect(calls[0].headers.authorization).toMatch(/^Basic /)
    expect(calls[0].body).toMatchObject({ grant_type: 'authorization_code', code_verifier: 'v' })
  })
  it('sobe as imagens e publica o tweet', async () => {
    const calls = mockFetch([IMG_ROUTE,
      ['POST https://api.x.com/2/media/upload', () => res(200, { data: { id: 'M1' } })],
      ['POST https://api.x.com/2/tweets', () => res(201, { data: { id: '99' } })],
    ])
    const out = await x.publish(ch(), { accessToken: 'AT' }, p({ text: 'oi', media: [img()] }))
    expect(out).toEqual({ status: 'published', remoteId: '99', remoteUrl: 'https://x.com/conta/status/99' })
    expect(calls.at(-1)!.body).toEqual({ text: 'oi', media: { media_ids: ['M1'] } })
  })
  it('validação', () => {
    expect(x.validate(p({ text: 'a'.repeat(281) }))).toMatch(/280/)
    expect(x.validate(p({ media: [vid] }))).toMatch(/vídeo/)
    expect(x.validate(p({ media: [img(1), img(2), img(3), img(4), img(5)] }))).toMatch(/4/)
  })
  it('refresh recusado vira reauth', async () => {
    mockFetch([['POST https://api.x.com/2/oauth2/token', () => res(400, { error: 'invalid_request' })]])
    await expect(x.refresh!({ accessToken: 'a', refreshToken: 'r' }, ch())).rejects.toMatchObject({ kind: 'reauth' })
  })
})

describe('threads', () => {
  const T = 'https://graph.threads.net'
  it('texto publica direto', async () => {
    mockFetch([
      [`POST ${T}/v1.0/1/threads_publish`, () => res(200, { id: 'P1' })],
      [`POST ${T}/v1.0/1/threads`, () => res(200, { id: 'C1' })],
      [`GET ${T}/v1.0/P1`, () => res(200, { permalink: 'https://threads.net/@conta/post/x' })],
    ])
    expect(await threads.publish(ch(), { accessToken: 't' }, p({ text: 'oi' }))).toEqual({ status: 'published', remoteId: 'P1', remoteUrl: 'https://threads.net/@conta/post/x' })
  })
  it('carrossel: itens → espera → pai → publica', async () => {
    let n = 0
    const calls = mockFetch([
      [`POST ${T}/v1.0/1/threads_publish`, () => res(200, { id: 'P9' })],
      [`POST ${T}/v1.0/1/threads`, (c) => res(200, { id: c.body.media_type === 'CAROUSEL' ? 'PAI' : `I${++n}` })],
      [/GET .*fields=status/, () => res(200, { status: 'FINISHED' })],
      [/GET .*fields=permalink/, () => res(200, {})],
    ])
    const first = await threads.publish(ch(), { accessToken: 't' }, p({ text: 'oi', media: [img(1), img(2)] }))
    expect(first).toMatchObject({ status: 'processing', pendingData: { children: ['I1', 'I2'], carousel: true } })
    const second = await threads.check!(ch(), { accessToken: 't' }, (first as any).pendingData)
    expect(second).toMatchObject({ pendingData: { parent: 'PAI' } })
    expect(await threads.check!(ch(), { accessToken: 't' }, (second as any).pendingData)).toMatchObject({ status: 'published', remoteId: 'P9' })
    expect(calls.find((c) => c.body?.media_type === 'CAROUSEL')!.body.children).toBe('I1,I2')
  })
  it('container com ERROR falha', async () => {
    mockFetch([[/GET .*fields=status/, () => res(200, { status: 'ERROR', error_message: 'formato' })]])
    await expect(threads.check!(ch(), { accessToken: 't' }, { children: ['I1'], carousel: false, text: '' })).rejects.toMatchObject({ kind: 'fatal', message: /formato/ })
  })
})

describe('pinterest', () => {
  it('acha a pasta pelo nome e cria o pin', async () => {
    const calls = mockFetch([
      ['GET https://api.pinterest.com/v5/boards', () => res(200, { items: [{ id: '777', name: 'Receitas' }] })],
      ['POST https://api.pinterest.com/v5/pins', () => res(201, { id: 'PIN1' })],
    ])
    const out = await pinterest.publish(ch(), { accessToken: 't' }, p({ text: 'desc', media: [img()], settings: { board: 'receitas', title: 'Bolo' } }))
    expect(out).toMatchObject({ remoteId: 'PIN1', remoteUrl: 'https://www.pinterest.com/pin/PIN1/' })
    expect(calls[1].body).toMatchObject({ board_id: '777', media_source: { source_type: 'image_url' } })
  })
  it('exige pasta e imagem', () => {
    expect(pinterest.validate(p({ media: [img()] }))).toMatch(/board/)
    expect(pinterest.validate(p({ settings: { board: '1' } }))).toMatch(/imagem/)
  })
})

describe('reddit', () => {
  it('post de texto e erros do /api/submit', async () => {
    const calls = mockFetch([['POST https://oauth.reddit.com/api/submit', () => res(200, { json: { errors: [], data: { name: 't3_abc', url: 'https://reddit.com/r/x/abc' } } })]])
    const out = await reddit.publish(ch(), { accessToken: 't' }, p({ text: 'corpo', settings: { subreddit: 'r/test', title: 'Oi' } }))
    expect(out).toMatchObject({ remoteId: 't3_abc' })
    expect(calls[0].body).toMatchObject({ sr: 'test', kind: 'self', text: 'corpo' })
    expect(calls[0].headers['user-agent']).toMatch(/nox-post/)
    mockFetch([['POST https://oauth.reddit.com/api/submit', () => res(200, { json: { errors: [['SUBREDDIT_NOEXIST', 'não existe', 'sr']] } })]])
    await expect(reddit.publish(ch(), { accessToken: 't' }, p({ settings: { subreddit: 'x', title: 'y' } }))).rejects.toMatchObject({ kind: 'fatal', message: /SUBREDDIT_NOEXIST/ })
  })
  it('exige subreddit e título, sem mídia', () => {
    expect(reddit.validate(p({ settings: { title: 'x' } }))).toMatch(/subreddit/)
    expect(reddit.validate(p({ media: [img()], settings: { subreddit: 'a', title: 'b' } }))).toMatch(/só texto/)
  })
})

describe('gmb', () => {
  it('connect traz um canal por local', async () => {
    mockFetch([
      ['POST https://oauth2.googleapis.com/token', () => res(200, { access_token: 'A', refresh_token: 'R', expires_in: 3600 })],
      ['GET https://mybusinessaccountmanagement.googleapis.com/v1/accounts', () => res(200, { accounts: [{ name: 'accounts/1' }] })],
      [/locations/, () => res(200, { locations: [{ name: 'locations/10', title: 'Loja Centro' }, { name: 'locations/11', title: 'Loja Sul' }] })],
    ])
    const out = await gmb.connect!({ code: 'c', codeVerifier: 'v', redirectUri: 'https://api.test/cb' })
    expect(out.map((a) => a.externalId)).toEqual(['locations/10', 'locations/11'])
    expect(out[0].meta).toEqual({ account: 'accounts/1' })
  })
  it('publica localPost com foto e botão', async () => {
    const calls = mockFetch([['POST https://mybusiness.googleapis.com/v4/accounts/1/locations/10/localPosts', () => res(200, { name: 'lp/1', searchUrl: 'https://g.test/1' })]])
    const out = await gmb.publish(ch({ externalId: 'locations/10', meta: { account: 'accounts/1' } }), { accessToken: 't' },
      p({ text: 'Promoção', media: [img()], settings: { cta_type: 'LEARN_MORE', cta_url: 'https://loja.test' } }))
    expect(out).toMatchObject({ remoteId: 'lp/1', remoteUrl: 'https://g.test/1' })
    expect(calls[0].body).toMatchObject({ summary: 'Promoção', callToAction: { actionType: 'LEARN_MORE' }, media: [{ mediaFormat: 'PHOTO' }] })
  })
  it('validação', () => {
    expect(gmb.validate(p({}))).toMatch(/obrigatório/)
    expect(gmb.validate(p({ text: 'x', settings: { cta_type: 'BOOK' } }))).toMatch(/cta_url/)
  })
})

describe('dribbble', () => {
  it('envia multipart e lê o id do Location', async () => {
    const calls = mockFetch([IMG_ROUTE, ['POST https://api.dribbble.com/v2/shots', () => res(202, '', { location: 'https://api.dribbble.com/v2/shots/123' })]])
    const out = await dribbble.publish(ch(), { accessToken: 't' }, p({ text: 'desc', media: [img()], settings: { title: 'Shot' } }))
    expect(out).toMatchObject({ remoteId: '123', remoteUrl: 'https://dribbble.com/shots/123' })
    expect((calls[1].body as FormData).get('title')).toBe('Shot')
  })
  it('exige título e imagem', () => {
    expect(dribbble.validate(p({ media: [img()] }))).toMatch(/title/)
    expect(dribbble.validate(p({ settings: { title: 'x' } }))).toMatch(/imagem/)
  })
})

describe('tumblr', () => {
  it('um canal por blog e post NPF', async () => {
    mockFetch([
      ['POST https://api.tumblr.com/v2/oauth2/token', () => res(200, { access_token: 'A', refresh_token: 'R', expires_in: 2520 })],
      ['GET https://api.tumblr.com/v2/user/info', () => res(200, { response: { user: { blogs: [{ uuid: 't:1', name: 'blog1', title: 'Blog' }] } } })],
    ])
    const [a] = await tumblr.connect!({ code: 'c', redirectUri: 'https://api.test/cb' })
    expect(a).toMatchObject({ externalId: 't:1', username: 'blog1' })
    const calls = mockFetch([['POST https://api.tumblr.com/v2/blog/blog1/posts', () => res(201, { response: { id_string: '555' } })]])
    const out = await tumblr.publish(ch({ username: 'blog1' }), { accessToken: 'A' }, p({ text: 'oi', media: [img()], settings: { tags: ['a', 'b'] } }))
    expect(out).toMatchObject({ remoteId: '555', remoteUrl: 'https://www.tumblr.com/blog1/555' })
    expect(calls[0].body).toMatchObject({ tags: 'a,b', content: [{ type: 'text' }, { type: 'image' }] })
  })
})

describe('slack', () => {
  it('connect guarda o webhook do canal escolhido', async () => {
    mockFetch([['POST https://slack.com/api/oauth.v2.access', () => res(200, {
      ok: true, access_token: 'xoxb', team: { id: 'T1', name: 'Nox' }, incoming_webhook: { channel: '#geral', channel_id: 'C1', url: 'https://hooks.slack.com/x' },
    })]])
    const [a] = await slack.connect!({ code: 'c', redirectUri: 'https://api.test/cb' })
    expect(a).toMatchObject({ externalId: 'T1:C1', credentials: { webhookUrl: 'https://hooks.slack.com/x' } })
  })
  it('publica com blocos de imagem; webhook removido vira reauth', async () => {
    const calls = mockFetch([['POST https://hooks.slack.com/x', () => res(200, 'ok')]])
    await slack.publish(ch({ meta: { channel: 'C1' } }), { accessToken: 'x', webhookUrl: 'https://hooks.slack.com/x' }, p({ text: 'oi', media: [img()] }))
    expect(calls[0].body.blocks.map((b: any) => b.type)).toEqual(['section', 'image'])
    mockFetch([['POST https://hooks.slack.com/x', () => res(404, 'no_service')]])
    await expect(slack.publish(ch(), { accessToken: 'x', webhookUrl: 'https://hooks.slack.com/x' }, p({ text: 'oi' }))).rejects.toMatchObject({ kind: 'reauth' })
  })
})

describe('vk', () => {
  it('connect exige device_id e guarda no token', async () => {
    await expect(vk.connect!({ code: 'c', redirectUri: 'r', query: {} })).rejects.toMatchObject({ message: /device_id/ })
    const calls = mockFetch([
      ['POST https://id.vk.com/oauth2/auth', () => res(200, { access_token: 'A', refresh_token: 'R', expires_in: 3600, user_id: 5 })],
      ['POST https://id.vk.com/oauth2/user_info', () => res(200, { user: { user_id: '5', first_name: 'Ana', last_name: 'Lima' } })],
    ])
    const [a] = await vk.connect!({ code: 'c', codeVerifier: 'v', redirectUri: 'r', query: { device_id: 'D1', state: 's' } })
    expect(a).toMatchObject({ externalId: '5', name: 'Ana Lima', credentials: { deviceId: 'D1' } })
    expect(calls[0].body).toMatchObject({ device_id: 'D1', code_verifier: 'v' })
  })
  it('sobe foto e posta no mural', async () => {
    const calls = mockFetch([IMG_ROUTE,
      ['POST https://api.vk.com/method/photos.getWallUploadServer', () => res(200, { response: { upload_url: 'https://up.vk.test/u' } })],
      ['POST https://up.vk.test/u', () => res(200, { server: 1, photo: '[]', hash: 'h' })],
      ['POST https://api.vk.com/method/photos.saveWallPhoto', () => res(200, { response: [{ id: 9, owner_id: 5 }] })],
      ['POST https://api.vk.com/method/wall.post', () => res(200, { response: { post_id: 77 } })],
    ])
    const out = await vk.publish(ch({ externalId: '5' }), { accessToken: 'A' }, p({ text: 'oi', media: [img()] }))
    expect(out).toEqual({ status: 'published', remoteId: '5_77', remoteUrl: 'https://vk.com/wall5_77' })
    expect(calls.at(-1)!.body).toMatchObject({ attachments: 'photo5_9', owner_id: '5' })
  })
  it('erro 5 da API vira reauth', async () => {
    mockFetch([['POST https://api.vk.com/method/wall.post', () => res(200, { error: { error_code: 5, error_msg: 'User authorization failed' } })]])
    await expect(vk.publish(ch(), { accessToken: 'A' }, p({ text: 'oi' }))).rejects.toMatchObject({ kind: 'reauth' })
  })
})

describe('kick e twitch (chat)', () => {
  it('kick envia mensagem ao próprio canal', async () => {
    const calls = mockFetch([['POST https://api.kick.com/public/v1/chat', () => res(200, { data: { is_sent: true, message_id: 'm1' } })]])
    expect(await kick.publish(ch({ externalId: '12', username: 'nox' }), { accessToken: 't' }, p({ text: 'ao vivo!' }))).toMatchObject({ remoteId: 'm1', remoteUrl: 'https://kick.com/nox' })
    expect(calls[0].body).toEqual({ type: 'user', broadcaster_user_id: 12, content: 'ao vivo!' })
  })
  it('twitch: mensagem barrada vira erro', async () => {
    mockFetch([['POST https://api.twitch.tv/helix/chat/messages', () => res(200, { data: [{ is_sent: false, drop_reason: { message: 'AutoMod' } }] })]])
    await expect(twitch.publish(ch(), { accessToken: 't' }, p({ text: 'oi' }))).rejects.toMatchObject({ message: /AutoMod/ })
  })
  it('só texto até 500', () => {
    expect(kick.validate(p({ text: 'a'.repeat(501) }))).toMatch(/500/)
    expect(twitch.validate(p({ text: 'x', media: [img()] }))).toMatch(/só texto/)
    expect(twitch.validate(p({}))).toMatch(/obrigatório/)
  })
})

describe('discord', () => {
  const hook = 'https://discord.com/api/webhooks/123/abc-DEF'
  it('connect valida o formato e lê o webhook', async () => {
    await expect(discord.connectWith!({ webhookUrl: 'https://evil.test/api/webhooks/1/x' })).rejects.toMatchObject({ message: /inválido/ })
    mockFetch([[`GET ${hook}`, () => res(200, { id: '123', name: 'Avisos', guild_id: 'G', channel_id: 'C' })]])
    const [a] = await discord.connectWith!({ webhookUrl: hook })
    expect(a).toMatchObject({ externalId: '123', credentials: { accessToken: hook }, meta: { guild: 'G', channel: 'C' } })
  })
  it('publica com embeds e devolve o link da mensagem', async () => {
    const calls = mockFetch([[`POST ${hook}?wait=true`, () => res(200, { id: 'M', channel_id: 'C' })]])
    const out = await discord.publish(ch({ meta: { guild: 'G' } }), { accessToken: hook }, p({ text: 'oi', media: [img(), vid] }))
    expect(out).toMatchObject({ remoteId: 'M', remoteUrl: 'https://discord.com/channels/G/C/M' })
    expect(calls[0].body).toMatchObject({ content: 'oi\nhttps://cdn.test/v.mp4', embeds: [{ image: { url: 'https://cdn.test/1.jpg' } }] })
  })
})

describe('telegram', () => {
  const API = 'https://api.telegram.org/bot123:ABC'
  it('connect confere o chat', async () => {
    mockFetch([[`POST ${API}/getChat`, () => res(200, { ok: true, result: { id: -100, title: 'Canal', username: 'canal' } })]])
    const [a] = await telegram.connectWith!({ botToken: '123:ABC', chatId: '@canal' })
    expect(a).toMatchObject({ externalId: '-100', credentials: { accessToken: '123:ABC', chatId: '-100' } })
    await expect(telegram.connectWith!({ botToken: 'lixo', chatId: '1' })).rejects.toMatchObject({ message: /botToken/ })
  })
  it('escolhe o método pela mídia', async () => {
    const creds = { accessToken: '123:ABC', chatId: '-100' }
    const calls = mockFetch([[/POST .*\/send/, (c) => res(200, { ok: true, result: c.url.endsWith('MediaGroup') ? [{ message_id: 3 }] : { message_id: 2 } })]])
    expect(await telegram.publish(ch({ username: 'canal' }), creds, p({ text: 'oi' }))).toMatchObject({ remoteUrl: 'https://t.me/canal/2' })
    await telegram.publish(ch(), creds, p({ text: 'oi', media: [vid] }))
    await telegram.publish(ch(), creds, p({ text: 'oi', media: [img(), img(2)] }))
    expect(calls.map((c) => c.url.split('/').pop())).toEqual(['sendMessage', 'sendVideo', 'sendMediaGroup'])
    expect(calls[2].body.media[0]).toMatchObject({ type: 'photo', caption: 'oi' })
  })
  it('bot removido do canal vira reauth', async () => {
    mockFetch([[/POST/, () => res(403, { ok: false, description: 'Forbidden: bot was kicked' })]])
    await expect(telegram.publish(ch(), { accessToken: '1:a', chatId: '1' }, p({ text: 'x' }))).rejects.toMatchObject({ kind: 'reauth' })
  })
  it('legenda de mídia até 1024', () => {
    expect(telegram.validate(p({ text: 'a'.repeat(1025), media: [img()] }))).toMatch(/1.024/)
    expect(telegram.validate(p({ text: 'a'.repeat(1025) }))).toBeNull()
  })
})

describe('mastodon', () => {
  const I = 'https://mastodon.test'
  const creds = { accessToken: 't', instance: I }
  it('connect na instância informada', async () => {
    mockFetch([[`GET ${I}/api/v1/accounts/verify_credentials`, () => res(200, { id: '7', username: 'nox', display_name: 'Nox' })]])
    const [a] = await mastodon.connectWith!({ instance: 'mastodon.test', accessToken: 't' })
    expect(a).toMatchObject({ externalId: '7@mastodon.test', username: 'nox@mastodon.test', credentials: { instance: I } })
  })
  it('imagem pronta publica na hora com Idempotency-Key', async () => {
    const calls = mockFetch([IMG_ROUTE,
      [`POST ${I}/api/v2/media`, () => res(200, { id: 'm1', url: 'https://x' })],
      [`POST ${I}/api/v1/statuses`, () => res(200, { id: 's1', url: `${I}/@nox/s1` })],
    ])
    expect(await mastodon.publish(ch(), creds, p({ text: 'oi', media: [img()] }))).toMatchObject({ remoteId: 's1' })
    expect(calls.at(-1)!.body).toMatchObject({ status: 'oi', media_ids: ['m1'], visibility: 'public' })
    expect(calls.at(-1)!.headers['idempotency-key']).toBeTruthy()
  })
  it('vídeo processando: espera e depois publica', async () => {
    let ready = false
    mockFetch([[/GET https:\/\/cdn/, () => res(200, 'v')],
      [`POST ${I}/api/v2/media`, () => res(202, { id: 'm1', url: null })],
      [`GET ${I}/api/v1/media/m1`, () => (ready ? res(200, { id: 'm1', url: 'https://x' }) : res(206, { id: 'm1', url: null }))],
      [`POST ${I}/api/v1/statuses`, () => res(200, { id: 's2', url: null })],
    ])
    const first = await mastodon.publish(ch(), creds, p({ text: 'vídeo', media: [vid] }))
    expect(first.status).toBe('processing')
    const second = await mastodon.check!(ch(), creds, (first as any).pendingData)
    expect(second.status).toBe('processing')
    ready = true
    expect(await mastodon.check!(ch(), creds, (second as any).pendingData)).toMatchObject({ status: 'published', remoteId: 's2' })
  })
})

describe('bluesky', () => {
  const S = 'https://bsky.social'
  const session = () => res(200, { did: 'did:plc:abc', handle: 'nox.bsky.social', accessJwt: 'jwt' })
  it('connect com senha de app', async () => {
    mockFetch([[`POST ${S}/xrpc/com.atproto.server.createSession`, session], [/getProfile/, () => res(200, { displayName: 'Nox' })]])
    const [a] = await bluesky.connectWith!({ identifier: '@nox.bsky.social', appPassword: 'aaaa-bbbb' })
    expect(a).toMatchObject({ externalId: 'did:plc:abc', name: 'Nox', username: 'nox.bsky.social', credentials: { accessToken: 'aaaa-bbbb', service: S } })
  })
  it('publica com imagem e facet de link', async () => {
    const calls = mockFetch([IMG_ROUTE,
      [`POST ${S}/xrpc/com.atproto.server.createSession`, session],
      [`POST ${S}/xrpc/com.atproto.repo.uploadBlob`, () => res(200, { blob: { ref: 'b1' } })],
      [`POST ${S}/xrpc/com.atproto.repo.createRecord`, () => res(200, { uri: 'at://did:plc:abc/app.bsky.feed.post/3k', cid: 'c' })],
    ])
    const out = await bluesky.publish(ch({ username: 'nox.bsky.social' }), { accessToken: 'pw', identifier: 'did:plc:abc', service: S }, p({ text: 'veja https://nox.test', media: [img()] }))
    expect(out).toMatchObject({ remoteUrl: 'https://bsky.app/profile/nox.bsky.social/post/3k' })
    const rec = calls.at(-1)!.body.record
    expect(rec.embed.images[0].image).toEqual({ ref: 'b1' })
    expect(rec.facets[0].features[0].uri).toBe('https://nox.test')
  })
  it('senha recusada vira reauth', async () => {
    mockFetch([[/createSession/, () => res(401, { error: 'AuthenticationRequired' })]])
    await expect(bluesky.publish(ch(), { accessToken: 'x', identifier: 'd', service: S }, p({ text: 'oi' }))).rejects.toMatchObject({ kind: 'reauth' })
  })
  it('facets em bytes UTF-8 e limite em grafemas', () => {
    expect(linkFacets('olá https://a.test.')[0].index).toEqual({ byteStart: 5, byteEnd: 19 })
    expect(bluesky.validate(p({ text: '👍🏽'.repeat(300) }))).toBeNull()
    expect(bluesky.validate(p({ text: 'a'.repeat(301) }))).toMatch(/300/)
  })
})

describe('lemmy', () => {
  const I = 'https://lemmy.test'
  it('login, comunidade e post', async () => {
    const calls = mockFetch([
      [`POST ${I}/api/v3/user/login`, () => res(200, { jwt: 'J' })],
      [`GET ${I}/api/v3/community?name=tech`, () => res(200, { community_view: { community: { id: 33 } } })],
      [`POST ${I}/api/v3/post`, () => res(200, { post_view: { post: { id: 5, ap_id: `${I}/post/5` } } })],
    ])
    const out = await lemmy.publish(ch(), { accessToken: 'pw', username: 'nox', instance: I }, p({ text: 'corpo', settings: { community: '!tech', title: 'Oi' } }))
    expect(out).toMatchObject({ remoteId: '5', remoteUrl: `${I}/post/5` })
    expect(calls[2].body).toMatchObject({ name: 'Oi', community_id: 33, body: 'corpo' })
    expect(calls[2].headers.authorization).toBe('Bearer J')
  })
  it('senha errada vira reauth', async () => {
    mockFetch([[/login/, () => res(400, { error: 'incorrect_login' })]])
    await expect(lemmy.connectWith!({ instance: I, username: 'a', password: 'b' })).rejects.toMatchObject({ kind: 'reauth' })
  })
})

describe('farcaster', () => {
  const N = 'https://api.neynar.com/v2/farcaster'
  it('connect exige signer aprovado', async () => {
    mockFetch([[`GET ${N}/signer`, () => res(200, { status: 'pending_approval' })]])
    await expect(farcaster.connectWith!({ apiKey: 'k', signerUuid: 's' })).rejects.toMatchObject({ message: /não aprovado/ })
    mockFetch([[`GET ${N}/signer`, () => res(200, { status: 'approved', fid: 9 })], [`GET ${N}/user/bulk`, () => res(200, { users: [{ username: 'nox' }] })]])
    expect((await farcaster.connectWith!({ apiKey: 'k', signerUuid: 's' }))[0]).toMatchObject({ externalId: '9', username: 'nox' })
  })
  it('cast com embeds', async () => {
    const calls = mockFetch([[`POST ${N}/cast`, () => res(200, { cast: { hash: '0xabcdef0123456789', author: { username: 'nox' } } })]])
    const out = await farcaster.publish(ch(), { accessToken: 'k', signerUuid: 's' }, p({ text: 'gm', media: [img()] }))
    expect(out).toMatchObject({ remoteId: '0xabcdef0123456789', remoteUrl: 'https://farcaster.xyz/nox/0xabcdef01' })
    expect(calls[0].headers['x-api-key']).toBe('k')
    expect(farcaster.validate(p({ text: 'é'.repeat(513) }))).toMatch(/bytes/)
  })
})

describe('nostr', () => {
  const sk = '0000000000000000000000000000000000000000000000000000000000000003'
  it('aceita nsec ou hex e assina conforme a NIP-01', async () => {
    const nsec = bech32Encode('nsec', Buffer.from(sk, 'hex'))
    expect(Buffer.from(bech32Decode(nsec, 'nsec')).toString('hex')).toBe(sk)
    const [a] = await nostr.connectWith!({ privateKey: nsec })
    expect(a.externalId).toBe('f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9')
    expect(a.username).toMatch(/^npub1/)
    const ev = signEvent(Buffer.from(sk, 'hex'), 'oi', 1700000000)
    expect(schnorr.verify(Buffer.from(ev.sig, 'hex'), Buffer.from(ev.id, 'hex'), Buffer.from(ev.pubkey, 'hex'))).toBe(true)
    await expect(nostr.connectWith!({ privateKey: 'xyz' })).rejects.toMatchObject({ message: /privateKey/ })
  })
  it('publica quando um relay confirma', async () => {
    const sent: any[] = []
    class FakeWS {
      onopen?: () => void; onmessage?: (m: { data: string }) => void; onerror?: () => void
      constructor(public url: string) { setTimeout(() => (url.includes('ruim') ? this.onerror?.() : this.onopen?.())) }
      send(data: string) { const [, ev] = JSON.parse(data); sent.push(ev); setTimeout(() => this.onmessage?.({ data: JSON.stringify(['OK', ev.id, true, '']) })) }
      close() {}
    }
    vi.stubGlobal('WebSocket', FakeWS)
    const out = await nostr.publish(ch(), { accessToken: sk, relays: ['wss://ruim.test', 'wss://bom.test'] }, p({ text: 'oi', media: [img()] }))
    expect(out).toMatchObject({ status: 'published', remoteUrl: expect.stringMatching(/^https:\/\/njump\.me\/note1/) })
    expect(sent[0].content).toBe('oi\nhttps://cdn.test/1.jpg')
  })
})

describe('blogs', () => {
  it('devto publica artigo com capa e tags', async () => {
    const calls = mockFetch([['POST https://dev.to/api/articles', () => res(201, { id: 1, url: 'https://dev.to/nox/oi' })]])
    const out = await devto.publish(ch(), { accessToken: 'k' }, p({ text: '# corpo', media: [img()], settings: { title: 'Oi', tags: ['a', 'b', 'c', 'd', 'e'] } }))
    expect(out).toMatchObject({ remoteUrl: 'https://dev.to/nox/oi' })
    expect(calls[0].body.article).toMatchObject({ title: 'Oi', published: true, main_image: 'https://cdn.test/1.jpg', tags: ['a', 'b', 'c', 'd'] })
    expect(calls[0].headers['api-key']).toBe('k')
  })
  it('medium publica em markdown', async () => {
    const calls = mockFetch([['POST https://api.medium.com/v1/users/U1/posts', () => res(201, { data: { id: 'p', url: 'https://medium.com/p' } })]])
    await medium.publish(ch({ externalId: 'U1' }), { accessToken: 't' }, p({ text: 'corpo', settings: { title: 'T', draft: true } }))
    expect(calls[0].body).toMatchObject({ contentFormat: 'markdown', publishStatus: 'draft' })
  })
  it('hashnode: um canal por blog, erro GraphQL vira falha', async () => {
    mockFetch([['POST https://gql.hashnode.com', () => res(200, { data: { me: { username: 'nox', publications: { edges: [{ node: { id: 'P1', title: 'Blog' } }] } } } })]])
    expect((await hashnode.connectWith!({ token: 't' }))[0]).toMatchObject({ externalId: 'P1', name: 'Blog' })
    const calls = mockFetch([['POST https://gql.hashnode.com', () => res(200, { data: { publishPost: { post: { id: 'x', url: 'https://b.test/x' } } } })]])
    expect(await hashnode.publish(ch({ externalId: 'P1' }), { accessToken: 't' }, p({ text: 'c', settings: { title: 'T' } }))).toMatchObject({ remoteUrl: 'https://b.test/x' })
    expect(calls[0].body.variables.input).toMatchObject({ publicationId: 'P1', contentMarkdown: 'c' })
    mockFetch([['POST https://gql.hashnode.com', () => res(200, { errors: [{ message: 'nope', extensions: { code: 'UNAUTHENTICATED' } }] })]])
    await expect(hashnode.publish(ch(), { accessToken: 't' }, p({ text: 'c', settings: { title: 'T' } }))).rejects.toMatchObject({ kind: 'reauth' })
  })
  it('wordpress sobe a capa e publica', async () => {
    const W = 'https://blog.test'
    const calls = mockFetch([IMG_ROUTE,
      [`POST ${W}/wp-json/wp/v2/media`, () => res(201, { id: 50 })],
      [`POST ${W}/wp-json/wp/v2/posts`, () => res(201, { id: 9, link: `${W}/?p=9` })],
    ])
    const out = await wordpress.publish(ch(), { accessToken: 'abcd', username: 'nox', site: W }, p({ text: '<p>oi</p>', media: [img()], settings: { title: 'T' } }))
    expect(out).toMatchObject({ remoteId: '9', remoteUrl: `${W}/?p=9` })
    expect(calls[2].body).toMatchObject({ title: 'T', status: 'publish', featured_media: 50 })
    expect(calls[1].headers.authorization).toBe(`Basic ${Buffer.from('nox:abcd').toString('base64')}`)
  })
  it('wordpress recusa usuário sem permissão de publicar', async () => {
    mockFetch([[/users\/me/, () => res(200, { id: 1, capabilities: {} })]])
    await expect(wordpress.connectWith!({ site: 'blog.test', username: 'a', appPassword: 'b' })).rejects.toMatchObject({ message: /não pode publicar/ })
  })
  it('artigos exigem título e corpo', () => {
    for (const prov of [devto, medium, hashnode, wordpress]) {
      expect(prov.validate(p({ text: 'x' }))).toMatch(/title/)
      expect(prov.validate(p({ settings: { title: 'x' } }))).toMatch(/obrigatório/)
    }
  })
})

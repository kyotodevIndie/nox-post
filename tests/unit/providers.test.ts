import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ProviderError } from '../../src/lib/errors'
import { facebook } from '../../src/providers/facebook'
import { pfetch, setSleep } from '../../src/providers/http'
import { instagram } from '../../src/providers/instagram'
import { fixText, linkedin } from '../../src/providers/linkedin'
import { FACEBOOK_RULES, INSTAGRAM_RULES, classifyWith } from '../../src/providers/meta'
import { postIdFromRaw, tiktok } from '../../src/providers/tiktok'
import { youtube } from '../../src/providers/youtube'
import { backoffSeconds } from '../../src/services/outbox'
import { signWebhook, signaturesMatch } from '../../src/security/signature'
import { open, seal } from '../../src/security/secretBox'

beforeAll(() => {
  setSleep(async () => {})
  process.env.SECRETS_KEY = 'test-0123456789abcdef0123456789abcdef'
})
afterEach(() => vi.unstubAllGlobals())

const res = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })

describe('pfetch', () => {
  it('tenta de novo em 429 e devolve a resposta boa', async () => {
    const f = vi.fn().mockResolvedValueOnce(res(429, 'slow down')).mockResolvedValueOnce(res(200, { ok: 1 }))
    vi.stubGlobal('fetch', f)
    const r = await pfetch('https://x.test')
    expect(await r.json()).toEqual({ ok: 1 })
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('401 vira reauth, 400 vira fatal com o corpo no detalhe', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(401, 'nope')))
    await expect(pfetch('https://x.test')).rejects.toMatchObject({ kind: 'reauth' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(400, '{"error":"bad"}')))
    await expect(pfetch('https://x.test', { label: 'teste' })).rejects.toMatchObject({ kind: 'fatal', message: 'teste: HTTP 400', detail: '{"error":"bad"}' })
  })

  it('usa a tabela de erros do provider', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(400, '{"error":{"message":"Error validating access token"}}')))
    await expect(pfetch('https://x.test', { classify: classifyWith(FACEBOOK_RULES) })).rejects.toMatchObject({ kind: 'reauth' })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(400, '{"error":{"code":2207042}}')))
    await expect(pfetch('https://x.test', { classify: classifyWith(INSTAGRAM_RULES) })).rejects.toMatchObject({ kind: 'fatal', message: 'limite de 25 posts por dia da conta atingido' })
  })

  it('5xx que não passa vira transient', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(503, 'down')))
    await expect(pfetch('https://x.test', { retries: 1 })).rejects.toMatchObject({ kind: 'transient' })
  })
})

describe('validações', () => {
  const p = (o: any) => ({ text: '', media: [], settings: {}, ...o })
  const img = { url: 'https://cdn.test/a.jpg', type: 'image' as const }
  const vid = { url: 'https://cdn.test/a.mp4', type: 'video' as const }

  it('instagram exige mídia', () => {
    expect(instagram.validate(p({ text: 'oi' }))).toMatch(/pelo menos uma/)
    expect(instagram.validate(p({ media: [img] }))).toBeNull()
  })
  it('youtube exige um vídeo e título', () => {
    expect(youtube.validate(p({ media: [vid] }))).toMatch(/title/)
    expect(youtube.validate(p({ media: [vid], settings: { title: 'Vídeo' } }))).toBeNull()
    expect(youtube.validate(p({ media: [img], settings: { title: 'x' } }))).toMatch(/um vídeo/)
  })
  it('tiktok sempre mostra a tela de autorização (dá para trocar de conta)', () => {
    process.env.TIKTOK_CLIENT_KEY ??= 'tk'
    const { url } = tiktok.authUrl!({ state: 's', redirectUri: 'https://api.test/oauth/tiktok/callback' })
    expect(new URL(url).searchParams.get('disable_auto_auth')).toBe('1')
  })
  it('tiktok exige um vídeo', () => {
    expect(tiktok.validate(p({ media: [vid] }))).toBeNull()
    expect(tiktok.validate(p({ media: [img] }))).toMatch(/um vídeo/)
  })
  it('facebook e linkedin não misturam vídeo com foto', () => {
    expect(facebook.validate(p({ media: [img, vid] }))).toMatch(/misturar/)
    expect(linkedin.validate(p({ media: [img, vid] }))).toMatch(/misturar/)
    expect(linkedin.validate(p({ text: 'só texto' }))).toBeNull()
  })
})

describe('instagram', () => {
  const channel = { externalId: '1789', name: 'Loja', username: 'loja', meta: { pageId: '55' } }
  const creds = { accessToken: 'tok' }

  it('carrossel: cria containers, espera, cria o carrossel e publica', async () => {
    const calls: string[] = []
    let n = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url.split('?')[0]}`)
      if (url.includes('/1789/media_publish')) return res(200, { id: 'MEDIA1' })
      if (url.includes('/1789/media?') && url.includes('CAROUSEL')) return res(200, { id: 'CAR' })
      if (url.includes('/1789/media?')) return res(200, { id: `C${++n}` })
      if (url.includes('fields=status_code')) return res(200, { status_code: 'FINISHED' })
      if (url.includes('fields=permalink')) return res(200, { permalink: 'https://instagram.com/p/xyz' })
      return res(404, 'inesperado')
    }))
    const media = [{ url: 'https://cdn.test/a.jpg', type: 'image' as const }, { url: 'https://cdn.test/b.jpg', type: 'image' as const }]
    const first = await instagram.publish(channel, creds, { text: 'legenda', media, settings: {} })
    expect(first).toMatchObject({ status: 'processing', pendingData: { postType: 'carousel', containers: ['C1', 'C2'] } })
    const second = await instagram.check!(channel, creds, (first as any).pendingData)
    expect(second).toMatchObject({ status: 'processing', pendingData: { carouselId: 'CAR' } })
    const third = await instagram.check!(channel, creds, (second as any).pendingData)
    expect(third).toEqual({ status: 'published', remoteId: 'MEDIA1', remoteUrl: 'https://instagram.com/p/xyz' })
  })

  it('container com ERROR vira falha com a mensagem traduzida', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(200, { status_code: 'ERROR', status: 'Error: 2207026' })))
    await expect(instagram.check!(channel, creds, { postType: 'single', containers: ['C1'], message: '' }))
      .rejects.toMatchObject({ kind: 'fatal', message: 'instagram: formato de vídeo não suportado' })
  })
})

describe('utilitários', () => {
  it('fixText escapa a sintaxe do LinkedIn mas mantém menção de empresa', () => {
    expect(fixText('oi (teste) #tag')).toBe('oi \\(teste\\) \\#tag')
    expect(fixText('fala @[Nox](urn:li:organization:123) *top*')).toBe('fala @[Nox](urn:li:organization:123) \\*top\\*')
  })
  it('postIdFromRaw lê o int64 do TikTok sem arredondar', () => {
    expect(postIdFromRaw('{"data":{"publicaly_available_post_id":[7300123456789012345],"status":"PUBLISH_COMPLETE"}}')).toBe('7300123456789012345')
  })
  it('assinatura de webhook no formato do Nox', () => {
    const sig = signWebhook('segredo', '1700000000', '{"a":1}')
    expect(signaturesMatch(sig, sig)).toBe(true)
    expect(signaturesMatch(sig, signWebhook('outro', '1700000000', '{"a":1}'))).toBe(false)
  })
  it('secretBox ida e volta', () => {
    expect(open(seal('token'))).toBe('token')
  })
  it('backoff dobra até 6h', () => {
    expect([1, 2, 3].map(backoffSeconds)).toEqual([30, 60, 120])
    expect(backoffSeconds(30)).toBe(6 * 3600)
  })
  it('ProviderError guarda o tipo', () => {
    expect(new ProviderError('reauth', 'x').kind).toBe('reauth')
  })
})

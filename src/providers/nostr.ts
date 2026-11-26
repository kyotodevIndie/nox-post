// Nostr: nota (kind 1) assinada com a chave da conta e enviada aos relays por WebSocket. credentials
// { privateKey, relays? } (nsec... ou hex; relays separados por vírgula). Mídia vai como URL no fim do texto
// (os clientes mostram a imagem/vídeo). Publicado = pelo menos um relay confirmou.
import { createHash } from 'node:crypto'
import { schnorr } from '@noble/curves/secp256k1.js'
import { ProviderError } from '../lib/errors'
import { rules } from './rules'
import type { Provider } from './types'

const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net']
const RELAY_TIMEOUT_MS = 10_000

// bech32 (NIP-19) só para nsec/npub/note: decodifica a chave e gera os links.
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
function polymod(values: number[]) {
  let chk = 1
  for (const v of values) {
    const top = chk >> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i]
  }
  return chk
}
const hrpExpand = (hrp: string) => [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)]
function convert(data: number[], from: number, to: number, pad: boolean) {
  let acc = 0, bits = 0
  const out: number[] = []
  for (const v of data) {
    acc = (acc << from) | v
    bits += from
    while (bits >= to) { bits -= to; out.push((acc >> bits) & ((1 << to) - 1)) }
  }
  if (pad && bits) out.push((acc << (to - bits)) & ((1 << to) - 1))
  return out
}
export function bech32Encode(hrp: string, bytes: Uint8Array) {
  const data = convert([...bytes], 8, 5, true)
  const mod = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >> (5 * (5 - i))) & 31)
  return `${hrp}1${[...data, ...checksum].map((d) => CHARSET[d]).join('')}`
}
export function bech32Decode(s: string, hrp: string): Uint8Array {
  const str = s.toLowerCase()
  const pos = str.lastIndexOf('1')
  const data = [...str.slice(pos + 1)].map((c) => CHARSET.indexOf(c))
  if (str.slice(0, pos) !== hrp || data.includes(-1) || polymod([...hrpExpand(hrp), ...data]) !== 1) throw new ProviderError('fatal', `nostr: ${hrp} inválida`)
  return Uint8Array.from(convert(data.slice(0, -6), 5, 8, false))
}

function secretKey(raw: string): Uint8Array {
  const v = raw.trim()
  const key = v.startsWith('nsec') ? bech32Decode(v, 'nsec') : /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, 'hex') : null
  if (!key || key.length !== 32) throw new ProviderError('fatal', 'nostr: privateKey deve ser nsec... ou 64 caracteres hex')
  return key
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')

/** Evento assinado conforme a NIP-01. */
export function signEvent(sk: Uint8Array, content: string, createdAt = Math.floor(Date.now() / 1000), tags: string[][] = []) {
  const pubkey = hex(schnorr.getPublicKey(sk))
  const id = createHash('sha256').update(JSON.stringify([0, pubkey, createdAt, 1, tags, content])).digest()
  return { id: hex(id), pubkey, created_at: createdAt, kind: 1, tags, content, sig: hex(schnorr.sign(id, sk)) }
}

/** Envia a um relay e espera o ["OK", id, aceito, motivo]. */
function sendToRelay(url: string, event: { id: string }): Promise<{ ok: boolean; reason: string }> {
  return new Promise((resolve) => {
    let ws: WebSocket
    const done = (r: { ok: boolean; reason: string }) => { clearTimeout(timer); try { ws.close() } catch {} resolve(r) }
    const timer = setTimeout(() => done({ ok: false, reason: 'sem resposta' }), RELAY_TIMEOUT_MS)
    try { ws = new WebSocket(url) } catch (e: any) { return done({ ok: false, reason: e?.message ?? 'endereço inválido' }) }
    ws.onopen = () => ws.send(JSON.stringify(['EVENT', event]))
    ws.onerror = () => done({ ok: false, reason: 'falha de conexão' })
    ws.onmessage = (m) => {
      try {
        const [type, id, ok, reason] = JSON.parse(String(m.data))
        if (type === 'OK' && id === event.id) done({ ok: !!ok, reason: reason ?? '' })
      } catch {}
    }
  })
}

const relaysOf = (raw?: unknown) => {
  const list = String(raw ?? '').split(/[\s,]+/).filter(Boolean)
  if (list.some((r) => !r.startsWith('wss://'))) throw new ProviderError('fatal', 'nostr: relays precisam começar com wss://')
  return list.length ? list : DEFAULT_RELAYS
}

export const nostr: Provider = {
  network: 'nostr',
  label: 'Nostr',
  requiredEnv: [],
  credentialFields: ['privateKey', 'relays?'],

  async connectWith({ privateKey, relays }) {
    const sk = secretKey(privateKey)
    const pub = schnorr.getPublicKey(sk)
    const npub = bech32Encode('npub', pub)
    return [{
      externalId: hex(pub), name: `${npub.slice(0, 12)}…${npub.slice(-6)}`, username: npub,
      credentials: { accessToken: hex(sk), relays: relaysOf(relays) }, expiresAt: null,
    }]
  },

  validate: (post) => rules('Nostr', { maxText: 20_000 })(post) ?? (post.text || post.media.length ? null : 'Nostr: mande texto ou mídia'),

  async publish(_channel, creds, post) {
    const content = [post.text, ...post.media.map((m) => m.url)].filter(Boolean).join('\n')
    const tags = (post.settings.hashtags ?? []).map((t: string) => ['t', String(t).replace(/^#/, '').toLowerCase()])
    const event = signEvent(Buffer.from(creds.accessToken, 'hex'), content, undefined, tags)
    const relays = creds.relays as string[]
    const results = await Promise.all(relays.map((r) => sendToRelay(r, event)))
    if (!results.some((r) => r.ok)) {
      throw new ProviderError('transient', 'nostr: nenhum relay aceitou a nota', relays.map((r, i) => `${r}: ${results[i].reason}`).join('; '))
    }
    return { status: 'published', remoteId: event.id, remoteUrl: `https://njump.me/${bech32Encode('note', Buffer.from(event.id, 'hex'))}` }
  },
}

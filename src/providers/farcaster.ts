// Farcaster: cast pela API do Neynar (o Farcaster não tem API HTTP oficial de escrita; o Neynar é o caminho usual).
// credentials { apiKey, signerUuid }: o signer aprovado da conta, criado no painel ou na API do Neynar.
// Mídia vai como embed de URL (até 2); settings.channel publica num canal (ex.: "dev").
import { ProviderError } from '../lib/errors'
import { pjson } from './http'
import { rules } from './rules'
import type { Provider } from './types'

const API = 'https://api.neynar.com/v2/farcaster'
const MAX_BYTES = 1024

const headers = (apiKey: string) => ({ 'x-api-key': apiKey, 'Content-Type': 'application/json' })

export const farcaster: Provider = {
  network: 'farcaster',
  label: 'Farcaster',
  requiredEnv: [],
  credentialFields: ['apiKey', 'signerUuid'],

  async connectWith({ apiKey, signerUuid }) {
    const h = headers(apiKey.trim())
    const signer = await pjson(`${API}/signer?signer_uuid=${encodeURIComponent(signerUuid.trim())}`, { headers: h, label: 'farcaster: signer' })
    if (signer.status !== 'approved' || !signer.fid) throw new ProviderError('fatal', `farcaster: signer não aprovado (status ${signer.status})`)
    const { users: [u] } = await pjson(`${API}/user/bulk?fids=${signer.fid}`, { headers: h, label: 'farcaster: perfil' })
    return [{
      externalId: String(signer.fid), name: u?.display_name || u?.username || `fid ${signer.fid}`, username: u?.username, picture: u?.pfp_url,
      credentials: { accessToken: apiKey.trim(), signerUuid: signerUuid.trim() }, expiresAt: null,
    }]
  },

  validate(post) {
    if (Buffer.byteLength(post.text) > MAX_BYTES) return `Farcaster: o texto passa de ${MAX_BYTES} bytes`
    return rules('Farcaster', { maxMedia: 2 })(post) ?? (post.text || post.media.length ? null : 'Farcaster: mande texto ou mídia')
  },

  async publish(channel, creds, post) {
    const r = await pjson(`${API}/cast`, {
      method: 'POST', headers: headers(creds.accessToken), label: 'farcaster: publicar',
      body: JSON.stringify({
        signer_uuid: creds.signerUuid, text: post.text, embeds: post.media.map((m) => ({ url: m.url })),
        ...(post.settings.channel && { channel_id: post.settings.channel }),
      }),
    })
    const hash: string = r.cast?.hash
    if (!hash) throw new ProviderError('fatal', 'farcaster: resposta sem hash do cast')
    const user = r.cast.author?.username ?? channel.username
    return { status: 'published', remoteId: hash, remoteUrl: user ? `https://farcaster.xyz/${user}/${hash.slice(0, 10)}` : null }
  },
}

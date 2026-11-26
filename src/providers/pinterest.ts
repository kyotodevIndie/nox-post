// Pinterest: pin de imagem (ou várias, viram pin de várias imagens) pela API v5. `settings.board` é o id ou o nome
// da pasta. Vídeo fica de fora (exige registrar mídia, subir para o S3 deles e esperar o processamento).
import { ProviderError } from '../lib/errors'
import { pjson } from './http'
import type { OAuthCfg } from './oauth'
import { bearer, exchangeCode, jsonBearer, oauthUrl, refreshWith, tokenCreds } from './oauth'
import { rules } from './rules'
import type { Provider } from './types'

const API = 'https://api.pinterest.com/v5'

const cfg: OAuthCfg = {
  network: 'pinterest', authorize: 'https://www.pinterest.com/oauth/', token: `${API}/oauth/token`,
  idEnv: 'PINTEREST_CLIENT_ID', secretEnv: 'PINTEREST_CLIENT_SECRET', basic: true, scopeSep: ',',
  scopes: ['user_accounts:read', 'boards:read', 'pins:read', 'pins:write'],
}

async function boardId(token: string, board: string): Promise<string> {
  if (/^\d+$/.test(board)) return board
  const { items } = await pjson(`${API}/boards?page_size=250`, { headers: bearer(token), label: 'pinterest: pastas' })
  const found = items?.find((b: any) => b.name.toLowerCase() === board.toLowerCase())
  if (!found) throw new ProviderError('fatal', `pinterest: pasta "${board}" não encontrada (existem: ${items?.map((b: any) => b.name).join(', ')})`)
  return found.id
}

export const pinterest: Provider = {
  network: 'pinterest',
  label: 'Pinterest',
  requiredEnv: ['PINTEREST_CLIENT_ID', 'PINTEREST_CLIENT_SECRET'],
  authUrl: (p) => oauthUrl(cfg, p),

  async connect(p) {
    const tok = await exchangeCode(cfg, p)
    const u = await pjson(`${API}/user_account`, { headers: bearer(tok.access_token), label: 'pinterest: perfil' })
    return [{ externalId: u.id ?? u.username, name: u.business_name || u.username, username: u.username, picture: u.profile_image, ...tokenCreds(cfg, tok) }]
  },

  refresh: (creds) => refreshWith(cfg, creds),

  validate(post) {
    const msg = rules('Pinterest', { maxText: 800, media: 'images', maxMedia: 5, settings: ['board'] })(post)
    if (msg) return msg
    if (!post.media.length) return 'Pinterest: precisa de pelo menos uma imagem'
    if ((post.settings.title ?? '').length > 100) return 'Pinterest: settings.title passa de 100 caracteres'
    return null
  },

  async publish(_channel, creds, post) {
    const s = post.settings
    const [first] = post.media
    const media_source = post.media.length === 1
      ? { source_type: 'image_url', url: first.url }
      : { source_type: 'multiple_image_urls', items: post.media.map((m) => ({ url: m.url, ...(s.link && { link: s.link }) })) }
    const pin = await pjson(`${API}/pins`, {
      method: 'POST', headers: jsonBearer(creds.accessToken), label: 'pinterest: criar pin',
      body: JSON.stringify({
        board_id: await boardId(creds.accessToken, String(s.board)), title: s.title, description: post.text, link: s.link,
        alt_text: first.alt, media_source,
      }),
    })
    return { status: 'published', remoteId: pin.id, remoteUrl: `https://www.pinterest.com/pin/${pin.id}/` }
  },
}

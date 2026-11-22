// Partes comuns de Facebook e Instagram (mesmo app da Meta, mesma Graph API).
// Adaptado de facebook.provider.ts e instagram.provider.ts do Postiz (gitroomhq/postiz-app, AGPL-3.0).
import type { Classify } from './http'
import { env, form, pjson, requireScopes } from './http'

export const GRAPH_VERSION = 'v25.0'
export const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`

type Rule = [needle: string, kind: 'reauth' | 'fatal' | 'retry', message: string]

// Trechos do corpo de erro da Meta e o que significam (lista do handleErrors do Postiz, traduzida).
const COMMON_RULES: Rule[] = [
  ['Error validating access token', 'reauth', 'token da Meta inválido, reconecte o canal'],
  ['REVOKED_ACCESS_TOKEN', 'reauth', 'acesso revogado na Meta, reconecte o canal'],
  ['must be granted before impersonating', 'reauth', 'faltam permissões da página, reconecte e aceite todas'],
  ['session has been invalidated', 'reauth', 'sessão invalidada pela Meta (comum com muitos posts seguidos); reconecte e espere 1 ou 2 dias'],
  ['(#200)', 'fatal', 'a Meta recusou por falta de permissão; a conta precisa de acesso total de conteúdo à página. Reconecte o canal'],
  ['Sorry, something went wrong', 'retry', 'a Meta está instável, tente de novo mais tarde'],
  ['An unknown error occurred', 'retry', 'erro desconhecido na Meta, tente de novo mais tarde'],
]

export const FACEBOOK_RULES: Rule[] = [
  ...COMMON_RULES,
  ['Unpublished posts must be posted to a page as the page itself', 'reauth', 'o app não tem autorização para publicar como esta página, reconecte'],
  ['1404078', 'reauth', 'a página exige nova autorização de publicação, reconecte'],
  ['1366046', 'fatal', 'fotos precisam ter menos de 4 MB e ser JPG ou PNG'],
  ['1390008', 'retry', 'posts rápidos demais, a Meta pediu para desacelerar'],
  ['1346003', 'fatal', 'conteúdo marcado como abusivo pelo Facebook'],
  ['2069019', 'fatal', 'arquivo inválido'],
  ['1404102', 'fatal', 'conteúdo viola os Padrões da Comunidade do Facebook'],
  ['1366051', 'fatal', 'essas fotos já foram postadas'],
  ['1609008', 'fatal', 'não é permitido postar links do facebook.com'],
  ['2061006', 'fatal', 'URL inválida no texto'],
  ['1349125', 'fatal', 'formato de conteúdo inválido'],
  ['1404112', 'fatal', 'a conta está com acesso limitado pelo Facebook por alguns dias'],
  ['Name parameter too long', 'fatal', 'texto longo demais'],
  ['4854002', 'fatal', 'o Facebook pede confirmação de identidade para publicar como esta página (abra o app no celular)'],
  ['No permission to publish the video', 'fatal', 'sem permissão para publicar vídeo nesta página'],
  ['does not exist', 'fatal', 'a página não existe mais, reconecte o canal'],
]

export const INSTAGRAM_RULES: Rule[] = [
  ...COMMON_RULES,
  ['the user is not an instagram business', 'reauth', 'a conta do Instagram precisa ser Profissional (Empresa ou Criador)'],
  ['You cannot access the app till you log in to', 'reauth', 'o Instagram pede para entrar em instagram.com e seguir as instruções; depois reconecte o canal'],
  ['2207050', 'fatal', 'usuário do Instagram com restrição'],
  ['2207003', 'retry', 'o Instagram demorou para baixar a mídia'],
  ['2207020', 'fatal', 'mídia expirou, envie de novo'],
  ['2207032', 'fatal', 'o Instagram não conseguiu criar a mídia'],
  ['2207052', 'retry', 'o Instagram não conseguiu buscar a mídia'],
  ['2207026', 'fatal', 'formato de vídeo não suportado'],
  ['2207023', 'fatal', 'tipo de mídia desconhecido'],
  ['2207006', 'fatal', 'mídia não encontrada, envie de novo'],
  ['2207028', 'fatal', 'carrossel inválido'],
  ['2207010', 'fatal', 'legenda longa demais'],
  ['2207004', 'fatal', 'imagem grande demais'],
  ['2207005', 'fatal', 'formato de imagem não suportado'],
  ['2207009', 'fatal', 'proporção não suportada (precisa ficar entre 4:5 e 1,91:1)'],
  ['36003', 'fatal', 'proporção não suportada (precisa ficar entre 4:5 e 1,91:1)'],
  ['36001', 'fatal', 'resolução de imagem inválida'],
  ['Page request limit reached', 'fatal', 'limite diário de posts da página atingido, tente amanhã'],
  ['2207042', 'fatal', 'limite de 25 posts por dia da conta atingido'],
  ['2207051', 'fatal', 'o Instagram bloqueou o pedido'],
  ['2207001', 'fatal', 'o Instagram considerou o post spam; tente com outro conteúdo'],
  ['2207082', 'retry', 'o Instagram não conseguiu processar o vídeo'],
  ['2207085', 'fatal', 'o Instagram não conseguiu processar o vídeo; confira formato, duração e resolução'],
  ['2207077', 'fatal', 'o Instagram não conseguiu baixar o vídeo'],
  ['too little or too many attachments', 'fatal', 'carrossel precisa ter de 2 a 10 mídias'],
  ['2207027', 'retry', 'a mídia ainda não estava pronta para publicar'],
  ['190,', 'fatal', 'faltam permissões na conta; reconecte e aceite todas'],
]

export const classifyWith = (rules: Rule[]): Classify => (body) => {
  for (const [needle, kind, message] of rules) if (body.includes(needle)) return { kind, message }
  return undefined
}

export function metaAuthUrl(p: { state: string; redirectUri: string; scopes: string[] }) {
  const url = new URL(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`)
  url.search = form({
    client_id: env('FACEBOOK_APP_ID'), redirect_uri: p.redirectUri, state: p.state, scope: p.scopes.join(','),
  }).toString()
  return { url: url.toString() }
}

/** Troca o code por token curto, depois por token longo (~60 dias), e confere as permissões concedidas. */
export async function metaLongLivedToken(p: { code: string; redirectUri: string; scopes: string[]; label: string }): Promise<string> {
  const short = await pjson(`${GRAPH}/oauth/access_token?` + form({
    client_id: env('FACEBOOK_APP_ID'), client_secret: env('FACEBOOK_APP_SECRET'), redirect_uri: p.redirectUri, code: p.code,
  }), { label: `${p.label}: trocar code` })
  const long = await pjson(`${GRAPH}/oauth/access_token?` + form({
    grant_type: 'fb_exchange_token', client_id: env('FACEBOOK_APP_ID'), client_secret: env('FACEBOOK_APP_SECRET'),
    fb_exchange_token: short.access_token,
  }), { label: `${p.label}: token longo` })
  const perms = await pjson(`${GRAPH}/me/permissions?access_token=${long.access_token}`, { label: `${p.label}: permissões` })
  requireScopes(p.scopes, (perms.data ?? []).filter((d: any) => d.status === 'granted').map((d: any) => d.permission), p.label)
  return long.access_token
}

/**
 * Páginas que a pessoa administra: as escolhidas na tela do OAuth (/me/accounts) e as do Business Manager
 * (owned_pages e client_pages), sem repetir. Páginas listadas sem access_token (sem papel na página) ficam de fora.
 */
export async function metaPages(userToken: string, fields: string): Promise<any[]> {
  const seen = new Map<string, any>()
  const walk = async (start: string) => {
    let next: string | undefined = start
    while (next) {
      const r: any = await pjson(next, { label: 'meta: listar páginas' })
      for (const page of r.data ?? []) {
        const prev = seen.get(page.id)
        if (!prev || (!prev.access_token && page.access_token)) seen.set(page.id, page)
      }
      next = r.paging?.next
    }
  }
  await walk(`${GRAPH}/me/accounts?fields=${fields}&limit=100&access_token=${userToken}`)
  try {
    let biz: string | undefined = `${GRAPH}/me/businesses?access_token=${userToken}`
    while (biz) {
      const r: any = await pjson(biz, { label: 'meta: listar empresas' })
      for (const b of r.data ?? []) {
        for (const edge of ['owned_pages', 'client_pages']) {
          await walk(`${GRAPH}/${b.id}/${edge}?fields=${fields}&limit=100&access_token=${userToken}`).catch(() => {})
        }
      }
      biz = r.paging?.next
    }
  } catch {
    // Nem toda conta tem Business Manager.
  }
  return [...seen.values()].filter((p) => p.access_token)
}

import { ProviderError } from '../lib/errors'

// fetch dos providers, no espírito do SocialAbstract.fetch do Postiz: 200/201 passa; 429 e 5xx tentam de novo
// (até 3 vezes, 5 s entre elas); 401 ou um corpo reconhecido pelo `classify` do provider vira reauth; o resto
// vira fatal com o corpo da resposta para diagnóstico.

export type Classify = (body: string, status: number) => { kind: 'reauth' | 'fatal' | 'retry'; message: string } | undefined

export interface FetchOpts extends RequestInit {
  classify?: Classify
  /** Rótulo para a mensagem de erro (ex.: 'instagram: criar container'). */
  label?: string
  /** Aceita qualquer 2xx (ex.: PUT de upload que responde 204). */
  any2xx?: boolean
  retries?: number
}

export let sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
/** Testes trocam a espera por zero. */
export function setSleep(fn: typeof sleep) { sleep = fn }

const MAX_BODY_IN_ERROR = 1_000

export async function pfetch(url: string, opts: FetchOpts = {}, attempt = 0): Promise<Response> {
  const { classify, label, any2xx, retries = 3, ...init } = opts
  let res: Response
  try {
    res = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(120_000) })
  } catch (e: any) {
    if (attempt < retries) { await sleep(5_000); return pfetch(url, opts, attempt + 1) }
    throw new ProviderError('transient', `${label ?? 'rede'}: sem resposta (${e?.message ?? e})`)
  }
  if (res.status === 200 || res.status === 201 || (any2xx && res.ok)) return res

  const body = await res.text().catch(() => '')
  const known = classify?.(body, res.status)
  const rateLimited = res.status === 429 || /rate.?limit/i.test(body)
  if ((rateLimited || (res.status >= 500 && !known) || known?.kind === 'retry') && attempt < retries) {
    await sleep(5_000)
    return pfetch(url, opts, attempt + 1)
  }
  const detail = body.slice(0, MAX_BODY_IN_ERROR)
  const prefix = label ? `${label}: ` : ''
  if (known?.kind === 'reauth' || (res.status === 401 && !known)) {
    throw new ProviderError('reauth', prefix + (known?.message ?? 'token recusado, reconecte o canal'), detail)
  }
  if (rateLimited || res.status >= 500) throw new ProviderError('transient', prefix + (known?.message ?? `HTTP ${res.status}`), detail)
  throw new ProviderError('fatal', prefix + (known?.message ?? `HTTP ${res.status}`), detail)
}

export async function pjson<T = any>(url: string, opts: FetchOpts = {}): Promise<T> {
  const res = await pfetch(url, opts)
  const text = await res.text()
  try { return (text ? JSON.parse(text) : {}) as T } catch {
    throw new ProviderError('fatal', `${opts.label ?? 'rede'}: resposta não é JSON`, text.slice(0, MAX_BODY_IN_ERROR))
  }
}

export const form = (o: Record<string, string>) => new URLSearchParams(o)

/** Exige que as variáveis existam (chamado só quando a rede é usada). */
export function env(name: string): string {
  const v = process.env[name]
  if (!v) throw new ProviderError('fatal', `${name} não configurada no servidor`)
  return v
}

/** Garante que o escopo concedido inclui o necessário (o usuário pode desmarcar permissões na tela da rede). */
export function requireScopes(required: string[], got: string | string[] | undefined, network: string) {
  const list = Array.isArray(got) ? got : decodeURIComponent(got ?? '').split(/[ ,]+/)
  const missing = required.filter((s) => !list.includes(s))
  if (missing.length) throw new ProviderError('fatal', `${network}: faltaram permissões na autorização (${missing.join(', ')}). Conecte de novo e aceite todas.`)
}

/** Endereço base de instância informado pelo tenant (Mastodon, Lemmy, WordPress...): só HTTPS, sem barra no fim. */
export function httpsBase(raw: string | undefined, field: string): string {
  let u: URL
  try { u = new URL(raw?.includes('://') ? raw : `https://${raw}`) } catch { throw new ProviderError('fatal', `${field} não é um endereço válido`) }
  if (u.protocol !== 'https:') throw new ProviderError('fatal', `${field} precisa ser HTTPS`)
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`
}

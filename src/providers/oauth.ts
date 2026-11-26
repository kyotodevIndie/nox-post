import { createHash, randomBytes } from 'node:crypto'
import { ProviderError } from '../lib/errors'
import type { Classify } from './http'
import { env, form, pjson } from './http'
import type { Credentials } from './types'

// OAuth 2.0 "de livro" (authorization code, PKCE opcional, refresh token), usado pelas redes que seguem o padrão.
// Quem foge do padrão (Meta, TikTok, YouTube, Threads) faz o seu.

export interface OAuthCfg {
  network: string
  authorize: string
  token: string
  idEnv: string
  /** Sem segredo = cliente público (só PKCE). */
  secretEnv?: string
  scopes: string[]
  scopeSep?: string
  pkce?: boolean
  /** Manda client_id/secret em Authorization: Basic em vez de no corpo. */
  basic?: boolean
  extraAuth?: Record<string, string>
  /** Cabeçalhos extras na chamada de token (ex.: User-Agent do Reddit). */
  tokenHeaders?: Record<string, string>
  classify?: Classify
  /** Validade quando a rede não manda expires_in; null = não vence. */
  defaultExpiresIn?: number | null
}

export function oauthUrl(cfg: OAuthCfg, { state, redirectUri }: { state: string; redirectUri: string }) {
  const codeVerifier = cfg.pkce ? randomBytes(32).toString('base64url') : undefined
  const url = new URL(cfg.authorize)
  url.search = form({
    client_id: env(cfg.idEnv), redirect_uri: redirectUri, response_type: 'code', state, scope: cfg.scopes.join(cfg.scopeSep ?? ' '),
    ...(codeVerifier && { code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'), code_challenge_method: 'S256' }),
    ...cfg.extraAuth,
  }).toString()
  return { url: url.toString(), codeVerifier }
}

export async function oauthToken(cfg: OAuthCfg, params: Record<string, string>, label = 'trocar code'): Promise<any> {
  const id = env(cfg.idEnv)
  const secret = cfg.secretEnv ? env(cfg.secretEnv) : undefined
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', ...cfg.tokenHeaders }
  const body: Record<string, string> = { ...params }
  if (cfg.basic && secret) headers.Authorization = `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`
  else Object.assign(body, { client_id: id, ...(secret && { client_secret: secret }) })
  const tok = await pjson(cfg.token, { method: 'POST', headers, body: form(body), classify: cfg.classify, label: `${cfg.network}: ${label}` })
  if (tok.error || !tok.access_token) throw new ProviderError('fatal', `${cfg.network}: ${tok.error_description ?? tok.error ?? 'a rede não devolveu token'}`)
  return tok
}

export const exchangeCode = (cfg: OAuthCfg, p: { code: string; codeVerifier?: string; redirectUri: string }) =>
  oauthToken(cfg, { grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri, ...(p.codeVerifier && { code_verifier: p.codeVerifier }) })

export function tokenCreds(cfg: OAuthCfg, tok: any, prev?: Credentials) {
  const secs = tok.expires_in ?? cfg.defaultExpiresIn
  return {
    credentials: { ...prev, accessToken: tok.access_token, refreshToken: tok.refresh_token ?? prev?.refreshToken },
    expiresAt: secs ? new Date(Date.now() + Number(secs) * 1000) : null,
  }
}

export async function refreshWith(cfg: OAuthCfg, creds: Credentials, extra: Record<string, string> = {}) {
  if (!creds.refreshToken) throw new ProviderError('reauth', `${cfg.network}: sem refresh token, reconecte o canal`)
  try {
    return tokenCreds(cfg, await oauthToken(cfg, { grant_type: 'refresh_token', refresh_token: creds.refreshToken, ...extra }, 'renovar token'), creds)
  } catch (e) {
    // invalid_grant e afins vêm como 400: o refresh token morreu.
    if (e instanceof ProviderError && e.kind === 'fatal') throw new ProviderError('reauth', `${e.message} (reconecte o canal)`, e.detail)
    throw e
  }
}

export const bearer = (token: string, extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${token}`, ...extra })
export const jsonBearer = (token: string) => bearer(token, { 'Content-Type': 'application/json' })

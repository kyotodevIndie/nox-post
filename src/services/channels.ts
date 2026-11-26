import { randomBytes } from 'node:crypto'
import { withTx, type Db, type Pool } from '../lib/db'
import { AppError, ProviderError } from '../lib/errors'
import { enabledProviders, getProvider } from '../providers'
import type { ChannelCtx, ConnectedAccount, Credentials, Provider } from '../providers/types'
import { openJson, sealJson } from '../security/secretBox'
import { emit } from './events'
import { channelView } from './views'

// Conexão de canais (OAuth das redes ou credenciais informadas pelo tenant) e renovação de tokens.
// O callback de cada rede OAuth é PUBLIC_URL/oauth/<rede>/callback (cadastre esse endereço no app da rede).

const STATE_TTL_MIN = 60
/** Renova o token quando faltar menos que isso para vencer. */
export const REFRESH_AHEAD_MS = 10 * 60_000

export const redirectUriFor = (network: string) => `${(process.env.PUBLIC_URL ?? '').replace(/\/$/, '')}/oauth/${network}/callback`

function enabledProvider(network: string): Provider {
  const p = getProvider(network)
  if (!p) throw new AppError(404, 'NETWORK_NOT_FOUND', `rede desconhecida: ${network}`)
  if (!enabledProviders().includes(p)) throw new AppError(400, 'NETWORK_DISABLED', `rede ${network} sem credenciais no servidor`)
  return p
}

export async function startConnect(db: Db, tenantId: string, p: { network: string; returnUrl?: string; ref?: string }): Promise<{ url: string; state: string }> {
  const provider = enabledProvider(p.network)
  if (!provider.authUrl) throw new AppError(400, 'CREDENTIALS_REQUIRED', `${p.network} conecta por credenciais: mande credentials { ${provider.credentialFields?.join(', ')} }`)
  const state = randomBytes(24).toString('base64url')
  const { url, codeVerifier } = provider.authUrl({ state, redirectUri: redirectUriFor(p.network) })
  await db.query('DELETE FROM oauth_states WHERE created_at < now() - make_interval(mins => $1)', [STATE_TTL_MIN])
  await db.query(
    `INSERT INTO oauth_states (state, tenant_id, network, code_verifier, return_url, ref) VALUES ($1, $2, $3, $4, $5, $6)`,
    [state, tenantId, p.network, codeVerifier ?? null, p.returnUrl ?? null, p.ref ?? null],
  )
  return { url, state }
}

export interface CallbackResult { returnUrl: string | null; channels: any[]; error?: string; ref: string | null }

/** Consome o state (uso único), troca o code e grava/atualiza um canal por conta devolvida pela rede. */
export async function finishConnect(pool: Pool, network: string, q: { code?: string; state?: string; error?: string; error_description?: string }): Promise<CallbackResult> {
  if (!q.state) throw new AppError(400, 'STATE_MISSING', 'state ausente')
  const st = (await pool.query(
    `DELETE FROM oauth_states s USING tenants t
      WHERE s.state = $1 AND s.network = $2 AND t.id = s.tenant_id AND s.created_at > now() - make_interval(mins => $3)
      RETURNING s.*, t.oauth_return_url AS tenant_return_url`,
    [q.state, network, STATE_TTL_MIN],
  )).rows[0]
  if (!st) throw new AppError(400, 'STATE_INVALID', 'link de conexão vencido ou já usado; comece de novo')
  const returnUrl: string | null = st.return_url ?? st.tenant_return_url ?? null
  if (q.error || !q.code) return { returnUrl, channels: [], ref: st.ref, error: q.error_description || q.error || 'autorização cancelada' }

  const provider = enabledProvider(network)
  if (!provider.connect) throw new AppError(400, 'CREDENTIALS_REQUIRED', `${network} não conecta por OAuth`)
  let accounts
  try {
    accounts = await provider.connect({ code: q.code, codeVerifier: st.code_verifier ?? undefined, redirectUri: redirectUriFor(network), query: q as Record<string, string> })
  } catch (e) {
    if (e instanceof ProviderError) return { returnUrl, channels: [], ref: st.ref, error: e.message }
    throw e
  }
  const channels = await saveAccounts(pool, st.tenant_id, network, st.ref, accounts)
  return { returnUrl, channels, ref: st.ref }
}

/** Conexão por credenciais (token, instância, senha de app): valida na rede e grava na hora, sem redirecionamento. */
export async function connectWithCredentials(pool: Pool, tenantId: string, p: { network: string; credentials: Record<string, string>; ref?: string }) {
  const provider = enabledProvider(p.network)
  if (!provider.connectWith) throw new AppError(400, 'OAUTH_REQUIRED', `${p.network} conecta por OAuth: chame sem credentials e mande a pessoa para a url`)
  const missing = (provider.credentialFields ?? []).filter((f) => !f.endsWith('?') && !p.credentials[f])
  if (missing.length) throw new AppError(422, 'CREDENTIALS_INVALID', `faltam campos em credentials: ${missing.join(', ')}`)
  let accounts
  try {
    accounts = await provider.connectWith(p.credentials)
  } catch (e) {
    if (e instanceof ProviderError) throw new AppError(422, 'CREDENTIALS_INVALID', e.message)
    throw e
  }
  return saveAccounts(pool, tenantId, p.network, p.ref ?? null, accounts)
}

/** Grava/atualiza um canal por conta devolvida pela rede e avisa o tenant. */
async function saveAccounts(pool: Pool, tenantId: string, network: string, ref: string | null, accounts: ConnectedAccount[]) {
  return withTx(pool, async (c) => {
    const out = []
    for (const a of accounts) {
      const row = (await c.query(
        `INSERT INTO channels (tenant_id, network, external_id, name, username, picture, credentials_enc, expires_at, meta, ref)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (tenant_id, network, external_id) DO UPDATE SET
           name = EXCLUDED.name, username = EXCLUDED.username, picture = EXCLUDED.picture, credentials_enc = EXCLUDED.credentials_enc,
           expires_at = EXCLUDED.expires_at, meta = EXCLUDED.meta, ref = COALESCE(EXCLUDED.ref, channels.ref),
           status = 'active', last_error = NULL, updated_at = now()
         RETURNING *`,
        [tenantId, network, a.externalId, a.name, a.username ?? null, a.picture ?? null, sealJson(a.credentials),
          a.expiresAt, JSON.stringify(a.meta ?? {}), ref],
      )).rows[0]
      out.push(channelView(row))
    }
    await emit(c, tenantId, 'channel.connected', { network, ref, channels: out })
    return out
  })
}

export const channelCtx = (row: any): ChannelCtx => ({ externalId: row.external_id, name: row.name, username: row.username, meta: row.meta ?? {} })

/** Marca o canal como precisando de reconexão (uma vez) e avisa o tenant. */
export async function markNeedsReauth(db: Db, row: any, reason: string): Promise<void> {
  const r = await db.query(
    `UPDATE channels SET status = 'needs_reauth', last_error = $2, updated_at = now() WHERE id = $1 AND status = 'active' RETURNING *`,
    [row.id, reason],
  )
  if (r.rows[0]) await emit(db, row.tenant_id, 'channel.needs_reauth', { channel: channelView(r.rows[0]), reason })
}

/**
 * Credenciais válidas do canal: renova antes se estiver perto de vencer (ou se `force`).
 * Falha de renovação do tipo reauth marca o canal e relança.
 */
export async function freshCredentials(pool: Pool, row: any, opts: { force?: boolean } = {}): Promise<Credentials> {
  const creds = openJson<Credentials>(row.credentials_enc)
  const provider = getProvider(row.network)!
  const nearExpiry = row.expires_at && new Date(row.expires_at).getTime() - REFRESH_AHEAD_MS < Date.now()
  if (!opts.force && !nearExpiry) return creds
  if (!provider.refresh) {
    if (nearExpiry || opts.force) {
      const reason = `${row.network}: token vencido, reconecte o canal`
      await markNeedsReauth(pool, row, reason)
      throw new ProviderError('reauth', reason)
    }
    return creds
  }
  try {
    const next = await provider.refresh(creds, channelCtx(row))
    await pool.query(`UPDATE channels SET credentials_enc = $2, expires_at = $3, last_error = NULL, updated_at = now() WHERE id = $1`,
      [row.id, sealJson(next.credentials), next.expiresAt])
    row.credentials_enc = sealJson(next.credentials)
    row.expires_at = next.expiresAt
    return next.credentials
  } catch (e) {
    if (e instanceof ProviderError && e.kind === 'reauth') await markNeedsReauth(pool, row, e.message)
    throw e
  }
}

/** Renova em segundo plano os tokens que vencem na próxima hora (worker). */
export async function refreshExpiring(pool: Pool, log: { warn: (...a: any[]) => void }): Promise<number> {
  const rows = (await pool.query(
    `SELECT * FROM channels WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < now() + interval '1 hour' ORDER BY expires_at LIMIT 50`,
  )).rows
  let n = 0
  for (const row of rows) {
    if (!getProvider(row.network)?.refresh) continue
    try {
      await freshCredentials(pool, row, { force: true })
      n++
    } catch (err) {
      log.warn({ err, channel: row.id }, 'renovação de token falhou')
    }
  }
  return n
}

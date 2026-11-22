import { randomBytes } from 'node:crypto'
import type { Db } from '../lib/db'
import { AppError } from '../lib/errors'
import { newSecret, seal } from '../security/secretBox'
import { sha256hex } from '../security/signature'

// Tenants = sistemas que usam a API. A chave começa com pnox_ e só é mostrada na criação.

export const newApiKey = () => 'pnox_' + randomBytes(32).toString('base64url')

export const tenantView = (t: any) => ({
  id: t.id, name: t.name, webhookUrl: t.webhook_url, oauthReturnUrl: t.oauth_return_url, active: t.active, createdAt: t.created_at,
})

export async function createTenant(db: Db, p: { name: string; webhookUrl?: string | null; oauthReturnUrl?: string | null }) {
  const apiKey = newApiKey()
  const webhookSecret = newSecret()
  const row = (await db.query(
    `INSERT INTO tenants (name, api_key_hash, webhook_url, webhook_secret_enc, oauth_return_url) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [p.name, sha256hex(apiKey), p.webhookUrl ?? null, seal(webhookSecret), p.oauthReturnUrl ?? null],
  )).rows[0]
  return { tenant: tenantView(row), apiKey, webhookSecret }
}

export async function updateTenant(db: Db, id: string, p: { name?: string; webhookUrl?: string | null; oauthReturnUrl?: string | null; active?: boolean }) {
  const row = (await db.query(
    `UPDATE tenants SET name = COALESCE($2, name),
            webhook_url = CASE WHEN $3::boolean THEN $4 ELSE webhook_url END,
            oauth_return_url = CASE WHEN $5::boolean THEN $6 ELSE oauth_return_url END,
            active = COALESCE($7, active)
      WHERE id = $1 RETURNING *`,
    [id, p.name ?? null, p.webhookUrl !== undefined, p.webhookUrl ?? null, p.oauthReturnUrl !== undefined, p.oauthReturnUrl ?? null, p.active ?? null],
  )).rows[0]
  if (!row) throw new AppError(404, 'TENANT_NOT_FOUND', 'tenant não encontrado')
  return tenantView(row)
}

/** Gera chave nova (a antiga para de valer na hora) e, se pedido, segredo de webhook novo. */
export async function rotateTenant(db: Db, id: string, p: { webhookSecret?: boolean }) {
  const apiKey = newApiKey()
  const webhookSecret = p.webhookSecret ? newSecret() : undefined
  const row = (await db.query(
    `UPDATE tenants SET api_key_hash = $2, webhook_secret_enc = COALESCE($3, webhook_secret_enc) WHERE id = $1 RETURNING *`,
    [id, sha256hex(apiKey), webhookSecret ? seal(webhookSecret) : null],
  )).rows[0]
  if (!row) throw new AppError(404, 'TENANT_NOT_FOUND', 'tenant não encontrado')
  return { tenant: tenantView(row), apiKey, ...(webhookSecret ? { webhookSecret } : {}) }
}

export async function tenantByKey(db: Db, apiKey: string) {
  if (!apiKey.startsWith('pnox_')) return null
  return (await db.query('SELECT * FROM tenants WHERE api_key_hash = $1 AND active', [sha256hex(apiKey)])).rows[0] ?? null
}

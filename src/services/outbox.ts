import type { Db, Pool } from '../lib/db'
import { open } from '../security/secretBox'
import { signWebhook } from '../security/signature'

// Entrega dos webhooks API -> tenant (outbox, igual ao Nox). Pega eventos vencidos com FOR UPDATE SKIP LOCKED,
// POST assinado, 2xx = entregue; senão backoff exponencial até MAX_ATTEMPTS e depois 'dead' (reenviável pelo admin).
// Idempotência do lado do tenant pelo X-Nox-Event-Id.

export const MAX_ATTEMPTS = 12
/** Espera antes da tentativa n+1 (segundos): 30s, 1m, 2m, 4m ... teto de 6h. */
export const backoffSeconds = (attempts: number) => Math.min(30 * 2 ** Math.max(0, attempts - 1), 6 * 3600)

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; ok: boolean }>

export async function deliverDue(pool: Pool, opts: { fetch?: FetchLike; limit?: number; now?: () => Date } = {}): Promise<{ delivered: number; failed: number }> {
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init))
  let delivered = 0, failed = 0
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    const due = (await c.query(
      `SELECT e.id, e.payload, e.attempts, t.webhook_url, t.webhook_secret_enc, t.active
         FROM outbound_events e JOIN tenants t ON t.id = e.tenant_id
        WHERE e.status = 'pending' AND e.next_attempt_at <= COALESCE($2::timestamptz, now())
        ORDER BY e.created_at FOR UPDATE OF e SKIP LOCKED LIMIT $1`, [opts.limit ?? 20, opts.now?.() ?? null])).rows
    for (const ev of due) {
      const attempts = ev.attempts + 1
      let code: number | null = null, error: string | null = null
      if (!ev.webhook_url || !ev.active) {
        error = !ev.webhook_url ? 'NO_WEBHOOK_URL' : 'TENANT_INACTIVE'
      } else {
        const body = JSON.stringify(ev.payload)
        const ts = String(Math.floor((opts.now?.() ?? new Date()).getTime() / 1000))
        try {
          const res = await doFetch(ev.webhook_url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json', 'User-Agent': 'nox-post/1',
              'X-Nox-Event-Id': ev.id, 'X-Nox-Timestamp': ts, 'X-Nox-Signature': signWebhook(open(ev.webhook_secret_enc), ts, body),
            },
            body, signal: AbortSignal.timeout(10_000),
          })
          code = res.status
          if (!res.ok) error = `HTTP ${res.status}`
        } catch (e: any) {
          error = String(e?.message ?? e).slice(0, 300)
        }
      }
      if (!error) {
        delivered++
        await c.query(`UPDATE outbound_events SET status = 'delivered', attempts = $2, delivered_at = now(), last_status_code = $3, last_error = NULL WHERE id = $1`,
          [ev.id, attempts, code])
      } else {
        failed++
        await c.query(
          `UPDATE outbound_events SET attempts = $2::int, last_status_code = $3, last_error = $4,
                  status = CASE WHEN $2::int >= $5::int THEN 'dead' ELSE 'pending' END,
                  next_attempt_at = COALESCE($6::timestamptz, now()) + make_interval(secs => $7)
            WHERE id = $1`, [ev.id, attempts, code, error, MAX_ATTEMPTS, opts.now?.() ?? null, backoffSeconds(attempts)])
      }
    }
    await c.query('COMMIT')
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    c.release()
  }
  return { delivered, failed }
}

/** Reenfileira um evento (dead ou pending) para entrega imediata. */
export async function requeueEvent(db: Db, id: string): Promise<boolean> {
  const r = await db.query(`UPDATE outbound_events SET status = 'pending', next_attempt_at = now(), attempts = 0 WHERE id = $1 AND status <> 'delivered' RETURNING id`, [id])
  return !!r.rows[0]
}

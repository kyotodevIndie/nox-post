import type { Pool } from '../lib/db'
import { ProviderError } from '../lib/errors'
import { getProvider } from '../providers'
import type { PublishOutcome } from '../providers/types'
import { channelCtx, freshCredentials } from './channels'
import { emit } from './events'
import { postView } from './views'

// Worker de publicação. Faz o papel do workflow de post do Postiz (Temporal), só com o Postgres:
// 1. pega posts vencidos com FOR UPDATE SKIP LOCKED e marca 'publishing' antes de chamar a rede;
// 2. publish() devolve published (fim) ou processing (vídeo/container sendo processado);
// 3. posts em processing são checados a cada CHECK_EVERY_S até MAX_CHECKS;
// 4. erro reauth: renova o token e tenta mais uma vez; se não der, o canal vira needs_reauth e o post falha.
// Nunca republica sozinho um post cujo resultado é incerto: 'publishing' parado há mais de STUCK_MIN vira falha
// (o processo caiu no meio do envio e a rede pode ter publicado). O tenant decide se reenvia.

export const CHECK_EVERY_S = 15
export const MAX_CHECKS = 240 // ~1 hora
export const STUCK_MIN = 120

type Log = { warn: (...a: any[]) => void; info?: (...a: any[]) => void }

async function finish(pool: Pool, post: any, outcome: PublishOutcome) {
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    if (outcome.status === 'published') {
      const row = (await c.query(
        `UPDATE posts SET status = 'published', remote_id = $2, remote_url = $3, published_at = now(), pending_data = NULL,
                next_check_at = NULL, error = NULL, updated_at = now() WHERE id = $1 RETURNING *`,
        [post.id, outcome.remoteId, outcome.remoteUrl],
      )).rows[0]
      await emit(c, post.tenant_id, 'post.published', { post: postView(row) })
    } else {
      await c.query(
        `UPDATE posts SET status = 'processing', pending_data = $2, checks = checks + 1,
                next_check_at = now() + make_interval(secs => $3), updated_at = now() WHERE id = $1`,
        [post.id, JSON.stringify(outcome.pendingData ?? null), CHECK_EVERY_S],
      )
    }
    await c.query('COMMIT')
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    c.release()
  }
}

async function fail(pool: Pool, post: any, err: unknown) {
  const message = err instanceof ProviderError ? err.message : `erro interno: ${(err as any)?.message ?? err}`
  const kind = err instanceof ProviderError ? err.kind : 'internal'
  const detail = err instanceof ProviderError ? err.detail : undefined
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    const row = (await c.query(
      `UPDATE posts SET status = 'failed', error = $2, next_check_at = NULL, updated_at = now() WHERE id = $1 RETURNING *`,
      [post.id, message.slice(0, 2000)],
    )).rows[0]
    await emit(c, post.tenant_id, 'post.failed', { post: postView(row), reason: kind, detail: detail?.slice(0, 1000) })
    await c.query('COMMIT')
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    c.release()
  }
}

/** Roda `fn` com credenciais frescas; em reauth renova uma vez e repete. */
async function withCredentials<T>(pool: Pool, channel: any, fn: (creds: any) => Promise<T>): Promise<T> {
  const creds = await freshCredentials(pool, channel)
  try {
    return await fn(creds)
  } catch (e) {
    if (!(e instanceof ProviderError) || e.kind !== 'reauth' || !getProvider(channel.network)?.refresh) throw e
    return fn(await freshCredentials(pool, channel, { force: true }))
  }
}

async function loadChannel(pool: Pool, id: string) {
  return (await pool.query('SELECT * FROM channels WHERE id = $1', [id])).rows[0]
}

export async function publishDue(pool: Pool, log: Log, limit = 5): Promise<number> {
  const claimed = (await pool.query(
    `UPDATE posts SET status = 'publishing', started_at = now(), updated_at = now()
      WHERE id IN (SELECT id FROM posts WHERE status = 'scheduled' AND scheduled_at <= now()
                    ORDER BY scheduled_at FOR UPDATE SKIP LOCKED LIMIT $1)
      RETURNING *`,
    [limit],
  )).rows
  await Promise.all(claimed.map(async (post) => {
    try {
      const channel = await loadChannel(pool, post.channel_id)
      const provider = getProvider(channel?.network)
      if (!channel || !provider) throw new ProviderError('fatal', 'canal ou rede indisponível')
      if (channel.status !== 'active') throw new ProviderError('reauth', channel.status === 'needs_reauth' ? 'canal precisa ser reconectado' : 'canal desconectado')
      const input = { text: post.text, media: post.media, settings: post.settings }
      const outcome = await withCredentials(pool, channel, (creds) => provider.publish(channelCtx(channel), creds, input))
      if (outcome.status === 'processing' && !provider.check) throw new ProviderError('fatal', `${provider.network}: processing sem check`)
      await finish(pool, post, outcome)
    } catch (err) {
      log.warn({ err: err instanceof ProviderError ? { kind: err.kind, message: err.message } : err, post: post.id }, 'publicação falhou')
      await fail(pool, post, err)
    }
  }))
  return claimed.length
}

export async function checkProcessing(pool: Pool, log: Log, limit = 10): Promise<number> {
  const due = (await pool.query(
    `UPDATE posts SET next_check_at = now() + make_interval(secs => $2), updated_at = now()
      WHERE id IN (SELECT id FROM posts WHERE status = 'processing' AND next_check_at <= now()
                    ORDER BY next_check_at FOR UPDATE SKIP LOCKED LIMIT $1)
      RETURNING *`,
    [limit, CHECK_EVERY_S * 4],
  )).rows
  await Promise.all(due.map(async (post) => {
    try {
      if (post.checks >= MAX_CHECKS) throw new ProviderError('fatal', 'a rede não terminou de processar em 1 hora; confira na conta antes de reenviar')
      const channel = await loadChannel(pool, post.channel_id)
      const provider = getProvider(channel?.network)
      if (!channel || !provider?.check) throw new ProviderError('fatal', 'canal ou rede indisponível')
      const outcome = await withCredentials(pool, channel, (creds) => provider.check!(channelCtx(channel), creds, post.pending_data))
      await finish(pool, post, outcome)
    } catch (err) {
      log.warn({ err: err instanceof ProviderError ? { kind: err.kind, message: err.message } : err, post: post.id }, 'checagem falhou')
      await fail(pool, post, err)
    }
  }))
  return due.length
}

/** Posts presos em 'publishing' (processo caiu no meio) viram falha com aviso de resultado incerto. */
export async function failStuck(pool: Pool): Promise<number> {
  const rows = (await pool.query(
    `SELECT * FROM posts WHERE status = 'publishing' AND started_at < now() - make_interval(mins => $1) LIMIT 50`, [STUCK_MIN],
  )).rows
  for (const post of rows) {
    await fail(pool, post, new ProviderError('transient', 'o envio foi interrompido no meio; confira na rede se o post saiu antes de reenviar'))
  }
  return rows.length
}

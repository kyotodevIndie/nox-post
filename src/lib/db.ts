import pg from 'pg'

// BIGINT (tamanho de mídia) como número: cabe com folga em Number.
pg.types.setTypeParser(20, (v: string) => Number(v))

export type Pool = pg.Pool
export type PoolClient = pg.PoolClient
/** Pool ou client dentro de transação. */
export type Db = { query: (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number | null }> }

type Log = { error: (obj: unknown, msg?: string) => void }

/** Pool com ouvinte de 'error' (conexão ociosa derrubada pelo servidor não derruba o processo). */
export function createPool(config: pg.PoolConfig, log: Log): pg.Pool {
  const pool = new pg.Pool(config)
  pool.on('error', (err: any) => log.error({ err: { message: err?.message, code: err?.code } }, 'pg: conexão ociosa caiu'))
  return pool
}

/** BEGIN/COMMIT/ROLLBACK num client dedicado. */
export async function withTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    const out = await fn(c)
    await c.query('COMMIT')
    return out
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    c.release()
  }
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

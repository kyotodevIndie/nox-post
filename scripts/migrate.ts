import 'dotenv/config'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'

// Aplica migrations/NNN_*.up.sql pendentes, em ordem, registrando cada uma em schema_migrations
// (cada arquivo numa transação junto com o registro; falha => ROLLBACK e para).
// Uso: pnpm migrate [--dry-run]
const __dirname = dirname(fileURLToPath(import.meta.url))
export const MIGRATIONS_DIR = join(__dirname, '../migrations')

export interface RunResult { applied: string[]; pending: string[]; failed?: { name: string; error: unknown } }

export function listMigrations(dir = MIGRATIONS_DIR): { name: string; path: string }[] {
  if (!existsSync(dir)) throw new Error(`migrations ausentes em ${dir}`)
  return readdirSync(dir).filter((f) => /^\d{3}_.+\.up\.sql$/.test(f)).sort().map((f) => ({ name: f, path: join(dir, f) }))
}

export async function runMigrations(pool: pg.Pool, opts: { dryRun?: boolean; log?: (m: string) => void } = {}): Promise<RunResult> {
  const log = opts.log ?? (() => {})
  const all = listMigrations()
  if (!opts.dryRun) {
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`)
  }
  const reg = await pool.query(`SELECT to_regclass('schema_migrations') AS t`)
  const done = new Set<string>(reg.rows[0].t ? (await pool.query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename) : [])
  const pending = all.filter((m) => !done.has(m.name))
  const result: RunResult = { applied: [], pending: pending.map((m) => m.name) }
  if (opts.dryRun) {
    for (const m of pending) log(`[dry-run] ${m.name}`)
    return result
  }
  for (const m of pending) {
    log(`→ ${m.name}`)
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      await c.query(readFileSync(m.path, 'utf-8'))
      await c.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [m.name])
      await c.query('COMMIT')
      result.applied.push(m.name)
    } catch (error) {
      await c.query('ROLLBACK').catch(() => {})
      result.failed = { name: m.name, error }
      log(`  falhou: ${error instanceof Error ? error.message : String(error)}`)
      return result
    } finally {
      await c.query('RESET lock_timeout').catch(() => {})
      c.release()
    }
  }
  log(`${result.applied.length} migration(s) aplicada(s).`)
  return result
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const pool = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL })
  try {
    const r = await runMigrations(pool, { dryRun, log: (m) => console.log(m) })
    if (r.failed) process.exitCode = 1
  } finally {
    await pool.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => { console.error(err); process.exit(1) })
}

import type { Pool } from '../lib/db'
import { refreshExpiring } from './channels'
import { deliverDue } from './outbox'
import { checkProcessing, failStuck, publishDue } from './publisher'

type Log = { warn: (...a: any[]) => void }

/** Um laço por tarefa, cada um com sua trava: um upload longo não segura a entrega de webhooks nem as checagens. */
function loop(name: string, everyMs: number, log: Log, fn: () => Promise<unknown>) {
  let busy = false
  const t = setInterval(async () => {
    if (busy) return
    busy = true
    try {
      await fn()
    } catch (err) {
      log.warn({ err }, `worker ${name} falhou (tenta de novo no próximo ciclo)`)
    } finally {
      busy = false
    }
  }, everyMs)
  t.unref()
  return t
}

export function startWorkers(pool: Pool, log: Log) {
  return [
    loop('publicar', 5_000, log, () => publishDue(pool, log)),
    loop('checar', 5_000, log, () => checkProcessing(pool, log)),
    loop('webhooks', 5_000, log, () => deliverDue(pool)),
    loop('tokens', 5 * 60_000, log, () => refreshExpiring(pool, log)),
    loop('presos', 5 * 60_000, log, () => failStuck(pool)),
  ]
}

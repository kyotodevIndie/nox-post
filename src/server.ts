import 'dotenv/config'
import { buildApp } from './app'
import { enabledProviders } from './providers'
import { startWorkers } from './services/worker'

for (const name of ['DATABASE_URL', 'SECRETS_KEY', 'PUBLIC_URL']) {
  if (!process.env[name]) { console.error(`${name} não configurada`); process.exit(1) }
}
if ((process.env.SECRETS_KEY ?? '').length < 32) { console.error('SECRETS_KEY precisa ter pelo menos 32 caracteres'); process.exit(1) }

const app = await buildApp()
const reg = await app.db.query(`SELECT to_regclass('posts') AS t`)
if (!reg.rows[0].t) { app.log.error('tabelas ausentes: rode `pnpm migrate` antes'); process.exit(1) }

app.log.info({ networks: enabledProviders().map((p) => p.network) }, 'redes habilitadas')
if (process.env.WORKERS !== '0') startWorkers(app.db, app.log)

await app.listen({ port: Number(process.env.PORT ?? 3500), host: process.env.HOST ?? '0.0.0.0' })
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => { app.close().finally(() => process.exit(0)) })
}

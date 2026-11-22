import 'dotenv/config'
import pg from 'pg'
import { createTenant } from '../src/services/tenants'

// Cria um tenant direto no banco (alternativa ao POST /admin/tenants). Mostra a chave e o segredo uma vez só.
// Uso: pnpm tenant:create "Meu app" [webhookUrl] [oauthReturnUrl]
const [name, webhookUrl, oauthReturnUrl] = process.argv.slice(2)
if (!name) { console.error('uso: pnpm tenant:create <nome> [webhookUrl] [oauthReturnUrl]'); process.exit(1) }
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
try {
  const r = await createTenant(pool, { name, webhookUrl, oauthReturnUrl })
  console.log(JSON.stringify(r, null, 2))
  console.log('\nGuarde apiKey e webhookSecret agora: não dá para ver de novo (só gerar outros com /admin/tenants/:id/rotate).')
} finally {
  await pool.end()
}

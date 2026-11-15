import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

// Cifra tokens das redes e segredos de webhook em repouso (AES-256-GCM). Chave = sha256(SECRETS_KEY).
// Formato: v1.<iv b64url>.<tag b64url>.<cifrado b64url>

function key(env: NodeJS.ProcessEnv = process.env): Buffer {
  const k = env.SECRETS_KEY
  if (!k || k.length < 32) throw new Error('SECRETS_KEY ausente ou curta (mínimo 32 caracteres)')
  return createHash('sha256').update(k).digest()
}

export function seal(plain: string, env?: NodeJS.ProcessEnv): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key(env), iv)
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.')
}

export function open(sealed: string, env?: NodeJS.ProcessEnv): string {
  const [v, iv, tag, enc] = sealed.split('.')
  if (v !== 'v1' || !iv || !tag || !enc) throw new Error('segredo cifrado em formato desconhecido')
  const d = createDecipheriv('aes-256-gcm', key(env), Buffer.from(iv, 'base64url'))
  d.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([d.update(Buffer.from(enc, 'base64url')), d.final()]).toString('utf8')
}

export const sealJson = (v: unknown, env?: NodeJS.ProcessEnv) => seal(JSON.stringify(v), env)
export const openJson = <T = any>(sealed: string, env?: NodeJS.ProcessEnv): T => JSON.parse(open(sealed, env))

export const newSecret = (bytes = 32) => randomBytes(bytes).toString('base64url')

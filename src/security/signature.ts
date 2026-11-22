import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

// Webhooks API -> tenant, no mesmo formato do Nox (headers X-Nox-Event-Id, X-Nox-Timestamp, X-Nox-Signature):
//   signature = 'v1=' + hex(HMAC_SHA256(segredo, `${timestamp}.${corpo cru}`)), timestamp Unix em segundos.

export const sha256hex = (v: string | Buffer) => createHash('sha256').update(v).digest('hex')

export function signWebhook(secret: string, timestamp: string, rawBody: string): string {
  return 'v1=' + createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')
}

/** Comparação em tempo constante de duas assinaturas 'v1=<hex>'. */
export function signaturesMatch(expected: string, received: string | undefined): boolean {
  if (typeof received !== 'string' || !received.startsWith('v1=')) return false
  const a = Buffer.from(expected.slice(3), 'hex')
  const b = Buffer.from(received.slice(3), 'hex')
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
}

/** Comparação em tempo constante de dois textos (token de admin). */
export function safeEqual(a: string, b: string | undefined): boolean {
  if (typeof b !== 'string') return false
  const x = Buffer.from(sha256hex(a)), y = Buffer.from(sha256hex(b))
  return timingSafeEqual(x, y)
}

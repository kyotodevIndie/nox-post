import type { Db } from '../lib/db'

// Eventos para o tenant: gravados na mesma transação da mudança e entregues pelo worker da outbox.
export type EventType = 'channel.connected' | 'channel.needs_reauth' | 'post.published' | 'post.failed'

export async function emit(db: Db, tenantId: string, type: EventType, data: Record<string, unknown>): Promise<void> {
  await db.query(
    `INSERT INTO outbound_events (id, tenant_id, type, payload)
     SELECT id, $1, $2, jsonb_build_object('id', id, 'type', $2::text, 'occurredAt', now(), 'data', $3::jsonb)
       FROM (SELECT gen_random_uuid() AS id) x`,
    [tenantId, type, JSON.stringify(data)],
  )
}

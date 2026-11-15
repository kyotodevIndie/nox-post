// Formato público dos objetos (nunca expõe credenciais).

export const channelView = (c: any) => ({
  id: c.id, network: c.network, externalId: c.external_id, name: c.name, username: c.username, picture: c.picture,
  status: c.status, ref: c.ref, lastError: c.last_error, expiresAt: c.expires_at, createdAt: c.created_at, updatedAt: c.updated_at,
})

export const postView = (p: any) => ({
  id: p.id, channelId: p.channel_id, externalRef: p.external_ref, text: p.text, media: p.media, settings: p.settings,
  scheduledAt: p.scheduled_at, status: p.status, remoteId: p.remote_id, remoteUrl: p.remote_url, error: p.error,
  publishedAt: p.published_at, createdAt: p.created_at, updatedAt: p.updated_at,
})

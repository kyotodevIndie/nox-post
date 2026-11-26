// Contrato dos providers. Inspirado na interface SocialProvider do Postiz (generateAuthUrl / authenticate /
// refreshToken / post / checkPostStatus / finalizePost), simplificado: o OAuth já devolve as contas
// (páginas, perfis, canais) e o `check` avança o post (inclui o que o Postiz chama de finalizePost).

export type Network =
  | 'facebook' | 'instagram' | 'linkedin' | 'linkedin-page' | 'youtube' | 'tiktok'
  | 'x' | 'threads' | 'pinterest' | 'reddit' | 'gmb' | 'dribbble' | 'tumblr' | 'slack' | 'discord' | 'telegram'
  | 'mastodon' | 'bluesky' | 'lemmy' | 'farcaster' | 'nostr' | 'vk' | 'kick' | 'twitch'
  | 'devto' | 'medium' | 'hashnode' | 'wordpress'

export interface MediaItem {
  url: string
  type: 'image' | 'video'
  thumbnail?: string
  alt?: string
}

/** Credenciais guardadas cifradas por canal. Cada provider sabe o que põe aqui. */
export interface Credentials {
  accessToken: string
  refreshToken?: string
  [k: string]: unknown
}

export interface ConnectedAccount {
  externalId: string
  name: string
  username?: string
  picture?: string
  credentials: Credentials
  /** Vencimento do access token; null = não vence ou não tem como renovar. */
  expiresAt: Date | null
  meta?: Record<string, unknown>
}

export interface ChannelCtx {
  externalId: string
  name: string
  username: string | null
  meta: Record<string, any>
}

export interface PostInput {
  text: string
  media: MediaItem[]
  settings: Record<string, any>
}

export type PublishOutcome =
  | { status: 'published'; remoteId: string; remoteUrl: string | null }
  | { status: 'processing'; pendingData: unknown }

export interface Provider {
  network: Network
  label: string
  /** Variáveis de ambiente obrigatórias; sem elas a rede fica desligada. */
  requiredEnv: string[]
  /** Conexão por OAuth (authUrl + connect). `query` traz o resto dos parâmetros do callback (ex.: device_id do VK). */
  authUrl?(p: { state: string; redirectUri: string }): { url: string; codeVerifier?: string }
  connect?(p: { code: string; codeVerifier?: string; redirectUri: string; query?: Record<string, string> }): Promise<ConnectedAccount[]>
  /**
   * Conexão por credenciais (token de API, instância, senha de app, webhook), para redes sem OAuth ou com OAuth por
   * instância. `credentialFields` lista os campos aceitos em POST /v1/channels/connect `credentials`.
   */
  credentialFields?: string[]
  connectWith?(input: Record<string, string>): Promise<ConnectedAccount[]>
  /** Renova o access token. Sem implementação = o canal precisa ser reconectado quando vencer. */
  refresh?(creds: Credentials, channel: ChannelCtx): Promise<{ credentials: Credentials; expiresAt: Date | null }>
  /** Valida o post antes de aceitar (mensagem de erro em português) ou null se estiver ok. */
  validate(post: PostInput): string | null
  publish(channel: ChannelCtx, creds: Credentials, post: PostInput): Promise<PublishOutcome>
  /** Obrigatório se `publish` pode devolver processing. Uma checagem só, sem laço: quem repete é o worker. */
  check?(channel: ChannelCtx, creds: Credentials, pendingData: any): Promise<PublishOutcome>
}

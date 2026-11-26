import { devto, hashnode, medium, wordpress } from './blogs'
import { bluesky } from './bluesky'
import { discord } from './discord'
import { dribbble } from './dribbble'
import { facebook } from './facebook'
import { farcaster } from './farcaster'
import { gmb } from './gmb'
import { instagram } from './instagram'
import { kick } from './kick'
import { lemmy } from './lemmy'
import { linkedin, linkedinPage } from './linkedin'
import { mastodon } from './mastodon'
import { nostr } from './nostr'
import { pinterest } from './pinterest'
import { reddit } from './reddit'
import { slack } from './slack'
import { telegram } from './telegram'
import { threads } from './threads'
import { tiktok } from './tiktok'
import { tumblr } from './tumblr'
import { twitch } from './twitch'
import type { Network, Provider } from './types'
import { vk } from './vk'
import { x } from './x'
import { youtube } from './youtube'

// Para adicionar uma rede: crie src/providers/<rede>.ts implementando Provider, inclua o nome em Network
// (types.ts) e registre aqui. O resto (OAuth, conexão por credenciais, fila, refresh, webhooks) é genérico.
let registry: Record<string, Provider> = Object.fromEntries(
  [
    facebook, instagram, linkedin, linkedinPage, youtube, tiktok,
    x, threads, pinterest, reddit, gmb, dribbble, tumblr, slack, vk, kick, twitch,
    discord, telegram, mastodon, bluesky, lemmy, farcaster, nostr, devto, medium, hashnode, wordpress,
  ].map((p) => [p.network, p]),
)
export function getProvider(network: string): Provider | undefined {
  return registry[network]
}

/** Redes com as variáveis de ambiente preenchidas. */
export function enabledProviders(env: NodeJS.ProcessEnv = process.env): Provider[] {
  return Object.values(registry).filter((p) => p.requiredEnv.every((k) => !!env[k]))
}

export const allNetworks = () => Object.keys(registry) as Network[]

/** Testes trocam o registro por providers falsos. */
export function setProviders(list: Provider[]) {
  registry = Object.fromEntries(list.map((p) => [p.network, p]))
}

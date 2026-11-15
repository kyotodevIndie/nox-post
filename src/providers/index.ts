import { facebook } from './facebook'
import { instagram } from './instagram'
import { linkedin, linkedinPage } from './linkedin'
import { tiktok } from './tiktok'
import type { Network, Provider } from './types'
import { youtube } from './youtube'

// Para adicionar uma rede: crie src/providers/<rede>.ts implementando Provider, inclua o nome em Network
// (types.ts) e registre aqui. O resto (OAuth, fila, refresh, webhooks) é genérico.
let registry: Record<string, Provider> = Object.fromEntries(
  [facebook, instagram, linkedin, linkedinPage, youtube, tiktok].map((p) => [p.network, p]),
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

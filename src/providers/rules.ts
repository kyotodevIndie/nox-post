import { isVideo } from './media'
import type { PostInput } from './types'

// Regras de validação comuns (mensagens em português, voltam como 422 POST_INVALID).

export interface Rules {
  /** Limite de caracteres (code points; o Bluesky conta grafemas por conta própria). */
  maxText?: number
  /** Texto obrigatório. */
  text?: boolean
  /** Mídia: 'none' (só texto), 'images' (sem vídeo), 'required' (pelo menos uma). */
  media?: 'none' | 'images' | 'required'
  maxMedia?: number
  /** Campos de settings obrigatórios. */
  settings?: string[]
}

export const chars = (s: string) => [...s].length

export function check(label: string, r: Rules, post: PostInput): string | null {
  if (r.text && !post.text.trim()) return `${label}: o texto é obrigatório`
  if (r.maxText && chars(post.text) > r.maxText) return `${label}: o texto passa de ${r.maxText.toLocaleString('pt-BR')} caracteres`
  if (r.media === 'none' && post.media.length) return `${label}: não aceita mídia, só texto`
  if (r.media === 'images' && post.media.some(isVideo)) return `${label}: vídeo não é suportado, só imagens`
  if (r.media === 'required' && !post.media.length) return `${label}: precisa de pelo menos uma imagem ou vídeo`
  if (r.maxMedia !== undefined && post.media.length > r.maxMedia) return `${label}: no máximo ${r.maxMedia} mídia(s) por post`
  for (const k of r.settings ?? []) if (post.settings[k] === undefined || post.settings[k] === '') return `${label}: settings.${k} é obrigatório`
  return null
}

export const rules = (label: string, r: Rules) => (post: PostInput) => check(label, r, post)

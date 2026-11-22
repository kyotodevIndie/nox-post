/** Erro de domínio com status HTTP e código estável (vai para a resposta). */
export class AppError extends Error {
  constructor(public status: number, public code: string, message?: string, public details?: Record<string, unknown>) {
    super(message ?? code)
  }
}

/**
 * Erro vindo de uma rede social. `kind` decide o que o worker faz:
 * - reauth: token inválido/revogado. Tenta renovar uma vez; se não der, o canal vira needs_reauth.
 * - fatal: a rede recusou o conteúdo ou a chamada. O post falha com a mensagem.
 * - transient: a rede não respondeu direito (429/5xx depois das retentativas). O post falha, mas pode ser reenviado.
 */
export class ProviderError extends Error {
  constructor(public kind: 'reauth' | 'fatal' | 'transient', message: string, public detail?: string) {
    super(message)
  }
}

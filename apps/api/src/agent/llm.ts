import Anthropic from '@anthropic-ai/sdk';

export type LlmParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
export type LlmMessage = Anthropic.Beta.Messages.BetaMessage;

/** Lo único que el agente necesita del proveedor. Los tests inyectan uno guionado. */
export interface LlmProvider {
  create(params: LlmParams): Promise<LlmMessage>;
}
export const LLM = Symbol('LLM');

/** Modelos donde un rechazo de seguridad se reintenta del lado del servidor en otro modelo. */
export const FALLBACK_MODELS: ReadonlySet<string> = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

/** Spec §7.2: timeout duro de 30 s y un reintento; después, el agente degrada. */
const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 1;

export class AnthropicProvider implements LlmProvider {
  private client: Anthropic | null = null;

  constructor(
    private readonly apiKey?: string,
    private readonly clientFactory: () => Anthropic =
      () => new Anthropic({ apiKey: this.apiKey, timeout: TIMEOUT_MS, maxRetries: MAX_RETRIES }),
  ) {}

  create(params: LlmParams): Promise<LlmMessage> {
    // Perezoso: sin ANTHROPIC_API_KEY la app arranca y funciona con menús.
    this.client ??= this.clientFactory();
    const withFallback = FALLBACK_MODELS.has(params.model)
      // VERIFICAR: el SDK 0.132 puede no tipar `fallbacks` todavía.
      ? { ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }
      : params;
    return this.client.beta.messages.create(withFallback as LlmParams) as Promise<LlmMessage>;
  }
}

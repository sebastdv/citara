/**
 * Precios en US$ por millón de tokens (API de Anthropic, 2026-10-09). La
 * escritura en caché con TTL de 5 min cuesta 1,25× la entrada. Un modelo que
 * no esté aquí no se puede usar: costo desconocido es tope inútil.
 * VERIFICAR la lectura de caché de Haiku 5.5 (se asume 0,1× la entrada).
 */
export const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

export interface Usage {
  input_tokens: number; output_tokens: number;
  cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null;
}

export function usdFor(model: string, usage: Usage): number {
  const p = PRICING[model];
  if (!p) throw new Error(`Sin precio conocido para el modelo ${model}`);
  return (usage.input_tokens * p.input + usage.output_tokens * p.output
    + (usage.cache_read_input_tokens ?? 0) * p.cacheRead
    + (usage.cache_creation_input_tokens ?? 0) * p.cacheWrite) / 1_000_000;
}

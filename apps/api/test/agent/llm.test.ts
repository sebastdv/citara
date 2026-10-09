import { describe, it, expect, vi } from 'vitest';
import { AnthropicProvider } from '../../src/agent/llm';

const fakeClient = () => {
  const create = vi.fn().mockResolvedValue({ id: 'msg_1', content: [], stop_reason: 'end_turn' });
  return { client: { beta: { messages: { create } } } as never, create };
};

describe('AnthropicProvider', () => {
  it('crea el cliente recién en la primera llamada: sin API key la app arranca igual', () => {
    const factory = vi.fn();
    new AnthropicProvider(undefined, factory);
    expect(factory).not.toHaveBeenCalled();
  });

  it('con Opus 5.5 pide el fallback del servidor ante un rechazo', async () => {
    const { client, create } = fakeClient();
    await new AnthropicProvider('k', () => client).create({ model: 'claude-opus-5-5', max_tokens: 10, messages: [] });
    expect(create.mock.calls[0][0]).toMatchObject({
      model: 'claude-opus-5-5', fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'] });
  });

  it('con Haiku 5.5 no hay fallback del servidor', async () => {
    const { client, create } = fakeClient();
    await new AnthropicProvider('k', () => client).create({ model: 'claude-haiku-5-5', max_tokens: 10, messages: [] });
    expect(create.mock.calls[0][0].fallbacks).toBeUndefined();
  });
});

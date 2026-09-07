import { describe, it, expect } from 'vitest';
import { advance } from '../../src/flow-engine/executor';
import type { FlowDefinition } from '@citara/shared';

const flow: FlowDefinition = {
  key: 'h', entry: 'menu',
  steps: {
    menu: {
      type: 'choice', text: '¿Sí?',
      buttons: [{ id: 'asesor', title: 'Hablar con alguien', next: 'humano' }],
    },
    humano: { type: 'handoff', text: 'Te comunico con un asesor. Un momento.' },
  },
};

describe('advance — handoff', () => {
  it('emite el mensaje de traspaso y marca la sesión en handoff', () => {
    const res = advance(flow, { stepKey: 'menu', vars: {}, status: 'active' }, 'asesor');
    expect(res.outbound).toEqual([
      { kind: 'text', body: 'Te comunico con un asesor. Un momento.' },
    ]);
    expect(res.state.status).toBe('handoff');
  });

  it('una sesión en handoff no produce más respuestas automáticas', () => {
    const res = advance(flow, { stepKey: 'humano', vars: {}, status: 'handoff' }, 'hola?');
    expect(res.outbound).toEqual([]);
    expect(res.state.status).toBe('handoff');
  });
});

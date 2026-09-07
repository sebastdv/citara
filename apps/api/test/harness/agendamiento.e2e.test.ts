import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { ConversationHarness } from './conversation-harness';
import { resetDb, seedChannel, seedFlow } from '../helpers';

const flow = {
  key: 'demo', entry: 'saludo',
  steps: {
    saludo: { type: 'message', text: '¡Hola! Soy el asistente de Salón X 👋', next: 'menu' },
    menu: {
      type: 'choice', kind: 'interactive_buttons', text: '¿En qué te ayudo?',
      buttons: [
        { id: 'agendar', title: 'Agendar cita', next: 'pide_nombre' },
        { id: 'asesor',  title: 'Hablar con alguien', next: 'humano' },
      ],
    },
    pide_nombre: { type: 'capture', text: '¿A nombre de quién?', var: 'nombre',
                   validate: 'text', next: 'listo' },
    listo: { type: 'end', text: 'Perfecto, {{nombre}}. Te contactamos pronto.' },
    humano: { type: 'handoff', text: 'Te comunico con alguien del equipo.' },
  },
};

let h: ConversationHarness;

beforeEach(async () => {
  await resetDb();
  const { tenantId, channelId } = await seedChannel();
  await seedFlow(tenantId, flow);
  h = await ConversationHarness.create({ tenantId, channelId, from: '573001112233' });
});

afterAll(async () => { await ConversationHarness.teardown(); });

describe('conversación de agendamiento (E2E del motor)', () => {
  it('recorre saludo → menú → captura → cierre', async () => {
    const primero = await h.say('Hola');
    expect(primero[0]).toEqual({ kind: 'text', body: '¡Hola! Soy el asistente de Salón X 👋' });
    expect(primero[1].kind).toBe('buttons');

    const traspulsar = await h.tap('agendar');
    expect(traspulsar).toEqual([{ kind: 'text', body: '¿A nombre de quién?' }]);

    const final = await h.say('Ana');
    expect(final).toEqual([
      { kind: 'text', body: 'Perfecto, Ana. Te contactamos pronto.' },
    ]);

    expect(await h.sessionStatus()).toBe('ended');
    // 3 entrantes + 4 salientes: el primer turno emite DOS (saludo y menú),
    // porque `message` encadena con el paso siguiente sin esperar input.
    expect(await h.messageCount()).toBe(7);
  });

  it('el traspaso a humano silencia al bot', async () => {
    await h.say('Hola');
    const salida = await h.tap('asesor');
    expect(salida).toEqual([{ kind: 'text', body: 'Te comunico con alguien del equipo.' }]);

    const despues = await h.say('¿Hay alguien ahí?');
    expect(despues).toEqual([]);
    expect(await h.sessionStatus()).toBe('handoff');
  });

  it('una entrada no reconocida repite el menú sin romper la sesión', async () => {
    await h.say('Hola');
    const salida = await h.say('quiero un helado');
    expect(salida[0].kind).toBe('buttons');
    expect(await h.sessionStatus()).toBe('active');
  });

  it('el mismo wamid reenviado no produce respuesta duplicada', async () => {
    await h.say('Hola');
    const repetido = await h.replayLast();
    expect(repetido).toEqual([]);
  });

  it('persiste las variables de la sesión entre turnos', async () => {
    await h.say('Hola');
    await h.tap('agendar');
    await h.say('Ana');
    expect(await h.sessionVars()).toEqual({ nombre: 'Ana' });
  });
});

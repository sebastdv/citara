import { describe, it, expect } from 'vitest';
import { isBareGreeting } from '../../src/flow-engine/greeting';

describe('isBareGreeting', () => {
  it.each(['Hola', 'hola!!', 'Buenas tardes', 'buenos días 👋', 'Holaaa', 'hola, qué tal?', ''])('"%s" es solo un saludo', (t) => {
    expect(isBareGreeting(t)).toBe(true);
  });
  it.each(['Hola, quiero un corte mañana', 'buenas, ¿tienen cita el jueves?', 'precio del tinte', 'cancelar'])('"%s" trae contenido', (t) => {
    expect(isBareGreeting(t)).toBe(false);
  });
});

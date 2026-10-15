import { describe, it, expect } from 'vitest';
import { isBareGreeting } from '../../src/flow-engine/greeting';

describe('isBareGreeting', () => {
  it.each(['Hola', 'hola!!', 'Buenas tardes', 'buenos días 👋', 'Holaaa', 'hola, qué tal?', '',
           'Hola buenas tardes', 'hola buenos días', 'Buenas buenas', 'buenas, cómo vas?', 'hola como va todo',
           'Buen día', 'holi 😊', 'hola hola', 'buenas noches, qué más', 'Hola qué tal, buenas tardes'])('"%s" es solo un saludo', (t) => {
    expect(isBareGreeting(t)).toBe(true);
  });
  it.each(['Hola, quiero un corte mañana', 'buenas, ¿tienen cita el jueves?', 'precio del tinte', 'cancelar',
           'hola buenas tardes quiero cancelar', 'buenos días, a qué hora abren'])('"%s" trae contenido', (t) => {
    expect(isBareGreeting(t)).toBe(false);
  });
});

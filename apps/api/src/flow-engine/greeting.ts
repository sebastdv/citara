const GREETING = /^(hola+|holi|buenas|buen dia|buenos dias|buenas tardes|buenas noches|hi|hello|hey|ola|saludos|alo)( (que tal|como estas|como esta))?$/;

/**
 * Un saludo sin contenido ("Hola", "buenas tardes 👋"). Con eso se abre el menú;
 * cualquier otra cosa en el primer mensaje es un pedido y va al agente.
 */
export function isBareGreeting(text: string): boolean {
  const t = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  return t === '' || GREETING.test(t);
}

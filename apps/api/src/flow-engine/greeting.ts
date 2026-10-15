// Un saludo es una secuencia de piezas de saludo, en cualquier orden y repetidas
// ("hola buenas tardes", "buenas buenas", "hola qué tal, buenas tardes"). Basta
// una palabra que no sea de saludo para que sea un pedido y vaya al agente.
const PIECE = '(?:hola+|holi|ola|hi|hello|hey|saludos|alo|buenas|buen dia|buenos dias|buenas tardes|buenas noches'
  + '|que tal|que mas|como estas|como esta|como vas|como va|como va todo)';
const GREETING = new RegExp(`^${PIECE}(?: ${PIECE})*$`);

/**
 * Un saludo sin contenido ("Hola", "buenas tardes 👋"). Con eso se abre el menú;
 * cualquier otra cosa en el primer mensaje es un pedido y va al agente.
 */
export function isBareGreeting(text: string): boolean {
  const t = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  return t === '' || GREETING.test(t);
}

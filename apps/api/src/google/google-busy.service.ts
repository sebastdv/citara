import { Injectable, Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
// Imports de VALOR: parámetros del constructor de un servicio Nest.
import { GoogleClient } from './google.client';
import { GoogleTokens } from './google-tokens.service';
import type { BusyInterval } from '../scheduling/availability';
import type { ExternalBusy } from '../scheduling/availability.service';

const CACHE_MS = 60_000;
/** Tras un fallo, no se vuelve a esperar a Google durante este tiempo. */
const FAILURE_CACHE_MS = 60_000;
/** Se consulta dentro del turno: el cliente espera, así que se corta pronto. */
const TIMEOUT_MS = 3_000;

/**
 * Cuándo está ocupada la persona en su calendario PRINCIPAL. Las citas de
 * Citara viven en el calendario "Citas" y no aparecen aquí: no hay doble conteo.
 */
@Injectable()
export class GoogleBusyService implements ExternalBusy {
  private readonly log = new Logger(GoogleBusyService.name);
  private readonly cache = new Map<string, { at: number; from: number; to: number; busy: BusyInterval[] }>();
  private readonly failures = new Map<string, number>();
  /**
   * Plazo TOTAL de la consulta, renovación del token y reintento incluidos: corre
   * dentro de la transacción del turno, con la conversación bloqueada.
   */
  deadlineMs = TIMEOUT_MS;

  constructor(private readonly tokens: GoogleTokens, private readonly google: GoogleClient) {}

  async busyFor(m: EntityManager, resourceId: string, from: Date, to: Date, now = Date.now()): Promise<BusyInterval[]> {
    const [acc] = await m.query(
      `SELECT id, refresh_token_encrypted FROM google_accounts WHERE resource_id = $1 AND status = 'active'`,
      [resourceId]);
    if (!acc) return [];
    const hit = this.cache.get(acc.id);
    const fresh = hit && now - hit.at < CACHE_MS && hit.from <= from.getTime() && hit.to >= to.getTime();
    const busy = fresh ? hit.busy : await this.fetch(acc, from, to, now);
    return busy.filter((b) => b.start < to && b.end > from);
  }

  private async fetch(acc: { id: string; refresh_token_encrypted: Buffer }, from: Date, to: Date, now: number) {
    const failedAt = this.failures.get(acc.id);
    if (failedAt !== undefined && now - failedAt < FAILURE_CACHE_MS) return [];
    try {
      const busy = await withDeadline(
        this.tokens.withToken({ id: acc.id, refreshTokenEncrypted: acc.refresh_token_encrypted },
          (token) => this.google.freeBusy(token, from, to, this.deadlineMs)),
        this.deadlineMs);
      this.failures.delete(acc.id);
      this.cache.set(acc.id, { at: now, from: from.getTime(), to: to.getTime(), busy });
      return busy;
    } catch (err) {
      // D4: sin Google se agenda igual. Una cuenta revocada la detecta el chequeo de salud.
      this.failures.set(acc.id, now);
      this.log.warn(`sin ocupado de Google para la cuenta ${acc.id}: ${(err as Error).message}`);
      return [];
    }
  }
}

/** La promesa, o un error si tarda más que `ms`. La llamada sigue en el aire, pero el turno ya no la espera. */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Google no respondió en ${ms} ms`)), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

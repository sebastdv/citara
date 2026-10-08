import { Injectable, Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
// Imports de VALOR: parámetros del constructor de un servicio Nest.
import { GoogleClient } from './google.client';
import { GoogleTokens } from './google-tokens.service';
import type { BusyInterval } from '../scheduling/availability';
import type { ExternalBusy } from '../scheduling/availability.service';

const CACHE_MS = 60_000;
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
    try {
      const busy = await this.tokens.withToken({ id: acc.id, refreshTokenEncrypted: acc.refresh_token_encrypted },
        (token) => this.google.freeBusy(token, from, to, TIMEOUT_MS));
      this.cache.set(acc.id, { at: now, from: from.getTime(), to: to.getTime(), busy });
      return busy;
    } catch (err) {
      // D4: sin Google se agenda igual. Una cuenta revocada la detecta el chequeo de salud.
      this.log.warn(`sin ocupado de Google para la cuenta ${acc.id}: ${(err as Error).message}`);
      return [];
    }
  }
}

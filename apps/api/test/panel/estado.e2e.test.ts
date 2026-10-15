import 'reflect-metadata';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { INestApplication } from '@nestjs/common';
import { createTestApp, resetDb, adminQuery, closeHelpers } from '../helpers';
import { seedBiz } from './seed';
import { panelSession } from './session';

let app: INestApplication, s: Awaited<ReturnType<typeof panelSession>>, backups: string;

beforeAll(async () => {
  backups = mkdtempSync(join(tmpdir(), 'citara-estado-'));
  process.env.PANEL_BACKUP_DIR = backups;
  app = await createTestApp();
});
beforeEach(async () => { await resetDb(); s = await panelSession(app); });
afterAll(async () => {
  delete process.env.PANEL_BACKUP_DIR;
  rmSync(backups, { recursive: true, force: true });
  await app.close(); await closeHelpers();
});

describe('pantalla de estado', () => {
  it('lista primero los negocios con avisos críticos y escapa lo que viene de la base', async () => {
    await seedBiz('bien', '1');
    const mal = await seedBiz('mal', '2');
    await adminQuery(`UPDATE whatsapp_channels SET status = 'disconnected' WHERE id = $1`, [mal.channelId]);
    await adminQuery(`UPDATE tenants SET name = '<img src=x onerror=alert(1)>' WHERE id = $1`, [mal.tenantId]);
    const res = await s.get('/panel/estado').expect(200);
    expect(res.text).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(res.text).not.toContain('<img src=x');
    expect(res.text).toContain('desconectado');
    expect(res.text.indexOf('&lt;img src=x')).toBeLessThan(res.text.indexOf('Negocio BIEN'));
    expect(res.text).toContain('Sin avisos');
  });

  it('avisa si no hay respaldo nocturno y deja de avisar cuando aparece uno reciente', async () => {
    let res = await s.get('/panel/estado').expect(200);
    expect(res.text).toContain('No hay ningún respaldo nocturno');
    writeFileSync(join(backups, 'daily-20261020-083000.dump'), 'x');
    res = await s.get('/panel/estado').expect(200);
    expect(res.text).not.toContain('No hay ningún respaldo nocturno');
    expect(res.text).toContain('daily-20261020-083000.dump');
  });

  it('está en la barra de navegación y pide sesión', async () => {
    expect((await s.get('/panel').expect(200)).text).toContain('href="/panel/estado"');
    await s.http().get('/panel/estado').expect(303);
  });
});

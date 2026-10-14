import { Body, Controller, Get, Logger, Post, Query, Req, Res, type OnModuleDestroy } from '@nestjs/common';
import type { Request, Response } from 'express';
// Imports de VALOR: parámetros del constructor de un controlador Nest.
import { DataSource } from 'typeorm';
import { LoginLimiter, LimiterUnavailableError } from './login-limiter';
import { createSession, findSession, SESSION_COOKIE } from './sessions';
import { dummyHash, verifyPassword } from './password';
import { foreignOrigin, readCookie, safeNext, sessionCookie } from './panel-auth';
import { newNonce, sendHtml } from './layout';
import { loginView } from './views';

const BAD = 'Correo o contraseña incorrectos';

/** La puerta del panel: el único controlador de /panel sin PanelGuard. */
@Controller('panel/login')
export class PanelLoginController implements OnModuleDestroy {
  private readonly log = new Logger(PanelLoginController.name);

  constructor(private readonly ds: DataSource, private readonly limiter: LoginLimiter) {}

  onModuleDestroy() { return this.limiter.close(); }

  @Get()
  async page(@Query('next') next: unknown, @Req() req: Request, @Res() res: Response) {
    const token = readCookie(req, SESSION_COOKIE);
    if (token && await findSession(this.ds, token)) { res.redirect(303, safeNext(next)); return; }
    const nonce = newNonce();
    sendHtml(res, 200, loginView(nonce, { next: safeNext(next) }), nonce);
  }

  @Post()
  async login(@Body() body: Record<string, unknown>, @Req() req: Request, @Res() res: Response) {
    const nonce = newNonce();
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 255) : '';
    const password = typeof body.password === 'string' ? body.password.slice(0, 1024) : '';
    const next = safeNext(body.next);
    const ip = req.ip ?? 'desconocida';
    const fail = (status: number, error: string) =>
      sendHtml(res, status, loginView(nonce, { next, error, email }), nonce);

    if (foreignOrigin(req)) return fail(403, 'La solicitud no vino del panel.');
    try {
      if (await this.limiter.blocked(email, ip)) return fail(429, 'Demasiados intentos. Espera 15 minutos.');
      const [op] = await this.ds.query(
        `SELECT id, password_hash FROM operators WHERE lower(email) = $1 AND disabled_at IS NULL`, [email]);
      // Mismo trabajo exista o no el correo: el tiempo no revela cuál falló.
      const ok = await verifyPassword(password, op?.password_hash ?? await dummyHash());
      if (!op || !ok) { await this.limiter.fail(email, ip); return fail(401, BAD); }
      await this.limiter.succeed(email);
      const token = await createSession(this.ds, op.id, { ip, userAgent: req.get('user-agent') ?? null });
      res.cookie(sessionCookie.name, token, sessionCookie.options());
      res.redirect(303, next);
    } catch (err) {
      if (!(err instanceof LimiterUnavailableError)) throw err;
      this.log.error(`login sin límite de intentos disponible: ${err.message}`);
      return fail(503, 'No se puede verificar el acceso ahora. Intenta en unos minutos.');
    }
  }
}

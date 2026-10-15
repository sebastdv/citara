import {
  CanActivate, Catch, HttpException, HttpStatus, Injectable,
  type ArgumentsHost, type ExceptionFilter, type ExecutionContext,
} from '@nestjs/common';
import type { Request, Response } from 'express';
// Import de VALOR: parámetro del constructor de un provider Nest.
import { DataSource } from 'typeorm';
import { ABSOLUTE_DAYS, findSession, sameSecret, SESSION_COOKIE, type OperatorSession } from './sessions';
import { newNonce, sendHtml, type PageCtx } from './layout';
import { forbiddenView } from './views';

export interface PanelRequest extends Request { operator?: OperatorSession; sessionToken?: string }

export function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

/** Solo rutas del panel: un `next` hacia fuera sería una redirección abierta. */
export function safeNext(next: unknown): string {
  if (typeof next !== 'string' || next.length > 512) return '/panel';
  if (!/^\/panel(\/[\w\-/]*)?(\?[^\\]*)?$/.test(next) || next.includes('..') || next.includes('//')) return '/panel';
  return next;
}

const publicOrigin = () => new URL(process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000').origin;

export const sessionCookie = {
  name: SESSION_COOKIE,
  options: () => ({
    httpOnly: true, sameSite: 'strict' as const, path: '/panel',
    // Detrás de TLS la cookie solo viaja cifrada; en local (http) no saldría nunca.
    secure: (process.env.PUBLIC_BASE_URL ?? '').startsWith('https://'),
    maxAge: ABSOLUTE_DAYS * 24 * 3600 * 1000,
  }),
};

/**
 * Un `Origin` presente y ajeno (incluido el opaco `null`) es otro sitio
 * enviando el formulario. Sin `Origin` decide el token CSRF.
 */
export function foreignOrigin(req: Request): boolean {
  const origin = req.headers.origin;
  return typeof origin === 'string' && origin !== publicOrigin();
}

/** Un GET sin sesión: el filtro lo convierte en una redirección al login. */
export class LoginRequired extends HttpException {
  /** next null: al login a secas (por ejemplo, al cerrar una sesión que ya venció). */
  constructor(readonly next: string | null) { super('Inicia sesión', HttpStatus.SEE_OTHER); }
}

/** Un POST sin sesión válida o sin CSRF: 403, pero como página del panel (ver PanelForbiddenFilter). */
export class PanelForbidden extends HttpException {
  constructor(message: string) { super(message, HttpStatus.FORBIDDEN); }
}

/** De dónde venía el POST, solo si es del propio panel: a ahí se vuelve tras entrar. */
function backTo(req: Request): string {
  try {
    const ref = new URL(String(req.headers.referer ?? ''));
    return ref.origin === publicOrigin() ? safeNext(ref.pathname + ref.search) : '/panel';
  } catch {
    return '/panel';
  }
}

/**
 * Sin esto, Nest respondía JSON y el operador perdía lo que estaba escribiendo:
 * la página devuelve su texto en un recuadro para copiarlo y un enlace para volver a entrar.
 */
@Catch(PanelForbidden)
export class PanelForbiddenFilter implements ExceptionFilter {
  catch(e: PanelForbidden, host: ArgumentsHost) {
    const req = host.switchToHttp().getRequest<Request>();
    const res = host.switchToHttp().getResponse<Response>();
    const draft = (req.body as Record<string, unknown> | undefined)?.texto;
    const nonce = newNonce();
    sendHtml(res, 403, forbiddenView(nonce, { message: e.message, next: backTo(req),
      // Por puntos de código, no por unidades de UTF-16: un emoji no se parte por la mitad.
      draft: typeof draft === 'string' && draft.trim() ? Array.from(draft).slice(0, 4096).join('') : undefined }), nonce);
  }
}

@Catch(LoginRequired)
export class LoginRedirectFilter implements ExceptionFilter {
  catch(e: LoginRequired, host: ArgumentsHost) {
    host.switchToHttp().getResponse<Response>()
      .redirect(303, e.next === null ? '/panel/login' : `/panel/login?next=${encodeURIComponent(safeNext(e.next))}`);
  }
}

/** Toda ruta del panel salvo el login (spec §3.7.1). */
@Injectable()
export class PanelGuard implements CanActivate {
  constructor(private readonly ds: DataSource) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<PanelRequest>();
    const token = readCookie(req, SESSION_COOKIE);
    const session = token ? await findSession(this.ds, token, { touch: !req.get('X-Fragment') }) : null;
    const read = req.method === 'GET' || req.method === 'HEAD';
    if (!session) {
      if (read) throw new LoginRequired(req.originalUrl);
      // Cerrar una sesión que ya venció no es un error: lo que se quería ya pasó.
      if (req.path === '/panel/logout') throw new LoginRequired(null);
      throw new PanelForbidden('Tu sesión venció. Vuelve a entrar.');
    }
    if (!read) {
      const sent = (req.body as Record<string, unknown> | undefined)?._csrf;
      if (typeof sent !== 'string' || !sameSecret(sent, session.csrf) || foreignOrigin(req)) {
        throw new PanelForbidden('La solicitud no vino del panel. Vuelve a cargar la página e inténtalo de nuevo.');
      }
    }
    req.operator = session;
    req.sessionToken = token!;
    return true;
  }
}

export const pageCtx = (req: PanelRequest): PageCtx =>
  ({ nonce: newNonce(), csrf: req.operator!.csrf, email: req.operator!.email });

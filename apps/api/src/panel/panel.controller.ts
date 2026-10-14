import { randomUUID } from 'node:crypto';
import {
  Body, Controller, Get, Inject, Logger, Param, Post, Query, Req, Res, UseFilters, UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
// Imports de VALOR: parámetros del constructor de un controlador Nest.
import { DataSource, type EntityManager } from 'typeorm';
import { OutboundQueue } from '../queues/outbound.queue';
import { runInTenant } from '../tenancy/tenant-context';
import { LoginRedirectFilter, PanelGuard, pageCtx, sessionCookie, type PanelRequest } from './panel-auth';
import { destroySession } from './sessions';
import { panelPage, sendHtml, type PageCtx } from './layout';
import { html } from './html';
import { loadInbox, type Cursor, type InboxFilter } from './inbox';
import { loadConversation } from './conversation';
import { panelTenants, tenantBySlug } from './tenants';
import { auditView, chatMessages, chatUrl, chatView, inboxList, inboxView } from './views';
import { loadAudit, type AuditFilter } from './audit-view';
import {
  ACTION_NOTICE, PanelActionError, pendingOperatorJobs, returnControl, sendOperatorMessage, takeControl,
} from './actions';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `antes=<instante exacto>_<uuid>`; cualquier otra cosa es la primera página. */
export function parseCursor(v: unknown): Cursor | undefined {
  if (typeof v !== 'string') return undefined;
  const [at, id] = v.split('_');
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(at ?? '') && UUID.test(id ?? '') ? { at, id } : undefined;
}

const str = (v: unknown) => (typeof v === 'string' && v ? v.slice(0, 64) : undefined);

@Controller('panel')
@UseGuards(PanelGuard)
@UseFilters(LoginRedirectFilter)
export class PanelController {
  private readonly log = new Logger(PanelController.name);

  constructor(
    private readonly ds: DataSource,
    @Inject(OutboundQueue) private readonly outbound: OutboundQueue,
  ) {}

  @Get()
  async inbox(@Query() q: Record<string, unknown>, @Req() req: PanelRequest, @Res() res: Response) {
    const ctx = pageCtx(req);
    const filter: InboxFilter = {
      tab: q.tab === 'todas' ? 'todas' : 'traspasos', slug: str(q.negocio), before: parseCursor(q.antes),
    };
    const now = new Date();
    const { rows, next } = await loadInbox(this.ds, filter, now);
    if (req.get('X-Fragment') === 'lista') return sendHtml(res, 200, inboxList(rows, now).value, ctx.nonce);
    sendHtml(res, 200, inboxView(ctx, { filter, tenants: await panelTenants(this.ds), rows, next }, now), ctx.nonce);
  }

  @Get('negocios/:slug/conversaciones/:id')
  async chat(@Param('slug') slug: string, @Param('id') id: string, @Req() req: PanelRequest, @Res() res: Response) {
    const ctx = pageCtx(req);
    const found = await this.find(slug, id);
    if (!found) return this.notFound(res, ctx);
    if (req.get('X-Fragment') === 'mensajes') {
      return sendHtml(res, 200, chatMessages(found.chat, found.tenant.timezone).value, ctx.nonce);
    }
    sendHtml(res, 200, chatView(ctx, { ...found, submissionId: randomUUID() }, new Date()), ctx.nonce);
  }

  @Get('auditoria')
  async audit(@Query() q: Record<string, unknown>, @Req() req: PanelRequest, @Res() res: Response) {
    const ctx = pageCtx(req);
    const conversationId = str(q.conversacion);
    const filter: AuditFilter = {
      slug: str(q.negocio), action: str(q.accion), before: parseCursor(q.antes),
      conversationId: conversationId && UUID.test(conversationId) ? conversationId : undefined,
    };
    const { rows, next } = await loadAudit(this.ds, filter);
    sendHtml(res, 200, auditView(ctx, { filter, tenants: await panelTenants(this.ds), rows, next }), ctx.nonce);
  }

  @Post('negocios/:slug/conversaciones/:id/tomar')
  take(@Param('slug') slug: string, @Param('id') id: string, @Req() req: PanelRequest, @Res() res: Response) {
    return this.act(slug, id, req, res, (m, tenantId) =>
      takeControl(m, { tenantId, conversationId: id, operatorId: req.operator!.operatorId, now: new Date() }));
  }

  @Post('negocios/:slug/conversaciones/:id/devolver')
  giveBack(@Param('slug') slug: string, @Param('id') id: string, @Req() req: PanelRequest, @Res() res: Response) {
    return this.act(slug, id, req, res, (m, tenantId) =>
      returnControl(m, { tenantId, conversationId: id, operatorId: req.operator!.operatorId }));
  }

  @Post('negocios/:slug/conversaciones/:id/responder')
  async reply(@Param('slug') slug: string, @Param('id') id: string, @Body() body: Record<string, unknown>,
              @Req() req: PanelRequest, @Res() res: Response) {
    const text = typeof body.texto === 'string' ? body.texto : '';
    const submissionId = typeof body.envio === 'string' && UUID.test(body.envio) ? body.envio : randomUUID();
    const tenant = UUID.test(id) ? await tenantBySlug(this.ds, slug) : null;
    if (!tenant) return this.notFound(res, pageCtx(req));
    try {
      const { job } = await runInTenant(this.ds, tenant.id, (m) => sendOperatorMessage(m, {
        tenantId: tenant.id, conversationId: id, operatorId: req.operator!.operatorId, text, submissionId, now: new Date() }));
      // Tras el commit. Si Redis falla, la fila queda pending y el chat ofrece reintentar.
      await this.outbound.add(job).catch((err: Error) => this.log.error(`no se encoló el mensaje del operador: ${err.message}`));
      res.redirect(303, chatUrl(slug, id));
    } catch (err) {
      if (!(err instanceof PanelActionError)) throw err;
      const found = err.code === 'no_encontrada' ? null : await this.find(slug, id);
      const ctx = pageCtx(req);
      if (!found) return this.notFound(res, ctx);
      sendHtml(res, 422, chatView(ctx, { ...found, draft: text, notice: ACTION_NOTICE[err.code], submissionId },
                                  new Date()), ctx.nonce);
    }
  }

  @Post('negocios/:slug/conversaciones/:id/reintentar')
  async retry(@Param('slug') slug: string, @Param('id') id: string, @Req() req: PanelRequest, @Res() res: Response) {
    const tenant = UUID.test(id) ? await tenantBySlug(this.ds, slug) : null;
    if (!tenant) return this.notFound(res, pageCtx(req));
    const jobs = await runInTenant(this.ds, tenant.id, (m) =>
      pendingOperatorJobs(m, { tenantId: tenant.id, conversationId: id }));
    if (!jobs.length && !(await this.find(slug, id))) return this.notFound(res, pageCtx(req));
    for (const job of jobs) await this.outbound.requeue(job);
    res.redirect(303, chatUrl(slug, id));
  }

  @Post('logout')
  async logout(@Req() req: PanelRequest, @Res() res: Response) {
    await destroySession(this.ds, req.sessionToken!);
    res.clearCookie(sessionCookie.name, { path: '/panel' });
    res.redirect(303, '/panel/login');
  }

  /** El slug se resuelve a id en `tenants` y la conversación se busca DENTRO de ese contexto. */
  private async find(slug: string, id: string) {
    if (!UUID.test(id)) return null;
    const tenant = await tenantBySlug(this.ds, slug);
    if (!tenant) return null;
    const chat = await runInTenant(this.ds, tenant.id, (m) => loadConversation(m, id));
    return chat ? { tenant, chat } : null;
  }

  /** Una acción sobre una conversación del negocio `slug`, en su contexto. */
  private async act(slug: string, id: string, req: PanelRequest, res: Response,
                    fn: (m: EntityManager, tenantId: string) => Promise<void>) {
    const tenant = UUID.test(id) ? await tenantBySlug(this.ds, slug) : null;
    if (!tenant) return this.notFound(res, pageCtx(req));
    try {
      await runInTenant(this.ds, tenant.id, (m) => fn(m, tenant.id));
    } catch (err) {
      if (err instanceof PanelActionError && err.code === 'no_encontrada') return this.notFound(res, pageCtx(req));
      throw err;
    }
    res.redirect(303, chatUrl(slug, id));
  }

  private notFound(res: Response, ctx: PageCtx) {
    sendHtml(res, 404, panelPage('No existe', ctx,
      html`<h1>No existe</h1><p><a href="/panel">Volver a la bandeja</a></p>`), ctx.nonce);
  }
}

/** Los controladores del panel tras el guard (el test de barrido los recorre). */
export const PANEL_CONTROLLERS = [PanelController];

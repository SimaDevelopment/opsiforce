import { randomBytes } from 'node:crypto';
import { Body, Controller, Get, Headers, Logger, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { timingSafeStringEqual } from '../common/secret-crypto';
import { Public } from '../tenant/tenant.decorator';
import {
  AppUsersProviderService,
  OAuthError,
  type AuthorizationRequest,
  type OAuthParams,
} from './app-users-provider.service';
import { AppUserLinksService } from './app-user-links.service';
import { AppUserMailer } from './app-user-mailer';
import { AppUsersService } from './app-users.service';
import { APP_USER_LOCK_MINUTES, APP_USER_PASSWORD_MIN_LENGTH } from './app-users.types';
import { forgotPasswordPage, messagePage, setPasswordPage, signInPage } from './sign-in-page';

const SIGN_IN_CSRF_COOKIE = '__Host-opsiforce_app_user_csrf';
const CSRF_MAX_AGE_SECONDS = 60 * 60;

const SIGN_IN_ERRORS = {
  'wrong-credentials': 'Email or password is incorrect.',
  locked: `Too many attempts. Try again in ${APP_USER_LOCK_MINUTES} minutes.`,
  disabled: 'This account has been disabled. Ask the App’s owner to enable it.',
} as const;

const EXPIRED_LINK =
  'This link has expired, was already used, or was replaced by a newer one. Ask the App’s owner for a new one.';

function cookiesOf(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0) cookies[part.slice(0, at).trim()] = decodeURIComponent(part.slice(at + 1).trim());
  }
  return cookies;
}

const sessionCookieName = (projectId: string) => `__Host-opsiforce_app_user_${projectId.replaceAll('-', '')}`;

const stringField = (value: unknown) => (typeof value === 'string' ? value : '');

@Public()
@Controller('app-auth')
export class AppUsersProviderController {
  private readonly logger = new Logger(AppUsersProviderController.name);

  constructor(
    private readonly provider: AppUsersProviderService,
    private readonly appUsers: AppUsersService,
    private readonly links: AppUserLinksService,
    private readonly mailer: AppUserMailer
  ) {}

  @Get('.well-known/openid-configuration')
  discovery() {
    return this.provider.discovery();
  }

  @Get('jwks')
  jwks() {
    return this.provider.jwks();
  }

  @Get('authorize')
  async authorize(
    @Query() query: OAuthParams,
    @Headers('cookie') cookie: string | undefined,
    @Res() reply: FastifyReply
  ) {
    const check = await this.provider.checkAuthorizationRequest(query);
    if (check.outcome === 'refused') return this.refuse(reply, check.message);
    if (check.outcome === 'redirect') return reply.redirect(check.location, 302);

    const { request } = check;
    const cookies = cookiesOf(cookie);
    const session = request.forceSignIn
      ? null
      : await this.provider.session(request.client.projectId, cookies[sessionCookieName(request.client.projectId)]);
    if (session) return reply.redirect(await this.provider.issueCode(request, session), 302);

    return this.showSignIn(reply, request, new URLSearchParams(query as Record<string, string>).toString(), cookies);
  }

  @Post('authorize')
  async signIn(@Body() body: OAuthParams, @Headers('cookie') cookie: string | undefined, @Res() reply: FastifyReply) {
    const raw = stringField(body?.request);
    const check = await this.provider.checkAuthorizationRequest(Object.fromEntries(new URLSearchParams(raw)));
    if (check.outcome === 'refused') return this.refuse(reply, check.message);
    if (check.outcome === 'redirect') return reply.redirect(check.location, 302);

    const cookies = cookiesOf(cookie);
    if (!this.validCsrf(cookies, body.csrf)) {
      return this.refuse(reply, 'This sign-in form expired. Go back to the App and try again.');
    }

    const { request } = check;
    const email = stringField(body.email);
    const result = await this.appUsers.signIn(request.client.projectId, email, stringField(body.password));
    if (result.outcome !== 'signed-in') {
      return this.showSignIn(reply, request, raw, cookies, { email, error: SIGN_IN_ERRORS[result.outcome] });
    }

    const session = await this.provider.newSession(result.user);
    this.setCookie(reply, sessionCookieName(request.client.projectId), session.value, session.maxAgeSeconds);
    return reply.redirect(await this.provider.issueCode(request, result.user), 302);
  }

  @Get('forgot')
  async forgot(
    @Query('request') raw: unknown,
    @Headers('cookie') cookie: string | undefined,
    @Res() reply: FastifyReply
  ) {
    const rawRequest = stringField(raw);
    const check = await this.provider.checkAuthorizationRequest(Object.fromEntries(new URLSearchParams(rawRequest)));
    if (check.outcome === 'refused') return this.refuse(reply, check.message);
    if (check.outcome === 'redirect') return reply.redirect(check.location, 302);
    if (!this.mailer.enabled) return reply.redirect(this.authorizeUrl(rawRequest), 302);
    return this.showForgot(reply, check.request.client.appName, rawRequest, cookiesOf(cookie));
  }

  @Post('forgot')
  async sendReset(
    @Body() body: OAuthParams,
    @Headers('cookie') cookie: string | undefined,
    @Res() reply: FastifyReply
  ) {
    const rawRequest = stringField(body?.request);
    const check = await this.provider.checkAuthorizationRequest(Object.fromEntries(new URLSearchParams(rawRequest)));
    if (check.outcome === 'refused') return this.refuse(reply, check.message);
    if (check.outcome === 'redirect') return reply.redirect(check.location, 302);
    const cookies = cookiesOf(cookie);
    if (!this.validCsrf(cookies, body.csrf)) {
      return this.refuse(reply, 'This form expired. Go back to the App and try again.');
    }
    const { client } = check.request;
    const email = stringField(body.email).trim();
    if (this.mailer.enabled) {
      void this.sendResetIfAccount(client.projectId, client.environmentId, email, this.authorizeUrl(rawRequest));
    }
    return this.showForgot(reply, client.appName, rawRequest, cookies, email);
  }

  private async sendResetIfAccount(projectId: string, environmentId: string, email: string, returnUrl: string) {
    try {
      const user = await this.appUsers.findByEmail(projectId, email);
      if (user && user.disabledAt === null) await this.links.sendSelfServiceReset(user.id, environmentId, returnUrl);
    } catch (err) {
      this.logger.warn(`Self-service reset for an App User of Project ${projectId} failed: ${(err as Error).message}`);
    }
  }

  @Get('set-password')
  async choosePassword(@Query('token') token: unknown, @Res() reply: FastifyReply) {
    const link = await this.links.open(stringField(token));
    if (!link) return this.html(reply, 410, messagePage({ title: 'Link expired', message: EXPIRED_LINK }));
    return this.html(
      reply,
      200,
      setPasswordPage({ ...link, action: `${this.provider.issuerPath}/set-password`, token: stringField(token) })
    );
  }

  @Post('set-password')
  async savePassword(@Body() body: OAuthParams, @Res() reply: FastifyReply) {
    const token = stringField(body?.token);
    const password = stringField(body.password);
    const link = await this.links.open(token);
    if (!link) return this.html(reply, 410, messagePage({ title: 'Link expired', message: EXPIRED_LINK }));
    const retry = (error: string) =>
      this.html(
        reply,
        200,
        setPasswordPage({ ...link, action: `${this.provider.issuerPath}/set-password`, token, error })
      );
    if (password.length < APP_USER_PASSWORD_MIN_LENGTH || password.length > 256) {
      return retry(`Choose a password of at least ${APP_USER_PASSWORD_MIN_LENGTH} characters.`);
    }
    if (password !== stringField(body.confirm))
      return retry('The passwords don’t match. Type the same password twice.');
    const result = await this.links.redeem(token, password);
    if (result.outcome === 'invalid')
      return this.html(reply, 410, messagePage({ title: 'Link expired', message: EXPIRED_LINK }));
    const next = result.link.returnUrl;
    return this.html(
      reply,
      200,
      messagePage({
        title: 'Password saved',
        message: `You can now sign in to ${result.link.appName} as ${result.link.email} with your new password.`,
        appName: result.link.appName,
        link: next ? { href: next, label: `Continue to ${result.link.appName}` } : undefined,
      })
    );
  }

  @Post('token')
  async token(@Body() body: OAuthParams, @Res() reply: FastifyReply) {
    reply.header('cache-control', 'no-store').header('pragma', 'no-cache');
    try {
      return reply.status(200).send(await this.provider.token(body ?? {}));
    } catch (err) {
      return this.oauthError(reply, err);
    }
  }

  @Get('logout')
  async logout(@Query() query: OAuthParams, @Res() reply: FastifyReply) {
    const target = await this.provider.logoutTarget(query);
    if (target.projectId) this.setCookie(reply, sessionCookieName(target.projectId), '', 0);
    if (target.location) return reply.redirect(target.location, 302);
    return this.html(reply, 200, messagePage({ title: 'Signed out', message: 'You have been signed out.' }));
  }

  private authorizeUrl(rawRequest: string): string {
    return `${this.provider.issuer}/authorize?${rawRequest}`;
  }

  private showForgot(
    reply: FastifyReply,
    appName: string,
    rawRequest: string,
    cookies: Record<string, string>,
    sentTo?: string
  ) {
    return this.html(
      reply,
      200,
      forgotPasswordPage({
        appName,
        action: `${this.provider.issuerPath}/forgot`,
        request: rawRequest,
        csrf: this.csrfFor(reply, cookies),
        backUrl: this.authorizeUrl(rawRequest),
        sentTo,
      })
    );
  }

  private validCsrf(cookies: Record<string, string>, submitted: unknown): boolean {
    const expected = cookies[SIGN_IN_CSRF_COOKIE];
    return !!expected && timingSafeStringEqual(expected, stringField(submitted));
  }

  private csrfFor(reply: FastifyReply, cookies: Record<string, string>): string {
    const csrf = cookies[SIGN_IN_CSRF_COOKIE] || randomBytes(24).toString('base64url');
    this.setCookie(reply, SIGN_IN_CSRF_COOKIE, csrf, CSRF_MAX_AGE_SECONDS);
    return csrf;
  }

  private showSignIn(
    reply: FastifyReply,
    request: AuthorizationRequest,
    rawRequest: string,
    cookies: Record<string, string>,
    form: { email?: string; error?: string } = {}
  ) {
    return this.html(
      reply,
      200,
      signInPage({
        appName: request.client.appName,
        action: `${this.provider.issuerPath}/authorize`,
        request: rawRequest,
        csrf: this.csrfFor(reply, cookies),
        forgotUrl: this.mailer.enabled
          ? `${this.provider.issuerPath}/forgot?${new URLSearchParams({ request: rawRequest })}`
          : undefined,
        ...form,
      })
    );
  }

  private refuse(reply: FastifyReply, message: string) {
    return this.html(reply, 400, messagePage({ title: 'Cannot sign in', message }));
  }

  private html(reply: FastifyReply, status: number, body: string) {
    return reply
      .status(status)
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .header('referrer-policy', 'no-referrer')
      .header('x-frame-options', 'DENY')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'")
      .send(body);
  }

  private setCookie(reply: FastifyReply, name: string, value: string, maxAgeSeconds: number) {
    const attributes = [
      `${name}=${encodeURIComponent(value)}`,
      'Path=/',
      `Max-Age=${maxAgeSeconds}`,
      'HttpOnly',
      'Secure',
      'SameSite=Lax',
    ];
    const existing = reply.getHeader('set-cookie');
    const list = existing === undefined ? [] : Array.isArray(existing) ? existing : [String(existing)];
    reply.header('set-cookie', [...list, attributes.join('; ')]);
  }

  private oauthError(reply: FastifyReply, err: unknown) {
    if (!(err instanceof OAuthError)) throw err;
    return reply.status(err.status).send({ error: err.error, error_description: err.description });
  }
}

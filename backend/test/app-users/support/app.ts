import { createHash, createPublicKey, randomBytes, verify, type JsonWebKey } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AppUsersModule } from '../../../src/app-users/app-users.module';
import { configuration } from '../../../src/config/configuration';
import { PermissionGuard } from '../../../src/permission/permission.guard';
import { appSignInCallbackUrls } from '../../../src/project/app-auth-route';
import { ProjectAppUsersController } from '../../../src/project/project-app-users.controller';
import { ProjectEnvironmentService } from '../../../src/project-environment/project-environment.service';
import { ProjectService } from '../../../src/project/project.service';
import { TenantGuard } from '../../../src/tenant/tenant.guard';
import { DomainTestModule } from '../../support/domain-module';
import { EveryServiceAvailableModule } from '../../support/every-service-available';
import { PublicApiConfigurationDoubleModule } from '../../support/public-api-configuration-double';
import {
  addMember,
  createProject,
  createTenant,
  type MemberFixture,
  type TenantFixture,
} from '../../support/project-fixtures';

export const GATE_SECRET = 'cookie-encryption-secret-for-app-users-tests';
export const ISSUER = 'https://opsiforce.test/api/app-auth';

const MAILGUN_ENV = {
  MAILGUN_API_KEY: 'key-test',
  MAILGUN_DOMAIN: 'mail.example-org.com',
  MAILGUN_SENDER: 'Opsiforce <apps@mail.example-org.com>',
} as const;

export async function createAppUsersTestApp(options: { mailgunUrl?: string } = {}): Promise<NestFastifyApplication> {
  process.env.OIDC_PLUGIN_SECRET = GATE_SECRET;
  const mailgun = options.mailgunUrl ? { ...MAILGUN_ENV, MAILGUN_URL: options.mailgunUrl } : {};
  Object.assign(process.env, mailgun);
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [configuration], ignoreEnvFile: true }),
      DomainTestModule,
      EveryServiceAvailableModule,
      PublicApiConfigurationDoubleModule,
      AppUsersModule,
    ],
    controllers: [ProjectAppUsersController],
    providers: [
      { provide: APP_GUARD, useClass: TenantGuard },
      { provide: APP_GUARD, useClass: PermissionGuard },
    ],
  }).compile();
  for (const name of Object.keys(mailgun)) delete process.env[name];

  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.setGlobalPrefix('api');
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

export interface AppUsersProject {
  tenant: TenantFixture;
  owner: MemberFixture;
  projectId: string;
  shortId: string;
  callbackUrl: string;
}

export async function projectUsingAppUsers(app: NestFastifyApplication): Promise<AppUsersProject> {
  const tenant = await createTenant(app);
  const owner = await addMember(app, tenant, ['can_manage_project_auth_settings']);
  const projectId = await createProject(app, tenant, { title: 'Equipment Monitor' });
  await app.get(ProjectService).updateAuth(projectId, projectId, { mode: 'app_users' }, tenant.tenantId);
  const development = await app.get(ProjectEnvironmentService).findById(projectId);
  const [callbackUrl] = appSignInCallbackUrls(development, 'apps.opsiforce.localtest.me');
  return { tenant, owner, projectId, shortId: development.shortId, callbackUrl };
}

export function pkce() {
  const verifier = randomBytes(32).toString('hex');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function cookiesFrom(setCookie: string | string[] | undefined): Record<string, string> {
  const list = setCookie === undefined ? [] : Array.isArray(setCookie) ? setCookie : [setCookie];
  return Object.fromEntries(
    list.map((line) => {
      const [pair] = line.split(';');
      const at = pair.indexOf('=');
      return [pair.slice(0, at), pair.slice(at + 1)];
    })
  );
}

export function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .filter(([, value]) => value !== '')
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

export function hiddenField(html: string, name: string): string {
  const match = html.match(new RegExp(`name="${name}" value="([^"]*)"`));
  if (!match) throw new Error(`no hidden field ${name} in the sign-in page`);
  return match[1].replaceAll('&amp;', '&');
}

export function form(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

export function claimsOf(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
}

export async function verifiedWithJwks(app: NestFastifyApplication, jwt: string): Promise<boolean> {
  const res = await app.inject({ method: 'GET', url: '/api/app-auth/jwks' });
  const { keys } = res.json() as { keys: (JsonWebKey & { kid: string })[] };
  const [header, payload, signature] = jwt.split('.');
  const { kid } = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as { kid: string };
  const jwk = keys.find((key) => key.kid === kid);
  if (!jwk) return false;
  return verify(
    'RSA-SHA256',
    Buffer.from(`${header}.${payload}`),
    createPublicKey({ key: jwk, format: 'jwk' }),
    Buffer.from(signature, 'base64url')
  );
}

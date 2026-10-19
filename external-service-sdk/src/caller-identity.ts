import { createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

export const callerIdentityHeader = 'x-opsiforce-caller';

export const callerIdentityLifetimeSeconds = 120;

export type CallerKind = 'call' | 'platform';

export interface CallerIdentity {
  kind: CallerKind;
  tenantId: string;
  projectId?: string;
  projectEnvironmentId?: string;
  environment?: string;
}

const id = z.string().min(1).max(200);

const claimsSchema = z
  .object({
    kind: z.enum(['call', 'platform']),
    tenantId: id,
    projectId: id.optional(),
    projectEnvironmentId: id.optional(),
    environment: id.optional(),
    iat: z.number(),
    exp: z.number(),
  })
  .refine(
    (claims) =>
      claims.kind === 'platform' ||
      (claims.projectId !== undefined && claims.projectEnvironmentId !== undefined && claims.environment !== undefined),
    'a call names its Project, ProjectEnvironment and environment'
  );

const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

function signature(signed: string, gatewayKey: string): Buffer {
  return createHmac('sha256', gatewayKey).update(signed).digest();
}

export interface MintOptions {
  now?: number;
  lifetimeSeconds?: number;
}

export function mintCallerIdentity(caller: CallerIdentity, gatewayKey: string, options: MintOptions = {}): string {
  const iat = Math.floor((options.now ?? Date.now()) / 1000);
  const exp = iat + (options.lifetimeSeconds ?? callerIdentityLifetimeSeconds);
  const payload = Buffer.from(JSON.stringify({ ...caller, iat, exp })).toString('base64url');
  const signed = `${header}.${payload}`;
  return `${signed}.${signature(signed, gatewayKey).toString('base64url')}`;
}

function decodedJson(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}

export function verifyCallerIdentity(
  token: string | null | undefined,
  gatewayKey: string,
  now: number = Date.now()
): CallerIdentity | undefined {
  if (!token || gatewayKey === '') return undefined;
  const [encodedHeader, payload, encodedSignature, ...rest] = token.split('.');
  if (encodedHeader === undefined || payload === undefined || encodedSignature === undefined || rest.length > 0) {
    return undefined;
  }
  const declared = decodedJson(encodedHeader) as { alg?: unknown } | undefined;
  if (declared?.alg !== 'HS256') return undefined;
  const expected = signature(`${encodedHeader}.${payload}`, gatewayKey);
  const presented = Buffer.from(encodedSignature, 'base64url');
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return undefined;

  const claims = claimsSchema.safeParse(decodedJson(payload));
  if (!claims.success || claims.data.exp * 1000 <= now) return undefined;
  const { kind, tenantId, projectId, projectEnvironmentId, environment } = claims.data;
  return {
    kind,
    tenantId,
    ...(projectId === undefined ? {} : { projectId }),
    ...(projectEnvironmentId === undefined ? {} : { projectEnvironmentId }),
    ...(environment === undefined ? {} : { environment }),
  };
}

import { createHmac } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';

export const APP_USERS_PROVIDER_PATH = '/api/app-auth';

export interface AppUsersAddresses {
  issuer: string;
  providerUrl: string;
}

const withoutTrailingSlash = (url: string | undefined) => (url ?? '').trim().replace(/\/+$/, '');

export function appUsersAddresses(config: ConfigService): AppUsersAddresses | null {
  const publicUrl = withoutTrailingSlash(config.get<string>('opsiforcePublicUrl'));
  if (!publicUrl) return null;
  const issuer = `${publicUrl}${APP_USERS_PROVIDER_PATH}`;
  const internalUrl = withoutTrailingSlash(config.get<string>('appUsersProviderInternalUrl'));
  return { issuer, providerUrl: internalUrl ? `${internalUrl}${APP_USERS_PROVIDER_PATH}` : issuer };
}

export function appUsersClientSecret(gateSecret: string, environmentId: string): string {
  return createHmac('sha256', gateSecret).update(`app-users-client:${environmentId}`).digest('hex');
}

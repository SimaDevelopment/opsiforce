import type { ConfigService } from '@nestjs/config';

export function customDomainsOffered(config: ConfigService): boolean {
  return config.get<string>('customDomainsClusterIssuer', '') !== '';
}

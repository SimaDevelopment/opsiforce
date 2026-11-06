import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { appCanonicalHost, type AppAddress } from '../common/app-host';

type AppUrlSubject = AppAddress & { servesAnExternalService: boolean; mainDomain: string | null };
type PublicUrlSubject = AppUrlSubject & { hasApp: boolean };

@Injectable()
export class PublicUrlService {
  private readonly appsHostname: string;

  constructor(configService: ConfigService) {
    this.appsHostname = configService.getOrThrow<string>('appsHostname');
  }

  publicUrlOnceLive(env: PublicUrlSubject): string | null {
    return env.hasApp ? this.publicUrlLiveOrNot(env) : null;
  }

  defaultAddressOnceLive(env: PublicUrlSubject): string | null {
    return env.hasApp && !env.servesAnExternalService ? appCanonicalHost(env, this.appsHostname) : null;
  }

  publicUrlLiveOrNot(env: AppUrlSubject): string | null {
    if (env.servesAnExternalService) return null;
    return `https://${env.mainDomain ?? appCanonicalHost(env, this.appsHostname)}/`;
  }
}

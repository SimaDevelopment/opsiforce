import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { appCanonicalHost, type AppAddress } from '../common/app-host';

type AppUrlSubject = AppAddress & { servesAnExternalService: boolean };
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

  publicUrlLiveOrNot(env: AppUrlSubject): string | null {
    return env.servesAnExternalService ? null : `https://${appCanonicalHost(env, this.appsHostname)}/`;
  }
}

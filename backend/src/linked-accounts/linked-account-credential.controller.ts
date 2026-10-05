import { Body, Controller, Headers, HttpCode, Post, UnauthorizedException } from '@nestjs/common';
import { Public } from '../tenant/tenant.decorator';
import type { LinkedAccountCredentialRequest, LinkedAccountCredentialView } from './linked-account.types';
import { LinkedAccountsService } from './linked-accounts.service';

@Public()
@Controller('internal/linked-accounts')
export class LinkedAccountCredentialController {
  constructor(private readonly linkedAccountsService: LinkedAccountsService) {}

  @Post('credential')
  @HttpCode(200)
  credential(
    @Headers('x-linked-account-proxy-token') token: string | undefined,
    @Body() body: LinkedAccountCredentialRequest | undefined
  ): Promise<LinkedAccountCredentialView> {
    if (!this.linkedAccountsService.isProxyServiceToken(token)) {
      throw new UnauthorizedException('Invalid Linked-account proxy service token');
    }
    return this.linkedAccountsService.credentialFor(body?.caller_secret, body?.force_refresh === true);
  }
}

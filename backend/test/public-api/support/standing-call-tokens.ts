import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  CALL_TOKEN_PREFIX,
  type CallTokenHolder,
  type CallTokens,
  type IssuedCallToken,
} from '../../../src/gateway/call-tokens';

/** Call tokens that survive redemption and open every route, so a test can drive `/api/v1` as one pod across many requests. */
@Injectable()
export class StandingCallTokens implements Pick<CallTokens, 'issue' | 'redeem'> {
  private readonly issued = new Map<string, CallTokenHolder>();

  issue(holder: CallTokenHolder): IssuedCallToken {
    const token = `${CALL_TOKEN_PREFIX}${randomUUID()}`;
    this.issued.set(token, holder);
    return { token, revoke: () => this.issued.delete(token) };
  }

  redeem(token: string, _operation: string | undefined): CallTokenHolder | null {
    return this.issued.get(token) ?? null;
  }
}

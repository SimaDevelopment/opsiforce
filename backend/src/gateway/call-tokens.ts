import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';

export const CALL_TOKEN_PREFIX = 'gc-';

export interface CallTokenHolder {
  service: string;
  callId: string;
  operation: string;
  tenantId: string;
  projectId: string;
  projectEnvironmentId: string;
}

export interface IssuedCallToken {
  token: string;
  revoke: () => void;
}

@Injectable()
export class CallTokens {
  private readonly issued = new Map<string, CallTokenHolder>();

  issue(holder: CallTokenHolder): IssuedCallToken {
    const token = `${CALL_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    this.issued.set(token, holder);
    return { token, revoke: () => this.issued.delete(token) };
  }

  redeem(token: string, operation: string | undefined): CallTokenHolder | null {
    const holder = this.issued.get(token) ?? null;
    this.issued.delete(token);
    return holder?.operation === operation ? holder : null;
  }
}

import type { VendorId } from './vendor-adapter';

export type LinkedAccountState = 'connected' | 'needs-sign-in' | 'awaiting-sign-in';

export type SignInView =
  | { state: 'pending'; userCode: string; verificationUrl: string; expiresAt: string }
  | { state: 'expired' }
  | { state: 'failed'; message: string };

export interface LinkedAccountView {
  vendor: VendorId;
  state: LinkedAccountState;
  signedInAs: string | null;
  reason: string | null;
  signIn: SignInView | null;
}

export interface LinkedAccountUsageView {
  plan: string | null;
  windows: Array<{ windowMinutes: number; usedPercent: number; resetsAt: string | null }>;
}

export interface StartedSignInView {
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
}

export interface LinkedAccountCredentialView {
  vendor: VendorId;
  accessToken: string;
  accountId: string | null;
  expiresAt: string | null;
}

export interface LinkedAccountCredentialRequest {
  caller_secret?: unknown;
  force_refresh?: unknown;
}

export interface PastedAccessToken {
  accessToken?: unknown;
}

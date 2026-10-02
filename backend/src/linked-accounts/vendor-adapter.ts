import type { JsonObject } from '../common/json';

export type VendorId = 'chatgpt';

export interface VendorCredential {
  accessToken: string;
  refreshToken: string | null;
}

export interface StartedSignIn {
  handle: JsonObject;
  userCode: string;
  verificationUrl: string;
  pollIntervalMs: number;
}

export type SignInPoll =
  | { outcome: 'pending' }
  | { outcome: 'rate-limited' }
  | { outcome: 'completed'; credential: VendorCredential }
  | { outcome: 'failed'; message: string };

export type RefreshResult =
  | { outcome: 'refreshed'; credential: VendorCredential }
  | { outcome: 'failed'; permanent: boolean; reason: string };

export type AccessTokenCheck =
  | { outcome: 'accepted'; accountId: string | null }
  | { outcome: 'failed'; permanent: boolean; reason: string };

export interface LinkedAccountDescription {
  accountId: string | null;
  signedInAs: string | null;
  expiresAt: Date | null;
  signedInWith: 'device' | 'access-token';
}

export interface UsageWindow {
  windowMinutes: number;
  usedPercent: number;
  resetsAt: Date | null;
}

export interface VendorUsage {
  plan: string | null;
  windows: UsageWindow[];
}

export class VendorRateLimitedError extends Error {}

export class VendorSignInUnavailableError extends Error {}

export class VendorUnavailableError extends Error {}

export interface VendorAdapter {
  readonly vendor: VendorId;
  startSignIn(): Promise<StartedSignIn>;
  pollSignIn(handle: JsonObject): Promise<SignInPoll>;
  refresh(credential: VendorCredential): Promise<RefreshResult>;
  pastedTokenRefusal(accessToken: string): string | null;
  whoami(accessToken: string): Promise<AccessTokenCheck>;
  revoke(credential: VendorCredential): Promise<void>;
  describe(credential: VendorCredential): LinkedAccountDescription;
  usage(accessToken: string, accountId: string | null): Promise<VendorUsage>;
}

export interface SignInProviderConnection {
  id: string;
  discoveryUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  requiredClaim?: RequiredClaim;
  groupsClaim?: string;
}

export interface RequiredClaim {
  name: string;
  values: string[];
}

export interface SignInProviderView {
  id: string;
  name: string;
  discoveryUrl: string;
  clientId: string;
  scope: string;
  requiredClaimName: string | null;
  requiredClaimValues: string[];
  groupsClaim: string | null;
  redirectUri: string;
  environmentCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SignInProviderOption {
  id: string;
  name: string;
}

export interface SaveSignInProviderDto {
  name?: string;
  discoveryUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  requiredClaimName?: string | null;
  requiredClaimValues?: string[];
  groupsClaim?: string | null;
}

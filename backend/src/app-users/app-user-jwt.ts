import { sign, verify, type JsonWebKey, type KeyObject } from 'node:crypto';

export type TokenUse = 'id' | 'access' | 'refresh' | 'session';

export interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  jwk: JsonWebKey;
}

export type JwtClaims = Record<string, unknown> & {
  iss: string;
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  token_use: TokenUse;
};

const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

export function signJwt(claims: JwtClaims, key: SigningKey): string {
  const signingInput = `${encode({ alg: 'RS256', typ: 'JWT', kid: key.kid })}.${encode(claims)}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), key.privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

export interface JwtExpectation {
  issuer: string;
  audience: string;
  use: TokenUse;
}

export function verifyJwt(token: string, key: SigningKey, expected: JwtExpectation): JwtClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  try {
    const { alg, kid } = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as {
      alg?: string;
      kid?: string;
    };
    if (alg !== 'RS256' || kid !== key.kid) return null;
    if (!verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), key.publicKey, Buffer.from(signature, 'base64url')))
      return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as JwtClaims;
    const now = Math.floor(Date.now() / 1000);
    if (claims.iss !== expected.issuer || claims.aud !== expected.audience || claims.token_use !== expected.use) {
      return null;
    }
    if (typeof claims.exp !== 'number' || claims.exp <= now || typeof claims.sub !== 'string') return null;
    return claims;
  } catch {
    return null;
  }
}

const GATEWAY_KEY = /(?<![A-Za-z0-9_-])gw-[A-Za-z0-9_-]+/;

const BASIC_CREDENTIALS = /^\s*basic\s+([A-Za-z0-9+/=_-]+)\s*$/i;

export function gatewayKeyIn(credential: string | undefined): string | null {
  if (credential === undefined || credential === '') return null;
  const basic = BASIC_CREDENTIALS.exec(credential);
  const searched = basic?.[1] === undefined ? credential : Buffer.from(basic[1], 'base64').toString('utf8');
  return GATEWAY_KEY.exec(searched)?.[0] ?? null;
}

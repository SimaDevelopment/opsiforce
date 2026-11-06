import { isIP } from 'node:net';
import { domainToASCII, domainToUnicode } from 'node:url';

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//;
const PATH_START = /[/?#]/;
const PORT = /^([^:]+):\d+$/;
const BRACKETED = /^\[(.*)\]$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_HOSTNAME_LENGTH = 253;
const WWW = 'www.';

const NOT_AN_IP_ADDRESS = 'Enter a domain name, not an IP address.';
const NOT_A_FULL_DOMAIN = 'Enter a full domain, like app.example-org.com.';
const NO_WILDCARDS = "Wildcard domains aren't supported. Add each address you need.";
const UNSUPPORTED_CHARACTERS = 'Use letters, digits, dots and dashes only.';

export type HostnameReading = { hostname: string; refusal?: undefined } | { refusal: string; hostname?: undefined };

function typedHost(input: string): string {
  const [host] = input.trim().toLowerCase().replace(SCHEME, '').split(PATH_START, 1);
  return host.replace(PORT, '$1').replace(BRACKETED, '$1').replace(/\.$/, '');
}

function isDomainName(hostname: string): boolean {
  return hostname.length <= MAX_HOSTNAME_LENGTH && hostname.split('.').every((label) => LABEL.test(label));
}

export function readHostname(input: string, refusedDomains: readonly string[]): HostnameReading {
  const typed = typedHost(input);
  if (isIP(typed)) return { refusal: NOT_AN_IP_ADDRESS };
  if (typed.includes('*')) return { refusal: NO_WILDCARDS };
  if (!typed.includes('.')) return { refusal: NOT_A_FULL_DOMAIN };
  const hostname = domainToASCII(typed);
  if (isIP(hostname)) return { refusal: NOT_AN_IP_ADDRESS };
  if (!isDomainName(hostname)) return { refusal: UNSUPPORTED_CHARACTERS };
  const platformDomain = refusedDomains.find((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  if (platformDomain) return { refusal: `${platformDomain} belongs to the platform and can't be connected.` };
  return { hostname };
}

export function displayHostname(hostname: string): string {
  return domainToUnicode(hostname) || hostname;
}

export function wwwOf(hostname: string): string {
  return `${WWW}${hostname}`;
}

export function withoutWww(hostname: string): string {
  return hostname.startsWith(WWW) ? hostname.slice(WWW.length) : hostname;
}

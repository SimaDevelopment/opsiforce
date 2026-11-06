import type { CustomDomainStatusValue } from '../../db/schema';

export type CustomDomainStatus = CustomDomainStatusValue;

export interface DnsRecord {
  type: 'CNAME' | 'ALIAS';
  name: string;
  host: string;
  value: string;
}

export interface CustomDomainView {
  id: string;
  hostname: string;
  displayHostname: string;
  bare: boolean;
  status: CustomDomainStatus;
  isMain: boolean;
  redirectsToMain: boolean;
  dnsAnswer: string | null;
  failureReason: string | null;
  checkedAt: Date | null;
  records: DnsRecord[];
  signInCallback: string | null;
}

export interface CustomDomainsView {
  items: CustomDomainView[];
  defaultAddress: string;
  usage: { used: number; limit: number | null };
}

export interface AddCustomDomainDto {
  hostname?: unknown;
}

export interface UpdateCustomDomainDto {
  redirectsToMain?: unknown;
}

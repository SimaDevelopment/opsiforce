import { wwwOf } from './hostname';
import { recordOrNone, type PublicDns } from './public-dns';

export interface DnsCheck {
  passed: boolean;
  answer: string | null;
}

export interface ThisApp {
  defaultAddress: string;
  isNamedBy: (target: string) => Promise<boolean>;
}

interface Addresses {
  v4: string[];
  v6: string[];
}

async function addressesOf(dns: PublicDns, name: string): Promise<Addresses> {
  const [v4, v6] = await Promise.all([
    recordOrNone(name, () => dns.resolve4(name)),
    recordOrNone(name, () => dns.resolve6(name)),
  ]);
  return { v4: v4 ?? [], v6: v6 ?? [] };
}

function describeAddresses({ v4, v6 }: Addresses): string | null {
  const parts = [
    ...(v4.length > 0 ? [`A → ${v4.join(', ')}`] : []),
    ...(v6.length > 0 ? [`AAAA → ${v6.join(', ')}`] : []),
  ];
  return parts.length > 0 ? parts.join('; ') : null;
}

function sharesAnAddress(one: Addresses, other: Addresses): boolean {
  return [...one.v4, ...one.v6].some((ip) => other.v4.includes(ip) || other.v6.includes(ip));
}

async function checkCname(dns: PublicDns, name: string, app: ThisApp): Promise<DnsCheck> {
  const targets = (await recordOrNone(name, () => dns.resolveCname(name))) ?? [];
  if (targets.length === 0) return { passed: false, answer: describeAddresses(await addressesOf(dns, name)) };
  const verdicts = await Promise.all(targets.map(app.isNamedBy));
  return { passed: verdicts.some(Boolean), answer: `CNAME → ${targets.join(', ')}` };
}

async function checkBare(dns: PublicDns, hostname: string, app: ThisApp): Promise<DnsCheck> {
  const www = wwwOf(hostname);
  const [wwwCheck, apex, defaultAddress] = await Promise.all([
    checkCname(dns, www, app),
    addressesOf(dns, hostname),
    addressesOf(dns, app.defaultAddress),
  ]);
  const answers = [describeAddresses(apex), wwwCheck.answer && `${www} ${wwwCheck.answer}`].filter(
    (answer): answer is string => answer !== null
  );
  return {
    passed: wwwCheck.passed && sharesAnAddress(apex, defaultAddress),
    answer: answers.length > 0 ? answers.join('; ') : null,
  };
}

export async function checkDns(
  dns: PublicDns,
  domain: { hostname: string; bare: boolean },
  app: ThisApp
): Promise<DnsCheck> {
  return domain.bare ? checkBare(dns, domain.hostname, app) : checkCname(dns, domain.hostname, app);
}

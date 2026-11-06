import { recordOrNone, type PublicDns } from './public-dns';

async function startsZone(dns: PublicDns, name: string): Promise<boolean> {
  return (
    (await recordOrNone(name, () => dns.resolveSoa(name))) !== null &&
    (await recordOrNone(name, () => dns.resolveCname(name))) === null
  );
}

export async function zoneStartOf(dns: PublicDns, hostname: string): Promise<string | null> {
  const labels = hostname.split('.');
  for (let first = 0; first < labels.length - 1; first++) {
    const name = labels.slice(first).join('.');
    if (await startsZone(dns, name)) return name;
  }
  return null;
}

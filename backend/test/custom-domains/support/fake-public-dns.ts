import type { SoaRecord } from 'node:dns';
import { isIPv4 } from 'node:net';
import type { PublicDns } from '../../../src/custom-domain/public-dns';

function dnsError(code: string, syscall: string, hostname: string): Error {
  return Object.assign(new Error(`${syscall} ${code} ${hostname}`), { code, syscall, hostname });
}

function soaOf(zone: string): SoaRecord {
  return {
    nsname: `ns1.${zone}`,
    hostmaster: `hostmaster.${zone}`,
    serial: 1,
    refresh: 3600,
    retry: 600,
    expire: 604800,
    minttl: 300,
  };
}

export class FakePublicDns implements PublicDns {
  private readonly zones = new Set(['com', 'org', 'uk', 'co.uk', 'app']);
  private readonly cnames = new Map<string, string>();
  private readonly addresses = new Map<string, string[]>();
  private reachable = true;

  zone(name: string): this {
    this.zones.add(name);
    return this;
  }

  cname(name: string, target: string): this {
    this.addresses.delete(name);
    this.cnames.set(name, target);
    return this;
  }

  address(name: string, ...ips: string[]): this {
    this.cnames.delete(name);
    this.addresses.set(name, ips);
    return this;
  }

  goUnreachable(): void {
    this.reachable = false;
  }

  comeBack(): void {
    this.reachable = true;
  }

  async resolveSoa(name: string): Promise<SoaRecord> {
    this.assertReachable('querySoa', name);
    const target = this.cnames.get(name);
    if (target !== undefined) {
      if (this.zones.has(target)) return soaOf(target);
      throw dnsError('EBADRESP', 'querySoa', name);
    }
    if (this.zones.has(name)) return soaOf(name);
    throw dnsError(this.exists(name) ? 'ENODATA' : 'ENOTFOUND', 'querySoa', name);
  }

  async resolveCname(name: string): Promise<string[]> {
    this.assertReachable('queryCname', name);
    const target = this.cnames.get(name);
    if (target !== undefined) return [target];
    throw dnsError(this.exists(name) ? 'ENODATA' : 'ENOTFOUND', 'queryCname', name);
  }

  async resolve4(name: string): Promise<string[]> {
    return this.addressesOf(name, 'queryA', isIPv4);
  }

  async resolve6(name: string): Promise<string[]> {
    return this.addressesOf(name, 'queryAaaa', (ip) => !isIPv4(ip));
  }

  private addressesOf(name: string, syscall: string, ofFamily: (ip: string) => boolean): string[] {
    this.assertReachable(syscall, name);
    const target = this.cnames.get(name);
    if (target !== undefined) return this.addressesOf(target, syscall, ofFamily);
    const found = (this.addresses.get(name) ?? []).filter(ofFamily);
    if (found.length > 0) return found;
    throw dnsError(this.exists(name) ? 'ENODATA' : 'ENOTFOUND', syscall, name);
  }

  private exists(name: string): boolean {
    return [...this.zones, ...this.cnames.keys(), ...this.addresses.keys()].some(
      (owner) => owner === name || owner.endsWith(`.${name}`)
    );
  }

  private assertReachable(syscall: string, name: string): void {
    if (!this.reachable) throw dnsError('ETIMEOUT', syscall, name);
  }
}

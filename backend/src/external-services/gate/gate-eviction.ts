import { lookup } from 'node:dns/promises';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { errorMessage } from '../../common/error-message';

export const GATE_EVICT_TIMEOUT_MS = 2_000;

type EvictionTarget = { tenantId: string; slug: string } | { gatewayKey: string };

@Injectable()
export class GateEviction {
  private readonly logger = new Logger(GateEviction.name);
  private readonly control: string;
  private readonly token: string;

  constructor(config: ConfigService) {
    this.control = config.get<string>('externalServiceProxyControl') ?? '';
    this.token = config.getOrThrow<string>('proxyControlToken');
  }

  evictService(tenantId: string, slug: string): Promise<void> {
    return this.evict({ tenantId, slug }, slug);
  }

  evictGatewayKey(gatewayKey: string): Promise<void> {
    return this.evict({ gatewayKey }, 'a Gateway Key');
  }

  private async evict(target: EvictionTarget, described: string): Promise<void> {
    if (this.control === '') return;
    const [host, port] = this.control.split(':');
    try {
      const replicas = await lookup(host ?? '', { all: true });
      await Promise.all(replicas.map((replica) => this.evictAt(replica.address, port ?? '', target)));
    } catch (error) {
      this.logger.warn(`The Gate's cache for ${described} could not be evicted: ${errorMessage(error)}`);
    }
  }

  private async evictAt(address: string, port: string, target: EvictionTarget): Promise<void> {
    const host = address.includes(':') ? `[${address}]` : address;
    const res = await fetch(`http://${host}:${port}/evict`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-proxy-control-token': this.token },
      body: JSON.stringify(target),
      signal: AbortSignal.timeout(GATE_EVICT_TIMEOUT_MS),
    });
    if (res.status !== 204) throw new Error(`${address} answered ${res.status}`);
  }
}

import { Injectable } from '@nestjs/common';

export const SERVICE_SWITCH_DRAIN_MS = 'SERVICE_SWITCH_DRAIN_MS';

export const SERVICE_SWITCH_DRAIN = 30_000;

export type LaneEntry = 'entered' | 'held' | 'moved';

@Injectable()
export class DefaultLaneHolds {
  private readonly inFlight = new Map<string, number>();
  private readonly holds = new Map<string, number>();
  private readonly drainWaiters = new Map<string, Set<() => void>>();
  private readonly releaseWaiters = new Map<string, Set<() => void>>();
  private readonly switchedDefaults = new Map<string, string>();

  enter(serviceId: string, environmentId: string): LaneEntry {
    if ((this.holds.get(serviceId) ?? 0) > 0) return 'held';
    const switchedDefault = this.switchedDefaults.get(serviceId);
    if (switchedDefault !== undefined && switchedDefault !== environmentId) return 'moved';
    this.inFlight.set(serviceId, (this.inFlight.get(serviceId) ?? 0) + 1);
    return 'entered';
  }

  leave(serviceId: string): void {
    const remaining = (this.inFlight.get(serviceId) ?? 1) - 1;
    if (remaining > 0) {
      this.inFlight.set(serviceId, remaining);
      return;
    }
    this.inFlight.delete(serviceId);
    this.notify(this.drainWaiters, serviceId);
  }

  async hold(serviceId: string, drainMs: number): Promise<boolean> {
    this.holds.set(serviceId, (this.holds.get(serviceId) ?? 0) + 1);
    if (!this.inFlight.has(serviceId)) return true;
    return this.waitFor(this.drainWaiters, serviceId, drainMs);
  }

  release(serviceId: string, switchedTo?: string): void {
    if (switchedTo !== undefined) this.switchedDefaults.set(serviceId, switchedTo);
    const remaining = (this.holds.get(serviceId) ?? 1) - 1;
    if (remaining > 0) {
      this.holds.set(serviceId, remaining);
      return;
    }
    this.holds.delete(serviceId);
    this.notify(this.releaseWaiters, serviceId);
  }

  isHeld(serviceId: string): boolean {
    return this.holds.has(serviceId);
  }

  async released(serviceId: string, waitMs: number): Promise<boolean> {
    if (!this.holds.has(serviceId)) return true;
    return this.waitFor(this.releaseWaiters, serviceId, waitMs);
  }

  private async waitFor(waiters: Map<string, Set<() => void>>, serviceId: string, waitMs: number): Promise<boolean> {
    let settle: () => void = () => undefined;
    const settled = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), waitMs);
      settle = () => {
        clearTimeout(timer);
        resolve(true);
      };
    });
    const forService = waiters.get(serviceId) ?? new Set();
    forService.add(settle);
    waiters.set(serviceId, forService);
    const result = await settled;
    forService.delete(settle);
    return result;
  }

  private notify(waiters: Map<string, Set<() => void>>, serviceId: string): void {
    for (const settle of waiters.get(serviceId) ?? []) settle();
    waiters.delete(serviceId);
  }
}

import { Injectable } from '@nestjs/common';

export const EVENT_DELIVERIES_PER_MINUTE = 60;

const WINDOW_MS = 60_000;

@Injectable()
export class EventDeliveryCap {
  private readonly windows = new Map<string, number[]>();

  admit(serviceId: string, projectEnvironmentId: string, now = Date.now()): boolean {
    const receiver = `${serviceId}:${projectEnvironmentId}`;
    const recent = (this.windows.get(receiver) ?? []).filter((at) => now - at < WINDOW_MS);
    if (recent.length >= EVENT_DELIVERIES_PER_MINUTE) {
      this.windows.set(receiver, recent);
      return false;
    }
    recent.push(now);
    this.windows.set(receiver, recent);
    this.forgetQuietReceivers(now);
    return true;
  }

  private forgetQuietReceivers(now: number): void {
    if (this.windows.size < 10_000) return;
    for (const [receiver, recent] of this.windows) {
      if (recent.every((at) => now - at >= WINDOW_MS)) this.windows.delete(receiver);
    }
  }
}

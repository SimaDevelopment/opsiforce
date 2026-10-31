import { Injectable } from '@nestjs/common';
import { ProjectEventsService } from './project-events.service';

interface Waiter {
  resolve: (ready: boolean) => void;
  timer: NodeJS.Timeout;
}

@Injectable()
export class AppReadinessService {
  private readonly servingProjects = new Map<string, string>();
  private readonly waiters = new Map<string, Set<Waiter>>();

  constructor(private readonly projectEvents: ProjectEventsService) {}

  markServing(key: string, projectId: string): void {
    if (!this.servingProjects.has(key)) {
      this.servingProjects.set(key, projectId);
      void this.projectEvents.publish(projectId);
    }
    this.resolveWaiters(key);
  }

  markDown(key: string): void {
    const projectId = this.servingProjects.get(key);
    if (projectId === undefined) return;
    this.servingProjects.delete(key);
    void this.projectEvents.publish(projectId);
  }

  clear(key: string): void {
    this.servingProjects.delete(key);
    const waiters = this.waiters.get(key);
    if (!waiters) return;
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(false);
    }
    this.waiters.delete(key);
  }

  servingEnvironmentsOf(projectId: string): Set<string> {
    const environments = new Set<string>();
    for (const [key, servingProjectId] of this.servingProjects) {
      if (servingProjectId === projectId) environments.add(key);
    }
    return environments;
  }

  awaitReady(key: string, timeoutMs: number): Promise<boolean> {
    if (this.servingProjects.has(key)) return Promise.resolve(true);

    return new Promise<boolean>((resolve) => {
      const waiters = this.waiters.get(key) ?? new Set<Waiter>();
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          if (waiters.size === 0) this.waiters.delete(key);
          resolve(false);
        }, timeoutMs),
      };
      waiters.add(waiter);
      this.waiters.set(key, waiters);
    });
  }

  private resolveWaiters(key: string): void {
    const waiters = this.waiters.get(key);
    if (!waiters) return;
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(true);
    }
    this.waiters.delete(key);
  }
}

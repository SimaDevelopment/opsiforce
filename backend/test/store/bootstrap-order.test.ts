import { describe, expect, it, vi } from 'vitest';
import { AgentUpdateService } from '../../src/agent-update/agent-update.service';
import type { AgentReconcilerService } from '../../src/agent/agent-reconciler.service';
import type { SkillReconcilerService } from '../../src/store/skill-reconciler.service';

describe('the boot sequence', () => {
  it('reconciles agents, then skills, then enqueues the sweep', async () => {
    const order: string[] = [];
    const agentReconciler = {
      ready: vi.fn(async () => {
        order.push('agents');
      }),
    } as unknown as AgentReconcilerService;
    const skillReconciler = {
      ready: vi.fn(async () => {
        order.push('skills');
      }),
    } as unknown as SkillReconcilerService;

    const service = new AgentUpdateService(
      { add: vi.fn(), addBulk: vi.fn() } as never,
      { get: () => true } as never,
      {} as never,
      {} as never,
      {} as never,
      { isJobRunning: vi.fn(async () => false) } as never,
      agentReconciler,
      skillReconciler
    );
    vi.spyOn(service, 'enqueueProjectSweep').mockImplementation(async () => {
      order.push('sweep');
    });

    await service.onApplicationBootstrap();

    expect(order).toEqual(['agents', 'skills', 'sweep']);
  });
});

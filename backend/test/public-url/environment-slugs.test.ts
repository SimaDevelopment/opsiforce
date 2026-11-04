import { describe, expect, it } from 'vitest';
import type { AgentRepository } from '../../src/agent/agent.repository';
import { EnvironmentService } from '../../src/environment/environment.service';

const environments = new EnvironmentService({} as AgentRepository);

describe('an Environment Slug', () => {
  it.each(['6713b7a51450', 'staging-6713b7a51450', '6713b7a51450abcd'])(
    'is refused when it ends like an App Short ID, as %s does',
    async (slug) => {
      await expect(environments.create('example-org', { name: 'Billing', slug })).rejects.toThrow(/App Short ID/);
    }
  );

  it('is refused when the name it comes from ends like an App Short ID', async () => {
    await expect(environments.create('example-org', { name: 'Release 6713b7a51450' })).rejects.toThrow(/App Short ID/);
  });
});

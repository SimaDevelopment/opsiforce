import { describe, expect, it } from 'vitest';
import { assertModelSelection, catalogModelIdsOf } from '../../src/agent/agent-models';
import { BASE_FORMATS } from '../../src/model-provider/base-formats';
import { servedModelsOf } from '../../src/model-provider/bifrost-provider-shape';
import { familyModels } from '../../src/model-provider/key-model-formats';

describe('gateway models outside the agent picker', () => {
  it('adds Luna and Terra to OpenAI gateway permissions without making them selectable agent models', () => {
    for (const model of ['gpt-6-luna', 'gpt-6.1-terra']) {
      expect(servedModelsOf(BASE_FORMATS.openai)).toContain(model);
      expect(catalogModelIdsOf('openai')).not.toContain(model);
      expect(() => assertModelSelection(`openai/${model}`, null)).toThrow();
      expect(servedModelsOf(BASE_FORMATS.anthropic)).not.toContain(model);
    }
  });

  it('keeps explicit provider restrictions, including a gateway-only subset', () => {
    expect(familyModels(['gpt-6-luna'], 'openai')).toEqual(['gpt-6-luna']);
    expect(familyModels(['gpt-6.1-sol'], 'openai')).toEqual(['gpt-6.1-sol']);
    expect(familyModels(['gpt-6-luna'], 'anthropic')).toEqual([]);
    expect(familyModels(['*'], 'openai')).toEqual(expect.arrayContaining(['gpt-6-luna', 'gpt-6.1-terra']));
  });

  it('deduplicates a gateway model if it is later added to the agent catalog', () => {
    const models = servedModelsOf(BASE_FORMATS.openai, { openai: { models: { 'gpt-6-luna': {} } } });
    expect(models.filter((model) => model === 'gpt-6-luna')).toHaveLength(1);
  });
});

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, describe, expect, it } from 'vitest';
import {
  assertModelSelection,
  effortValues,
  loadModelCatalog,
  modelCatalogResponse,
  readModelCatalog,
} from '../../src/agent/agent-models';

const catalog = readModelCatalog();
const providers = modelCatalogResponse();

describe('the model catalog the Store UI picks from', () => {
  it('carries every provider the distribution ships, named and sorted', () => {
    const shipped = Object.keys(catalog).filter((id) => Object.keys(catalog[id].models ?? {}).length > 0);
    expect(providers.map((provider) => provider.id).toSorted()).toEqual(shipped.toSorted());
    expect(providers.map((provider) => provider.name)).toEqual(providers.map((provider) => provider.name).toSorted());
    for (const provider of providers) expect(provider.name.length).toBeGreaterThan(0);
  });

  it('identifies a model by the `provider/model` pair the profile route takes', () => {
    for (const provider of providers) {
      for (const model of provider.models) {
        expect(model.id.startsWith(`${provider.id}/`)).toBe(true);
        expect(catalog[provider.id].models?.[model.id.slice(provider.id.length + 1)]).toBeDefined();
      }
    }
  });

  it('offers exactly the efforts the model declares, and none where it declares no reasoning options', () => {
    for (const provider of providers) {
      for (const model of provider.models) {
        const entry = catalog[provider.id].models?.[model.id.slice(provider.id.length + 1)] ?? {};
        expect(model.efforts).toEqual(effortValues(entry));
      }
    }
    const withoutEfforts = providers
      .flatMap((provider) => provider.models)
      .filter((model) => model.efforts.length === 0);
    expect(withoutEfforts.length).toBeGreaterThan(0);
  });

  /** The picker must never be able to compose a pair `PUT /agents/:id/profile` then refuses. */
  it('offers only pairs the profile route accepts', () => {
    for (const provider of providers) {
      for (const model of provider.models) {
        for (const effort of model.efforts) expect(() => assertModelSelection(model.id, effort)).not.toThrow();
        if (model.efforts.length === 0) expect(() => assertModelSelection(model.id, null)).not.toThrow();
      }
    }
  });

  it('refuses an effort the chosen model does not declare', () => {
    const constrained = providers.flatMap((provider) => provider.models).find((model) => model.efforts.length > 0);
    assert(constrained, 'the catalog ships no model that declares efforts');
    expect(() => assertModelSelection(constrained.id, 'not-an-effort')).toThrow();
  });

  it('reads a provider and model name off the catalog rather than the key', () => {
    const named = modelCatalogResponse({
      acme: { name: 'Acme', models: { 'rocket-1': { name: 'Rocket One', reasoning_options: [] } } },
      bare: { models: { plain: {} } },
    });
    expect(named).toEqual([
      { id: 'acme', name: 'Acme', models: [{ id: 'acme/rocket-1', name: 'Rocket One', efforts: [] }] },
      { id: 'bare', name: 'bare', models: [{ id: 'bare/plain', name: 'plain', efforts: [] }] },
    ]);
  });

  it('drops a provider that ships no models', () => {
    expect(modelCatalogResponse({ empty: { name: 'Empty' } })).toEqual([]);
  });
});

function catalogFixture(contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'opsiforce-models-')), 'models.json');
  writeFileSync(path, contents, 'utf8');
  return path;
}

describe('loading the catalog the image ships', () => {
  it('reads the catalog the backend image carries', () => {
    expect(Object.keys(loadModelCatalog()).length).toBeGreaterThan(0);
  });

  it('refuses to start when the catalog is missing from the image', () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'opsiforce-models-')), 'models.json');
    expect(() => loadModelCatalog(missing)).toThrow(/models\.json/);
  });

  it('refuses to start when the catalog is not readable JSON', () => {
    expect(() => loadModelCatalog(catalogFixture('{ not json'))).toThrow(/JSON/);
  });

  it('refuses to start when the catalog offers no model to run an agent on', () => {
    expect(() => loadModelCatalog(catalogFixture('{}'))).toThrow(/no models/);
    expect(() => loadModelCatalog(catalogFixture('{"openai":{"models":{}}}'))).toThrow(/no models/);
  });
});

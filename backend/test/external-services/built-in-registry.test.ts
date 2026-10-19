import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../db';
import { externalServices } from '../../db/schema';
import {
  brokenBuiltInsDir,
  createExternalServicesTestApp,
  handlerlessBuiltInsDir,
  FIXTURE_SERVICE,
  type ExternalServicesTestApp,
} from './support/app';

async function builtInRows() {
  return db.select().from(externalServices).where(eq(externalServices.slug, FIXTURE_SERVICE));
}

describe('the Built-in External Services the backend boots with', () => {
  let harness: ExternalServicesTestApp;

  beforeAll(async () => {
    harness = await createExternalServicesTestApp();
  });

  afterAll(async () => {
    await harness.close();
  });

  it('holds one built-in row per folder, owned by no Organization', async () => {
    expect(await builtInRows()).toEqual([
      expect.objectContaining({ slug: FIXTURE_SERVICE, origin: 'built_in', tenantId: null }),
    ]);
  });

  it('keeps the same row across boots', async () => {
    const [before] = await builtInRows();

    const second = await createExternalServicesTestApp();
    await second.close();

    expect(await builtInRows()).toEqual([expect.objectContaining({ id: before?.id })]);
  });

  it('refuses to boot when a built-in folder fails the manifest check, naming the folder and the problem', async () => {
    await expect(createExternalServicesTestApp({ builtInsDir: brokenBuiltInsDir })).rejects.toThrow(
      /fixture-broken[\s\S]*operations: SDK 2 has no Operations/
    );
  });

  it('refuses to boot when a built-in folder has no service.ts', async () => {
    await expect(createExternalServicesTestApp({ builtInsDir: handlerlessBuiltInsDir })).rejects.toThrow(
      /fixture-handlerless[\s\S]*service\.ts is missing/
    );
  });
});

import type { TestProject } from 'vitest/node';
import { startTestPostgres, type TestPostgres } from '../support/postgres';

declare module 'vitest' {
  interface ProvidedContext {
    databaseUrl: string;
    workerCount: number;
  }
}

let postgres: TestPostgres | null = null;

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const workerCount = project.vitest.config.maxWorkers ?? 1;

  postgres = await startTestPostgres(workerCount);
  project.provide('databaseUrl', postgres.url);
  project.provide('workerCount', workerCount);

  return async () => {
    await postgres?.stop();
    postgres = null;
  };
}

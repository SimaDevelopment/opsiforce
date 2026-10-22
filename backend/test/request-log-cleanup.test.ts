import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  REQUEST_LOG_CLEANUP_BATCH_SIZE,
  RequestLogCleanupProcessor,
} from '../src/cleanup/request-log-cleanup.processor';
import { createDomainTestingModule, type DomainTestHarness } from './support/domain';

let harness: DomainTestHarness;
let storageMountPath: string;

beforeAll(async () => {
  harness = await createDomainTestingModule();
  storageMountPath = mkdtempSync(path.join(tmpdir(), 'request-log-cleanup-'));
});

afterAll(async () => {
  await harness.close();
  rmSync(storageMountPath, { recursive: true, force: true });
});

function runCleanup(): Promise<void> {
  const settings: Record<string, unknown> = { storageMountPath, requestLogRetentionDays: 3 };
  const config = { getOrThrow: (key: string) => settings[key] } as unknown as ConfigService;
  return new RequestLogCleanupProcessor(config).process({} as Job);
}

async function requestLogOfNewProject(schema: string): Promise<DatabaseSync> {
  const tenant = await harness.tenants.getOrCreateTenant(`request-log-${Date.now()}-${Math.random()}`);
  const project = await harness.projects.create({ title: 'Request log' }, tenant.id);
  const environment = await harness.projectEnvironments.findById(project.id);
  const dataDirectory = path.join(storageMountPath, environment.directory, 'data');
  mkdirSync(dataDirectory, { recursive: true });
  const database = new DatabaseSync(path.join(dataDirectory, 'database.db'));
  database.exec(schema);
  return database;
}

const APP_REQUESTS = `CREATE TABLE app_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

it('deletes requests past the retention in batches and keeps newer ones', async () => {
  const database = await requestLogOfNewProject(APP_REQUESTS);
  const insert = database.prepare(
    "INSERT INTO app_requests (method, url, created_at) VALUES ('GET', ?, datetime('now', ?))"
  );
  const expired = REQUEST_LOG_CLEANUP_BATCH_SIZE * 2 + 345;
  for (let index = 0; index < expired; index++) insert.run(`/old/${index}`, `-${4 + (index % 20)} days`);
  insert.run('/kept/two-days', '-2 days');
  insert.run('/kept/now', '-0 days');

  await runCleanup();

  const urls = database.prepare('SELECT url FROM app_requests ORDER BY id').all() as { url: string }[];
  expect(urls.map((row) => row.url)).toEqual(['/kept/two-days', '/kept/now']);
  database.close();
});

it('leaves a database without a request log untouched', async () => {
  const database = await requestLogOfNewProject(
    "CREATE TABLE process_logs (id INTEGER PRIMARY KEY, line TEXT, created_at TEXT); INSERT INTO process_logs (line, created_at) VALUES ('old', datetime('now', '-9 days'))"
  );

  await runCleanup();

  expect(database.prepare('SELECT COUNT(*) AS count FROM process_logs').get()).toEqual({ count: 1 });
  database.close();
});

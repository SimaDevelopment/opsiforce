import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inject } from 'vitest';
import { workerDatabaseUrl } from './workers';

const poolId = Number(process.env.VITEST_POOL_ID ?? '1');
const workerCount = inject('workerCount');

if (!Number.isInteger(poolId) || poolId < 1 || poolId > workerCount) {
  throw new Error(
    `VITEST_POOL_ID ${process.env.VITEST_POOL_ID} has no database: only ${workerCount} were created. Vitest resolved a higher maxWorkers than globalSetup cloned databases for.`
  );
}

process.env.DATABASE_URL = workerDatabaseUrl(inject('databaseUrl'), poolId);
process.env.NODE_ENV ??= 'test';
process.env.K8S_NAMESPACE ??= 'opsiforce-test';
process.env.STORAGE_TYPE ??= 'hostPath';
const storageMountPath = process.env.STORAGE_MOUNT_PATH ?? path.join(tmpdir(), `opsiforce-test-storage-${poolId}`);
mkdirSync(path.join(storageMountPath, 'projects'), { recursive: true });
process.env.STORAGE_MOUNT_PATH = storageMountPath;

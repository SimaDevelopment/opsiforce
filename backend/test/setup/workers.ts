export function workerDatabaseName(poolId: number): string {
  return `opsiforce_w${poolId}`;
}

export function workerDatabaseUrl(templateUrl: string, poolId: number): string {
  const url = new URL(templateUrl);
  url.pathname = `/${workerDatabaseName(poolId)}`;
  return url.toString();
}

export interface UsageBucketKey {
  tenantId: string;
  projectId: string | null;
  projectEnvironmentId: string | null;
  service: string;
}

export interface UsageCount {
  name: string;
  label: string;
  n: number;
}

export const EXTERNAL_SERVICE_DOORBELL_QUEUE = 'external-service-doorbell';

export const RING_JOB = 'ring';

export interface DoorbellJobData {
  projectEnvironmentId: string;
  externalServiceId: string;
  service: string;
  retry: number;
}

export const DOORBELL_RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000] as const;

export const MAX_EVENT_IDS_PER_RING = 500;

export function doorbellJobId(projectEnvironmentId: string, externalServiceId: string): string {
  return `${projectEnvironmentId}.${externalServiceId}`;
}

export function doorbellFollowUpJobId(jobId: string): string {
  return `${jobId}.again`;
}

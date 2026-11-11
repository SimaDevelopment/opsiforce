import type { SkillsOffCarryLine } from '../delivery/environment-skills';
import type { ProjectConfigurationCarryLine } from '../external-services';
import type { ProjectStatus } from '../project/project.types';

export const PROJECT_PUBLISH_QUEUE = 'project-publish';

export const PublishStatus = {
  Queued: 'queued',
  Committing: 'committing',
  Building: 'building',
  Migrating: 'migrating',
  Swapping: 'swapping',
  Done: 'done',
  Failed: 'failed',
} as const;

export type PublishStatus = (typeof PublishStatus)[keyof typeof PublishStatus];

export const ACTIVE_PUBLISH_STATUSES: PublishStatus[] = [
  PublishStatus.Queued,
  PublishStatus.Committing,
  PublishStatus.Swapping,
  PublishStatus.Building,
  PublishStatus.Migrating,
];

export interface PublishJobData {
  publishJobId: string;
  projectId: string;
  projectEnvironmentId: string;
  environmentId: string;
  tenantId: string;
  isFirstPublish: boolean;
  variables: Record<string, string>;
  scheduleIds: string[];
  serviceIds: string[] | null;
  withData: boolean;
}

export interface PublishDto {
  environmentId: string;
  variables?: Record<string, string>;
  scheduleIds?: string[];
  serviceIds?: string[];
  withData?: boolean;
}

export interface PublishTarget {
  environmentId: string;
  name: string;
  slug: string;
  description: string | null;
  projectEnvironmentId: string | null;
  status: ProjectStatus | null;
  deployedCommitSha: string | null;
}

export interface PublishFormVariable {
  key: string;
  value: string;
  devValue: string;
  isNew: boolean;
}

export interface PublishFormScheduleOption {
  id: string;
  name: string;
  selected: boolean;
}

export interface PublishFormServiceOption {
  id: string;
  name: string;
  selected: boolean;
  targetHasOwn: boolean;
}

export interface PublishFormResponse {
  environmentId: string;
  environmentName: string;
  isFirstPublish: boolean;
  developmentHasData: boolean;
  variables: PublishFormVariable[];
  schedules: PublishFormScheduleOption[];
  services: PublishFormServiceOption[];
}

export type AppDataCarryLine = { kind: 'app-data'; outcome: 'replaced' };

export type PublishReportLine = ProjectConfigurationCarryLine | SkillsOffCarryLine | AppDataCarryLine;

export interface PublishJobResponse {
  id: string;
  projectEnvironmentId: string;
  environmentId: string;
  status: PublishStatus;
  commitSha: string | null;
  error: string | null;
  report: PublishReportLine[];
  publicUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

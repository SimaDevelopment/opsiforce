import type { GateFinding, SkillFlags } from './gate';

export type { CatalogListFilter as SkillListFilter } from './catalog-filters';

export interface SkillFileInput {
  path: string;
  content: string;
  isBinary?: boolean;
  executable?: boolean;
}

export interface CreateSkillDto {
  name: string;
  displayName?: string;
  files?: SkillFileInput[];
}

export interface CreateSkillVersionDto {
  files: SkillFileInput[];
}

export interface ValidateSkillDto {
  name?: string;
  files: SkillFileInput[];
}

export interface DuplicateSkillDto {
  name: string;
  displayName?: string;
}

export interface UpdateSkillDto {
  displayName?: string | null;
}

export interface SetSkillVisibilityDto {
  visibility: string;
}

export interface SkillVersionSummary {
  version: number;
  description: string | null;
  flags: SkillFlags;
}

export interface SkillSummary {
  id: string;
  name: string;
  displayName: string | null;
  description: string | null;
  origin: string;
  visibility: string;
  disabled: boolean;
  disableable: boolean;
  available: boolean;
  createdBy: string | null;
  createdByName: string | null;
  builderChatId: string | null;
  usedByAgentCount: number;
  outdatedAgentCount: number;
  latestVersion: SkillVersionSummary | null;
  createdAt: Date;
  updatedAt: Date;
}

/** One agent carrying the skill, with every version it pins and whether any of them is behind. */
export interface SkillAgentUsage {
  id: string;
  name: string;
  displayName: string | null;
  pinnedVersions: number[];
  outdated: boolean;
  omittedIn: number;
}

export interface SkillVersionResponse {
  version: number;
  description: string | null;
  flags: SkillFlags;
  lints: string[];
  contentHash: string;
  createdVia: string;
  sourceRef: string | null;
  createdBy: string | null;
  createdAt: Date;
  isLatest: boolean;
}

export interface SkillFileResponse {
  path: string;
  content: string;
  isBinary: boolean;
  isExecutable: boolean;
  size: number;
}

export interface GateResponse {
  valid: boolean;
  errors: GateFinding[];
  lints: GateFinding[];
  flags: SkillFlags;
}

export interface SkillExport {
  fileName: string;
  archive: Buffer;
}

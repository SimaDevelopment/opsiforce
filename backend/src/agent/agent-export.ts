import type { TemplatePathNote } from '../agent-template/agent-template.types';
import type { ExportManifestStamp } from '../export/project-export.types';

export const AGENT_EXPORT_KIND = 'agent';
export const AGENT_EXPORT_FORMAT_VERSION = 1;
export const AGENT_EXPORT_MANIFEST = 'manifest.json';
export const AGENT_EXPORT_TEMPLATE_DIR = 'template';
export const AGENT_EXPORT_SKILLS_DIR = 'skills';

export type AgentExportSkillOrigin = 'built_in' | 'custom';

export interface AgentExportManifestAgent {
  displayName: string | null;
  slug: string;
  description: string | null;
  platformApi: boolean;
}

export interface AgentExportManifestProfile {
  promptBody: string;
  model: string;
  variant: string | null;
}

export interface AgentExportManifestSkill {
  name: string;
  origin: AgentExportSkillOrigin;
  contentHash: string;
  file?: string;
}

export interface AgentExportManifest {
  kind: typeof AGENT_EXPORT_KIND;
  stamp: ExportManifestStamp;
  agent: AgentExportManifestAgent;
  profile: AgentExportManifestProfile;
  skills: AgentExportManifestSkill[];
  template: { hash: string } | null;
}

export interface AgentExportFile {
  fileName: string;
  archive: Buffer;
}

export interface AgentExportSkillHits {
  name: string;
  hits: TemplatePathNote[];
}

export interface AgentExportPreview {
  template: TemplatePathNote[];
  skills: AgentExportSkillHits[];
}

export function agentExportFileName(slug: string): string {
  return `${slug}-agent-export.zip`;
}

export function agentExportSkillFile(name: string): string {
  return `${AGENT_EXPORT_SKILLS_DIR}/${name}.zip`;
}

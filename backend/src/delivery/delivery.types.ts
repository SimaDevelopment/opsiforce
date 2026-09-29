import type { SkillTree } from '../store/gate';

export const CUSTOM_AGENT_PACKAGE = 'custom';

export const OPENCODE_DIR = '.opencode';
export const OPENCODE_CONFIG_FILE = `${OPENCODE_DIR}/opencode.json`;
export const AGENTS_DIR = `${OPENCODE_DIR}/agents`;
export const SKILLS_DIR = `${OPENCODE_DIR}/skills`;
export const STAGING_DIR = '.opsiforce/staging';
export const LEDGER_DIR = '.opsiforce/agents';

export interface AgentFile {
  slug: string;
  model: string | null;
  promptBody: string;
}

export interface DeliverySkill {
  name: string;
  skillVersionId: string | null;
  contentHash: string;
  tree: SkillTree;
}

export const BUILDER_TEMPLATE_DIR = 'template';

export interface TemplateLay {
  agentId: string;
  environmentId: string;
  intoDirectory: string;
}

export interface DeliveryPlan {
  projectEnvironmentId: string;
  directory: string;
  runtimeAgentSlug: string;
  template: TemplateLay | null;
  agentFile: AgentFile | null;
  skills: DeliverySkill[];
}

/** The Custom Agent whose Development Template a fresh Builder chat opens with (ADR-0073). */
export interface DeliveryAtCreateOptions {
  builderSubjectAgentId?: string | null;
}

export function modelReference(model: string | null, variant: string | null): string | null {
  if (!model) return null;
  return variant ? `${model}#${variant}` : model;
}

export function renderAgentFile(file: AgentFile): string {
  const frontmatter = ['---', ...(file.model ? [`model: ${file.model}`] : []), 'mode: primary', '---'];
  return `${frontmatter.join('\n')}\n\n${file.promptBody.trim()}\n`;
}

export const SKILL_DELIVERY_QUEUE = 'skill-delivery';

/** The ladder the Agent-Updates reload already retries on (ADR-0060). */
export const SKILL_DELIVERY_RETRY_DELAYS_MS = [5, 15, 30, 60].map((minutes) => minutes * 60 * 1000);

export const SKILL_DELIVERY_DEFER_DELAY_MS = 30 * 1000;

export interface SkillDeliveryJobData {
  projectEnvironmentId: string;
  attempt: number;
}

export type SkillDeliveryOutcome =
  | { status: 'converged'; written: string[]; deleted: string[]; omitted: string[] }
  | { status: 'deferred'; reason: string }
  | { status: 'skipped'; reason: string };

export interface LedgerFile {
  contentVersion?: string;
  ownedSkills?: string[];
}

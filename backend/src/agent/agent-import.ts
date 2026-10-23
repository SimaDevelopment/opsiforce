import { BadRequestException, ConflictException, UnprocessableEntityException } from '@nestjs/common';
import type { AgentDetail } from './agent.types';
import type { AgentProjectSettings, AgentProjectSettingsChoice } from './agent-copy-settings';

export interface ImportAgentDto extends AgentProjectSettingsChoice {
  uploadId?: string;
  displayName?: string | null;
}

export interface InspectAgentImportDto {
  uploadId?: string;
}

export interface AgentImportInspection {
  displayName: string | null;
  slug: string;
  projectSettings: AgentProjectSettings;
  maxWarmPoolSize: number;
}

export type AgentImportNoteKind = 'model' | 'skill' | 'template';

export interface AgentImportNote {
  kind: AgentImportNoteKind;
  name?: string;
  path?: string;
  message: string;
}

export type AgentImportProblemKind = 'name' | 'skill' | 'template';

export interface AgentImportProblem {
  kind: AgentImportProblemKind;
  name?: string;
  path?: string;
  message: string;
}

export interface AgentImportResult {
  agent: AgentDetail;
  notes: AgentImportNote[];
}

export function serviceSettingsLeftOut(skillName: string): AgentImportNote {
  return {
    kind: 'skill',
    name: skillName,
    message: `Left out the service settings of \`${skillName}\`: setting them needs the Configure project External Services permission (can_configure_project_external_services)`,
  };
}

export function serviceSettingsOfUnavailableService(skillName: string): AgentImportNote {
  return {
    kind: 'skill',
    name: skillName,
    message: `Left out the service settings of \`${skillName}\`: its External Service isn't available here`,
  };
}

export function notAnAgentExport(message: string): BadRequestException {
  return new BadRequestException({ code: 'not_an_agent_export', message });
}

/** A name problem answers 409 `name_unavailable` so the dialog can resubmit a new name on the same upload. */
export function importRefused(
  problems: AgentImportProblem[],
  nameFromFile: string
): ConflictException | UnprocessableEntityException {
  const nameProblem = problems.find((problem) => problem.kind === 'name');
  const others = problems.length - (nameProblem ? 1 : 0);
  if (nameProblem) {
    return new ConflictException({
      code: 'name_unavailable',
      message:
        others > 0 ? `${nameProblem.message}, and ${others} more problem(s) stop this import` : nameProblem.message,
      nameFromFile,
      problems,
    });
  }
  return new UnprocessableEntityException({
    code: 'import_refused',
    message: `${problems.length} problem(s) stop this import; nothing was written`,
    problems,
  });
}

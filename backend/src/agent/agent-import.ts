import { BadRequestException, ConflictException, UnprocessableEntityException } from '@nestjs/common';
import type { AgentDetail } from './agent.types';

export interface ImportAgentDto {
  uploadId?: string;
  displayName?: string | null;
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

export function notAnAgentExport(message: string): BadRequestException {
  return new BadRequestException({ code: 'not_an_agent_export', message });
}

export function exportFormatUnsupported(version: number, supported: number): BadRequestException {
  return new BadRequestException({
    code: 'export_format_unsupported',
    message: `The file uses export format ${version}, but this deployment reads up to ${supported}; import it into a newer deployment`,
    exportFormatVersion: version,
  });
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

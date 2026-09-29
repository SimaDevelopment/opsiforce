export interface TemplatePathNote {
  path: string;
  reason: string;
}

export interface TemplateSavedFile {
  path: string;
  size: number;
  executable: boolean;
}

export interface TemplateSaveResult {
  hash: string | null;
  files: TemplateSavedFile[];
  skipped: TemplatePathNote[];
  warnings: TemplatePathNote[];
}

/** What an overlay wrote: the version's hash and every file path it placed, relative to the target. */
export interface TemplateOverlay {
  hash: string;
  paths: string[];
}

/** `damaged` marks a link whose version folder is missing. */
export interface EnvironmentTemplate {
  hash: string;
  damaged: boolean;
}

export type TemplateComparison = 'same' | 'changed' | 'added' | 'removed' | 'none';

export function compareTemplates(source: string | null, target: string | null): TemplateComparison {
  if (source === null) return target === null ? 'none' : 'removed';
  if (target === null) return 'added';
  return source === target ? 'same' : 'changed';
}

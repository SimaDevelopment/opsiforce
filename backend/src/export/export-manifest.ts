import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { PROJECT_EXPORT_KIND, type ExportManifestStamp } from './project-export.types';

export const EXPORT_MANIFEST_FILE = 'manifest.json';

export type ExportKind = 'project' | 'agent' | 'external-service';

const IMPORTED_FROM: Record<ExportKind, string> = {
  project: 'This is a Project export; import it from Projects',
  agent: "This is an Agent export; import it from the Store's Agents tab",
  'external-service': 'This is an External Service export; import it from Store → External Services',
};

const NAMED: Record<ExportKind, string> = {
  project: 'a Project',
  agent: 'an Agent',
  'external-service': 'an External Service',
};

function isExportKind(kind: unknown): kind is ExportKind {
  return typeof kind === 'string' && kind in IMPORTED_FROM;
}

export function wrongExportKind(manifest: { kind?: unknown }, expected: ExportKind): string | null {
  const kind = manifest.kind === undefined ? PROJECT_EXPORT_KIND : manifest.kind;
  if (kind === expected) return null;
  if (isExportKind(kind)) return IMPORTED_FROM[kind];
  const shown = typeof kind === 'string' ? kind : JSON.stringify(kind);
  return `This is a \`${shown}\` export, not ${NAMED[expected]} export`;
}

export function exportStampOf(config: ConfigService, exportFormatVersion: number): ExportManifestStamp {
  const platformVersion = config.get<string>('platformVersion', '0.1.0');
  return {
    exportFormatVersion,
    platformVersion,
    agentImageVersion: config.get<string>('agentImageVersion', platformVersion),
    arch: config.get<string>('arch', process.arch),
  };
}

export function exportFormatUnsupported(version: number, supported: number): BadRequestException {
  return new BadRequestException({
    code: 'export_format_unsupported',
    message: `The file uses export format ${version}, but this deployment reads up to ${supported}; import it into a newer deployment`,
    exportFormatVersion: version,
  });
}

import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { errorMessage } from '../../common/error-message';
import { GitService } from '../../git/git.service';
import { SERVICE_SKILL_FILE } from '../registry/built-in-services';
import { SERVICE_APP_FOLDER } from '../registry/published-service-files';
import { readFileInFolder } from '../registry/service-folder-files';
import type { TestReportView } from './test-reports';

export const PUBLISH_NOTE_FILE = 'PUBLISH.md';

export const CODE_DIFF_LIMIT_BYTES = 512 * 1024;

export type TestWarningCode = 'no-test-report' | 'changed-since-test' | 'upstream-never-called';

export interface TestWarning {
  code: TestWarningCode;
  message: string;
}

export type FolderDiff =
  | { state: 'present'; base: string | null; diff: string; truncated: boolean }
  | { state: 'unavailable'; reason: string };

export interface PublishChanges {
  publishNote: string | null;
  codeDiff: FolderDiff;
  skillDiff: FolderDiff;
}

export function testWarningsOf(report: TestReportView): TestWarning[] {
  if (report.state !== 'present') {
    return [
      {
        code: 'no-test-report',
        message:
          report.state === 'missing'
            ? 'No test report: the External Service Builder has not written one.'
            : 'No test report: the one written cannot be read.',
      },
    ];
  }
  const warnings: TestWarning[] = [];
  if (report.changedSince === null || report.changedSince.length > 0 || !report.manifestMatches) {
    warnings.push({
      code: 'changed-since-test',
      message: 'Changed since the test: what was tested is not what you publish.',
    });
  }
  if (!report.upstreamCalled) {
    warnings.push({
      code: 'upstream-never-called',
      message: 'Never called the real upstream: no live call in the test report reached it.',
    });
  }
  return warnings;
}

function limited(diff: string, base: string | null): FolderDiff {
  const bytes = Buffer.byteLength(diff);
  if (bytes <= CODE_DIFF_LIMIT_BYTES) return { state: 'present', base, diff, truncated: false };
  return {
    state: 'present',
    base,
    diff: Buffer.from(diff).subarray(0, CODE_DIFF_LIMIT_BYTES).toString('utf8'),
    truncated: true,
  };
}

function unavailable(reason: string): Pick<PublishChanges, 'codeDiff' | 'skillDiff'> {
  return { codeDiff: { state: 'unavailable', reason }, skillDiff: { state: 'unavailable', reason } };
}

@Injectable()
export class PublishChangesReader {
  private readonly logger = new Logger(PublishChangesReader.name);
  private readonly storageMountPath: string;

  constructor(
    config: ConfigService,
    private readonly git: GitService
  ) {
    this.storageMountPath = config.getOrThrow<string>('storageMountPath');
  }

  async of(developmentDirectory: string, defaultCommit: string | null): Promise<PublishChanges> {
    const workspace = join(this.storageMountPath, developmentDirectory);
    const [publishNote, diffs] = await Promise.all([
      readFileInFolder(join(workspace, SERVICE_APP_FOLDER), PUBLISH_NOTE_FILE),
      this.diffs(workspace, defaultCommit),
    ]);
    return { publishNote, ...diffs };
  }

  private async diffs(workspace: string, base: string | null): Promise<Pick<PublishChanges, 'codeDiff' | 'skillDiff'>> {
    if (!(await this.git.isRepo(workspace))) return unavailable("Development's workspace has no git history.");
    if (base !== null && !(await this.git.hasCommit(workspace, base))) {
      return unavailable(`The Default environment's commit ${base.slice(0, 7)} is not in Development's history.`);
    }
    try {
      const [code, skill] = await this.git.workingTreeDiffs(workspace, base, SERVICE_APP_FOLDER, [
        SERVICE_APP_FOLDER,
        `${SERVICE_APP_FOLDER}/${SERVICE_SKILL_FILE}`,
      ]);
      return { codeDiff: limited(code ?? '', base), skillDiff: limited(skill ?? '', base) };
    } catch (error) {
      this.logger.warn(`Diffing ${workspace} against ${base ?? 'nothing'} failed: ${errorMessage(error)}`);
      return unavailable('The code diff could not be computed.');
    }
  }
}

import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  formatProblemPath,
  serviceTestReportPath,
  serviceTestReportSchema,
  type ServiceTestReportLine,
} from '@opsiforce/external-service-sdk/platform';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../../db';
import { externalServiceCalls } from '../../../db/schema';
import { GitService } from '../../git/git.service';
import { readStampedFileInFolder } from '../registry/service-folder-files';

const WORKSPACE_ROOT = '/workspace/';

const SOURCES_THAT_CALL_THE_SERVICE: ReadonlySet<string> = new Set(['live-call', 'conversation']);

export type TestReportView =
  | { state: 'missing' }
  | { state: 'unreadable'; problems: string[] }
  | {
      state: 'present';
      writtenAt: string;
      commit: string;
      headCommit: string | null;
      changedSince: string[] | null;
      manifestMatches: boolean;
      counts: { pass: number; fail: number; notChecked: number };
      lines: ServiceTestReportLine[];
      upstreamCalled: boolean;
      unknownCallIds: string[];
    };

function workspaceRelativeTestReportPath(): string {
  return serviceTestReportPath.slice(WORKSPACE_ROOT.length);
}

@Injectable()
export class ServiceTestReports {
  private readonly storageMountPath: string;

  constructor(
    config: ConfigService,
    private readonly git: GitService
  ) {
    this.storageMountPath = config.getOrThrow<string>('storageMountPath');
  }

  async of(serviceId: string, manifestHash: string | null, workspaceDirectory: string): Promise<TestReportView> {
    const workspace = join(this.storageMountPath, workspaceDirectory);
    const stamped = await readStampedFileInFolder(workspace, workspaceRelativeTestReportPath());
    if (stamped === null) return { state: 'missing' };
    const { content: raw, modifiedAt: writtenAt } = stamped;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (error) {
      return { state: 'unreadable', problems: [`not JSON: ${error instanceof Error ? error.message : String(error)}`] };
    }
    const parsed = serviceTestReportSchema.safeParse(json);
    if (!parsed.success) {
      return {
        state: 'unreadable',
        problems: parsed.error.issues.map((issue) => `${formatProblemPath(issue.path)}: ${issue.message}`),
      };
    }
    const report = parsed.data;
    const [headCommit, changedSince, calls] = await Promise.all([
      this.git.currentSha(workspace).catch(() => null),
      this.git.changedSince(workspace, report.commit).catch(() => null),
      this.callsOf(serviceId, report.lines),
    ]);
    const allowed = new Set(calls.filter((call) => call.decision === 'allowed').map((call) => call.id));
    const known = new Set(calls.map((call) => call.id));
    return {
      state: 'present',
      writtenAt: writtenAt.toISOString(),
      commit: report.commit,
      headCommit,
      changedSince,
      manifestMatches: report.manifestHash === manifestHash,
      counts: {
        pass: report.lines.filter((line) => line.result === 'pass').length,
        fail: report.lines.filter((line) => line.result === 'fail').length,
        notChecked: report.lines.filter((line) => line.result === 'not-checked').length,
      },
      lines: report.lines,
      upstreamCalled: report.lines.some(
        (line) =>
          line.result !== 'not-checked' &&
          SOURCES_THAT_CALL_THE_SERVICE.has(line.source) &&
          line.callIds.some((id) => allowed.has(id))
      ),
      unknownCallIds: [...new Set(report.lines.flatMap((line) => line.callIds))].filter((id) => !known.has(id)),
    };
  }

  private async callsOf(serviceId: string, lines: ServiceTestReportLine[]) {
    const ids = [...new Set(lines.flatMap((line) => line.callIds))];
    if (ids.length === 0) return [];
    return db
      .select({ id: externalServiceCalls.id, decision: externalServiceCalls.decision })
      .from(externalServiceCalls)
      .where(and(eq(externalServiceCalls.externalServiceId, serviceId), inArray(externalServiceCalls.id, ids)));
  }
}

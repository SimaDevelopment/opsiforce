import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { db } from '../../../db';
import { projectEnvironments } from '../../../db/schema';
import { fileMode, writeTextAtomic } from '../../common/fs';
import { lockProjectGit } from '../../common/locks';
import { GitService, type CommittedFile } from '../../git/git.service';
import { SERVICE_APP_FOLDER } from '../registry/published-service-files';

const INITIAL_COMMIT_MESSAGE_FILE = '.opsiforce/initial-commit-message';

export interface ServiceAppSeed {
  files: CommittedFile[];
  commitMessage: string;
}

@Injectable()
export class ServiceAppSeeder {
  private readonly storageMountPath: string;

  constructor(
    config: ConfigService,
    private readonly git: GitService
  ) {
    this.storageMountPath = config.getOrThrow<string>('storageMountPath');
  }

  async seed(projectEnvironmentId: string, seed: ServiceAppSeed): Promise<void> {
    const workspace = join(this.storageMountPath, await this.directoryOf(projectEnvironmentId));
    const templateLaid = existsSync(join(workspace, '.git'));
    if (templateLaid) await this.removeTracked(workspace);
    await writeApp(join(workspace, SERVICE_APP_FOLDER), seed.files);
    if (!templateLaid) {
      await writeTextAtomic(join(workspace, INITIAL_COMMIT_MESSAGE_FILE), `${seed.commitMessage}\n`);
      return;
    }
    await db.transaction(async (tx) => {
      await lockProjectGit(tx, projectEnvironmentId);
      await this.git.commitPaths(workspace, [SERVICE_APP_FOLDER], seed.commitMessage);
    });
  }

  private async removeTracked(workspace: string): Promise<void> {
    for (const path of await this.git.trackedFiles(workspace, SERVICE_APP_FOLDER)) {
      await rm(join(workspace, path), { force: true });
    }
  }

  private async directoryOf(projectEnvironmentId: string): Promise<string> {
    const [environment] = await db
      .select({ directory: projectEnvironments.directory })
      .from(projectEnvironments)
      .where(eq(projectEnvironments.id, projectEnvironmentId));
    if (!environment) throw new NotFoundException(`Project environment ${projectEnvironmentId} not found`);
    return environment.directory;
  }
}

async function writeApp(appDir: string, files: CommittedFile[]): Promise<void> {
  for (const file of files) await writeTextAtomic(join(appDir, file.path), file.content, fileMode(file.executable));
}

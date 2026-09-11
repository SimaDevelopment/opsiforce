import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { basename, extname } from 'path';
import { isConvertibleToPdf, MAX_CONVERTIBLE_BYTES } from './convertible-formats';
import {
  ConversionFailure,
  type ConversionOutcome,
  ConversionStatus,
  type ConversionStatusResponse,
} from './file-conversion.types';
import { GotenbergService } from './gotenberg.service';
import { WorkspaceFileService } from './workspace-file.service';

const JOB_TTL_MS = 5 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;
const MAX_TRACKED_JOBS = 32;
// A pending job pins its document in memory until Gotenberg answers, so admission is capped too.
// The slot is reserved synchronously in start(), before any await, or a burst would all pass the check.
const MAX_PENDING_JOBS = 8;

interface ConversionJob {
  id: string;
  projectId: string;
  directory: string;
  name: string;
  status: ConversionStatus;
  failure?: ConversionFailure;
  error?: string;
  pdf?: Buffer;
  expiresAt: number;
}

export interface ConversionResult {
  name: string;
  pdf: Buffer;
}

@Injectable()
export class FileConversionService implements OnModuleDestroy {
  private readonly logger = new Logger(FileConversionService.name);
  private readonly jobs = new Map<string, ConversionJob>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly workspaceFileService: WorkspaceFileService,
    private readonly gotenbergService: GotenbergService
  ) {
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweeper.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweeper);
    this.jobs.clear();
  }

  async start(projectId: string, directory: string, relativePath: string): Promise<string> {
    if (!isConvertibleToPdf(relativePath)) throw new BadRequestException('This format is not convertible');
    if (this.pendingJobs() >= MAX_PENDING_JOBS) {
      throw new HttpException('Too many conversions in progress', HttpStatus.TOO_MANY_REQUESTS);
    }

    const job: ConversionJob = {
      id: randomUUID(),
      projectId,
      directory,
      name: basename(relativePath),
      status: ConversionStatus.Pending,
      expiresAt: Date.now() + JOB_TTL_MS,
    };
    this.track(job);

    try {
      const file = await this.workspaceFileService.openForRead(directory, relativePath);

      if (file.size > MAX_CONVERTIBLE_BYTES) {
        await file.handle.close().catch(() => {});
        this.fail(job, ConversionFailure.Unconvertible, 'This document is too large to convert');
        return job.id;
      }

      const bytes = await file.handle.readFile().finally(() => file.handle.close().catch(() => {}));
      void this.run(job, bytes);
      return job.id;
    } catch (err) {
      this.jobs.delete(job.id);
      throw err;
    }
  }

  status(projectId: string, directory: string, jobId: string): ConversionStatusResponse {
    const job = this.find(projectId, directory, jobId);
    return { status: job.status, failure: job.failure, error: job.error };
  }

  result(projectId: string, directory: string, jobId: string): ConversionResult {
    const job = this.find(projectId, directory, jobId);
    if (job.status !== ConversionStatus.Complete || !job.pdf)
      throw new NotFoundException('Conversion result not ready');
    return { name: `${basename(job.name, extname(job.name))}.pdf`, pdf: job.pdf };
  }

  private async run(job: ConversionJob, bytes: Buffer): Promise<void> {
    const outcome = await this.gotenbergService
      .convertToPdf({ name: job.name, bytes, traceId: job.id })
      .catch((err: unknown): ConversionOutcome => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Conversion of ${job.name} threw: ${message}`);
        return { ok: false as const, failure: ConversionFailure.Retryable, error: 'The converter failed' };
      });
    if (!this.jobs.has(job.id)) return;

    if (outcome.ok) {
      job.status = ConversionStatus.Complete;
      job.pdf = outcome.pdf;
      job.expiresAt = Date.now() + JOB_TTL_MS;
      return;
    }
    this.fail(job, outcome.failure, outcome.error);
  }

  private fail(job: ConversionJob, failure: ConversionFailure, error: string): void {
    job.status = ConversionStatus.Failed;
    job.failure = failure;
    job.error = error;
    job.expiresAt = Date.now() + JOB_TTL_MS;
  }

  private find(projectId: string, directory: string, jobId: string): ConversionJob {
    const job = this.jobs.get(jobId);
    if (!job || job.projectId !== projectId || job.directory !== directory || job.expiresAt <= Date.now()) {
      throw new NotFoundException('Conversion job not found');
    }
    return job;
  }

  private pendingJobs(): number {
    let pending = 0;
    for (const job of this.jobs.values()) {
      if (job.status === ConversionStatus.Pending) pending += 1;
    }
    return pending;
  }

  private track(job: ConversionJob): void {
    this.jobs.set(job.id, job);
    if (this.jobs.size <= MAX_TRACKED_JOBS) return;

    for (const [id, tracked] of this.jobs) {
      if (this.jobs.size <= MAX_TRACKED_JOBS) break;
      if (tracked.status === ConversionStatus.Pending) continue;
      this.jobs.delete(id);
    }
  }

  private sweep(): void {
    const now = Date.now();
    let removed = 0;
    for (const [id, job] of this.jobs) {
      if (job.expiresAt > now) continue;
      this.jobs.delete(id);
      removed += 1;
    }
    if (removed > 0) this.logger.debug(`Discarded ${removed} expired conversion job(s)`);
  }
}

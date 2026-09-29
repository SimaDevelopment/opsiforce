import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, rmdir, stat, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { once } from 'node:events';
import { Transform, type Readable } from 'node:stream';
import { importsRootPath, type CreateImportUploadResult } from './project-import.types';

const UPLOAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PART_SUFFIX = '.part';
const PART_NAME_PATTERN = /^\d+\.part$/;
const CLAIM_SUFFIX = '.finalizing';
const STAGING_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface UploadSessionRef {
  tenantId: string;
  uploadId: string;
}

export interface AssembleUploadParams {
  claimDir: string;
  destPath: string;
}

export interface WriteChunkParams extends UploadSessionRef {
  index: string;
  digestHeader: string | undefined;
  contentLengthHeader: string | undefined;
  body: Readable;
}

@Injectable()
export class ProjectImportUploadService {
  private readonly logger = new Logger(ProjectImportUploadService.name);
  private readonly storageMountPath: string;
  readonly chunkSize: number;

  constructor(private readonly configService: ConfigService) {
    this.storageMountPath = this.configService.getOrThrow<string>('storageMountPath');
    this.chunkSize = this.configService.getOrThrow<number>('importChunkSize');
  }

  stagingRoot(): string {
    return importsRootPath(this.storageMountPath);
  }

  stagingDir(ref: UploadSessionRef): string {
    return path.join(this.stagingRoot(), ref.tenantId, ref.uploadId);
  }

  partPath(sessionDir: string, index: number): string {
    return path.join(sessionDir, `${index}${PART_SUFFIX}`);
  }

  async createSession(tenantId: string, size: number | undefined): Promise<CreateImportUploadResult> {
    assertSize(size);
    const uploadId = crypto.randomUUID();
    await mkdir(this.stagingDir({ tenantId, uploadId }), { recursive: true });
    return { uploadId, chunkSize: this.chunkSize };
  }

  async writeChunk(params: WriteChunkParams): Promise<void> {
    const ref = { tenantId: params.tenantId, uploadId: assertUploadId(params.uploadId) };
    const index = assertChunkIndex(params.index);
    const expectedDigest = assertDigest(params.digestHeader);
    const expectedLength = this.assertChunkLength(params.contentLengthHeader);

    const stagingDir = this.stagingDir(ref);
    await this.assertSessionExists(stagingDir);

    const tempPath = path.join(stagingDir, `${index}${PART_SUFFIX}.${crypto.randomUUID()}.tmp`);
    const digest = crypto.createHash('sha256');
    let received = 0;
    const verifier = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        received += chunk.length;
        if (received > expectedLength) {
          done(new BadRequestException(`Chunk body is longer than its declared ${expectedLength} bytes`));
          return;
        }
        digest.update(chunk);
        done(null, chunk);
      },
    });

    try {
      await pipeline(params.body, verifier, createWriteStream(tempPath));
      if (received !== expectedLength) {
        throw new BadRequestException(`Chunk body is ${received} bytes, expected ${expectedLength}`);
      }
      if (digest.digest('hex') !== expectedDigest) {
        throw new UnprocessableEntityException('Chunk checksum does not match X-Chunk-Sha256');
      }
      await rename(tempPath, this.partPath(stagingDir, index));
    } catch (err) {
      await unlink(tempPath).catch(() => {});
      throw err;
    }
  }

  async claimSession(ref: UploadSessionRef): Promise<string> {
    const stagingDir = this.stagingDir({ tenantId: ref.tenantId, uploadId: assertUploadId(ref.uploadId) });
    const claimDir = `${stagingDir}${CLAIM_SUFFIX}`;
    try {
      await rename(stagingDir, claimDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NotFoundException('Upload session not found or already finalized');
      }
      if ((err as NodeJS.ErrnoException).code === 'ENOTEMPTY') {
        throw new ConflictException('The upload session is already being finalized');
      }
      throw err;
    }
    return claimDir;
  }

  /** Assembles a claimed session into `destPath` for `use`; a 400 consumes the upload, any other failure keeps it for a retry. */
  async consumeUpload<T>(ref: UploadSessionRef, destPath: string, use: () => Promise<T>): Promise<T> {
    const claimDir = await this.claimSession(ref);
    try {
      await this.assembleUpload({ claimDir, destPath });
      const result = await use();
      await this.deleteClaim(claimDir).catch(() => {});
      return result;
    } catch (err) {
      if (err instanceof HttpException && err.getStatus() === 400) {
        await this.deleteClaim(claimDir).catch(() => {});
      } else {
        await this.releaseClaim(ref, claimDir);
      }
      throw err;
    }
  }

  async releaseClaim(ref: UploadSessionRef, claimDir: string): Promise<void> {
    const stagingDir = this.stagingDir({ tenantId: ref.tenantId, uploadId: assertUploadId(ref.uploadId) });
    await rename(claimDir, stagingDir).catch(() => {});
  }

  async deleteClaim(claimDir: string): Promise<void> {
    await rm(claimDir, { recursive: true, force: true });
  }

  async assembleUpload(params: AssembleUploadParams): Promise<void> {
    const partCount = await this.assertPartsComplete(params.claimDir);

    await mkdir(path.dirname(params.destPath), { recursive: true });
    const destination = createWriteStream(params.destPath);
    try {
      for (let index = 0; index < partCount; index += 1) {
        await pipeline(createReadStream(this.partPath(params.claimDir, index)), destination, { end: false });
      }
      destination.end();
      await once(destination, 'finish');
    } catch (err) {
      destination.destroy();
      throw err;
    }
  }

  async deleteSession(ref: UploadSessionRef): Promise<void> {
    await rm(this.stagingDir({ tenantId: ref.tenantId, uploadId: assertUploadId(ref.uploadId) }), {
      recursive: true,
      force: true,
    });
  }

  async sweepAbandonedSessions(): Promise<number> {
    const cutoff = Date.now() - STAGING_RETENTION_MS;
    const root = this.stagingRoot();
    let removed = 0;

    for (const tenant of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!tenant.isDirectory()) continue;
      const tenantDir = path.join(root, tenant.name);

      for (const session of await readdir(tenantDir, { withFileTypes: true }).catch(() => [])) {
        if (!session.isDirectory() || !isSessionDirName(session.name)) continue;
        const sessionDir = path.join(tenantDir, session.name);
        const stats = await stat(sessionDir).catch(() => null);
        if (!stats || stats.mtimeMs >= cutoff) continue;

        try {
          await rm(sessionDir, { recursive: true, force: true });
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          this.logger.warn(`Failed to remove abandoned upload ${tenant.name}/${session.name}: ${reason}`);
          continue;
        }
        removed += 1;
      }

      await rmdir(tenantDir).catch(() => {});
    }

    return removed;
  }

  private async assertPartsComplete(stagingDir: string): Promise<number> {
    const sizes = new Map<number, number>();
    for (const entry of await readdir(stagingDir, { withFileTypes: true })) {
      if (!entry.isFile() || !PART_NAME_PATTERN.test(entry.name)) continue;
      const stats = await stat(path.join(stagingDir, entry.name));
      sizes.set(Number.parseInt(entry.name, 10), stats.size);
    }

    if (sizes.size === 0) throw new BadRequestException('The upload is empty: no chunks were uploaded.');
    for (let index = 0; index < sizes.size; index += 1) {
      const size = sizes.get(index);
      if (size === undefined) {
        throw new BadRequestException(`The upload is incomplete: chunk ${index} of ${sizes.size} is missing.`);
      }
      if (index < sizes.size - 1 && size !== this.chunkSize) {
        throw new BadRequestException(`Chunk ${index} is ${size} bytes, expected ${this.chunkSize}.`);
      }
    }
    return sizes.size;
  }

  private assertChunkLength(header: string | undefined): number {
    if (!header) throw new BadRequestException('Content-Length is required');
    const length = Number(header);
    if (!Number.isSafeInteger(length) || length <= 0) {
      throw new BadRequestException('Content-Length must be a positive integer');
    }
    if (length > this.chunkSize) {
      throw new BadRequestException(`Chunk is larger than the ${this.chunkSize} byte chunk size`);
    }
    return length;
  }

  private async assertSessionExists(stagingDir: string): Promise<void> {
    const stats = await stat(stagingDir).catch(() => null);
    if (!stats?.isDirectory()) throw new NotFoundException('Upload session not found');
  }
}

function assertSize(size: number | undefined): void {
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) {
    throw new BadRequestException('A positive integer "size" is required');
  }
}

function isSessionDirName(name: string): boolean {
  const uploadId = name.endsWith(CLAIM_SUFFIX) ? name.slice(0, -CLAIM_SUFFIX.length) : name;
  return UPLOAD_ID_PATTERN.test(uploadId);
}

function assertUploadId(uploadId: string): string {
  if (!UPLOAD_ID_PATTERN.test(uploadId)) throw new BadRequestException('Malformed upload id');
  return uploadId;
}

function assertChunkIndex(index: string): number {
  const parsed = Number(index);
  if (!/^(0|[1-9]\d*)$/.test(index) || !Number.isSafeInteger(parsed)) {
    throw new BadRequestException('Chunk index must be a non-negative integer');
  }
  return parsed;
}

function assertDigest(header: string | undefined): string {
  const digest = header?.toLowerCase();
  if (!digest || !SHA256_PATTERN.test(digest)) {
    throw new BadRequestException('X-Chunk-Sha256 must be a hex SHA-256 digest');
  }
  return digest;
}

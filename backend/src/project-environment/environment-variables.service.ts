import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readEnvJson, writeEnvJson } from '../common/env-file';
import { PodService } from '../pod/pod.service';
import { ProjectEnvironmentService } from './project-environment.service';
import type { ProjectEnvironmentContext } from './project-environment.types';
import {
  EnvironmentVariablesResponse,
  UpdateEnvironmentVariablesDto,
  UpdateEnvironmentVariablesResult,
} from './environment-variables.types';

const CONTROL_REQUEST_TIMEOUT_MS = 5000;
const CONTROL_TOKEN_ENV_NAME = 'OPSIFORCE_CONTROL_TOKEN';
const KEY_MAX_LENGTH = 256;
const VALUE_MAX_LENGTH = 32768;
const MAX_VARIABLES = 200;

@Injectable()
export class EnvironmentVariablesService {
  private readonly logger = new Logger(EnvironmentVariablesService.name);
  private readonly storageMountPath: string;
  private readonly controlPort: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly projectEnvironmentService: ProjectEnvironmentService,
    private readonly podService: PodService
  ) {
    this.storageMountPath = this.configService.getOrThrow<string>('storageMountPath');
    this.controlPort = this.configService.getOrThrow<number>('agentControlPort');
  }

  async getVariables(projectId: string, environmentId: string): Promise<EnvironmentVariablesResponse> {
    const env = await this.findEnvironment(projectId, environmentId);
    const variables = await readEnvJson(this.storageMountPath, env.directory);
    return { variables: Object.entries(variables).map(([key, value]) => ({ key, value })) };
  }

  async updateVariables(
    projectId: string,
    environmentId: string,
    dto: UpdateEnvironmentVariablesDto | undefined
  ): Promise<UpdateEnvironmentVariablesResult> {
    const env = await this.findEnvironment(projectId, environmentId);
    const variables = this.validateVariables(dto?.variables);

    await writeEnvJson(this.storageMountPath, env.directory, variables);

    if (!dto?.restartApp || !env.podIp) return { ok: true, restart: 'none' };

    const restarted = await this.tryControlRestart(env.id, env.podIp);
    return { ok: true, restart: restarted ? 'app' : 'pod' };
  }

  private async findEnvironment(projectId: string, environmentId: string): Promise<ProjectEnvironmentContext> {
    const env = await this.projectEnvironmentService.findById(environmentId);
    if (env.projectId !== projectId) {
      throw new NotFoundException(`Environment ${environmentId} not found`);
    }
    return env;
  }

  private async tryControlRestart(environmentId: string, podIp: string): Promise<boolean> {
    const token = await this.readControlToken(environmentId);
    if (!token) return false;

    try {
      const response = await fetch(`http://${podIp}:${this.controlPort}/restart-app`, {
        method: 'POST',
        headers: { 'x-control-token': token },
        signal: AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.logger.warn(`Control restart for environment ${environmentId} returned ${response.status}`);
        return false;
      }
      const { killed } = (await response.json()) as { killed?: number };
      if (!killed) {
        this.logger.warn(
          `Control restart for environment ${environmentId} found no supervised App process, falling back to pod recreate`
        );
        return false;
      }
      return true;
    } catch (err) {
      this.logger.warn(
        `Control restart unavailable for environment ${environmentId}, falling back to pod recreate: ${(err as Error).message}`
      );
      return false;
    }
  }

  private async readControlToken(environmentId: string): Promise<string | null> {
    try {
      const pod = await this.podService.getPod(this.podService.assignedPodName(environmentId));
      const entry = pod.spec?.containers?.[0]?.env?.find((e) => e.name === CONTROL_TOKEN_ENV_NAME);
      return entry?.value ?? null;
    } catch {
      return null;
    }
  }

  private validateVariables(value: unknown): Record<string, string> {
    if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException("'variables' must be an object of string values");
    }

    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > MAX_VARIABLES) {
      throw new BadRequestException(`At most ${MAX_VARIABLES} variables are allowed`);
    }

    const result: Record<string, string> = {};
    for (const [rawKey, rawValue] of entries) {
      const key = rawKey.trim();
      if (key.length === 0 || key.length > KEY_MAX_LENGTH) {
        throw new BadRequestException(`Variable keys must be 1-${KEY_MAX_LENGTH} characters`);
      }
      if (typeof rawValue !== 'string') {
        throw new BadRequestException(`Variable '${key}' must have a string value`);
      }
      if (rawValue.length > VALUE_MAX_LENGTH) {
        throw new BadRequestException(`Variable '${key}' exceeds the ${VALUE_MAX_LENGTH} character limit`);
      }
      result[key] = rawValue;
    }
    return result;
  }
}

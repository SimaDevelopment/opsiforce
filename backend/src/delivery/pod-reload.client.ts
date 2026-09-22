import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PodOpencodeClient } from '../agent-session/pod-opencode.client';
import { PodService } from '../pod/pod.service';

const CONTROL_TIMEOUT_MS = 3000;
const CONFIRM_TIMEOUT_MS = 5000;
const CONTROL_TOKEN_ENV_NAME = 'OPSIFORCE_CONTROL_TOKEN';

export type NotifyTarget = 'config' | 'agents' | 'skills';

export class SkillsNotLive extends Error {
  constructor(
    readonly missing: string[],
    readonly unexpected: string[]
  ) {
    super(
      `The pod did not serve the delivered skills: ${[
        missing.length > 0 ? `missing ${missing.join(', ')}` : '',
        unexpected.length > 0 ? `still serving ${unexpected.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('; ')}`
    );
  }
}

@Injectable()
export class PodReloadClient {
  private readonly logger = new Logger(PodReloadClient.name);
  private readonly controlPort: number;
  private readonly agentPort: number;
  private readonly confirmAttempts: number;
  private readonly confirmPollMs: number;

  constructor(
    configService: ConfigService,
    private readonly podService: PodService,
    private readonly opencode: PodOpencodeClient
  ) {
    this.controlPort = configService.getOrThrow<number>('agentControlPort');
    this.agentPort = configService.getOrThrow<number>('agentPort');
    this.confirmAttempts = configService.getOrThrow<number>('skillDeliveryConfirmAttempts');
    this.confirmPollMs = configService.getOrThrow<number>('skillDeliveryConfirmPollMs');
  }

  /** Best effort: a pod that cannot be notified is still confirmed, in case its watcher fired. */
  async notify(projectEnvironmentId: string, podIp: string, targets: NotifyTarget[]): Promise<boolean> {
    const token = await this.readControlToken(projectEnvironmentId);
    if (!token) return false;
    try {
      const response = await fetch(`http://${podIp}:${this.controlPort}/notify-config-change`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-control-token': token },
        body: JSON.stringify({ targets }),
        signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
      });
      if (response.ok) return true;
      this.logger.warn(`notify-config-change for environment ${projectEnvironmentId} returned ${response.status}`);
      return false;
    } catch (err) {
      this.logger.warn(
        `notify-config-change unavailable for environment ${projectEnvironmentId}: ${(err as Error).message}`
      );
      return false;
    }
  }

  async confirmSkills(podIp: string, expected: string[], absent: string[]): Promise<void> {
    let missing: string[] = expected;
    let unexpected: string[] = absent;
    for (let attempt = 0; attempt < Math.max(1, this.confirmAttempts); attempt += 1) {
      if (attempt > 0) await sleep(this.confirmPollMs);
      const served = new Set(
        await this.opencode.skillIds(`http://${podIp}:${this.agentPort}`, { timeoutMs: CONFIRM_TIMEOUT_MS })
      );
      missing = expected.filter((name) => !served.has(name));
      unexpected = absent.filter((name) => served.has(name));
      if (missing.length === 0 && unexpected.length === 0) return;
    }
    throw new SkillsNotLive(missing, unexpected);
  }

  private async readControlToken(projectEnvironmentId: string): Promise<string | null> {
    try {
      const pod = await this.podService.getPod(this.podService.assignedPodName(projectEnvironmentId));
      const entry = pod?.spec?.containers?.[0]?.env?.find((variable) => variable.name === CONTROL_TOKEN_ENV_NAME);
      return entry?.value ?? null;
    } catch {
      return null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

import { BadRequestException } from '@nestjs/common';

const BIFROST_PROVIDER_NAME_MAX_LENGTH = 50;

const NAME_SLUG = /^[a-z0-9-]+$/;

const BIFROST_STANDARD_PROVIDER_NAMES = new Set([
  'anthropic',
  'azure',
  'bedrock',
  'bedrock_mantle',
  'cerebras',
  'cohere',
  'deepseek',
  'gemini',
  'groq',
  'mistral',
  'ollama',
  'opencode-go',
  'opencode-zen',
  'openai',
  'parasail',
  'perplexity',
  'sgl',
  'vertex',
  'openrouter',
  'elevenlabs',
  'huggingface',
  'nebius',
  'xai',
  'replicate',
  'vllm',
  'runway',
  'runware',
  'fireworks',
  'sarvam',
  'wafer',
]);

const PRICING_TRAP_SUBSTRINGS = ['bedrock', 'cohere', 'together', 'vertex_ai', 'fireworks_ai', 'runwayml'];

export const PLATFORM_PROVIDER_PREFIX = 'opsiforce';

export const RESERVED_TENANT_NAME = PLATFORM_PROVIDER_PREFIX;

export function isReservedTenantName(tenantName: string): boolean {
  return tenantName === RESERVED_TENANT_NAME || isOpsiforceProviderName(tenantName);
}

export function platformBifrostProviderName(name: string): string {
  return customBifrostProviderName(PLATFORM_PROVIDER_PREFIX, name);
}

export function isOpsiforceProviderName(bifrostProvider: string): boolean {
  return bifrostProvider.startsWith(`${PLATFORM_PROVIDER_PREFIX}-`);
}

export function customBifrostProviderName(tenantName: string, name: string): string {
  return `${tenantName}-${name}`;
}

export function customNameMaxLength(tenantName: string): number {
  return Math.max(0, BIFROST_PROVIDER_NAME_MAX_LENGTH - 1 - tenantName.length);
}

export function assertCustomName(tenantName: string, name: unknown): asserts name is string {
  if (typeof name !== 'string' || name.length === 0) throw new BadRequestException('Enter a name');
  if (!NAME_SLUG.test(name)) {
    throw new BadRequestException('A name uses only lowercase letters, digits and hyphens');
  }
  const maxLength = customNameMaxLength(tenantName);
  if (name.length > maxLength) {
    throw new BadRequestException(`A name in this organization is at most ${maxLength} characters`);
  }
  if (BIFROST_STANDARD_PROVIDER_NAMES.has(name)) {
    throw new BadRequestException(`${name} is reserved for a standard provider; choose another name`);
  }
  const trap = pricingTrapIn(name);
  if (trap) {
    throw new BadRequestException(
      `A name can't contain "${trap}": the model gateway would price its requests as that vendor's`
    );
  }
  const tenantTrap = pricingTrapIn(tenantName);
  if (tenantTrap) {
    throw new BadRequestException(
      `This organization’s name contains "${tenantTrap}": the model gateway would price its model providers’ requests as that vendor’s`
    );
  }
}

function pricingTrapIn(text: string): string | undefined {
  return PRICING_TRAP_SUBSTRINGS.find((substring) => text.includes(substring));
}

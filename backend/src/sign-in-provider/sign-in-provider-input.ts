import { BadRequestException } from '@nestjs/common';
import type { SaveSignInProviderDto } from './sign-in-provider.types';

const DISCOVERY_SUFFIX = '/.well-known/openid-configuration';
const NAME_MAX_LENGTH = 64;
const CLAIM_NAME_PATTERN = /^[^\s'"[\]{}]{1,200}$/;

export interface SignInProviderFields {
  name: string;
  discoveryUrl: string;
  clientId: string;
  scope: string;
  requiredClaimName: string | null;
  requiredClaimValues: string[];
  groupsClaim: string | null;
}

function normalizeDiscoveryUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!URL.canParse(trimmed)) throw new BadRequestException('Discovery URL must be a valid URL');
  return trimmed.endsWith(DISCOVERY_SUFFIX) ? trimmed : `${trimmed}${DISCOVERY_SUFFIX}`;
}

function normalizeScope(raw: string | undefined): string {
  const scopes = (raw ?? '').split(/\s+/).filter(Boolean);
  if (scopes.length === 0) return 'openid profile email';
  if (!scopes.includes('openid')) throw new BadRequestException('Scope must include openid');
  return [...new Set(scopes)].join(' ');
}

function normalizeRequiredClaim(
  name: string | null | undefined,
  values: string[] | undefined
): Pick<SignInProviderFields, 'requiredClaimName' | 'requiredClaimValues'> {
  const claimName = name?.trim() ?? '';
  if (values !== undefined && !Array.isArray(values)) {
    throw new BadRequestException('requiredClaimValues must be a list of strings');
  }
  const claimValues = [...new Set((values ?? []).map((v) => String(v).trim()).filter(Boolean))];
  if (!claimName) {
    if (claimValues.length > 0) throw new BadRequestException('Allowed values need a claim name');
    return { requiredClaimName: null, requiredClaimValues: [] };
  }
  assertClaimName(claimName);
  return { requiredClaimName: claimName, requiredClaimValues: claimValues };
}

function normalizeGroupsClaim(name: unknown): string | null {
  if (name !== null && typeof name !== 'string') throw new BadRequestException('groupsClaim must be a string');
  const claimName = name?.trim() ?? '';
  if (!claimName) return null;
  assertClaimName(claimName);
  return claimName;
}

function assertClaimName(claimName: string): void {
  if (!CLAIM_NAME_PATTERN.test(claimName) || claimName.startsWith('.') || claimName.endsWith('.')) {
    throw new BadRequestException(
      'Claim name must be a claim such as groups, a dotted path such as realm_access.roles, or a namespaced claim such as https://example.com/roles'
    );
  }
}

export function signInProviderFields(
  dto: SaveSignInProviderDto,
  existing?: SignInProviderFields
): SignInProviderFields {
  const name = (dto.name ?? existing?.name ?? '').trim();
  if (!name) throw new BadRequestException('Name is required');
  if (name.length > NAME_MAX_LENGTH)
    throw new BadRequestException(`Name must be at most ${NAME_MAX_LENGTH} characters`);

  const discoveryUrl = dto.discoveryUrl !== undefined ? dto.discoveryUrl : existing?.discoveryUrl;
  if (!discoveryUrl?.trim()) throw new BadRequestException('Discovery URL is required');

  const clientId = (dto.clientId ?? existing?.clientId ?? '').trim();
  if (!clientId) throw new BadRequestException('Client ID is required');

  const claimTouched = dto.requiredClaimName !== undefined || dto.requiredClaimValues !== undefined;
  const claim = claimTouched
    ? normalizeRequiredClaim(dto.requiredClaimName, dto.requiredClaimValues)
    : {
        requiredClaimName: existing?.requiredClaimName ?? null,
        requiredClaimValues: existing?.requiredClaimValues ?? [],
      };

  return {
    name,
    discoveryUrl: normalizeDiscoveryUrl(discoveryUrl),
    clientId,
    scope: dto.scope !== undefined ? normalizeScope(dto.scope) : (existing?.scope ?? normalizeScope(undefined)),
    ...claim,
    groupsClaim:
      dto.groupsClaim !== undefined ? normalizeGroupsClaim(dto.groupsClaim) : (existing?.groupsClaim ?? null),
  };
}

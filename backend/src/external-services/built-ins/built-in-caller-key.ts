import type { SecretSealer } from '../../sealing/secret-sealer';

export function builtInCallerKey(sealer: SecretSealer, slug: string): string {
  return sealer.derivedKey(`built-in caller identity|${slug}`);
}

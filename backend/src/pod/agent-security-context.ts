import type { V1SecurityContext } from '@kubernetes/client-node';

/** Privileged agents must stay inside the explicitly installed Kata runtime. */
export function agentSecurityContext(runtimeClassName?: string, privileged = false): V1SecurityContext | undefined {
  if (!privileged) return undefined;
  if (runtimeClassName !== 'kata-clh-runtime-rs-opsiforce') {
    throw new Error('Privileged agents require the kata-clh-runtime-rs-opsiforce RuntimeClass');
  }
  return { privileged: true };
}

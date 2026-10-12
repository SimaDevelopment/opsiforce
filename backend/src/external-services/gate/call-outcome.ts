export const CALL_OUTCOMES = ['allowed', 'refused', 'failed'] as const;

export type CallOutcome = (typeof CALL_OUTCOMES)[number];

export const FAILED_STATUS_FROM = 400;

export function outcomeOf(call: { decision: string; status: number }): CallOutcome {
  if (call.decision === 'refused') return 'refused';
  return call.status >= FAILED_STATUS_FROM ? 'failed' : 'allowed';
}

export const outcomeHeader = 'opsiforce-outcome';

export const settingHeader = 'opsiforce-setting';

export const refusalStatuses = {
  'not supported': 404,
  'not allowed': 403,
  'not connected': 403,
  incomplete: 403,
  failed: 502,
  unidentified: 401,
} as const;

export type RefusalOutcome = keyof typeof refusalStatuses;

const tryAgain = "Try again; if it keeps failing, an Organization admin can check this service's Calls.";

export const failureMessages = {
  failed: (serviceName: string) => `${serviceName} couldn't do this. ${tryAgain}`,
  upstreamUnreachable: (serviceName: string) => `${serviceName} couldn't reach its upstream system. ${tryAgain}`,
  secretInAnswer: (serviceName: string) => `${serviceName}'s answer was blocked because it contained a stored secret.`,
  formOutOfDate: () => 'This form is out of date. Reload the page and try again.',
} as const;

export type FailureKind = keyof typeof failureMessages;

export type CallOutcome = 'proxied' | 'handled' | RefusalOutcome;

export interface Refusal {
  outcome: RefusalOutcome;
  status: number;
  message: string;
  setting: string | null;
  link: string | null;
}

export type RefusalOverride = (
  refusal: Refusal,
  request: Request
) => Response | undefined | Promise<Response | undefined>;

const verdicts = new WeakSet<object>();

export type Verdict =
  | { readonly verdict: 'allow' }
  | { readonly verdict: 'not allowed'; readonly message: string; readonly setting?: string }
  | { readonly verdict: 'not supported'; readonly message?: string };

export function issueVerdict<Issued extends Verdict>(verdict: Issued): Issued {
  const frozen = Object.freeze(verdict);
  verdicts.add(frozen);
  return frozen;
}

export function isVerdict(value: unknown): value is Verdict {
  return typeof value === 'object' && value !== null && verdicts.has(value);
}

export function refusalOf(
  outcome: RefusalOutcome,
  message: string,
  options: { setting?: string | null; link?: string | null; status?: number } = {}
): Refusal {
  return {
    outcome,
    status: options.status ?? refusalStatuses[outcome],
    message,
    setting: options.setting ?? null,
    link: options.link ?? null,
  };
}

function defaultRefusalResponse(refusal: Refusal): Response {
  const { outcome, message, setting, link } = refusal;
  return Response.json({ outcome, message, setting, link }, { status: refusal.status });
}

export async function refusalResponse(
  refusal: Refusal,
  request: Request,
  override: RefusalOverride | undefined
): Promise<Response> {
  let answer: Response | undefined;
  try {
    answer = await override?.(refusal, request);
  } catch {
    answer = undefined;
  }
  const chosen = answer instanceof Response ? answer : defaultRefusalResponse(refusal);
  const headers = new Headers(chosen.headers);
  headers.delete(outcomeHeader);
  headers.delete(settingHeader);
  headers.set(outcomeHeader, refusal.outcome);
  if (refusal.setting !== null) headers.set(settingHeader, refusal.setting);
  headers.delete('content-length');
  return new Response(chosen.body, { status: refusal.status, headers });
}

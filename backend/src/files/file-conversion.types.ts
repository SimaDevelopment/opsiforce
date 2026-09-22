export const ConversionStatus = {
  Pending: 'pending',
  Complete: 'complete',
  Failed: 'failed',
} as const;

export type ConversionStatus = (typeof ConversionStatus)[keyof typeof ConversionStatus];

export const ConversionFailure = {
  Unconvertible: 'unconvertible',
  Retryable: 'retryable',
  Busy: 'busy',
} as const;

export type ConversionFailure = (typeof ConversionFailure)[keyof typeof ConversionFailure];

export interface StartConversionDto {
  environmentId?: string;
  path?: string;
}

export interface ConversionJobResponse {
  jobId: string;
}

export interface ConversionStatusResponse {
  status: ConversionStatus;
  failure?: ConversionFailure;
  error?: string;
}

export type ConversionOutcome = { ok: true; pdf: Buffer } | { ok: false; failure: ConversionFailure; error: string };

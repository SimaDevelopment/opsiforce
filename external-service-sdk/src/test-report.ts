import { z } from 'zod';

export const serviceTestReportPath = '/workspace/.cache/service-test-report.json';

export const testReportResults = ['pass', 'fail', 'not-checked'] as const;

export const testReportSources = ['unit-test', 'live-call', 'event', 'conversation'] as const;

export const testReportLimits = {
  maxLines: 500,
  maxCallIdsPerLine: 100,
  maxTextLength: 1000,
} as const;

const sourcesProvedByCalls: ReadonlySet<string> = new Set(['live-call', 'conversation']);

export const serviceTestReportLineSchema = z
  .strictObject({
    expectation: z.string().trim().min(1).max(testReportLimits.maxTextLength),
    result: z.enum(testReportResults),
    source: z.enum(testReportSources),
    callIds: z.array(z.string().min(1).max(200)).max(testReportLimits.maxCallIdsPerLine),
    reason: z.string().trim().min(1).max(testReportLimits.maxTextLength).optional(),
  })
  .superRefine((line, ctx) => {
    if (line.result === 'not-checked' && line.reason === undefined) {
      ctx.addIssue({ code: 'custom', path: ['reason'], message: 'a not-checked line says why' });
    }
    if (line.result !== 'not-checked' && sourcesProvedByCalls.has(line.source) && line.callIds.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['callIds'],
        message: `a ${line.result} decided by a ${line.source} names the Call log rows that prove it`,
      });
    }
  });

export const serviceTestReportSchema = z.strictObject({
  commit: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, 'a full git commit id'),
  manifestHash: z.string().regex(/^[0-9a-f]{64}$/, 'a sha256 hex manifest hash'),
  lines: z.array(serviceTestReportLineSchema).min(1).max(testReportLimits.maxLines),
});

export type ServiceTestReportLine = z.infer<typeof serviceTestReportLineSchema>;
export type ServiceTestReport = z.infer<typeof serviceTestReportSchema>;

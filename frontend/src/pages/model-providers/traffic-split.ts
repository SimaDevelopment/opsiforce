import type { BaseFormatId, ModelProviderStatus } from '~/api/model-providers';

export interface SplitRow {
  name: string;
  enabled: boolean;
  weight: number;
  status?: ModelProviderStatus;
}

const IN_TRAFFIC: ReadonlySet<ModelProviderStatus> = new Set(['working', 'failing']);

export const MIN_WEIGHT = 0;
export const MAX_WEIGHT = 100;
export const WEIGHT_RULE_MESSAGE = 'At least one enabled provider needs a weight above 0';
export const WEIGHT_RANGE_MESSAGE = `Weights are whole numbers from ${MIN_WEIGHT} to ${MAX_WEIGHT}`;

export const BASE_FORMAT_LABEL: Record<BaseFormatId, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

export function isWeight(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_WEIGHT && value <= MAX_WEIGHT;
}

export function carriesTraffic(row: SplitRow): boolean {
  return row.enabled && (row.status === undefined || IN_TRAFFIC.has(row.status));
}

export function shareOf(row: SplitRow, rows: SplitRow[]): number {
  if (!carriesTraffic(row)) return 0;
  const inTraffic = rows.filter(carriesTraffic);
  const total = inTraffic.reduce((sum, other) => sum + other.weight, 0);
  if (total > 0) return row.weight / total;
  return inTraffic[0]?.name === row.name ? 1 : 0;
}

const SHARE_FORMAT = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 });

export function formatShare(share: number): string {
  return SHARE_FORMAT.format(share);
}

export function splitError(rows: SplitRow[]): string | null {
  if (rows.some((row) => !isWeight(row.weight))) return WEIGHT_RANGE_MESSAGE;
  const enabled = rows.filter((row) => row.enabled);
  if (enabled.length > 0 && enabled.every((row) => row.weight === 0)) return WEIGHT_RULE_MESSAGE;
  return null;
}

export function retryTargetsOf(row: SplitRow, rows: SplitRow[]): string[] {
  return rows.filter((other) => other.name !== row.name && carriesTraffic(other)).map((other) => other.name);
}

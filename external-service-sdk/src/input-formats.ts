import type { InputFormat } from './input-schema.ts';

const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const dateTimePattern = /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?([Zz]|[+-]\d{2}:\d{2})$/;
const emailPattern = /^[^\s@]{1,64}@[^\s@.]{1,63}(\.[^\s@.]{1,63}){1,10}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hostnameLabelPattern = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;

function isDate(value: string): boolean {
  const match = datePattern.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isDateTime(value: string): boolean {
  const match = dateTimePattern.exec(value);
  if (!match || !isDate(match[1] ?? '')) return false;
  return Number(match[2]) < 24 && Number(match[3]) < 60 && Number(match[4]) < 61;
}

function isUri(value: string): boolean {
  if (value.length > 8192 || !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return false;
  return URL.canParse(value);
}

function isHostname(value: string): boolean {
  return value.length <= 253 && value.split('.').every((label) => hostnameLabelPattern.test(label));
}

function isIpv4(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

export const inputFormatCheckers: Record<InputFormat, (value: string) => boolean> = {
  'date-time': isDateTime,
  date: isDate,
  email: (value) => value.length <= 254 && emailPattern.test(value),
  uri: isUri,
  uuid: (value) => uuidPattern.test(value),
  hostname: isHostname,
  ipv4: isIpv4,
};

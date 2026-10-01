import type { BaseFormatId } from '../model-provider/base-formats';
import type { VendorId } from './vendor-adapter';

export const VENDOR_BASE_FORMAT: Record<VendorId, BaseFormatId> = { chatgpt: 'openai' };

export function isVendorId(value: unknown): value is VendorId {
  return typeof value === 'string' && Object.hasOwn(VENDOR_BASE_FORMAT, value);
}

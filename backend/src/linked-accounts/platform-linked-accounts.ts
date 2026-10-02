import type { VendorId } from './vendor-adapter';

const PLATFORM_LINKED_ACCOUNTS: Record<string, VendorId> = { 'custom-openai-1': 'chatgpt' };

export const PLATFORM_LINKED_ACCOUNT_NAMES = Object.keys(PLATFORM_LINKED_ACCOUNTS);

export function platformLinkedAccountVendorOf(name: string): VendorId | null {
  return Object.hasOwn(PLATFORM_LINKED_ACCOUNTS, name) ? (PLATFORM_LINKED_ACCOUNTS[name] ?? null) : null;
}

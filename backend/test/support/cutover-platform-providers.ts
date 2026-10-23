interface CutoverPlatformProviderRow {
  tenantId: null;
  bifrostProvider: string;
  chatEnabled: boolean;
  chatWeight: number;
  backendEnabled?: boolean;
  backendWeight?: number;
}

export const CUTOVER_PLATFORM_PROVIDER_ROWS: CutoverPlatformProviderRow[] = [
  {
    tenantId: null,
    bifrostProvider: 'openai',
    chatEnabled: true,
    chatWeight: 0,
    backendEnabled: true,
    backendWeight: 1,
  },
  {
    tenantId: null,
    bifrostProvider: 'anthropic',
    chatEnabled: true,
    chatWeight: 1,
    backendEnabled: true,
    backendWeight: 1,
  },
  { tenantId: null, bifrostProvider: 'custom-openai-1', chatEnabled: true, chatWeight: 1 },
];

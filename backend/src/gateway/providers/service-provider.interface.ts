// TODO: remove in the release after External Services v2 ships: the dead POST /api/gateway dispatcher's provider contract
export interface ServiceProviderContext {
  projectId: string;
  tenantId: string;
}

export interface ServiceProviderResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface ServiceProvider {
  readonly serviceName: string;
  execute(payload: unknown, context: ServiceProviderContext): Promise<ServiceProviderResult>;
}

export const SERVICE_PROVIDERS = Symbol('SERVICE_PROVIDERS');

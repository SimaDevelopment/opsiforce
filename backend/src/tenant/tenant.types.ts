export interface TenantConfigResponse {
  privateWorkspaceEnabled: boolean;
  customDomainsEnabled: boolean;
}

export interface UpdateTenantConfigDto {
  privateWorkspaceEnabled?: boolean;
}

import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { RequirePermission } from '../permission/permission.guard';
import { CurrentTenant, PlatformScope, type TenantContext } from '../tenant/tenant.decorator';
import { ResourcePresetService } from './resource-preset.service';
import type {
  CreatePresetDto,
  OrganizationPresetsView,
  PlatformPresetsView,
  PresetApplied,
  PresetSaveResult,
  SetDefaultPresetDto,
  UpdatePresetDto,
} from './resource-preset.types';

const NOTHING_APPLIED: PresetApplied = { projects: 0, restarting: 0 };

@Controller('resource-presets')
export class ResourcePresetController {
  constructor(private readonly presets: ResourcePresetService) {}

  @Get()
  @RequirePermission('can_manage_tenant_resources')
  ownView(@CurrentTenant() tenant: TenantContext): Promise<OrganizationPresetsView> {
    return this.presets.organizationView(tenant.tenantId);
  }

  @Post()
  @RequirePermission('can_manage_tenant_resources')
  createOwn(@CurrentTenant() tenant: TenantContext, @Body() body: CreatePresetDto | undefined) {
    return this.organization(tenant.tenantId, () =>
      this.presets.createPreset(tenant.tenantId, body?.name, body?.resources)
    );
  }

  @Put('default')
  @RequirePermission('can_manage_tenant_resources')
  setOwnDefault(@CurrentTenant() tenant: TenantContext, @Body() body: SetDefaultPresetDto | undefined) {
    return this.organization(tenant.tenantId, () =>
      this.presets.setOrganizationDefault(tenant.tenantId, body?.presetId)
    );
  }

  @Patch(':id')
  @RequirePermission('can_manage_tenant_resources')
  updateOwn(
    @CurrentTenant() tenant: TenantContext,
    @Param('id') id: string,
    @Body() body: UpdatePresetDto | undefined
  ) {
    return this.organization(tenant.tenantId, () => this.presets.updatePreset(tenant.tenantId, id, body));
  }

  @Delete(':id')
  @RequirePermission('can_manage_tenant_resources')
  deleteOwn(@CurrentTenant() tenant: TenantContext, @Param('id') id: string) {
    return this.organization(tenant.tenantId, () => this.presets.deletePreset(tenant.tenantId, id));
  }

  @Post(':id/apply')
  @RequirePermission('can_manage_tenant_resources')
  applyOwn(@CurrentTenant() tenant: TenantContext, @Param('id') id: string) {
    return this.organization(tenant.tenantId, () => this.presets.applyPreset(tenant.tenantId, id));
  }

  @Delete(':id/override')
  @RequirePermission('can_manage_tenant_resources')
  removeOwnOverride(@CurrentTenant() tenant: TenantContext, @Param('id') id: string, @Query('apply') apply?: string) {
    return this.organization(tenant.tenantId, () => this.presets.removeOverride(tenant.tenantId, id, apply));
  }

  @Get('platform')
  @PlatformScope()
  @RequirePermission('can_manage_platform_resources')
  platformView(): Promise<PlatformPresetsView> {
    return this.presets.platformView();
  }

  @Post('platform')
  @PlatformScope()
  @RequirePermission('can_manage_platform_resources')
  createPlatform(@Body() body: CreatePresetDto | undefined) {
    return this.platform(() => this.presets.createPreset(null, body?.name, body?.resources));
  }

  @Put('platform/default')
  @PlatformScope()
  @RequirePermission('can_manage_platform_resources')
  setPlatformDefault(@Body() body: SetDefaultPresetDto | undefined) {
    return this.platform(() => this.presets.setPlatformDefault(body?.presetId));
  }

  @Put('platform/agents/:agentId')
  @PlatformScope()
  @RequirePermission('can_manage_platform_resources')
  setBuiltInAgentPreset(@Param('agentId') agentId: string, @Body() body: SetDefaultPresetDto | undefined) {
    return this.platform(() => this.presets.setBuiltInAgentPreset(agentId, body?.presetId ?? null));
  }

  @Post('platform/:id/apply')
  @PlatformScope()
  @RequirePermission('can_manage_platform_resources')
  applyPlatform(@Param('id') id: string) {
    return this.platform(() => this.presets.applyPreset(null, id));
  }

  @Patch('platform/:id')
  @PlatformScope()
  @RequirePermission('can_manage_platform_resources')
  updatePlatform(@Param('id') id: string, @Body() body: UpdatePresetDto | undefined) {
    return this.platform(() => this.presets.updatePreset(null, id, body));
  }

  @Delete('platform/:id')
  @PlatformScope()
  @RequirePermission('can_manage_platform_resources')
  deletePlatform(@Param('id') id: string) {
    return this.platform(() => this.presets.deletePreset(null, id));
  }

  @Get('tenants/:tenantId')
  @PlatformScope()
  @RequirePermission('can_manage_platform_resources')
  tenantView(@Param('tenantId') tenantId: string): Promise<OrganizationPresetsView> {
    return this.presets.organizationView(tenantId);
  }

  @Post('tenants/:tenantId')
  @PlatformScope()
  @RequirePermission('can_manage_platform_resources')
  createForTenant(@Param('tenantId') tenantId: string, @Body() body: CreatePresetDto | undefined) {
    return this.organization(tenantId, () => this.presets.createPreset(tenantId, body?.name, body?.resources));
  }

  @Put('tenants/:tenantId/default')
  @PlatformScope()
  @RequirePermission('can_manage_platform_resources')
  setTenantDefault(@Param('tenantId') tenantId: string, @Body() body: SetDefaultPresetDto | undefined) {
    return this.organization(tenantId, () => this.presets.setOrganizationDefault(tenantId, body?.presetId));
  }

  @Patch('tenants/:tenantId/:id')
  @PlatformScope()
  @RequirePermission('can_manage_platform_resources')
  updateForTenant(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @Body() body: UpdatePresetDto | undefined
  ) {
    return this.organization(tenantId, () => this.presets.updatePreset(tenantId, id, body));
  }

  @Delete('tenants/:tenantId/:id')
  @PlatformScope()
  @RequirePermission('can_manage_platform_resources')
  deleteForTenant(@Param('tenantId') tenantId: string, @Param('id') id: string) {
    return this.organization(tenantId, () => this.presets.deletePreset(tenantId, id));
  }

  @Post('tenants/:tenantId/:id/apply')
  @PlatformScope()
  @RequirePermission('can_manage_platform_resources')
  applyForTenant(@Param('tenantId') tenantId: string, @Param('id') id: string) {
    return this.organization(tenantId, () => this.presets.applyPreset(tenantId, id));
  }

  @Delete('tenants/:tenantId/:id/override')
  @PlatformScope()
  @RequirePermission('can_manage_platform_resources')
  removeTenantOverride(@Param('tenantId') tenantId: string, @Param('id') id: string, @Query('apply') apply?: string) {
    return this.organization(tenantId, () => this.presets.removeOverride(tenantId, id, apply));
  }

  private async organization(
    tenantId: string,
    change: () => Promise<PresetApplied | void>
  ): Promise<PresetSaveResult<OrganizationPresetsView>> {
    const applied = (await change()) ?? NOTHING_APPLIED;
    return { view: await this.presets.organizationView(tenantId), applied };
  }

  private async platform(change: () => Promise<PresetApplied | void>): Promise<PresetSaveResult<PlatformPresetsView>> {
    const applied = (await change()) ?? NOTHING_APPLIED;
    return { view: await this.presets.platformView(), applied };
  }
}

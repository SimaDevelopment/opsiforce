import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { Perms } from '../permission/permission.constants';
import { RequirePermission } from '../permission/permission.guard';
import { PlatformScope } from '../tenant/tenant.decorator';
import { AgentCallerRefusalGuard } from './agent-caller-refusal.guard';
import { PlatformModelProvidersService } from './platform-model-providers.service';
import type {
  ConnectionTestPassed,
  EditModelProviderConnectionDto,
  SetModelProviderModelsDto,
  ModelProviderConnectionDto,
  NewModelProviderDto,
  PlatformModelProviderAccessView,
  PlatformModelProviderCreationRules,
  PlatformModelProvidersView,
  SetModelProviderAccessDto,
  SetModelProviderAvailabilityModeDto,
} from './model-provider.types';

@Controller('platform-model-providers')
@PlatformScope()
@RequirePermission(Perms.managePlatformModelProviders)
@UseGuards(AgentCallerRefusalGuard)
export class PlatformModelProvidersController {
  constructor(private readonly platformService: PlatformModelProvidersService) {}

  @Get()
  list(): Promise<PlatformModelProvidersView> {
    return this.platformService.list();
  }

  @Get('creation-rules')
  rules(): PlatformModelProviderCreationRules {
    return this.platformService.rules();
  }

  @Get('access')
  access(): Promise<PlatformModelProviderAccessView> {
    return this.platformService.access();
  }

  @Put(':name/availability')
  setAvailabilityMode(
    @Param('name') name: string,
    @Body() body: SetModelProviderAvailabilityModeDto | undefined
  ): Promise<PlatformModelProviderAccessView> {
    return this.platformService.setAvailabilityMode(name, body);
  }

  @Put(':name/access/:tenantId')
  setAccess(
    @Param('name') name: string,
    @Param('tenantId') tenantId: string,
    @Body() body: SetModelProviderAccessDto | undefined
  ): Promise<PlatformModelProviderAccessView> {
    return this.platformService.setAccess(name, tenantId, body);
  }

  @Post('test')
  @HttpCode(200)
  test(@Body() body: NewModelProviderDto | undefined): Promise<ConnectionTestPassed> {
    return this.platformService.test(body);
  }

  @Post()
  create(@Body() body: NewModelProviderDto | undefined): Promise<PlatformModelProvidersView> {
    return this.platformService.create(body);
  }

  @Patch(':name')
  editConnection(
    @Param('name') name: string,
    @Body() body: EditModelProviderConnectionDto | undefined
  ): Promise<PlatformModelProvidersView> {
    return this.platformService.editConnection(name, body);
  }

  @Put(':name/models')
  setModels(
    @Param('name') name: string,
    @Body() body: SetModelProviderModelsDto | undefined
  ): Promise<PlatformModelProvidersView> {
    return this.platformService.setModels(name, body);
  }

  @Post(':name/re-enter-key')
  @HttpCode(200)
  reenterKey(
    @Param('name') name: string,
    @Body() body: ModelProviderConnectionDto | undefined
  ): Promise<PlatformModelProvidersView> {
    return this.platformService.reenterKey(name, body);
  }

  @Delete(':name')
  delete(@Param('name') name: string): Promise<PlatformModelProvidersView> {
    return this.platformService.delete(name);
  }
}

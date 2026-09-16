import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { GatewayAuthGuard } from '../../gateway/gateway-auth.guard';
import type { GatewayRequest } from '../../gateway/gateway-key.service';
import { Public } from '../../tenant/tenant.decorator';
import { definitionOf, jsonBodyOf, routeNotFound, subpathSegmentsOf } from './dispatch-request';
import type { JsonValue, ServiceRouteMethod } from '../platform/external-service-definition';
import { ExternalServiceRegistry } from '../platform/external-service-registry';
import { matchServiceRoute } from './service-route-matcher';

const IDENTITY_SEGMENT = 'identity';

@Public()
@UseGuards(GatewayAuthGuard)
@Controller('external-services/agent')
export class ExternalServicesAgentController {
  constructor(private readonly registry: ExternalServiceRegistry) {}

  @Get(':service/*')
  get(
    @Req() request: GatewayRequest,
    @Param() params: Record<string, string>,
    @Body() body: JsonValue | undefined
  ): Promise<JsonValue> {
    return this.dispatch('GET', request, params, body);
  }

  @Post(':service/*')
  post(
    @Req() request: GatewayRequest,
    @Param() params: Record<string, string>,
    @Body() body: JsonValue | undefined
  ): Promise<JsonValue> {
    return this.dispatch('POST', request, params, body);
  }

  @Patch(':service/*')
  patch(
    @Req() request: GatewayRequest,
    @Param() params: Record<string, string>,
    @Body() body: JsonValue | undefined
  ): Promise<JsonValue> {
    return this.dispatch('PATCH', request, params, body);
  }

  @Delete(':service/*')
  delete(
    @Req() request: GatewayRequest,
    @Param() params: Record<string, string>,
    @Body() body: JsonValue | undefined
  ): Promise<JsonValue> {
    return this.dispatch('DELETE', request, params, body);
  }

  private dispatch(
    method: ServiceRouteMethod,
    request: GatewayRequest,
    params: Record<string, string>,
    body: JsonValue | undefined
  ): Promise<JsonValue> {
    const definition = definitionOf(this.registry, params);
    const environmentId = environmentIdOf(request);
    const segments = subpathSegmentsOf(params);

    if (method === 'GET' && segments.length === 1 && segments[0] === IDENTITY_SEGMENT) {
      return definition.identity(environmentId);
    }

    const matched = matchServiceRoute(definition.routes?.agent ?? [], method, segments);
    if (!matched) throw routeNotFound(definition.serviceName, method, segments);

    return matched.route.handler({ environmentId, params: matched.params, body: jsonBodyOf(body) });
  }
}

function environmentIdOf(request: GatewayRequest): string {
  const projectEnvironmentId = request.gatewayContext.projectEnvironmentId;
  if (!projectEnvironmentId) {
    throw new BadRequestException('External-services agent endpoints require an environment-scoped gateway key');
  }
  return projectEnvironmentId;
}

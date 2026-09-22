import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { GatewayKeyService, type GatewayRequest } from './gateway-key.service';

@Injectable()
export class GatewayAuthGuard implements CanActivate {
  constructor(private readonly gatewayKeyService: GatewayKeyService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<GatewayRequest>();

    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or invalid Authorization header');
    }

    const token = authHeader.slice(7);
    const identity = await this.gatewayKeyService.validateToken(token, 'service');
    if (!identity) {
      throw new UnauthorizedException('Invalid gateway token');
    }

    request.gatewayContext = identity;
    return true;
  }
}

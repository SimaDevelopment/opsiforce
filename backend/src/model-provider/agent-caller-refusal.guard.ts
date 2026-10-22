import { ForbiddenException, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { podCredentialOf } from '../public-api/auth/gateway-bearer';

@Injectable()
export class AgentCallerRefusalGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (podCredentialOf(request.headers)) throw new ForbiddenException('Agent Callers cannot manage model providers');
    return true;
  }
}

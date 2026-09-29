import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { getEmailHeader, getGroupsHeader, getUserIdHeader, getUsernameHeader } from '../permission/permission.utils';

export interface UserContext {
  userId: string;
  username: string;
  email: string | null;
  displayName: string | null;
  groups: string;
}

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): UserContext => {
  const request = ctx.switchToHttp().getRequest<FastifyRequest>();
  const userId = getUserIdHeader(request);
  if (!userId) {
    throw new UnauthorizedException('No authenticated user');
  }
  const username = getUsernameHeader(request) ?? getEmailHeader(request) ?? userId;
  return {
    userId,
    username,
    email: getEmailHeader(request),
    displayName: username,
    groups: getGroupsHeader(request),
  };
});

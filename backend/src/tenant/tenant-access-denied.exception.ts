import { ForbiddenException } from '@nestjs/common';

export class TenantAccessDeniedException extends ForbiddenException {}

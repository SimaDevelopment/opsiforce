import { ForbiddenException } from '@nestjs/common';

export class MissingPermissionException extends ForbiddenException {
  constructor(readonly permission: string) {
    super(`Missing permission: ${permission}`);
  }
}

import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiExtension, DECORATORS } from '@nestjs/swagger';
import type { OperationKind } from '@opsiforce/external-service-sdk';
import { operationKindExtension, operationNameExtension } from '@opsiforce/external-service-sdk/platform';

export const EXTERNAL_SERVICE_OPERATION_KEY = 'externalServiceOperation';

export interface ExternalServiceOperationOptions {
  kind?: OperationKind;
}

function operationId(name: string): MethodDecorator {
  return (_target, _key, descriptor) => {
    const previous = (Reflect.getMetadata(DECORATORS.API_OPERATION, descriptor.value as object) ?? {}) as object;
    Reflect.defineMetadata(DECORATORS.API_OPERATION, { ...previous, operationId: name }, descriptor.value as object);
    return descriptor;
  };
}

export function ExternalServiceOperation(name: string, options: ExternalServiceOperationOptions = {}): MethodDecorator {
  return applyDecorators(
    SetMetadata(EXTERNAL_SERVICE_OPERATION_KEY, name),
    operationId(name),
    ApiExtension(operationNameExtension, name),
    ...(options.kind ? [ApiExtension(operationKindExtension, options.kind)] : [])
  );
}

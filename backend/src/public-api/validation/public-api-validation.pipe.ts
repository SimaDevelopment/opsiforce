import {
  ArgumentMetadata,
  Injectable,
  InternalServerErrorException,
  StandardSchemaValidationPipe,
} from '@nestjs/common';
import { ValidationIssuesSignal } from './validation-issues.signal';

const SCHEMA_REQUIRED_FOR = new Set(['body', 'query', 'param']);

@Injectable()
export class PublicApiValidationPipe extends StandardSchemaValidationPipe {
  constructor() {
    super({ exceptionFactory: (issues) => new ValidationIssuesSignal(issues, 'body') });
  }

  override async transform<T>(value: T, metadata: ArgumentMetadata): Promise<T> {
    if (SCHEMA_REQUIRED_FOR.has(metadata.type) && !metadata.schema) {
      throw new InternalServerErrorException(`public API ${metadata.type} parameter declared without a schema`);
    }
    try {
      return await super.transform(value, metadata);
    } catch (error) {
      if (error instanceof ValidationIssuesSignal) throw new ValidationIssuesSignal(error.issues, metadata.type);
      throw error;
    }
  }
}

import { Catch, HttpStatus, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { problem, sendProblem } from '../http/problem-reply';

export interface ConfigurationIssue {
  pointer: string;
  message: string;
}

export class InvalidConfigurationError extends Error {
  constructor(readonly issues: ConfigurationIssue[]) {
    super(issues.map((issue) => `${issue.pointer} ${issue.message}`).join('; '));
  }
}

@Catch(InvalidConfigurationError)
export class InvalidConfigurationFilter implements ExceptionFilter<InvalidConfigurationError> {
  catch(error: InvalidConfigurationError, host: ArgumentsHost): void {
    void sendProblem(
      host.switchToHttp().getResponse<FastifyReply>(),
      problem({
        status: HttpStatus.BAD_REQUEST,
        code: 'invalid-configuration',
        detail: 'The values do not fit the form',
        message: error.message,
        errors: error.issues,
      })
    );
  }
}

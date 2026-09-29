import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { tap } from 'rxjs';
import { ProjectEventsService } from '../../project/project-events.service';
import { chatProjectIdOf, type CallerRequest } from './caller';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class ChatEventsInterceptor implements NestInterceptor {
  constructor(private readonly projectEvents: ProjectEventsService) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<CallerRequest>();

    return next.handle().pipe(
      tap(() => {
        if (READ_METHODS.has(request.method)) return;
        const chatProjectId = request.caller && chatProjectIdOf(request.caller);
        if (chatProjectId) void this.projectEvents.publish(chatProjectId);
      })
    );
  }
}

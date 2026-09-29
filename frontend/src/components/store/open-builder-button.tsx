import { Show } from 'solid-js';
import { Link } from '@tanstack/solid-router';
import { builderPath, envSearch, type BuilderSubjectRef } from '~/api/builder';
import { Button, buttonVariants } from '~/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '~/components/ui/tooltip';
import { MessageSquare } from '~/components/icons';
import { cn } from '~/lib/cn';

export function OpenBuilderButton(props: {
  subject: BuilderSubjectRef;
  disabled: boolean;
  returnEnv?: string;
}) {
  return (
    <Show
      when={!props.disabled}
      fallback={
        <Tooltip>
          <TooltipTrigger as="span" tabIndex={0} class="inline-flex rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
            <Button size="sm" variant="outline" disabled class="pointer-events-none">
              <MessageSquare class="h-4 w-4" aria-hidden="true" />
              Edit in Builder
            </Button>
          </TooltipTrigger>
          <TooltipContent>Enable it to keep building.</TooltipContent>
        </Tooltip>
      }
    >
      <Link
        to={builderPath(props.subject)}
        search={envSearch(props.returnEnv)} class={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'gap-2')}>
        <MessageSquare class="h-4 w-4" aria-hidden="true" />
        Edit in Builder
      </Link>
    </Show>
  );
}

import { Show, createSignal, onCleanup } from 'solid-js';
import { toast } from 'solid-sonner';
import { Check, Copy } from '~/components/icons';
import { Button } from '~/components/ui/button';

const COPIED_FEEDBACK_MS = 2000;

export interface SignInDetailsProps {
  appUrl?: string;
  email: string;
  password: string;
}

function detailsText(props: SignInDetailsProps): string {
  return [props.appUrl && `Sign in at ${props.appUrl}`, `Email: ${props.email}`, `Password: ${props.password}`]
    .filter(Boolean)
    .join('\n');
}

export function SignInDetails(props: SignInDetailsProps) {
  const [copied, setCopied] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(detailsText(props));
    } catch {
      toast.error('Copying failed. Select the details and copy them yourself.');
      return;
    }
    setCopied(true);
    clearTimeout(timer);
    timer = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
  };

  return (
    <div class="space-y-3">
      <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-md border border-border bg-muted/30 p-3 text-xs">
        <Show when={props.appUrl}>
          {(url) => (
            <>
              <dt class="text-muted-foreground">App</dt>
              <dd class="break-all font-mono" translate="no">
                {url()}
              </dd>
            </>
          )}
        </Show>
        <dt class="text-muted-foreground">Email</dt>
        <dd class="break-all font-mono" translate="no">
          {props.email}
        </dd>
        <dt class="text-muted-foreground">Password</dt>
        <dd class="break-all font-mono" translate="no">
          {props.password}
        </dd>
      </dl>
      <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
        <Show when={copied()} fallback={<Copy class="h-3.5 w-3.5" aria-hidden="true" />}>
          <Check class="of-ink of-tone-done h-3.5 w-3.5" aria-hidden="true" />
        </Show>
        {copied() ? 'Copied' : 'Copy Sign-in Details'}
      </Button>
      <p class="sr-only" aria-live="polite">
        {copied() ? 'Sign-in details copied' : ''}
      </p>
    </div>
  );
}

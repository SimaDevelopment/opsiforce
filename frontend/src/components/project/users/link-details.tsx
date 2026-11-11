import { Show, createSignal, onCleanup } from 'solid-js';
import { toast } from 'solid-sonner';
import type { AppUserLink, AppUserLinkPurpose } from '~/api/app-users';
import { Check, Copy, Mail } from '~/components/icons';
import { Button } from '~/components/ui/button';
import { INPUT_CLASS } from './fields';

const COPIED_FEEDBACK_MS = 2000;
const EXPIRES = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function LinkDetails(props: {
  link: AppUserLink;
  purpose: AppUserLinkPurpose;
  email: string;
  onEmail?: () => void;
  emailing?: boolean;
}) {
  const [copied, setCopied] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.link.url);
    } catch {
      toast.error('Copying failed. Select the link and copy it yourself.');
      return;
    }
    setCopied(true);
    clearTimeout(timer);
    timer = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
  };

  return (
    <div class="space-y-2">
      <Show when={props.link.emailed}>
        <p class="of-note of-tone-done text-xs leading-snug" role="status">
          Emailed to {props.email}. You can also copy the link below.
        </p>
      </Show>
      <div class="flex gap-2">
        <input
          readonly
          aria-label={props.purpose === 'invite' ? 'Invite link' : 'Reset link'}
          value={props.link.url}
          onFocus={(e) => e.currentTarget.select()}
          class={`${INPUT_CLASS} font-mono text-xs`}
          translate="no"
        />
        <Button type="button" size="sm" class="h-9 shrink-0" onClick={() => void copy()}>
          <Show when={copied()} fallback={<Copy class="h-3.5 w-3.5" aria-hidden="true" />}>
            <Check class="h-3.5 w-3.5" aria-hidden="true" />
          </Show>
          {copied() ? 'Copied' : 'Copy Link'}
        </Button>
      </div>
      <Show when={props.onEmail}>
        {(email) => (
          <div class="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" loading={props.emailing} onClick={() => email()()}>
              <Mail class="h-3.5 w-3.5" aria-hidden="true" />
              {props.link.emailed ? 'Email Again' : 'Email Link'}
            </Button>
            <span class="text-xs text-muted-foreground">Sends a new link; this one stops working.</span>
          </div>
        )}
      </Show>
      <p class="text-xs text-muted-foreground leading-snug">
        Works once, until {EXPIRES.format(new Date(props.link.expiresAt))}, and{' '}
        {props.purpose === 'invite'
          ? 'lets them choose their own password.'
          : 'lets them choose a new password, which signs them out everywhere.'}
      </p>
      <p class="sr-only" aria-live="polite">
        {copied() ? 'Link copied' : ''}
      </p>
    </div>
  );
}

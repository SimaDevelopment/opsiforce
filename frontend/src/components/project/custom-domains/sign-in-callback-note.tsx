import { CopyButton } from '~/components/external-service-form/copy-button';

export function SignInCallbackNote(props: { callback: string }) {
  return (
    <div class="of-note of-tone-needs-you text-xs">
      <div class="min-w-0 flex-1 space-y-1">
        <p>
          This App signs visitors in with your identity provider. Register this sign-in callback there, or sign-in on
          this domain fails:
        </p>
        <div class="flex items-center gap-1">
          <span class="min-w-0 flex-1 break-all font-mono">{props.callback}</span>
          <CopyButton text={props.callback} label="Copy sign-in callback" />
        </div>
      </div>
    </div>
  );
}

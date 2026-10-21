import { Match, Show, Switch, createEffect, createSignal, createUniqueId, on, onCleanup, onMount } from 'solid-js';
import { toast } from 'solid-sonner';
import { ApiError } from '~/api/client';
import {
  useDisconnectLinkedAccount,
  useLinkedAccount,
  usePasteAccessToken,
  useStartSignIn,
  type ModelProviderScope,
  type ModelProviderStatus,
} from '~/api/model-providers';
import { ClipboardPaste, Copy, ExternalLink, LoaderCircle, LogIn, LogOut, RefreshCw } from '~/components/icons';
import { Button } from '~/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '~/components/ui/dialog';
import { DropdownMenuItem } from '~/components/ui/dropdown-menu';
import { INPUT_CLASS, errorMessage } from './connection-fields';
import { LinkedAccountUsage } from './linked-account-usage';
import { StatusBadge, Tip } from './provider-widgets';

const SECOND_MS = 1000;

const SIGNED_OUT_STATUSES: ReadonlySet<ModelProviderStatus> = new Set(['not-signed-in', 'needs-sign-in']);

const [pastingTokenFor, setPastingTokenFor] = createSignal<string | null>(null);

function accountKey(scope: ModelProviderScope, name: string): string {
  return `${scope}:${name}`;
}

const DISCONNECT_DESCRIPTION: Record<ModelProviderScope, string> = {
  tenant:
    'The sign-in is revoked at OpenAI and removed. This provider stops taking requests until someone signs in again; the format’s other providers that are on take over.',
  platform:
    'The sign-in is revoked at OpenAI and removed. This provider stops taking requests in every organization it serves until you sign in again. Updating every organization can take a few seconds.',
};

const CONNECTED_TIP: Record<ModelProviderScope, string> = {
  tenant: 'Requests to this provider use this ChatGPT account’s plan, for every Agent in this organization.',
  platform: 'Requests to this provider use this ChatGPT account’s plan, for every organization it serves.',
};

function withoutScheme(url: string): string {
  return url.replace(/^https?:\/\//, '');
}

function Countdown(props: { until: string }) {
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), SECOND_MS);
  onCleanup(() => clearInterval(timer));
  const secondsLeft = () => Math.max(0, Math.floor((Date.parse(props.until) - now()) / SECOND_MS));
  return (
    <span class="tabular-nums">
      {Math.floor(secondsLeft() / 60)}:{String(secondsLeft() % 60).padStart(2, '0')}
    </span>
  );
}

function CopyButton(props: { value: string; label: string }) {
  async function copy() {
    await navigator.clipboard.writeText(props.value);
    toast.success(`${props.label} copied`);
  }
  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      class="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
      aria-label={`Copy ${props.label.toLowerCase()}`}
      onClick={() => void copy()}
    >
      <Copy class="h-3 w-3" aria-hidden="true" />
    </Button>
  );
}

function DeviceCodePanel(props: { userCode: string; verificationUrl: string; expiresAt: string }) {
  return (
    <section
      aria-label="ChatGPT sign-in code"
      class="max-w-sm space-y-2 rounded-md border border-border bg-muted/40 p-2.5 text-xs"
    >
      <p class="font-medium text-foreground">Approve the sign-in at OpenAI</p>
      <ol class="space-y-1">
        <li class="flex min-w-0 items-center gap-1.5">
          <span class="w-3 shrink-0 text-muted-foreground">1.</span>
          <span class="shrink-0">Open</span>
          <a
            class="inline-flex min-w-0 items-center gap-1 rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            href={props.verificationUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span class="truncate" translate="no">
              {withoutScheme(props.verificationUrl)}
            </span>
            <ExternalLink class="h-3 w-3 shrink-0" aria-hidden="true" />
            <span class="sr-only">(opens in a new tab)</span>
          </a>
          <CopyButton value={props.verificationUrl} label="Link" />
        </li>
        <li class="flex items-center gap-1.5">
          <span class="w-3 shrink-0 text-muted-foreground">2.</span>
          <span>Enter</span>
          <code
            translate="no"
            class="rounded bg-background px-1.5 py-0.5 font-mono text-xs font-semibold tracking-wider text-foreground ring-1 ring-border"
          >
            {props.userCode}
          </code>
          <CopyButton value={props.userCode} label="Code" />
        </li>
      </ol>
      <p class="flex items-center gap-1.5 text-muted-foreground">
        <LoaderCircle class="h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        <span>
          Waiting for approval · expires in <Countdown until={props.expiresAt} />
        </span>
      </p>
    </section>
  );
}

function PasteAccessTokenForm(props: { scope: ModelProviderScope; name: string; onDone: () => void; quiet?: boolean }) {
  const [accessToken, setAccessToken] = createSignal('');
  const paste = usePasteAccessToken(props.scope);
  const inputId = createUniqueId();
  const hintId = createUniqueId();

  function submit(event: SubmitEvent) {
    event.preventDefault();
    paste.mutate(
      { name: props.name, accessToken: accessToken().trim() },
      {
        onSuccess: () => {
          if (!props.quiet) toast.success(`${props.name} connected`);
          props.onDone();
        },
      }
    );
  }

  return (
    <form class="max-w-sm space-y-1.5 rounded-md border border-border bg-muted/40 p-2.5 text-xs" onSubmit={submit}>
      <label for={inputId} class="block font-medium text-foreground">
        Codex access token
      </label>
      <input
        id={inputId}
        type="password"
        name="accessToken"
        class={INPUT_CLASS}
        placeholder="at-…"
        autocomplete="off"
        aria-describedby={hintId}
        value={accessToken()}
        onInput={(event) => setAccessToken(event.currentTarget.value)}
      />
      <p id={hintId} class="text-muted-foreground">
        A Codex access token from a Business or Enterprise workspace. It isn’t refreshed: paste a new one or sign in
        again when it expires.
      </p>
      <Show when={paste.error}>
        {(err) => (
          <p class="text-destructive" role="alert">
            {errorMessage(err(), 'The access token could not be checked')}
          </p>
        )}
      </Show>
      <div class="flex items-center gap-2">
        <Button type="submit" size="sm" class="h-7" loading={paste.isPending} disabled={accessToken().trim() === ''}>
          Connect
        </Button>
        <Button type="button" size="sm" variant="ghost" class="h-7" onClick={() => props.onDone()}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function useLinkedAccountActions(
  scope: ModelProviderScope,
  name: () => string,
  linked: () => boolean = () => true
) {
  const [disconnecting, setDisconnecting] = createSignal(false);
  const account = useLinkedAccount(scope, name, linked);
  const startSignIn = useStartSignIn(scope);
  const disconnect = useDisconnectLinkedAccount(scope);

  return {
    connected: () => linked() && account.data?.state === 'connected',
    signingIn: () => account.data?.signIn?.state === 'pending',
    busy: () => startSignIn.isPending || disconnect.isPending,
    disconnectPending: () => disconnect.isPending,
    disconnecting,
    setDisconnecting,
    signIn: () => {
      setPastingTokenFor(null);
      startSignIn.mutate(name(), {
        onError: (err) => toast.error(err instanceof ApiError ? err.message : 'The sign-in could not be started'),
      });
    },
    pasteToken: () => setPastingTokenFor(accountKey(scope, name())),
    disconnect: () =>
      disconnect.mutate(name(), {
        onSuccess: () => {
          setDisconnecting(false);
          toast.success(`${name()} disconnected`);
        },
        onError: (err) => toast.error(err instanceof ApiError ? err.message : `${name()} could not be disconnected`),
      }),
  };
}

export type LinkedAccountActions = ReturnType<typeof useLinkedAccountActions>;

export function LinkedAccountMenuItems(props: { actions: LinkedAccountActions; linked?: boolean }) {
  return (
    <Show
      when={props.actions.connected()}
      fallback={
        <Show when={props.linked !== false && !props.actions.signingIn()}>
          <DropdownMenuItem onSelect={() => props.actions.signIn()}>
            <LogIn class="h-3.5 w-3.5" />
            Sign in with ChatGPT
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => props.actions.pasteToken()}>
            <ClipboardPaste class="h-3.5 w-3.5" />
            Paste access token
          </DropdownMenuItem>
        </Show>
      }
    >
      <DropdownMenuItem onSelect={() => props.actions.signIn()}>
        <RefreshCw class="h-3.5 w-3.5" />
        Sign in again
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => props.actions.setDisconnecting(true)}>
        <LogOut class="h-3.5 w-3.5" />
        Disconnect
      </DropdownMenuItem>
    </Show>
  );
}

export function LinkedAccountStatus(props: {
  scope: ModelProviderScope;
  name: string;
  status: ModelProviderStatus;
  editable: boolean;
}) {
  const actions = useLinkedAccountActions(props.scope, () => props.name);
  const offersSignIn = () => props.editable && SIGNED_OUT_STATUSES.has(props.status) && !actions.signingIn();
  return (
    <div class="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <StatusBadge status={props.status} />
      <Show when={offersSignIn()}>
        <Button
          size="sm"
          variant="link"
          class="h-5 px-0 text-xs font-medium underline decoration-muted-foreground/40 underline-offset-4 hover:decoration-foreground"
          loading={actions.busy()}
          aria-label={`Sign in ${props.name} with ChatGPT`}
          onClick={() => actions.signIn()}
        >
          {props.status === 'needs-sign-in' ? 'Sign in again' : 'Sign in'}
        </Button>
      </Show>
    </div>
  );
}

export function DisconnectDialog(props: { scope: ModelProviderScope; name: string; actions: LinkedAccountActions }) {
  return (
    <Dialog
      open={props.actions.disconnecting()}
      onOpenChange={(open) => !props.actions.disconnectPending() && props.actions.setDisconnecting(open)}
    >
      <DialogContent class="max-w-sm">
        <DialogTitle>Disconnect {props.name}</DialogTitle>
        <DialogDescription>{DISCONNECT_DESCRIPTION[props.scope]}</DialogDescription>
        <DialogFooter>
          <Button
            size="sm"
            variant="outline"
            disabled={props.actions.disconnectPending()}
            onClick={() => props.actions.setDisconnecting(false)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            variant="destructive"
            loading={props.actions.disconnectPending()}
            onClick={() => props.actions.disconnect()}
          >
            Disconnect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function LinkedAccountSignIn(props: {
  scope: ModelProviderScope;
  name: string;
  editable: boolean;
  linked: boolean;
}) {
  const account = useLinkedAccount(props.scope, () => props.name);
  const pasting = () => props.editable && pastingTokenFor() === accountKey(props.scope, props.name);
  const pending = () => {
    const signIn = account.data?.signIn;
    return signIn?.state === 'pending' ? signIn : null;
  };
  const failure = () => {
    const signIn = account.data?.signIn;
    return signIn?.state === 'failed' ? signIn.message : null;
  };
  const expired = () => account.data?.signIn?.state === 'expired';
  const connected = () => props.linked && account.data?.state === 'connected';
  const endedReason = () => (account.data?.state === 'needs-sign-in' ? account.data.reason : null);

  return (
    <Show when={account.data}>
      {(data) => (
        <div class="space-y-1.5 text-xs">
          <Switch>
            <Match when={pending()}>
              {(signIn) => (
                <DeviceCodePanel
                  userCode={signIn().userCode}
                  verificationUrl={signIn().verificationUrl}
                  expiresAt={signIn().expiresAt}
                />
              )}
            </Match>
            <Match when={connected()}>
              <Show when={data().signedInAs}>
                {(signedInAs) => (
                  <Tip content={CONNECTED_TIP[props.scope]} class="text-muted-foreground">
                    Signed in as
                    <span class="ml-1 min-w-0 break-all text-foreground" translate="no">
                      {signedInAs()}
                    </span>
                  </Tip>
                )}
              </Show>
              <LinkedAccountUsage scope={props.scope} name={props.name} />
            </Match>
            <Match when={true}>
              <Show when={endedReason()}>
                {(reason) => (
                  <p class="text-destructive" role="alert">
                    OpenAI ended the sign-in: {reason()}
                  </p>
                )}
              </Show>
              <Show when={expired()}>
                <output class="block text-muted-foreground">
                  The last sign-in code expired before it was approved.
                </output>
              </Show>
              <Show when={failure()}>
                {(message) => (
                  <p class="text-destructive" role="alert">
                    {message()}
                  </p>
                )}
              </Show>
              <Show when={pasting()}>
                <PasteAccessTokenForm scope={props.scope} name={props.name} onDone={() => setPastingTokenFor(null)} />
              </Show>
            </Match>
          </Switch>
        </div>
      )}
    </Show>
  );
}

export function LinkedAccountSignInStep(props: { scope: ModelProviderScope; name: string; onClose: () => void }) {
  const account = useLinkedAccount(props.scope, () => props.name);
  const actions = useLinkedAccountActions(props.scope, () => props.name);
  const [pasting, setPasting] = createSignal(false);
  const pending = () => {
    const signIn = account.data?.signIn;
    return signIn?.state === 'pending' ? signIn : null;
  };
  const failure = () => {
    const signIn = account.data?.signIn;
    return signIn?.state === 'failed' ? signIn.message : null;
  };
  const connected = () => account.data?.state === 'connected';
  const startingCode = () => actions.busy() || account.isPending;

  onMount(() => actions.signIn());

  createEffect(
    on(
      connected,
      (isConnected) => {
        if (!isConnected) return;
        const signedInAs = account.data?.signedInAs;
        toast.success(signedInAs ? `${props.name} is signed in as ${signedInAs}` : `${props.name} is signed in`);
        props.onClose();
      },
      { defer: true }
    )
  );

  return (
    <>
      <DialogTitle>Sign in {props.name} with ChatGPT</DialogTitle>
      <DialogDescription>
        <span translate="no">{props.name}</span> is added. It takes requests once a ChatGPT account is signed in.
      </DialogDescription>
      <div class="mt-4 space-y-3 text-xs" aria-live="polite">
        <Switch>
          <Match when={pasting()}>
            <PasteAccessTokenForm scope={props.scope} name={props.name} quiet onDone={() => setPasting(false)} />
          </Match>
          <Match when={pending()}>
            {(signIn) => (
              <DeviceCodePanel
                userCode={signIn().userCode}
                verificationUrl={signIn().verificationUrl}
                expiresAt={signIn().expiresAt}
              />
            )}
          </Match>
          <Match when={startingCode()}>
            <output class="flex items-center gap-1.5 text-muted-foreground">
              <LoaderCircle class="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              Getting a sign-in code…
            </output>
          </Match>
          <Match when={true}>
            <div class="space-y-2">
              <p
                class={failure() ? 'text-destructive' : 'text-muted-foreground'}
                role={failure() ? 'alert' : undefined}
              >
                {failure() ?? 'The sign-in code expired before it was approved.'}
              </p>
              <Button size="sm" variant="outline" class="h-7" onClick={() => actions.signIn()}>
                <RefreshCw class="h-3 w-3" aria-hidden="true" />
                Get a new code
              </Button>
            </div>
          </Match>
        </Switch>
        <Show when={!pasting()}>
          <Button
            size="sm"
            variant="link"
            class="h-5 px-0 text-xs text-muted-foreground"
            onClick={() => setPasting(true)}
          >
            <ClipboardPaste class="h-3 w-3" aria-hidden="true" />
            Use a Codex access token instead
          </Button>
        </Show>
      </div>
      <div class="mt-4 flex items-center justify-end gap-2">
        <span class="mr-auto text-xs text-muted-foreground">You can also sign in later from its row.</span>
        <Button size="sm" variant="outline" onClick={() => props.onClose()}>
          Finish later
        </Button>
      </div>
    </>
  );
}

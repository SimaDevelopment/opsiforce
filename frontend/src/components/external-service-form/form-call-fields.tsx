import { Match, Show, Switch, createSignal, onMount } from 'solid-js';
import type { Field } from '@opsiforce/external-service-sdk/forms';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import { ExternalLink, LoaderCircle, RefreshCw } from '~/components/icons';
import { cn } from '~/lib/cn';
import type { ButtonResult, FormContext, InfoResult, MessageLevel } from './form-context';
import { formCallFailure } from './form-labels';
import { HelpText } from './help-text';

type InfoFieldDefinition = Extract<Field, { type: 'info' }>;
type ButtonFieldDefinition = Extract<Field, { type: 'button' }>;

const SHOWN_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function badgeVariant(level: MessageLevel | undefined) {
  if (level === 'success') return 'success';
  if (level === 'warning') return 'warning';
  if (level === 'error') return 'destructive';
  return 'info';
}

function messageClass(level: MessageLevel | undefined): string {
  if (level === 'error') return 'text-destructive';
  if (level === 'warning') return 'text-amber-700';
  if (level === 'success') return 'text-emerald-700';
  return 'text-muted-foreground';
}

function isHttpLink(link: string): boolean {
  return /^https?:\/\//i.test(link);
}

function itemRequest(itemId: string | undefined) {
  return itemId === undefined ? {} : { item: itemId };
}

export function CallInfo(props: {
  id: string;
  field: InfoFieldDefinition;
  call: string;
  itemId?: string;
  ctx: FormContext;
}) {
  const [result, setResult] = createSignal<InfoResult | null>(null);
  const [failure, setFailure] = createSignal<string | null>(null);
  const [asking, setAsking] = createSignal(false);

  const ask = async () => {
    const callService = props.ctx.callService;
    if (!callService) return;
    setAsking(true);
    setFailure(null);
    try {
      setResult((await callService('info', props.call, itemRequest(props.itemId))) as InfoResult);
    } catch (error) {
      setResult(null);
      setFailure(formCallFailure(error));
    } finally {
      setAsking(false);
    }
  };

  onMount(() => void ask());

  return (
    <div class="flex flex-col gap-1">
      <Show when={props.field.label}>
        <span id={props.id} class="text-xs text-muted-foreground">
          {props.field.label}
        </span>
      </Show>
      <Show
        when={props.ctx.callService}
        fallback={<span class="text-[11px] text-muted-foreground">Shown live to people who can change this.</span>}
      >
        <div
          class="flex min-h-6 items-center gap-1.5"
          aria-live="polite"
          aria-labelledby={props.field.label ? props.id : undefined}
        >
          <Switch>
            <Match when={asking()}>
              <span class="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <LoaderCircle class="h-3 w-3 animate-spin" aria-hidden="true" /> Asking the service…
              </span>
            </Match>
            <Match when={failure()}>
              {(message) => (
                <Badge variant="destructive" class="w-fit px-1.5 py-0 text-[10px] font-medium">
                  {message()}
                </Badge>
              )}
            </Match>
            <Match when={result()}>
              {(answer) => (
                <Badge variant={badgeVariant(answer().level)} class="w-fit px-1.5 py-0 text-[10px] font-medium">
                  {answer().text}
                </Badge>
              )}
            </Match>
          </Switch>
          <Show when={!asking()}>
            <button
              type="button"
              class="rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
              aria-label={`Ask again${props.field.label ? `: ${props.field.label}` : ''}`}
              onClick={() => void ask()}
            >
              <RefreshCw class="h-3 w-3" aria-hidden="true" />
            </button>
          </Show>
        </div>
      </Show>
      <Show when={props.field.help}>{(help) => <HelpText text={help()} />}</Show>
    </div>
  );
}

export function CallButton(props: { field: ButtonFieldDefinition; itemId?: string; ctx: FormContext }) {
  const [running, setRunning] = createSignal(false);
  const [confirming, setConfirming] = createSignal(false);
  const [result, setResult] = createSignal<ButtonResult | null>(null);
  const [failure, setFailure] = createSignal<string | null>(null);

  const run = async () => {
    const callService = props.ctx.callService;
    if (!callService) return;
    setRunning(true);
    setResult(null);
    setFailure(null);
    try {
      setResult((await callService('buttons', props.field.call, itemRequest(props.itemId))) as ButtonResult);
    } catch (error) {
      setFailure(formCallFailure(error));
    } finally {
      setRunning(false);
    }
  };

  const confirmText = () => {
    const confirm = props.field.confirm;
    if (confirm === undefined || confirm === false) return null;
    return confirm === true ? `Run "${props.field.label}"?` : confirm;
  };

  const press = () => {
    if (confirmText() === null) void run();
    else setConfirming(true);
  };

  return (
    <div class="flex flex-col gap-1.5">
      <Button
        type="button"
        variant="outline"
        size="sm"
        class="h-7 w-fit text-xs"
        loading={running()}
        disabled={props.ctx.readOnly() || !props.ctx.callService}
        onClick={press}
      >
        {props.field.label}
      </Button>
      <Show when={failure()}>
        {(message) => (
          <span class="text-[11px] text-destructive" role="alert">
            {message()}
          </span>
        )}
      </Show>
      <Show when={result()}>{(answer) => <ButtonAnswer result={answer()} />}</Show>
      <Show when={props.field.help}>{(help) => <HelpText text={help()} />}</Show>
      <ConfirmDialog
        open={confirming()}
        onOpenChange={setConfirming}
        title={props.field.label}
        description={confirmText() ?? undefined}
        confirmLabel={props.field.label}
        onConfirm={() => void run()}
      />
    </div>
  );
}

function ButtonAnswer(props: { result: ButtonResult }) {
  return (
    <div role="status" class="flex flex-col gap-1.5">
      <Switch>
        <Match when={'message' in props.result && props.result}>
          {(answer) => <span class={cn('text-[11px]', messageClass(answer().level))}>{answer().message}</span>}
        </Match>
        <Match when={'image' in props.result && props.result}>
          {(answer) => (
            <figure class="flex flex-col gap-1">
              <Show
                when={SHOWN_IMAGE_TYPES.has(answer().image.mimeType)}
                fallback={
                  <span class="text-[11px] text-muted-foreground">
                    The service answered an image this page can't show.
                  </span>
                }
              >
                <img
                  src={`data:${answer().image.mimeType};base64,${answer().image.base64}`}
                  alt={answer().caption ?? 'Image from the service'}
                  class="w-40 rounded-md border border-border bg-white p-1"
                />
              </Show>
              <Show when={answer().caption}>
                <figcaption class="text-[11px] text-muted-foreground">{answer().caption}</figcaption>
              </Show>
            </figure>
          )}
        </Match>
        <Match when={'link' in props.result && props.result}>
          {(answer) => (
            <Show
              when={isHttpLink(answer().link)}
              fallback={<span class="text-[11px] text-muted-foreground">{answer().link}</span>}
            >
              <a
                href={answer().link}
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex w-fit items-center gap-1 text-[11px] text-foreground underline underline-offset-2"
              >
                {answer().label ?? answer().link}
                <ExternalLink class="h-3 w-3" aria-hidden="true" />
              </a>
            </Show>
          )}
        </Match>
      </Switch>
    </div>
  );
}

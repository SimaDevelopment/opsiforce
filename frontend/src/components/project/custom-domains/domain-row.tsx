import { Show, createSignal } from 'solid-js';
import { toast } from '~/lib/toast';
import {
  useCheckCustomDomain,
  useSetCustomDomainRedirect,
  type CustomDomain,
  type EnvironmentRef,
} from '~/api/custom-domains';
import { ActionsMenu, ActionsMenuCheckItem, ActionsMenuItem } from '~/components/actions-menu';
import { ICON_BUTTON_CLASS } from '~/components/external-service-form/form-styles';
import { ArrowRight, ChevronDown, ChevronRight, Copy, LoaderCircle, RefreshCw, Star, Trash2 } from '~/components/icons';
import { Tooltip, TooltipContent, TooltipTrigger } from '~/components/ui/tooltip';
import { cn } from '~/lib/cn';
import { checkedAgo, lastCheckedLine } from './checked-ago';
import { DnsRecords } from './dns-records';
import { DomainChecklist } from './domain-checklist';
import { DOMAIN_STATUS } from './domain-status';
import { SignInCallbackNote } from './sign-in-callback-note';

export function DomainRow(props: {
  environment: EnvironmentRef;
  domain: CustomDomain;
  mainDomain: CustomDomain | undefined;
  canManage: boolean;
  now: number;
  onMakeMain: () => void;
  onRemove: () => void;
}) {
  const checkDomain = useCheckCustomDomain();
  const setRedirect = useSetCustomDomainRedirect();
  const [openedByHand, setOpenedByHand] = createSignal<boolean | null>(null);
  const isOpen = () => openedByHand() ?? props.domain.status !== 'connected';
  const checking = () => checkDomain.isPending;
  const status = () => DOMAIN_STATUS[props.domain.status];
  const address = () => `https://${props.domain.displayHostname}/`;
  const checkedTooltip = () => {
    const ago = checkedAgo(props.domain.checkedAt, props.now);
    return ago === null ? 'Check now · not checked yet' : `Check now · last checked ${ago}`;
  };

  const copyAddress = () => {
    void navigator.clipboard?.writeText(address());
    toast.success('Copied');
  };

  const redirected = () => props.mainDomain !== undefined && !props.domain.isMain && props.domain.redirectsToMain;

  const setRedirectToMain = (redirectsToMain: boolean) =>
    setRedirect.mutate(
      { ...props.environment, domainId: props.domain.id, redirectsToMain },
      {
        onError: (err) =>
          toast.error(err instanceof Error ? err.message : `Failed to change ${props.domain.displayHostname}`),
      }
    );

  const check = () =>
    checkDomain.mutate(
      { ...props.environment, domainId: props.domain.id },
      {
        onError: (err) =>
          toast.error(err instanceof Error ? err.message : `Failed to check ${props.domain.displayHostname}`),
      }
    );

  return (
    <div class="rounded-md border border-border bg-background">
      <div class="flex flex-wrap items-center gap-x-1.5 gap-y-1 p-2.5">
        <button
          type="button"
          class="-m-1 flex min-w-40 flex-1 items-center gap-1.5 rounded p-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-expanded={isOpen()}
          onClick={() => setOpenedByHand(!isOpen())}
        >
          <Show
            when={isOpen()}
            fallback={<ChevronRight class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
          >
            <ChevronDown class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          </Show>
          <span
            class="truncate font-mono text-xs font-medium text-foreground"
            title={props.domain.displayHostname}
            translate="no"
          >
            {props.domain.displayHostname}
          </span>
          <Show when={props.domain.bare}>
            <span class="shrink-0 text-xs text-muted-foreground">+ www</span>
          </Show>
          <Show when={props.domain.isMain}>
            <span
              class="inline-flex shrink-0 items-center rounded bg-muted px-1.5 py-0.5 text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground"
              title="The Main domain is the App's Public URL."
            >
              Main
            </span>
          </Show>
        </button>
        <div class="ml-auto flex shrink-0 items-center gap-1.5">
          <span
            class={cn('of-note of-note-sm shrink-0 whitespace-nowrap', status().tone)}
            title={status().hint}
            aria-live="polite"
          >
            <Show when={checking() || props.domain.status === 'issuing'}>
              <LoaderCircle class="h-3 w-3 motion-safe:animate-spin" aria-hidden="true" />
            </Show>
            {checking() ? 'Checking…' : status().label}
          </span>
          <Show when={props.canManage}>
            <Tooltip>
              <TooltipTrigger
                class={ICON_BUTTON_CLASS}
                aria-label={`Check ${props.domain.displayHostname}`}
                disabled={checking()}
                onClick={check}
              >
                <RefreshCw class={cn('h-3.5 w-3.5', checking() && 'motion-safe:animate-spin')} aria-hidden="true" />
              </TooltipTrigger>
              <TooltipContent>{checkedTooltip()}</TooltipContent>
            </Tooltip>
          </Show>
          <ActionsMenu label={`Actions for ${props.domain.displayHostname}`} triggerClass={ICON_BUTTON_CLASS}>
            <ActionsMenuItem icon={Copy} onSelect={copyAddress}>
              Copy address
            </ActionsMenuItem>
            <Show when={props.canManage && props.domain.status === 'connected' && !props.domain.isMain}>
              <ActionsMenuItem icon={Star} onSelect={() => props.onMakeMain()}>
                Make main
              </ActionsMenuItem>
            </Show>
            <Show when={props.canManage && props.mainDomain !== undefined && !props.domain.isMain}>
              <ActionsMenuCheckItem
                icon={ArrowRight}
                checked={props.domain.redirectsToMain}
                onChange={(redirectsToMain) => setRedirectToMain(redirectsToMain)}
              >
                Redirect to Main domain
              </ActionsMenuCheckItem>
            </Show>
            <Show when={props.canManage}>
              <ActionsMenuItem icon={Trash2} destructive onSelect={() => props.onRemove()}>
                Remove
              </ActionsMenuItem>
            </Show>
          </ActionsMenu>
        </div>
      </div>
      <Show when={isOpen()}>
        <div class="space-y-2.5 border-t border-border p-2.5">
          <Show
            when={props.domain.status !== 'connected'}
            fallback={
              <>
                <Show
                  when={props.domain.isMain}
                  fallback={
                    <Show
                      when={redirected() && props.mainDomain}
                      fallback={<p class="text-xs text-muted-foreground">{status().hint}</p>}
                    >
                      {(main) => (
                        <p class="text-xs text-muted-foreground">
                          Visitors are sent on to <span translate="no">{main().displayHostname}</span>, the Main domain.
                        </p>
                      )}
                    </Show>
                  }
                >
                  <p class="text-xs text-muted-foreground">Served here over https. This is the App's Public URL.</p>
                </Show>
                <DnsRecords records={props.domain.records} />
                <p class="text-xs text-muted-foreground">{lastCheckedLine(props.domain.checkedAt, props.now)}</p>
                <Show when={!redirected() && props.domain.signInCallback}>
                  {(callback) => <SignInCallbackNote callback={callback()} />}
                </Show>
              </>
            }
          >
            <DomainChecklist
              domain={props.domain}
              canManage={props.canManage}
              checking={checking()}
              now={props.now}
              onCheck={check}
            />
          </Show>
        </div>
      </Show>
    </div>
  );
}

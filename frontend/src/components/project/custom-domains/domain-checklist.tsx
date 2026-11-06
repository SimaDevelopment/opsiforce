import { Show, type JSX } from 'solid-js';
import type { CustomDomain } from '~/api/custom-domains';
import { RefreshCw } from '~/components/icons';
import { StepMarker, type StepState } from '~/components/project/step-progress';
import { Button } from '~/components/ui/button';
import { cn } from '~/lib/cn';
import { lastCheckedLine } from './checked-ago';
import { DnsRecords } from './dns-records';

function dnsStage(domain: CustomDomain, checking: boolean): StepState {
  if (domain.status === 'issuing' || domain.status === 'connected' || domain.status === 'failed') return 'done';
  return checking ? 'active' : 'pending';
}

function certificateStage(domain: CustomDomain): StepState {
  if (domain.status === 'connected') return 'done';
  if (domain.status === 'issuing') return 'active';
  if (domain.status === 'failed') return 'failed';
  return 'pending';
}

function Stage(props: { state: StepState; title: JSX.Element; children?: JSX.Element }) {
  return (
    <li class="flex gap-2.5">
      <StepMarker state={props.state} />
      <div class="min-w-0 flex-1 space-y-1.5">
        <p
          class={cn(
            'text-xs font-medium leading-5',
            props.state === 'pending' ? 'text-muted-foreground' : 'text-foreground'
          )}
        >
          {props.title}
        </p>
        {props.children}
      </div>
    </li>
  );
}

function CheckButton(props: { label: string; checking: boolean; onCheck: () => void }) {
  return (
    <Button size="sm" variant="outline" class="h-7 shrink-0" disabled={props.checking} onClick={props.onCheck}>
      <RefreshCw class={cn('h-3.5 w-3.5', props.checking && 'motion-safe:animate-spin')} aria-hidden="true" />
      {props.label}
    </Button>
  );
}

export function DomainChecklist(props: {
  domain: CustomDomain;
  canManage: boolean;
  checking: boolean;
  now: number;
  onCheck: () => void;
}) {
  const dns = () => dnsStage(props.domain, props.checking);
  const recordsTitle = () =>
    props.domain.bare ? 'Add these records at your DNS provider' : 'Add this record at your DNS provider';

  return (
    <ol class="space-y-3">
      <Stage state={dns()} title={dns() === 'done' ? 'DNS points at this App' : recordsTitle()}>
        <Show when={dns() !== 'done'}>
          <DnsRecords records={props.domain.records} />
          <Show when={props.domain.bare}>
            <p class="text-xs text-muted-foreground">
              No ALIAS record at your DNS provider? Remove this domain, add{' '}
              <span translate="no">www.{props.domain.displayHostname}</span> instead, and forward{' '}
              <span translate="no">{props.domain.displayHostname}</span> to it with your provider’s URL redirect.
            </p>
          </Show>
          <p class="text-xs text-muted-foreground">
            DNS answers now:{' '}
            <span class="break-all font-mono text-foreground">
              {props.domain.dnsAnswer ?? 'no record for this name yet'}
            </span>
          </p>
          <div class="flex items-center gap-2">
            <Show when={props.canManage}>
              <CheckButton label="Check" checking={props.checking} onCheck={props.onCheck} />
            </Show>
            <p class="min-w-0 text-xs text-muted-foreground">
              {lastCheckedLine(props.domain.checkedAt, props.now)} Press Check after you add the record. DNS changes can
              take from minutes to a few hours.
            </p>
          </div>
        </Show>
      </Stage>
      <Stage state={certificateStage(props.domain)} title="Certificate for https">
        <Show when={props.domain.status === 'issuing'}>
          <p class="text-xs text-muted-foreground">
            Usually takes a minute. The domain starts working as soon as the certificate is ready.
            <Show when={props.canManage}> This updates on its own while this window is open.</Show>
          </p>
        </Show>
        <Show when={props.domain.status === 'failed'}>
          <p class="of-note of-tone-failed break-words text-xs">
            Usually the record points somewhere else, a proxy in front of the domain is on, or something blocks port 80.
            Fix that, then Try again.
          </p>
          <Show when={props.canManage}>
            <CheckButton label="Try again" checking={props.checking} onCheck={props.onCheck} />
          </Show>
          <Show when={props.domain.failureReason}>
            {(reason) => (
              <p class="break-words text-[0.6875rem] text-muted-foreground">
                <span class="font-medium">Details:</span> {reason()}
              </p>
            )}
          </Show>
        </Show>
      </Stage>
      <Stage
        state="pending"
        title={
          <>
            Serving at <span translate="no">https://{props.domain.displayHostname}/</span>
          </>
        }
      />
    </ol>
  );
}

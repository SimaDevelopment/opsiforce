import { For, Show, createMemo, createSignal, type JSX } from 'solid-js';
import { Pager, createOffsetPages } from '~/components/pager';
import type { Field } from '@opsiforce/external-service-sdk/forms';
import type {
  CheckReport,
  ConfigurationImpact,
  ManifestChange,
  ManifestDiff,
  NamedEnvironment,
  SchemaInput,
  ServiceConfigurationReview,
  TestReport,
} from '~/api/external-service-publishing';
import type { ConfigurationIssue, ConfigurationValues } from '~/api/external-service-views';
import type { FormContext, ServiceCaller } from '~/components/external-service-form/form-context';
import { createFormDraft, type FormDraft } from '~/components/external-service-form/form-draft';
import { createLabelBook } from '~/components/external-service-form/form-labels';
import { ServiceFormFields } from '~/components/external-service-form/form-renderer';
import { validateFormValues, withDefaults } from '~/components/external-service-form/form-values';
import { AlertTriangle, Check, Info, X } from '~/components/icons';
import { ChangeMark, KindPill, usedByLabel } from './service-marks';

const SHORT_COMMIT = 7;

function ReviewSection(props: { title: string; children: JSX.Element }) {
  return (
    <section class="flex flex-col gap-2 p-3">
      <h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{props.title}</h3>
      {props.children}
    </section>
  );
}

function Note(props: { tone: 'warning' | 'info' | 'error'; children: JSX.Element }) {
  const tones = {
    warning: 'border-amber-500/40 bg-amber-500/10',
    info: 'border-border bg-muted/40',
    error: 'border-destructive/40 bg-destructive/10',
  } as const;
  return (
    <div class={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${tones[props.tone]}`}>
      <Show
        when={props.tone === 'info'}
        fallback={<AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" aria-hidden="true" />}
      >
        <Info class="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      </Show>
      <div class="min-w-0 flex-1">{props.children}</div>
    </div>
  );
}

function InputList(props: { inputs: SchemaInput[] }) {
  return (
    <div class="flex flex-wrap gap-1">
      <For each={props.inputs}>
        {(input) => (
          <span
            class={`rounded px-1.5 py-px font-mono text-[10px] ${input.bound ? 'bg-emerald-50 text-emerald-700' : 'bg-muted text-muted-foreground'}`}
            title={
              input.bound
                ? `Checked against the "${input.bound}" bound`
                : 'Any value the caller sends reaches the service'
            }
          >
            {input.pointer}
            {input.bound ? ` → ${input.bound}` : ' · unbound'}
          </span>
        )}
      </For>
    </div>
  );
}

function CheckChange(props: {
  change: ManifestChange | undefined;
  aspects: ManifestDiff['events'][number]['aspects'];
}) {
  return (
    <Show when={props.change}>
      {(change) => (
        <Show
          when={change() !== 'unchanged'}
          fallback={<span class="text-[11px] text-muted-foreground">Unchanged</span>}
        >
          <ChangeMark change={change()} aspects={props.aspects} />
        </Show>
      )}
    </Show>
  );
}

export function CheckSection(props: {
  check: CheckReport;
  changes?: ManifestDiff | null;
  impact?: ConfigurationImpact | null;
}) {
  const operationChange = (name: string) => props.changes?.operations.find((entry) => entry.name === name);
  const eventChange = (type: string) => props.changes?.events.find((entry) => entry.type === type);
  const removedOperations = () => (props.changes?.operations ?? []).filter((entry) => entry.change === 'removed');
  const removedEvents = () => (props.changes?.events ?? []).filter((entry) => entry.change === 'removed');
  const usedBy = (operation: string) =>
    props.impact?.removedOperations.find((entry) => entry.operation === operation)?.configurations ?? 0;
  const errors = () => props.check.problems.filter((problem) => problem.severity === 'error');
  const warnings = () => props.check.problems.filter((problem) => problem.severity === 'warning');
  return (
    <ReviewSection title="Check">
      <Show when={errors().length > 0}>
        <Note tone="error">
          <p class="mb-1 font-medium">service.json does not pass check, so it cannot go live.</p>
          <ul class="list-disc pl-4">
            <For each={errors()}>
              {(problem) => (
                <li>
                  <span class="font-mono">{problem.path}</span>: {problem.message}
                </li>
              )}
            </For>
          </ul>
        </Note>
      </Show>
      <For each={warnings()}>
        {(problem) => (
          <Note tone="warning">
            <span class="font-mono">{problem.path}</span>: {problem.message}
          </Note>
        )}
      </For>
      <Show when={props.check.operations.length + removedOperations().length > 0}>
        <ul class="flex flex-col divide-y divide-border rounded-md border border-border">
          <For each={props.check.operations}>
            {(operation) => (
              <li class="flex flex-col gap-1 px-3 py-2">
                <div class="flex items-center gap-2">
                  <span class="font-mono text-xs">{operation.name}</span>
                  <KindPill kind={operation.kind} />
                  <span class="flex-1" />
                  <CheckChange
                    change={operationChange(operation.name)?.change}
                    aspects={operationChange(operation.name)?.aspects ?? []}
                  />
                </div>
                <InputList inputs={operation.inputs} />
              </li>
            )}
          </For>
          <For each={removedOperations()}>
            {(operation) => (
              <li class="flex items-center gap-2 px-3 py-2">
                <span class="font-mono text-xs text-muted-foreground line-through">{operation.name}</span>
                <span class="opacity-60">
                  <KindPill kind={operation.kind} />
                </span>
                <span class="flex-1" />
                <Show when={usedBy(operation.name) > 0}>
                  <span class="text-[11px] text-amber-700">{usedByLabel(usedBy(operation.name))}</span>
                </Show>
                <ChangeMark change="removed" aspects={[]} />
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={props.check.events.length + removedEvents().length > 0}>
        <ul class="flex flex-col divide-y divide-border rounded-md border border-border">
          <For each={props.check.events}>
            {(event) => (
              <li class="flex flex-col gap-1 px-3 py-2">
                <div class="flex items-center gap-2">
                  <span class="text-xs">
                    <span class="font-mono">{event.type}</span>
                    <span class="text-muted-foreground"> · Event</span>
                  </span>
                  <span class="flex-1" />
                  <CheckChange
                    change={eventChange(event.type)?.change}
                    aspects={eventChange(event.type)?.aspects ?? []}
                  />
                </div>
                <InputList inputs={event.inputs} />
              </li>
            )}
          </For>
          <For each={removedEvents()}>
            {(event) => (
              <li class="flex items-center gap-2 px-3 py-2 text-xs">
                <span class="font-mono text-muted-foreground line-through">{event.type}</span>
                <span class="text-muted-foreground"> · Event</span>
                <span class="flex-1" />
                <ChangeMark change="removed" aspects={[]} />
              </li>
            )}
          </For>
        </ul>
      </Show>
    </ReviewSection>
  );
}

function configurationsLabel(count: number): string {
  return count === 1 ? '1 Project configuration' : `${count} Project configurations`;
}

export function ImpactSection(props: { impact: ConfigurationImpact | null; callersStayOn: NamedEnvironment | null }) {
  const consumerPages = createOffsetPages(() => props.impact?.consumers ?? []);
  return (
    <ReviewSection title="Impact on Project configurations">
      <Show
        when={props.impact}
        fallback={
          <Note tone="info">
            Callers keep reaching {props.callersStayOn?.name ?? 'the Default environment'}. This version reaches them
            only after you make this environment the Default environment.
          </Note>
        }
      >
        {(impact) => (
          <Show
            when={impact().configurations > 0}
            fallback={<p class="text-xs text-muted-foreground">No Project configures this service yet.</p>}
          >
            <p class="text-xs">{configurationsLabel(impact().configurations)} use this service.</p>
            <Show
              when={impact().consumers.length > 0}
              fallback={<p class="text-xs text-muted-foreground">None of them changes.</p>}
            >
              <ul class="flex list-disc flex-col gap-0.5 pl-4 text-xs">
                <For each={impact().renamed}>
                  {(rename) => (
                    <li>
                      <span class="font-mono">{rename.from}</span> → <span class="font-mono">{rename.to}</span> in{' '}
                      {configurationsLabel(rename.configurations)}
                    </li>
                  )}
                </For>
                <For each={impact().needsAttention}>
                  {(entry) => (
                    <li class="text-amber-800">
                      Needs attention in {configurationsLabel(entry.configurations)}:{' '}
                      <span class="font-mono">{entry.field}</span>. Their calls answer "configuration incomplete" until
                      someone saves them again.
                    </li>
                  )}
                </For>
                <For each={impact().newOperationsOff}>
                  {(entry) => (
                    <li>
                      <span class="font-mono">{entry.operation}</span> is new and stays off in{' '}
                      {configurationsLabel(entry.configurations)}
                    </li>
                  )}
                </For>
                <For each={impact().removedOperations}>
                  {(entry) => (
                    <li>
                      <span class="font-mono">{entry.operation}</span> is gone, though it is switched on in{' '}
                      {configurationsLabel(entry.configurations)}
                    </li>
                  )}
                </For>
              </ul>
              <details class="text-xs">
                <summary class="cursor-pointer text-muted-foreground">Affected Projects</summary>
                <ul class="mt-1 flex flex-col gap-0.5 pl-4">
                  <For each={consumerPages.page()}>
                    {(consumer) => (
                      <li>
                        {consumer.projectTitle ?? consumer.projectId}
                        <span class="text-muted-foreground"> · {consumer.environmentName ?? 'Development'}</span>
                      </li>
                    )}
                  </For>
                </ul>
                <Show when={consumerPages.needsPager()}>
                  <Pager {...consumerPages.pagerProps()} />
                </Show>
              </details>
            </Show>
          </Show>
        )}
      </Show>
    </ReviewSection>
  );
}

function ResultMark(props: { result: 'pass' | 'fail' | 'not-checked' }) {
  return (
    <Show
      when={props.result === 'pass'}
      fallback={
        <Show
          when={props.result === 'fail'}
          fallback={<span class="w-3.5 shrink-0 text-center text-muted-foreground">–</span>}
        >
          <X class="h-3.5 w-3.5 shrink-0 text-destructive" aria-label="failed" />
        </Show>
      }
    >
      <Check class="h-3.5 w-3.5 shrink-0 text-emerald-600" aria-label="passed" />
    </Show>
  );
}

export function TestReportSection(props: { report: TestReport }) {
  return (
    <ReviewSection title="Test report">
      <Show when={props.report.state === 'missing'}>
        <Note tone="warning">
          No test report. Ask the External Service Builder to test the service and write its report before you publish.
        </Note>
      </Show>
      <Show when={props.report.state === 'unreadable' ? props.report : null}>
        {(report) => (
          <Note tone="warning">
            <p class="mb-1">The test report cannot be trusted as written:</p>
            <ul class="list-disc pl-4 font-mono text-[11px]">
              <For each={report().problems}>{(problem) => <li>{problem}</li>}</For>
            </ul>
          </Note>
        )}
      </Show>
      <Show when={props.report.state === 'present' ? props.report : null}>
        {(report) => (
          <>
            <p class="text-xs">
              {report().counts.pass} passed, {report().counts.fail} failed, {report().counts.notChecked} not checked at
              commit <span class="font-mono">{report().commit.slice(0, SHORT_COMMIT)}</span>
              <Show when={report().headCommit && report().headCommit !== report().commit}>
                {' '}
                (the workspace is now at <span class="font-mono">{report().headCommit?.slice(0, SHORT_COMMIT)}</span>)
              </Show>
              .
            </p>
            <Show when={(report().changedSince ?? []).length > 0}>
              <Note tone="warning">
                Changed since the test: <span class="font-mono">{(report().changedSince ?? []).join(', ')}</span>
              </Note>
            </Show>
            <Show when={report().changedSince === null}>
              <Note tone="warning">The tested commit is not in the workspace's history.</Note>
            </Show>
            <Show when={!report().manifestMatches}>
              <Note tone="warning">service.json changed since the test.</Note>
            </Show>
            <Show when={!report().upstreamCalled}>
              <Note tone="warning">Never called the real upstream: no live call was answered by the service.</Note>
            </Show>
            <Show when={report().unknownCallIds.length > 0}>
              <Note tone="warning">
                Some Calls the report cites are not in this service's Call log:{' '}
                <span class="font-mono">{report().unknownCallIds.join(', ')}</span>
              </Note>
            </Show>
            <ul class="flex flex-col divide-y divide-border rounded-md border border-border text-xs">
              <For each={report().lines}>
                {(line) => (
                  <li class="flex items-start gap-2 px-3 py-1.5">
                    <ResultMark result={line.result} />
                    <div class="min-w-0 flex-1">
                      <p>{line.expectation}</p>
                      <p class="text-[11px] text-muted-foreground">
                        {line.source}
                        <Show when={line.reason}>{(reason) => <> · {reason()}</>}</Show>
                      </p>
                    </div>
                  </li>
                )}
              </For>
            </ul>
          </>
        )}
      </Show>
    </ReviewSection>
  );
}

export interface NewFieldsDraft {
  review: ServiceConfigurationReview;
  draft: FormDraft;
  copied: () => ReadonlySet<string>;
  setCopied: (key: string, copied: boolean) => void;
  isValid: () => boolean;
  submission: () => { values: ConfigurationValues; copyFromDevelopment: string[] };
  showServerIssues: (issues: readonly ConfigurationIssue[]) => void;
}

function keyOf(field: Field): string | null {
  return 'key' in field && typeof field.key === 'string' ? field.key : null;
}

export function createNewFieldsDraft(review: ServiceConfigurationReview): NewFieldsDraft {
  const fields = review.fields;
  const draft = createFormDraft(fields, withDefaults(fields, {}), review.missing);
  const [copied, setCopiedKeys] = createSignal<ReadonlySet<string>>(new Set());
  const typedFields = () => fields.filter((field) => !copied().has(keyOf(field) ?? ''));
  const errors = createMemo(() =>
    validateFormValues(typedFields(), JSON.parse(JSON.stringify(draft.values)) as ConfigurationValues)
  );
  return {
    review,
    draft,
    copied,
    setCopied: (key, on) =>
      setCopiedKeys((previous) => {
        const next = new Set(previous);
        if (on) next.add(key);
        else next.delete(key);
        return next;
      }),
    isValid: () => errors().size === 0,
    submission: () => {
      const values = JSON.parse(JSON.stringify(draft.values)) as ConfigurationValues;
      const typed = new Set(typedFields().map(keyOf));
      return {
        values: Object.fromEntries(Object.entries(values).filter(([key]) => typed.has(key))),
        copyFromDevelopment: [...copied()],
      };
    },
    showServerIssues: (issues) => draft.showServerIssues(issues),
  };
}

export function NewFieldsSection(props: { fields: NewFieldsDraft; callService: ServiceCaller; firstPublish: boolean }) {
  const labels = createLabelBook(props.fields.review.fields, {});
  const ctx: FormContext = {
    draft: props.fields.draft,
    readOnly: () => false,
    templateValues: () => ({}),
    serviceConfigurationOptions: () => [],
    storedLabel: labels.storedLabel,
    seenOptions: labels.seenOptions,
    callService: (route, name, request) => props.callService(route, name, request),
  };
  return (
    <ReviewSection title="Service configuration">
      <Show
        when={props.fields.review.fields.length > 0}
        fallback={
          <p class="text-xs text-muted-foreground">
            The configuration your Projects use already has every field this version requires.
          </p>
        }
      >
        <p class="text-xs text-muted-foreground">
          {props.firstPublish
            ? 'The configuration your Projects will use. It is saved with the Publish; Development keeps its own.'
            : 'This version requires fields the configuration your Projects use lacks. They are saved with the Publish.'}
        </p>
        <div class="flex flex-col gap-3">
          <For each={props.fields.review.fields}>
            {(field) => {
              const key = keyOf(field) ?? '';
              const copyable = () => props.fields.review.fromDevelopment.includes(key);
              const isCopied = () => props.fields.copied().has(key);
              return (
                <div class="rounded-md border border-border p-3">
                  <Show
                    when={!isCopied()}
                    fallback={
                      <p class="text-xs">
                        <span class="font-medium">{'label' in field && field.label ? field.label : key}</span>
                        <span class="text-muted-foreground">
                          {' '}
                          · Development's value, sealed again for your Projects
                        </span>
                      </p>
                    }
                  >
                    <ServiceFormFields fields={[field]} ctx={ctx} />
                  </Show>
                  <Show when={copyable()}>
                    <label class="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={isCopied()}
                        onChange={(event) => props.fields.setCopied(key, event.currentTarget.checked)}
                      />
                      Copy from Development
                    </label>
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
    </ReviewSection>
  );
}

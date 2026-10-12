import { Match, Show, Switch, createEffect, createMemo, createSignal, on, type JSX } from 'solid-js';
import { ApiError } from '~/api/client';
import { useEnvironments } from '~/api/environments';
import {
  usePublishJob,
  usePublishReview,
  usePublishService,
  useRefreshAfterPublish,
  useServiceEnvironments,
  type PublishReview,
} from '~/api/external-service-publishing';
import { callDevelopmentServiceForm, type ConfigurationIssue } from '~/api/external-service-views';
import type { PublishJob } from '~/api/publish';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Spinner } from '~/components/ui/spinner';
import { Rocket } from '~/components/icons';
import { PublishPreviewCard, PublishTargetList } from '~/components/publish-environments';
import { CallersReachSetting, DefaultEnvironmentSwitch, type ServiceTarget } from './default-environment-switch';
import {
  CheckSection,
  createNewFieldsDraft,
  ImpactSection,
  NewFieldsSection,
  TestReportSection,
} from './publish-review';

const SHORT_COMMIT = 7;

const JOB_STATUS_LABEL: Record<PublishJob['status'], string> = {
  queued: 'Waiting to start…',
  committing: "Saving Development's latest changes…",
  swapping: 'Preparing the new version…',
  building: 'Starting the service…',
  migrating: 'Waiting for the service to answer…',
  done: 'Published.',
  failed: 'The Publish failed.',
};

export function PublishServiceDialog(props: {
  serviceId: string;
  displayName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const environments = useServiceEnvironments(
    () => props.serviceId,
    () => props.open
  );
  const registry = useEnvironments({ enabled: () => props.open });
  const targets = createMemo((): ServiceTarget[] =>
    (environments.data ?? []).flatMap((environment) => {
      const entry = registry.data?.find((candidate) => candidate.id === environment.environmentId);
      return entry ? [{ ...environment, id: entry.id, shortName: entry.shortName, color: entry.color }] : [];
    })
  );
  const [chosen, setChosen] = createSignal<string | null>(null);
  const target = () =>
    chosen() ??
    targets().find((environment) => environment.serviceDefault)?.environmentId ??
    targets()[0]?.environmentId ??
    null;
  const review = usePublishReview(
    () => props.serviceId,
    () => (props.open ? target() : null)
  );
  const [started, setStarted] = createSignal(false);
  const [switchingTo, setSwitchingTo] = createSignal<ServiceTarget | null>(null);
  const job = usePublishJob(
    () => props.serviceId,
    target,
    () => props.open && started()
  );
  const refresh = useRefreshAfterPublish(() => props.serviceId);
  const jobStatus = createMemo(() => job.data?.status);

  createEffect(
    on(jobStatus, (status) => {
      if (status === 'done' || status === 'failed') refresh();
    })
  );

  const close = (open: boolean) => {
    if (!open) {
      setStarted(false);
      setChosen(null);
      setSwitchingTo(null);
    }
    props.onOpenChange(open);
  };

  return (
    <Dialog open={props.open} onOpenChange={close}>
      <DialogContent class="max-h-[85vh] max-w-2xl overflow-y-auto" align="top">
        <Show
          when={switchingTo()}
          fallback={
            <DialogHeader>
              <DialogTitle>Publish {props.displayName}</DialogTitle>
              <DialogDescription>
                Pick an environment to publish Development's latest version to. Callers keep reaching the environment
                chosen below.
              </DialogDescription>
            </DialogHeader>
          }
        >
          {(switching) => (
            <DialogHeader>
              <DialogTitle>Move callers to {switching().name}</DialogTitle>
              <DialogDescription>
                Callers move to the version published there. Calls already running finish where they started.
              </DialogDescription>
            </DialogHeader>
          )}
        </Show>
        <Switch
          fallback={
            <div class="mt-4 space-y-4">
              <PublishTargetList
                targets={targets()}
                chosen={target()}
                onPick={setChosen}
                status={(environment) =>
                  environment.deployedCommitSha
                    ? `Published · ${environment.deployedCommitSha.slice(0, SHORT_COMMIT)}`
                    : 'Not published yet'
                }
              />
              <Show
                when={review.data}
                keyed
                fallback={
                  <>
                    <Show
                      when={review.isError}
                      fallback={
                        <div class="flex justify-center py-8">
                          <Spinner />
                        </div>
                      }
                    >
                      <p class="text-sm text-muted-foreground" role="alert">
                        {review.error instanceof ApiError
                          ? review.error.message
                          : 'The Publish review could not be read.'}
                      </p>
                    </Show>
                    <DialogFooter>
                      <Button size="sm" variant="outline" onClick={() => close(false)}>
                        Close
                      </Button>
                    </DialogFooter>
                  </>
                }
              >
                {(loaded) => (
                  <PublishReviewBody
                    serviceId={props.serviceId}
                    review={loaded}
                    onPublished={() => setStarted(true)}
                    onClose={() => close(false)}
                  >
                    <CallersReachSetting targets={targets()} onSwitch={setSwitchingTo} />
                  </PublishReviewBody>
                )}
              </Show>
            </div>
          }
        >
          <Match when={started()}>
            <PublishProgress job={job.data ?? null} onClose={() => close(false)} onBack={() => setStarted(false)} />
          </Match>
          <Match when={switchingTo()}>
            {(switching) => (
              <div class="mt-4">
                <DefaultEnvironmentSwitch
                  serviceId={props.serviceId}
                  target={switching()}
                  onBack={() => setSwitchingTo(null)}
                />
              </div>
            )}
          </Match>
        </Switch>
      </DialogContent>
    </Dialog>
  );
}

function PublishReviewBody(props: {
  serviceId: string;
  review: PublishReview;
  onPublished: () => void;
  onClose: () => void;
  children: JSX.Element;
}) {
  const fields = props.review.serviceConfiguration ? createNewFieldsDraft(props.review.serviceConfiguration) : null;
  const publish = usePublishService(() => props.serviceId);
  const [failure, setFailure] = createSignal<string | null>(null);
  const ready = () => props.review.check.ok && fields !== null && fields.isValid();

  const submit = () => {
    if (!fields) return;
    setFailure(null);
    publish.mutate(
      { environmentId: props.review.target.environmentId, ...fields.submission() },
      {
        onSuccess: () => props.onPublished(),
        onError: (error) => {
          const issues = error instanceof ApiError ? error.details.errors : undefined;
          if (Array.isArray(issues)) fields.showServerIssues(issues as ConfigurationIssue[]);
          setFailure(error.message || 'The Publish could not start.');
        },
      }
    );
  };

  return (
    <>
      <PublishPreviewCard title={`What ${props.review.target.name} will receive`}>
        <CheckSection check={props.review.check} changes={props.review.changes} impact={props.review.impact} />
        <ImpactSection impact={props.review.impact} callersStayOn={props.review.current} />
        <TestReportSection report={props.review.testReport} />
        <Show when={fields}>
          {(draft) => (
            <NewFieldsSection
              fields={draft()}
              firstPublish={props.review.target.firstPublish}
              callService={(route, name, request) =>
                callDevelopmentServiceForm(props.serviceId, route, name, {
                  values: JSON.parse(JSON.stringify(draft().draft.values)),
                  ...request,
                })
              }
            />
          )}
        </Show>
      </PublishPreviewCard>
      <Show when={failure()}>
        {(message) => (
          <p class="text-xs text-destructive" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <Show when={!failure() && props.review.check.ok && fields && !fields.isValid()}>
        <p class="text-xs text-muted-foreground">Fill the required fields to publish.</p>
      </Show>
      {props.children}
      <DialogFooter>
        <Button size="sm" variant="outline" onClick={() => props.onClose()}>
          Close
        </Button>
        <Button size="sm" disabled={!ready()} loading={publish.isPending} onClick={submit}>
          <Rocket class="h-3.5 w-3.5" aria-hidden="true" />
          Publish to {props.review.target.name}
        </Button>
      </DialogFooter>
    </>
  );
}

function PublishProgress(props: { job: PublishJob | null; onClose: () => void; onBack: () => void }) {
  const status = () => props.job?.status ?? 'queued';
  return (
    <div class="flex flex-col gap-4">
      <div class="flex items-center gap-3 text-sm" role="status">
        <Show when={status() !== 'done' && status() !== 'failed'}>
          <Spinner />
        </Show>
        <span>{JOB_STATUS_LABEL[status()]}</span>
      </div>
      <Show when={status() === 'failed' && props.job?.error}>
        {(error) => <p class="text-xs text-destructive">{error()}</p>}
      </Show>
      <div class="flex justify-end gap-3 border-t border-border pt-4">
        <Switch>
          <Match when={status() === 'failed'}>
            <Button size="sm" variant="outline" onClick={() => props.onBack()}>
              Back to the review
            </Button>
          </Match>
        </Switch>
        <Button size="sm" onClick={() => props.onClose()}>
          {status() === 'done' || status() === 'failed' ? 'Close' : 'Close and keep publishing'}
        </Button>
      </div>
    </div>
  );
}

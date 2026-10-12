import { Show, createSignal } from 'solid-js';
import { toast } from 'solid-sonner';
import { ApiError } from '~/api/client';
import {
  useDefaultEnvironmentReview,
  useSwitchDefaultEnvironment,
  type DefaultEnvironmentReview,
  type ServiceEnvironment,
} from '~/api/external-service-publishing';
import { callServiceForm, type ConfigurationIssue } from '~/api/external-service-views';
import {
  DefaultEnvironmentSetting,
  PublishPreviewCard,
  type EnvironmentChoice,
} from '~/components/publish-environments';
import { Button } from '~/components/ui/button';
import { DialogFooter } from '~/components/ui/dialog';
import { Spinner } from '~/components/ui/spinner';
import { CheckSection, createNewFieldsDraft, ImpactSection, NewFieldsSection } from './publish-review';

export type ServiceTarget = ServiceEnvironment & EnvironmentChoice;

export function CallersReachSetting(props: { targets: ServiceTarget[]; onSwitch: (target: ServiceTarget) => void }) {
  const published = () => props.targets.filter((target) => target.published);
  const current = () => published().find((target) => target.serviceDefault) ?? null;

  return (
    <DefaultEnvironmentSetting
      id="service-default-environment"
      label="Callers reach"
      description="Agents, Apps and webhooks reach the version published to this environment. Stored state and the webhook URL stay with the service."
      choices={published()}
      value={current()}
      disabled={published().length === 0}
      onChange={(target) => target.id !== current()?.id && props.onSwitch(target)}
      notice={
        published().length === 0
          ? 'Nothing is published yet — the first environment you publish becomes the one callers reach.'
          : undefined
      }
    />
  );
}

export function DefaultEnvironmentSwitch(props: { serviceId: string; target: ServiceTarget; onBack: () => void }) {
  const review = useDefaultEnvironmentReview(
    () => props.serviceId,
    () => props.target.environmentId
  );
  return (
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
              {review.error instanceof ApiError ? review.error.message : 'The switch could not be reviewed.'}
            </p>
          </Show>
          <DialogFooter>
            <Button size="sm" variant="outline" onClick={() => props.onBack()}>
              Back
            </Button>
          </DialogFooter>
        </>
      }
    >
      {(loaded) => <SwitchReviewBody serviceId={props.serviceId} review={loaded} onBack={props.onBack} />}
    </Show>
  );
}

function SwitchReviewBody(props: { serviceId: string; review: DefaultEnvironmentReview; onBack: () => void }) {
  const fields = props.review.serviceConfiguration ? createNewFieldsDraft(props.review.serviceConfiguration) : null;
  const switchDefault = useSwitchDefaultEnvironment(() => props.serviceId);
  const [failure, setFailure] = createSignal<string | null>(null);
  const ready = () => props.review.check.ok && fields !== null && fields.isValid();

  const submit = () => {
    if (!fields) return;
    setFailure(null);
    switchDefault.mutate(
      { environmentId: props.review.target.environmentId, ...fields.submission() },
      {
        onSuccess: () => {
          toast.success(`Callers now reach ${props.review.target.name}`);
          props.onBack();
        },
        onError: (error) => {
          const issues = error instanceof ApiError ? error.details.errors : undefined;
          if (Array.isArray(issues)) fields.showServerIssues(issues as ConfigurationIssue[]);
          setFailure(error.message || 'Callers could not be moved to this environment.');
        },
      }
    );
  };

  return (
    <>
      <div class="space-y-4">
        <PublishPreviewCard title={`What callers reach in ${props.review.target.name}`}>
          <CheckSection check={props.review.check} />
          <ImpactSection impact={props.review.impact} callersStayOn={props.review.current} />
          <Show when={fields}>
            {(draft) => (
              <NewFieldsSection
                fields={draft()}
                firstPublish={false}
                callService={(route, name, request) =>
                  callServiceForm({ id: props.serviceId, origin: 'custom' }, route, name, {
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
      </div>
      <DialogFooter>
        <Button size="sm" variant="outline" onClick={() => props.onBack()}>
          Back
        </Button>
        <Button size="sm" disabled={!ready()} loading={switchDefault.isPending} onClick={submit}>
          Move callers to {props.review.target.name}
        </Button>
      </DialogFooter>
    </>
  );
}

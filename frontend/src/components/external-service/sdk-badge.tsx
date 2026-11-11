import { Match, Show, Switch } from 'solid-js';
import { useNavigate } from '@tanstack/solid-router';
import type { SdkStatus } from '~/api/external-service-views';
import { ArrowUp } from '~/components/icons';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { opencodeMessageId } from '~/lib/opencode-id';

export function SdkBadge(props: { sdk: SdkStatus }) {
  const vendored = () => props.sdk.vendored ?? 'unknown';
  return (
    <Switch
      fallback={
        <Badge variant="outline" class="font-medium text-muted-foreground" title="The SDK this service runs">
          SDK {vendored()}
        </Badge>
      }
    >
      <Match when={props.sdk.status === 'upgrade-available'}>
        <Badge
          variant="info"
          class="font-medium"
          title="Upgrade SDK asks the External Service Builder to move this service to it; callers get it when you Publish"
        >
          SDK {vendored()} · {props.sdk.latest} available
        </Badge>
      </Match>
      <Match when={props.sdk.status === 'needs-upgrade'}>
        <Badge
          variant="warning"
          class="font-medium"
          title="The platform no longer accepts this SDK; ask the External Service Builder to upgrade it"
        >
          SDK {vendored()} · needs upgrade
        </Badge>
      </Match>
    </Switch>
  );
}

function sdkUpgradeRequest(sdk: SdkStatus): string {
  return `Upgrade this service's SDK from ${sdk.vendored} to ${sdk.latest}: read what the newer CHANGELOG adds, change the code where it asks, rerun the tests and write a new test report.`;
}

export function UpgradeSdkButton(props: { serviceId: string; sdk: SdkStatus | null }) {
  const navigate = useNavigate();
  return (
    <Show when={props.sdk?.status === 'upgrade-available' ? props.sdk : null}>
      {(sdk) => (
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            void navigate({
              to: '/store/external-services/$id/builder',
              params: { id: props.serviceId },
              search: { prompt: sdkUpgradeRequest(sdk()), promptId: opencodeMessageId() },
            })
          }
        >
          <ArrowUp class="h-3.5 w-3.5" aria-hidden="true" />
          Upgrade SDK
        </Button>
      )}
    </Show>
  );
}

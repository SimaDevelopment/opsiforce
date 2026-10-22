import { Match, Switch } from 'solid-js';
import type { SdkStatus } from '~/api/external-service-views';
import { Badge } from '~/components/ui/badge';

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
          title="Ask the External Service Builder to upgrade the vendored SDK when you want what the newer one brings"
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

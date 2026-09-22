import { createFileRoute } from '@tanstack/solid-router';
import { Spinner } from '~/components/ui/spinner';

export const Route = createFileRoute('/settings/')({
  component: SettingsIndex,
});

function SettingsIndex() {
  return (
    <div class="flex h-full items-center justify-center">
      <Spinner />
    </div>
  );
}

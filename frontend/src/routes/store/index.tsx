import { createFileRoute } from '@tanstack/solid-router';
import { Spinner } from '~/components/ui/spinner';

export const Route = createFileRoute('/store/')({
  component: StoreIndex,
});

function StoreIndex() {
  return (
    <div class="flex h-full items-center justify-center">
      <Spinner />
    </div>
  );
}

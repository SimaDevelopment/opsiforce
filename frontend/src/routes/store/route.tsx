import { Show, createEffect } from 'solid-js';
import { Outlet, createFileRoute, useLocation, useNavigate } from '@tanstack/solid-router';
import { StoreNav } from '~/components/store/store-nav';

export const Route = createFileRoute('/store')({
  component: StoreLayout,
});

const BUILDER_PATH = /^\/store\/(agents|skills)\/[^/]+\/builder\/?$/;

function StoreLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const isIndex = () => location().pathname === '/store' || location().pathname === '/store/';
  const inBuilder = () => BUILDER_PATH.test(location().pathname);

  createEffect(() => {
    if (isIndex()) navigate({ to: '/store/agents', replace: true });
  });

  return (
    <div class="flex h-full w-full flex-col overflow-hidden">
      <Show when={!inBuilder()}>
        <StoreNav />
      </Show>
      <div class="min-h-0 min-w-0 flex-1 overflow-hidden">
        <Outlet />
      </div>
    </div>
  );
}

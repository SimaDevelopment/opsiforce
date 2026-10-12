import { Show, createEffect } from 'solid-js';
import { Outlet, createFileRoute, useLocation, useNavigate } from '@tanstack/solid-router';
import { StoreNav, storeSectionForPath } from '~/components/store/store-nav';
import { createDocumentTitle } from '~/lib/create-document-title';

export const Route = createFileRoute('/store')({
  component: StoreLayout,
});

const BUILDER_PATH = /^\/store\/(agents|skills|external-services)\/[^/]+\/builder\/?$/;

function StoreLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const isIndex = () => location().pathname === '/store' || location().pathname === '/store/';
  const inBuilder = () => BUILDER_PATH.test(location().pathname);
  createDocumentTitle(() => storeSectionForPath(location().pathname)?.label ?? 'Store');

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

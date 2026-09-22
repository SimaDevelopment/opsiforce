import { Show, createEffect } from 'solid-js';
import { Outlet, createFileRoute, useLocation, useNavigate } from '@tanstack/solid-router';
import { usePermissions } from '~/api/permissions';
import { Spinner } from '~/components/ui/spinner';
import { SectionRail } from '~/components/section-rail';
import { BuilderChatRail } from '~/components/store/builder-chat-rail';
import { STORE_TABS, STORE_GROUP_ORDER, firstPermittedStoreTab, storeTabForPath } from '~/constants/store-tabs';

export const Route = createFileRoute('/store')({
  component: StoreLayout,
});

function StoreLayout() {
  const { permissions, hasPermission } = usePermissions();
  const navigate = useNavigate();
  const location = useLocation();

  const permittedTabs = () => STORE_TABS.filter((tab) => tab.isPermitted(hasPermission));
  const isIndex = () => location().pathname === '/store' || location().pathname === '/store/';
  const currentAllowed = () => {
    const tab = storeTabForPath(location().pathname);
    return !tab || tab.isPermitted(hasPermission);
  };

  createEffect(() => {
    if (permissions.isPending) return;
    const first = firstPermittedStoreTab(hasPermission);
    if (!first) {
      navigate({ to: '/', replace: true });
      return;
    }
    if (isIndex() || !currentAllowed()) {
      navigate({ to: first.to, replace: true });
    }
  });

  return (
    <div class="flex h-full w-full flex-col overflow-hidden md:flex-row">
      <Show when={!permissions.isPending && permittedTabs().length > 0}>
        <SectionRail tabs={permittedTabs()} groupOrder={STORE_GROUP_ORDER} belowTabsOnDesktop={<BuilderChatRail />} />
      </Show>
      <div class="min-h-0 min-w-0 flex-1 overflow-hidden">
        <Show
          when={!permissions.isPending && !isIndex() && currentAllowed()}
          fallback={
            <div class="flex h-full items-center justify-center">
              <Spinner />
            </div>
          }
        >
          <Outlet />
        </Show>
      </div>
    </div>
  );
}

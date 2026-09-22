import { Show, createEffect } from 'solid-js';
import { Outlet, createFileRoute, useLocation, useNavigate } from '@tanstack/solid-router';
import { usePermissions } from '~/api/permissions';
import { Spinner } from '~/components/ui/spinner';
import { SectionRail } from '~/components/section-rail';
import { ADMIN_TABS, ADMIN_GROUP_ORDER, firstPermittedAdminTab, adminTabForPath } from '~/constants/admin-tabs';

export const Route = createFileRoute('/admin')({
  component: AdminLayout,
});

function AdminLayout() {
  const { permissions, hasPermission } = usePermissions();
  const navigate = useNavigate();
  const location = useLocation();

  const permittedTabs = () => ADMIN_TABS.filter((tab) => tab.isPermitted(hasPermission));
  const isIndex = () => location().pathname === '/admin' || location().pathname === '/admin/';
  const currentAllowed = () => {
    const tab = adminTabForPath(location().pathname);
    return !tab || tab.isPermitted(hasPermission);
  };

  createEffect(() => {
    if (permissions.isPending) return;
    const first = firstPermittedAdminTab(hasPermission);
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
        <SectionRail tabs={permittedTabs()} groupOrder={ADMIN_GROUP_ORDER} />
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

import { Show, createEffect } from 'solid-js';
import { Outlet, createFileRoute, useLocation, useNavigate } from '@tanstack/solid-router';
import { usePermissions } from '~/api/permissions';
import { Spinner } from '~/components/ui/spinner';
import { SectionRail } from '~/components/section-rail';
import {
  SETTINGS_TABS,
  SETTINGS_GROUP_ORDER,
  firstPermittedSettingsTab,
  settingsTabForPath,
} from '~/constants/settings-tabs';

export const Route = createFileRoute('/settings')({
  component: SettingsLayout,
});

function SettingsLayout() {
  const { permissions, hasPermission } = usePermissions();
  const navigate = useNavigate();
  const location = useLocation();

  const permittedTabs = () => SETTINGS_TABS.filter((tab) => tab.isPermitted(hasPermission));
  const isIndex = () => location().pathname === '/settings' || location().pathname === '/settings/';
  const currentAllowed = () => {
    const tab = settingsTabForPath(location().pathname);
    return !tab || tab.isPermitted(hasPermission);
  };

  createEffect(() => {
    if (permissions.isPending) return;
    const first = firstPermittedSettingsTab(hasPermission);
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
        <SectionRail tabs={permittedTabs()} groupOrder={SETTINGS_GROUP_ORDER} />
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

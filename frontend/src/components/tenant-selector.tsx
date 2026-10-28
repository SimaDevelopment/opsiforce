import { Show, For } from 'solid-js';
import { api, type Tenant } from '~/api/client';
import { createTenantState } from '~/lib/tenant-state';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '~/components/ui/dropdown-menu';
import { SidebarMenu, SidebarMenuItem } from '~/components/ui/sidebar';
import { Check, ChevronsUpDown } from '~/components/icons';
import { createAppQuery } from '~/lib/create-app-query';

export function TenantSelector() {
  const [currentTenant, setTenant] = createTenantState();

  const tenantsQuery = createAppQuery(() => ({
    queryKey: ['tenants'],
    queryFn: () => api.get<Tenant[]>('/tenants'),
  }));

  const currentDisplayName = () => {
    const tenants = tenantsQuery.data;
    if (!tenants) return '';
    const match = tenants.find((t) => t.name === currentTenant());
    return match?.displayName ?? currentTenant();
  };

  const tenantInitial = () => (currentDisplayName() || '?').trim().charAt(0).toUpperCase();

  const initTenant = () => {
    const tenants = tenantsQuery.data;
    if (!tenants || tenants.length === 0) return;
    if (!currentTenant() || !tenants.some((t) => t.name === currentTenant())) {
      setTenant(tenants[0].name);
    }
  };

  return (
    <Show when={tenantsQuery.data} fallback={null}>
      {(tenants) => {
        initTenant();
        // The tenant was hidden entirely below two of them, so the shell never
        // said which organization you were in. It is orientation first and a
        // switcher second: with one tenant it reads as a static label, with
        // several it opens the menu.
        return (
          <Show when={tenants().length > 0}>
            <SidebarMenu>
              <SidebarMenuItem>
                <Show
                  when={tenants().length >= 2}
                  fallback={
                    <div class="of-sb-tenant group-data-[collapsible=icon]/sidebar:justify-center">
                      <span class="av">{tenantInitial()}</span>
                      <span class="nm group-data-[collapsible=icon]/sidebar:hidden">{currentDisplayName()}</span>
                    </div>
                  }
                >
                <DropdownMenu>
                  <DropdownMenuTrigger
                    as={(props: Record<string, unknown>) => (
                      <button
                        {...props}
                        class="of-sb-tenant fr-panel group-data-[collapsible=icon]/sidebar:justify-center"
                      >
                        <span class="av">{tenantInitial()}</span>
                        <span class="nm group-data-[collapsible=icon]/sidebar:hidden">{currentDisplayName()}</span>
                        <ChevronsUpDown
                          class="w-3.5 h-3.5 shrink-0 group-data-[collapsible=icon]/sidebar:hidden"
                          style={{ color: 'var(--ink-subtle)' }}
                        />
                      </button>
                    )}
                  />
                  <DropdownMenuContent class="min-w-56">
                    <For each={tenants()}>
                      {(tenant) => (
                        <DropdownMenuItem
                          class={tenant.name === currentTenant() ? 'bg-accent' : ''}
                          onSelect={() => setTenant(tenant.name)}
                        >
                          <span class="of-tenant-avatar">
                            {(tenant.displayName || tenant.name).trim().charAt(0).toUpperCase()}
                          </span>
                          <span class="flex-1 truncate">{tenant.displayName}</span>
                          <Show when={tenant.name === currentTenant()}>
                            <Check class="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--ink-accent)' }} />
                          </Show>
                        </DropdownMenuItem>
                      )}
                    </For>
                  </DropdownMenuContent>
                </DropdownMenu>
                </Show>
              </SidebarMenuItem>
            </SidebarMenu>
          </Show>
        );
      }}
    </Show>
  );
}

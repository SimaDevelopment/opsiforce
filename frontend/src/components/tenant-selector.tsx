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
import { Building2, ChevronsUpDown } from '~/components/icons';
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
        return (
          <Show when={tenants().length >= 2}>
            <SidebarMenu>
              <SidebarMenuItem>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    as={(props: Record<string, unknown>) => (
                      <button
                        {...props}
                        class="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm text-sidebar-foreground outline-none transition-colors hover:bg-sidebar-accent group-data-[collapsible=icon]/sidebar:justify-center"
                      >
                        <div class="w-7 h-7 shrink-0 rounded-lg bg-sidebar-accent flex items-center justify-center">
                          <Building2 class="w-4 h-4" />
                        </div>
                        <span class="truncate flex-1 text-left text-sm font-medium group-data-[collapsible=icon]/sidebar:hidden">
                          {currentDisplayName()}
                        </span>
                        <ChevronsUpDown class="w-4 h-4 shrink-0 text-sidebar-muted-foreground group-data-[collapsible=icon]/sidebar:hidden" />
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
                          {tenant.displayName}
                        </DropdownMenuItem>
                      )}
                    </For>
                  </DropdownMenuContent>
                </DropdownMenu>
              </SidebarMenuItem>
            </SidebarMenu>
          </Show>
        );
      }}
    </Show>
  );
}

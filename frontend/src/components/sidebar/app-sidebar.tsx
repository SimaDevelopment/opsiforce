import { Show, createSignal, type Component } from 'solid-js';
import { toast } from 'solid-sonner';
import { useLocation, useNavigate } from '@tanstack/solid-router';
import { useAgents } from '~/api/agents';
import { usePermissions } from '~/api/permissions';
import { useCurrentUser } from '~/api/user';
import { useCreateDefaultProject } from '~/api/default-project-target';
import { limitRefusalMessage } from '~/api/limits';
import { firstPermittedSettingsTab } from '~/constants/settings-tabs';
import { firstPermittedAdminTab } from '~/constants/admin-tabs';
import {
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from '~/components/ui/sidebar';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '~/components/ui/dropdown-menu';
import { TenantSelector } from '~/components/tenant-selector';
import { PaletteShortcut, openCommandPalette } from '~/components/command-palette';
import { canOpenStore } from '~/components/store/store-nav';
import { modShortcut } from '~/lib/shortcut';
import { BrandMark } from './brand-mark';
import { ProjectSidebar } from './project-sidebar';
import { CreateWorkspaceDialog } from '~/components/create-workspace-dialog';
import { CreateMenu } from './create-menu';
import { ProjectImportDialog } from '~/components/project/project-import-dialog';
import { SidebarAttention } from './sidebar-attention';
import { COLLAPSED_HIDDEN, COLLAPSED_ROW, SidebarSectionNav } from './sidebar-section-nav';
import { ProjectFilters } from './project-filters';
import { useProjects } from '~/api/projects';
import { useWorkspaces } from '~/api/workspaces';
import { createProjectFilters, filterProjects } from '~/lib/project-filters';
import { SETTINGS_TABS, SETTINGS_GROUP_ORDER } from '~/constants/settings-tabs';
import { ADMIN_TABS, ADMIN_GROUP_ORDER } from '~/constants/admin-tabs';
import {
  Calendar,
  ChevronsUpDown,
  FolderKanban,
  LogOut,
  Plus,
  Search,
  Server,
  Settings,
  Store,
} from '~/components/icons';

/** One destination in the sidebar's nav block — the shared row geometry. */
function NavRow(props: {
  icon: Component<{ class?: string }>;
  label: string;
  to: string;
  active: boolean;
  onNavigate: ReturnType<typeof useNavigate>;
}) {
  const { open } = useSidebar();
  return (
    <button
      type="button"
      class={`of-row fr-panel ${COLLAPSED_ROW}`}
      title={open() ? undefined : props.label}
      aria-label={props.label}
      aria-current={props.active ? 'page' : undefined}
      onClick={() => props.onNavigate({ to: props.to })}
    >
      <props.icon class="w-4 h-4 shrink-0" />
      <span class={`lbl ${COLLAPSED_HIDDEN}`}>{props.label}</span>
    </button>
  );
}

export function AppSidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const path = () => location().pathname;
  const inSettings = () => path().startsWith('/settings');
  const inAdmin = () => path().startsWith('/admin');
  const inSection = () => inSettings() || inAdmin();
  const { toggleSidebar } = useSidebar();
  const { hasPermission } = usePermissions();
  const currentUser = useCurrentUser();
  const agents = useAgents();
  const createDefaultProject = useCreateDefaultProject();

  // the same persisted signals ProjectSidebar reads, kept in step by the
  // storage event rather than by a shared provider
  const filters = createProjectFilters();
  const [filtersOpen, setFiltersOpen] = createSignal(false);
  const allProjects = useProjects();
  const allWorkspaces = useWorkspaces();
  const matchCount = () =>
    filterProjects(
      allProjects.data,
      { scope: filters.scope(), recency: filters.recency(), status: filters.status() },
      allWorkspaces.data,
      currentUser.data?.id
    ).length;
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = createSignal(false);
  const [importOpen, setImportOpen] = createSignal(false);

  const canOpenSettings = () => !!firstPermittedSettingsTab(hasPermission);
  const canOpenAdmin = () => !!firstPermittedAdminTab(hasPermission);

  const projectCreateDisabled = () => createDefaultProject.isPending() || !createDefaultProject.hasDestination();
  const menuDisabled = () =>
    projectCreateDisabled() && !hasPermission('can_import_project') && !hasPermission('can_manage_workspaces');

  const handleCreateProject = async (agentId: string) => {
    try {
      const project = await createDefaultProject.createProject({ agentId });
      toast.success('Project created');
      navigate({
        to: '/projects/$projectId',
        params: { projectId: project.id },
        search: { prompt: undefined, promptId: undefined },
      });
    } catch (err) {
      toast.error(limitRefusalMessage(err, 'Failed to create project'));
    }
  };

  const userName = () => currentUser.data?.displayName ?? '';
  const userEmail = () => currentUser.data?.email ?? '';
  const userInitial = () => {
    const name = userName();
    return name ? name.charAt(0).toUpperCase() : 'U';
  };

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader class="gap-2 pb-0">
        <div class="of-sb-head group-data-[collapsible=icon]/sidebar:justify-center group-data-[collapsible=icon]/sidebar:pl-0">
          <BrandMark nameClass="of-sb-word group-data-[collapsible=icon]/sidebar:hidden" />
          <div class="ml-auto group-data-[collapsible=icon]/sidebar:hidden">
            <SidebarTrigger />
          </div>
        </div>
        <div class="hidden group-data-[collapsible=icon]/sidebar:flex justify-center">
          <SidebarTrigger />
        </div>

        <TenantSelector />

        <div class="group-data-[collapsible=icon]/sidebar:hidden flex items-center gap-1.5 pb-1">
          <button
            type="button"
            class="of-sb-search fr-panel flex-1 min-w-0"
            onClick={openCommandPalette}
            aria-keyshortcuts="Meta+K Control+K"
          >
            <Search class="w-3.5 h-3.5 shrink-0" />
            <span class="truncate">Search</span>
            <span aria-hidden="true" class="of-sb-search-hint">
              <PaletteShortcut />
            </span>
          </button>
          <ProjectFilters
            open={filtersOpen()}
            onOpenChange={setFiltersOpen}
            scope={filters.scope()}
            onScopeChange={filters.setScope}
            recency={filters.recency()}
            onRecencyChange={filters.setRecency}
            status={filters.status()}
            onStatusChange={filters.setStatus}
            active={filters.active()}
            onReset={filters.reset}
            matchCount={matchCount()}
            totalCount={allProjects.data?.length ?? 0}
          />
          <CreateMenu
            disabled={projectCreateDisabled()}
            canCreateWorkspace={hasPermission('can_manage_workspaces')}
            canImport={hasPermission('can_import_project')}
            agents={agents.data}
            onCreateProject={handleCreateProject}
            onOpenCreateWorkspace={() => setCreateWorkspaceOpen(true)}
            onOpenImport={() => setImportOpen(true)}
            /* the same primitive as the filter beside it: both are icon buttons
               on the search row, so they share one shape */
            trigger={(triggerProps) => (
              <button
                {...triggerProps}
                type="button"
                class="of-btn of-btn-icon of-btn-outline fr-panel shrink-0"
                disabled={menuDisabled()}
                title="Create"
                aria-label="Create"
              >
                <Plus class="w-4 h-4" />
              </button>
            )}
          />
        </div>
        <div class="hidden group-data-[collapsible=icon]/sidebar:flex flex-col items-center gap-1 pb-2">
          <button
            type="button"
            class="w-7 h-7 rounded-md flex items-center justify-center text-sidebar-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
            onClick={openCommandPalette}
            aria-label="Search"
            aria-keyshortcuts="Meta+K Control+K"
            title={`Search (${modShortcut('K')})`}
          >
            <Search class="w-4 h-4" />
          </button>
          <CreateMenu
            disabled={projectCreateDisabled()}
            canCreateWorkspace={hasPermission('can_manage_workspaces')}
            canImport={hasPermission('can_import_project')}
            agents={agents.data}
            onCreateProject={handleCreateProject}
            onOpenCreateWorkspace={() => setCreateWorkspaceOpen(true)}
            onOpenImport={() => setImportOpen(true)}
            trigger={(triggerProps) => (
              <button
                {...triggerProps}
                class="w-7 h-7 rounded-md flex items-center justify-center text-sidebar-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
                disabled={menuDisabled()}
                title="Create"
              >
                <Plus class="w-4 h-4" />
              </button>
            )}
          />
        </div>
      </SidebarHeader>

      {/* Destinations sit above the tree, so the sidebar reads as one list of
          places rather than a project tree with a hidden menu under the avatar. */}
      <Show when={!inSection()}>
        <nav class="flex flex-col gap-1 px-2 pt-1 pb-2" aria-label="Main">
          <Show when={canOpenStore(hasPermission)}>
            <NavRow icon={Store} label="Store" to="/store" active={path().startsWith('/store')} onNavigate={navigate} />
          </Show>
          <Show when={hasPermission('can_manage_schedules')}>
            <NavRow
              icon={Calendar}
              label="Schedules"
              to="/schedules"
              active={path().startsWith('/schedules')}
              onNavigate={navigate}
            />
          </Show>
          <Show when={canOpenSettings()}>
            <NavRow
              icon={Settings}
              label="Settings"
              to="/settings"
              active={path().startsWith('/settings')}
              onNavigate={navigate}
            />
          </Show>
        </nav>
        <SidebarSeparator />
      </Show>

      <SidebarContent>
        {/* On /settings and /admin the sidebar becomes that section's navigation
          rather than letting a second rail open beside it. */}
        <Show when={inSettings()}>
          <SidebarSectionNav
            title="Settings"
            tabs={SETTINGS_TABS.filter((tab) => tab.isPermitted(hasPermission))}
            groupOrder={SETTINGS_GROUP_ORDER}
          />
        </Show>
        <Show when={inAdmin()}>
          <SidebarSectionNav
            title="Admin"
            tabs={ADMIN_TABS.filter((tab) => tab.isPermitted(hasPermission))}
            groupOrder={ADMIN_GROUP_ORDER}
          />
        </Show>
        <Show when={!inSection()}>
          <div class="group-data-[collapsible=icon]/sidebar:hidden">
            <SidebarAttention />
          </div>
        </Show>
        <Show when={!inSection()}>
          <div class="hidden group-data-[collapsible=icon]/sidebar:block px-2 py-2">
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton onClick={() => toggleSidebar()} title="Show projects">
                  <FolderKanban class="w-4 h-4 shrink-0" />
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </div>
        </Show>
        <Show when={!inSection()}>
          <div class="group-data-[collapsible=icon]/sidebar:hidden px-2 py-1">
            <ProjectSidebar />
          </div>
        </Show>
      </SidebarContent>

      <SidebarSeparator />

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger
                as={(triggerProps: Record<string, unknown>) => (
                  <button
                    {...triggerProps}
                    class="of-sb-user fr-panel group-data-[collapsible=icon]/sidebar:justify-center"
                  >
                    <span class="av">{userInitial()}</span>
                    <span class="two group-data-[collapsible=icon]/sidebar:hidden">
                      <b>{userName()}</b>
                      <Show when={userEmail()}>
                        <span class="truncate">{userEmail()}</span>
                      </Show>
                    </span>
                    <ChevronsUpDown
                      class="w-3.5 h-3.5 shrink-0 group-data-[collapsible=icon]/sidebar:hidden"
                      style={{ color: 'var(--ink-subtle)' }}
                    />
                  </button>
                )}
              />
              <DropdownMenuContent class="min-w-56">
                <div class="px-2 py-1.5">
                  <p class="text-sm font-medium truncate">{userName()}</p>
                </div>
                <DropdownMenuSeparator />
                <Show when={canOpenAdmin()}>
                  <DropdownMenuItem onSelect={() => navigate({ to: '/admin' })}>
                    <Server class="w-4 h-4 text-muted-foreground" />
                    Admin
                  </DropdownMenuItem>
                </Show>
                <DropdownMenuItem
                  onSelect={() => {
                    window.location.href = '/oauth2/sign_out';
                  }}
                >
                  <LogOut class="w-4 h-4 text-muted-foreground" />
                  Log out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <CreateWorkspaceDialog open={createWorkspaceOpen()} onOpenChange={setCreateWorkspaceOpen} />
      <ProjectImportDialog open={importOpen()} onOpenChange={setImportOpen} />
    </Sidebar>
  );
}

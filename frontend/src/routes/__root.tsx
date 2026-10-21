import { For, Show, createEffect, on } from 'solid-js';
import { QueryClient, QueryClientProvider } from '@tanstack/solid-query';
import { Outlet, createRootRoute, useRouter, useLocation } from '@tanstack/solid-router';
import { TanStackDevtools } from '@tanstack/solid-devtools';
import { SolidQueryDevtoolsPanel } from '@tanstack/solid-query-devtools';
import { TanStackRouterDevtoolsPanel } from '@tanstack/solid-router-devtools';
import { ApiError } from '~/api/client';
import { AppSidebar } from '~/components/sidebar/app-sidebar';
import { BrandMark } from '~/components/sidebar/brand-mark';
import { JobDockHost } from '~/components/project/jobs/job-dock-host';
import { useSidebar } from '~/components/ui/sidebar';
import { Button } from '~/components/ui/button';
import { Menu } from '~/components/icons';
import { PRIVATE_ROOT_COMPONENTS } from '~/private-loader';
import { createTenantChangeHandler } from '~/lib/tenant-state';
import { Toaster } from 'solid-sonner';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 0,
      refetchOnWindowFocus: true,
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status === 404) return false;
        return failureCount < 3;
      },
    },
  },
});

function MobileHeader() {
  const { isMobile, toggleSidebar } = useSidebar();

  return (
    <Show when={isMobile()}>
      <header class="flex items-center gap-1.5 h-11 px-3 shrink-0 bg-background border-b border-border">
        <Button variant="ghost" size="icon" class="h-8 w-8" onClick={toggleSidebar} aria-label="Open sidebar">
          <Menu class="h-5 w-5" />
        </Button>
        <BrandMark nameClass="text-foreground" />
      </header>
    </Show>
  );
}

function SidebarLayout() {
  const { sidebarResize, setOpenMobile } = useSidebar();
  const location = useLocation();

  createEffect(
    on(
      () => location().pathname,
      () => setOpenMobile(false),
      { defer: true }
    )
  );

  return (
    <JobDockHost>
      <div
        class="group/sidebar-wrapper flex h-full w-full"
        style={{
          '--sidebar-width': `${sidebarResize.width()}px`,
          '--sidebar-width-icon': '3rem',
        }}
      >
        <AppSidebar />
        <div class="flex flex-1 flex-col min-w-0 h-full overflow-hidden bg-background">
          <MobileHeader />
          <div class="flex-1 min-w-0 h-full overflow-hidden">
            <Outlet />
          </div>
        </div>
      </div>
    </JobDockHost>
  );
}

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppContent />
    </QueryClientProvider>
  );
}

function AppContent() {
  const router = useRouter();
  const location = useLocation();
  const isPermissionDenied = () => location().pathname === '/permission-denied';

  createTenantChangeHandler();

  return (
    <>
      <Toaster position="bottom-right" richColors />
      <For each={PRIVATE_ROOT_COMPONENTS}>{(PrivateRootComponent) => <PrivateRootComponent />}</For>
      <Show when={!isPermissionDenied()} fallback={<Outlet />}>
        <SidebarLayout />
      </Show>
      <Show when={import.meta.env.DEV}>
        <TanStackDevtools
          plugins={[
            {
              name: 'TanStack Query',
              render: () => <SolidQueryDevtoolsPanel client={queryClient} />,
            },
            {
              name: 'TanStack Router',
              render: () => <TanStackRouterDevtoolsPanel router={router} />,
            },
          ]}
        />
      </Show>
    </>
  );
}

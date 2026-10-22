import { createSignal, onMount, Show } from 'solid-js';
import { createFileRoute } from '@tanstack/solid-router';
import { Lock, LogOut } from '~/components/icons';
import { Button } from '~/components/ui/button';
import { createDocumentTitle } from '~/lib/create-document-title';

export const Route = createFileRoute('/permission-denied')({
  component: PermissionDeniedPage,
});

function handleLogout() {
  window.location.href = '/oauth2/sign_out';
}

function PermissionDeniedPage() {
  createDocumentTitle(() => 'No permission');
  const [username, setUsername] = createSignal<string>();

  onMount(async () => {
    try {
      const res = await fetch('/api/tenants');
      if (res.ok) {
        window.location.href = '/';
        return;
      }
    } catch {}

    try {
      const res = await fetch('/oauth2/userinfo');
      if (res.ok) {
        const data = await res.json();
        setUsername(data.preferredUsername ?? data.email);
      }
    } catch {}
  });

  return (
    <div class="flex h-screen w-screen flex-col items-center justify-center gap-6 bg-background">
      <div class="flex flex-col items-center gap-4 text-center">
        <div class="flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
          <Lock class="w-8 h-8 text-destructive" stroke-width={1.5} />
        </div>
        <div class="flex flex-col gap-1">
          <h1 class="text-2xl font-semibold text-foreground">No permission</h1>
          <p class="text-sm text-muted-foreground">You don't have access to this system.</p>
          <Show when={username()}>
            {(name) => <p class="text-sm font-medium text-muted-foreground">Username: {name()}</p>}
          </Show>
        </div>
      </div>
      <Button variant="outline" size="sm" class="gap-1.5" onClick={handleLogout}>
        <LogOut class="w-3.5 h-3.5" />
        Log out
      </Button>
    </div>
  );
}

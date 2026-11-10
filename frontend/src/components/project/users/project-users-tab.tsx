import { For, Show, createMemo, createSignal } from 'solid-js';
import { useAppUsers } from '~/api/app-users';
import { useEnvironments, useProjectEnvironments, type ProjectEnvironment } from '~/api/environments';
import { EnvironmentBadge } from '~/components/environment-badge';
import { ShieldCheck, Tag, UserPlus, Users } from '~/components/icons';
import { ProjectAuthDialog } from '~/components/project-auth-dialog';
import { SettingsSection } from '~/components/settings/settings-section';
import { ErrorState, RowList, SectionTitle } from '~/components/store/store-list';
import { Button } from '~/components/ui/button';
import { Skeleton } from '~/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '~/components/ui/tabs';
import { InviteUserDialog } from './invite-user-dialog';
import { RolesView } from './roles-view';
import { UsersView } from './users-view';

function SignInAccess(props: { environments: ProjectEnvironment[]; onOpenAuth: (env: ProjectEnvironment) => void }) {
  const tenantEnvironments = useEnvironments();
  const badgeOf = (env: ProjectEnvironment) =>
    tenantEnvironments.data?.find((tenantEnv) => tenantEnv.id === env.environmentId);
  const using = () => props.environments.filter((env) => env.authMode === 'app_users').length;

  return (
    <section class="mb-6" aria-labelledby="sign-in-access">
      <SectionTitle>
        <span id="sign-in-access" class="inline-flex items-center gap-2">
          <ShieldCheck class="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          Where visitors sign in
        </span>
      </SectionTitle>
      <Show when={using() === 0}>
        <p class="of-note of-tone-needs-you mb-2 text-xs leading-snug">
          No environment asks visitors to sign in with these accounts yet. Turn on App Users for one below.
        </p>
      </Show>
      <RowList>
        <For each={props.environments}>
          {(env) => {
            const on = () => env.authMode === 'app_users';
            return (
              <div class="flex items-center gap-3 px-4 py-2.5">
                <Show when={badgeOf(env)} fallback={<span class="text-sm font-medium">{env.name}</span>}>
                  {(badge) => <EnvironmentBadge environment={badge()} />}
                </Show>
                <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {on() ? 'Visitors sign in with these accounts' : 'Uses another kind of App Auth'}
                </span>
                <Button size="sm" variant={on() ? 'ghost' : 'outline'} onClick={() => props.onOpenAuth(env)}>
                  {on() ? 'App Auth' : 'Turn On'}
                </Button>
              </div>
            );
          }}
        </For>
      </RowList>
    </section>
  );
}

export function ProjectUsersTab(props: { projectId: string }) {
  const projectId = () => props.projectId;
  const overview = useAppUsers(projectId);
  const environments = useProjectEnvironments(projectId);
  const [inviteOpen, setInviteOpen] = createSignal(false);
  const [authEnv, setAuthEnv] = createSignal<ProjectEnvironment | null>(null);

  const envList = () => environments.data ?? [];
  const linkEnvironment = createMemo(() => {
    const using = envList().filter((env) => env.authMode === 'app_users');
    return (
      using.find((env) => env.id === props.projectId) ?? using[0] ?? envList().find((e) => e.id === props.projectId)
    );
  });
  const appUrl = () => linkEnvironment()?.publicUrl ?? undefined;

  return (
    <>
      <SettingsSection
        icon={Users}
        title="Users"
        description="The people who can sign in to this project’s App, and the roles the App uses to decide what they can do."
        width="wide"
        action={
          <Button size="sm" onClick={() => setInviteOpen(true)} disabled={!overview.data}>
            <UserPlus class="h-4 w-4" aria-hidden="true" />
            Invite User
          </Button>
        }
      >
        <Show when={environments.data}>
          <SignInAccess environments={envList()} onOpenAuth={setAuthEnv} />
        </Show>

        <Show
          when={overview.data}
          fallback={
            <Show
              when={overview.error}
              fallback={
                <div class="space-y-2">
                  <Skeleton class="h-9 w-64" />
                  <Skeleton class="h-40 w-full" />
                </div>
              }
            >
              {(error) => <ErrorState message={`Couldn’t load users: ${error().message}`} />}
            </Show>
          }
        >
          {(data) => (
            <>
              <Tabs defaultValue="users">
                <TabsList class="w-auto">
                  <TabsTrigger value="users" class="flex-none">
                    <Users class="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                    Users
                    <span class="ml-1.5 text-xs tabular-nums text-muted-foreground">{data().users.length}</span>
                  </TabsTrigger>
                  <TabsTrigger value="roles" class="flex-none">
                    <Tag class="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                    Roles
                    <span class="ml-1.5 text-xs tabular-nums text-muted-foreground">{data().roles.length}</span>
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="users" class="mt-4">
                  <UsersView
                    projectId={props.projectId}
                    overview={data()}
                    linkEnvironmentId={linkEnvironment()?.id}
                    appUrl={appUrl()}
                    onInvite={() => setInviteOpen(true)}
                  />
                </TabsContent>
                <TabsContent value="roles" class="mt-4">
                  <RolesView projectId={props.projectId} roles={data().roles} />
                </TabsContent>
              </Tabs>
              <InviteUserDialog
                projectId={props.projectId}
                roles={data().roles}
                linkEnvironmentId={linkEnvironment()?.id}
                appUrl={appUrl()}
                canEmail={data().email}
                open={inviteOpen()}
                onOpenChange={setInviteOpen}
              />
            </>
          )}
        </Show>
      </SettingsSection>

      <Show when={authEnv()}>
        {(env) => (
          <ProjectAuthDialog
            projectId={props.projectId}
            environmentId={env().id}
            environmentName={env().name}
            appUrl={env().publicUrl ?? undefined}
            open
            onOpenChange={(open) => {
              if (!open) setAuthEnv(null);
            }}
          />
        )}
      </Show>
    </>
  );
}

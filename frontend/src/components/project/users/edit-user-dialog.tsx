import { Show, createEffect, createSignal, createUniqueId, on } from 'solid-js';
import { toast } from 'solid-sonner';
import {
  displayStatus,
  useCreateAppUserLink,
  useUpdateAppUser,
  type AppUser,
  type AppUserLink,
  type AppUserRole,
} from '~/api/app-users';
import { ApiError } from '~/api/client';
import { KeyRound, Link2, Mail, UserRound } from '~/components/icons';
import { Button } from '~/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '~/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '~/components/ui/tabs';
import { Field, INPUT_CLASS, PasswordField, generatePassword, passwordError } from './fields';
import { EMAIL_PATTERN } from './invite-user-dialog';
import { LinkDetails } from './link-details';
import { RolePicker } from './role-picker';
import { SignInDetails } from './sign-in-details';
import { StatusBadge } from './status-badge';

const HTTP_CONFLICT = 409;

type Tab = 'profile' | 'access';

type Access =
  | { kind: 'idle' }
  | { kind: 'set-password' }
  | { kind: 'link'; link: AppUserLink }
  | { kind: 'password-set'; password: string };

export function EditUserDialog(props: {
  projectId: string;
  user: AppUser | null;
  roles: AppUserRole[];
  linkEnvironmentId?: string;
  appUrl?: string;
  canEmail: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const projectId = () => props.projectId;
  const update = useUpdateAppUser(projectId);
  const createLink = useCreateAppUserLink(projectId);
  const rolesLabel = createUniqueId();
  const [email, setEmail] = createSignal('');
  const [name, setName] = createSignal('');
  const [roles, setRoles] = createSignal<string[]>([]);
  const [emailFailure, setEmailFailure] = createSignal<string | null>(null);
  const [formFailure, setFormFailure] = createSignal<string | null>(null);
  const [access, setAccess] = createSignal<Access>({ kind: 'idle' });
  const [password, setPassword] = createSignal('');
  const [passwordAttempted, setPasswordAttempted] = createSignal(false);
  const [tab, setTab] = createSignal<Tab>('profile');

  createEffect(
    on(
      () => [props.open, props.user?.id] as const,
      ([open]) => {
        const user = props.user;
        if (!open || !user) return;
        setEmail(user.email);
        setName(user.name ?? '');
        setRoles(user.roles);
        setEmailFailure(null);
        setFormFailure(null);
        setAccess({ kind: 'idle' });
        setPasswordAttempted(false);
        setTab('profile');
      }
    )
  );

  const linkAccess = () => {
    const current = access();
    return current.kind === 'link' ? current : null;
  };
  const passwordSetAccess = () => {
    const current = access();
    return current.kind === 'password-set' ? current : null;
  };

  const emailError = () => {
    if (emailFailure()) return emailFailure();
    if (!email().trim()) return 'Enter an email address';
    if (!EMAIL_PATTERN.test(email().trim())) return 'Enter a full email address, like name@example-org.com';
    return null;
  };

  const save = (user: AppUser) => {
    if (emailError()) return;
    update.mutate(
      { id: user.id, dto: { email: email().trim(), name: name().trim() || null, roles: roles() } },
      {
        onSuccess: () => {
          props.onOpenChange(false);
          toast.success(`Saved ${email().trim()}. If they’re signed in, the App gets it within 5 minutes.`);
        },
        onError: (e) => {
          if (e instanceof ApiError && e.status === HTTP_CONFLICT) setEmailFailure(e.message);
          else setFormFailure((e as Error).message);
        },
      }
    );
  };

  const [sending, setSending] = createSignal(false);

  const makeLink = (user: AppUser, send: boolean) => {
    setSending(send);
    createLink.mutate(
      {
        id: user.id,
        purpose: user.status === 'invited' ? 'invite' : 'reset',
        environmentId: props.linkEnvironmentId,
        send,
      },
      {
        onSuccess: (link) => {
          setAccess({ kind: 'link', link });
          if (link.emailError) toast.error(`The email couldn’t be sent (${link.emailError}). Copy the link instead.`);
        },
        onError: (e) =>
          toast.error(
            send
              ? `Failed to email the link: ${(e as Error).message}`
              : `Failed to create the link: ${(e as Error).message}`
          ),
      }
    );
  };

  const setNewPassword = (user: AppUser) => {
    setPasswordAttempted(true);
    if (passwordError(password())) return;
    const chosen = password();
    update.mutate(
      { id: user.id, dto: { password: chosen } },
      {
        onSuccess: () => setAccess({ kind: 'password-set', password: chosen }),
        onError: (e) => toast.error(`Failed to set the password: ${(e as Error).message}`),
      }
    );
  };

  const profileForm = (user: AppUser) => (
    <form
      class="space-y-4"
      novalidate
      onSubmit={(e) => {
        e.preventDefault();
        save(user);
      }}
    >
      <div class="grid gap-3 sm:grid-cols-2">
        <Field label="Email" error={emailError()}>
          {(control) => (
            <input
              id={control.id}
              type="email"
              name="app-user-email"
              autocomplete="off"
              autocapitalize="none"
              spellcheck={false}
              value={email()}
              onInput={(e) => {
                setEmail(e.currentTarget.value);
                setEmailFailure(null);
              }}
              disabled={update.isPending}
              aria-invalid={control.invalid()}
              aria-describedby={control.describedBy()}
              class={INPUT_CLASS}
            />
          )}
        </Field>
        <Field label="Name">
          {(control) => (
            <input
              id={control.id}
              name="app-user-name"
              autocomplete="off"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              disabled={update.isPending}
              class={INPUT_CLASS}
            />
          )}
        </Field>
      </div>
      <div class="space-y-2">
        <p id={rolesLabel} class="text-xs font-medium">
          Roles
        </p>
        <RolePicker
          projectId={props.projectId}
          roles={props.roles}
          value={roles()}
          onChange={setRoles}
          disabled={update.isPending}
          labelledBy={rolesLabel}
        />
      </div>
      <Show when={formFailure()}>
        {(message) => (
          <p role="alert" class="text-xs text-destructive">
            {message()}
          </p>
        )}
      </Show>
      <DialogFooter>
        <Button type="button" variant="outline" size="sm" onClick={() => props.onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" size="sm" loading={update.isPending && access().kind === 'idle'}>
          Save Changes
        </Button>
      </DialogFooter>
    </form>
  );

  const accessPanel = (user: AppUser) => (
    <div class="space-y-4">
      <p class="text-xs text-muted-foreground leading-snug">
        {user.status === 'invited'
          ? `${user.email} hasn’t chosen a password yet. A new invite link replaces the old one.`
          : `Send ${user.email} a reset link so they choose a new password, or set one for them. Either way they’re signed out everywhere and any lock is lifted.`}
      </p>
      <Show
        when={access().kind === 'idle'}
        fallback={
          <>
            <Show when={linkAccess()}>
              {(a) => (
                <LinkDetails
                  link={a().link}
                  purpose={user.status === 'invited' ? 'invite' : 'reset'}
                  email={user.email}
                  onEmail={props.canEmail ? () => makeLink(user, true) : undefined}
                  emailing={createLink.isPending}
                />
              )}
            </Show>
            <Show when={access().kind === 'set-password'}>
              <div class="space-y-3">
                <PasswordField
                  label="New password"
                  value={password()}
                  onInput={setPassword}
                  error={passwordAttempted() ? passwordError(password()) : null}
                  disabled={update.isPending}
                />
                <DialogFooter>
                  <Button type="button" variant="outline" size="sm" onClick={() => setAccess({ kind: 'idle' })}>
                    Cancel
                  </Button>
                  <Button type="button" size="sm" loading={update.isPending} onClick={() => setNewPassword(user)}>
                    Set Password
                  </Button>
                </DialogFooter>
              </div>
            </Show>
            <Show when={passwordSetAccess()}>
              {(a) => <SignInDetails appUrl={props.appUrl} email={user.email} password={a().password} />}
            </Show>
          </>
        }
      >
        <div class="flex flex-wrap gap-2">
          <Show when={props.canEmail}>
            <Button
              type="button"
              size="sm"
              loading={createLink.isPending && sending()}
              disabled={createLink.isPending}
              onClick={() => makeLink(user, true)}
            >
              <Mail class="h-3.5 w-3.5" aria-hidden="true" />
              {user.status === 'invited' ? 'Email New Invite' : 'Email Reset Link'}
            </Button>
          </Show>
          <Button
            type="button"
            variant="outline"
            size="sm"
            loading={createLink.isPending && !sending()}
            disabled={createLink.isPending}
            onClick={() => makeLink(user, false)}
          >
            <Link2 class="h-3.5 w-3.5" aria-hidden="true" />
            {user.status === 'invited' ? 'Copy New Invite Link' : 'Copy Reset Link'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setPassword(generatePassword());
              setPasswordAttempted(false);
              setAccess({ kind: 'set-password' });
            }}
          >
            <KeyRound class="h-3.5 w-3.5" aria-hidden="true" />
            Set Password
          </Button>
        </div>
      </Show>
    </div>
  );

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent class="max-w-lg">
        <Show when={props.user}>
          {(user) => (
            <>
              <DialogTitle class="flex items-center gap-2">
                <span class="truncate" translate="no">
                  {user().name ?? user().email}
                </span>
                <StatusBadge status={displayStatus(user())} />
              </DialogTitle>
              <DialogDescription>
                {user().status === 'disabled'
                  ? 'Disabled users can’t sign in. Enable them to send a reset link or set a password.'
                  : 'New sign-ins get changes right away. People already signed in get them within 5 minutes, when their sign-in renews.'}
              </DialogDescription>
              <Show when={user().status !== 'disabled'} fallback={<div class="mt-2">{profileForm(user())}</div>}>
                <Tabs value={tab()} onChange={(value) => setTab(value as Tab)} class="mt-2">
                  <TabsList class="w-auto">
                    <TabsTrigger value="profile" class="flex-none">
                      <UserRound class="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                      Profile
                    </TabsTrigger>
                    <TabsTrigger value="access" class="flex-none">
                      <KeyRound class="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                      {user().status === 'invited' ? 'Invite' : 'Password'}
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value="profile" class="mt-4">
                    {profileForm(user())}
                  </TabsContent>
                  <TabsContent value="access" class="mt-4">
                    {accessPanel(user())}
                  </TabsContent>
                </Tabs>
              </Show>
            </>
          )}
        </Show>
      </DialogContent>
    </Dialog>
  );
}

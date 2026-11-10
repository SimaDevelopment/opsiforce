import { Show, createEffect, createSignal, createUniqueId } from 'solid-js';
import { useCreateAppUser, useCreateAppUserLink, type AppUserLink, type AppUserRole } from '~/api/app-users';
import { ApiError } from '~/api/client';
import { Button } from '~/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '~/components/ui/dialog';
import { cn } from '~/lib/cn';
import { Field, INPUT_CLASS, PasswordField, generatePassword, passwordError } from './fields';
import { LinkDetails } from './link-details';
import { RolePicker } from './role-picker';
import { SignInDetails } from './sign-in-details';

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HTTP_CONFLICT = 409;

type Method = 'link' | 'password';
type Result =
  | { kind: 'link'; id: string; email: string; link: AppUserLink }
  | { kind: 'password'; email: string; password: string };

export function InviteUserDialog(props: {
  projectId: string;
  roles: AppUserRole[];
  linkEnvironmentId?: string;
  appUrl?: string;
  canEmail: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const projectId = () => props.projectId;
  const create = useCreateAppUser(projectId);
  const createLink = useCreateAppUserLink(projectId);
  const rolesLabel = createUniqueId();
  const [email, setEmail] = createSignal('');
  const [name, setName] = createSignal('');
  const [roles, setRoles] = createSignal<string[]>([]);
  const [method, setMethod] = createSignal<Method>('link');
  const [password, setPassword] = createSignal('');
  const [attempted, setAttempted] = createSignal(false);
  const [failure, setFailure] = createSignal<{ field: 'email' | 'form'; message: string } | null>(null);
  const [result, setResult] = createSignal<Result | null>(null);
  const [sendEmail, setSendEmail] = createSignal(true);
  const [emailFailure, setEmailFailure] = createSignal<string | null>(null);
  let emailInput: HTMLInputElement | undefined;
  let passwordInput: HTMLInputElement | undefined;

  const resetForm = () => {
    setEmail('');
    setName('');
    setRoles([]);
    setMethod('link');
    setPassword(generatePassword());
    setAttempted(false);
    setFailure(null);
    setResult(null);
    setSendEmail(true);
    setEmailFailure(null);
  };

  createEffect(() => {
    if (props.open) resetForm();
  });

  const emailAgain = (current: Extract<Result, { kind: 'link' }>) =>
    createLink.mutate(
      { id: current.id, purpose: 'invite', environmentId: props.linkEnvironmentId, send: true },
      {
        onSuccess: (link) => {
          setEmailFailure(link.emailError ?? null);
          setResult({ ...current, link });
        },
        onError: (e) => setEmailFailure((e as Error).message),
      }
    );

  const linkResult = () => {
    const done = result();
    return done?.kind === 'link' ? done : null;
  };
  const passwordResult = () => {
    const done = result();
    return done?.kind === 'password' ? done : null;
  };

  const saving = () => create.isPending || createLink.isPending;

  const emailError = () => {
    const server = failure();
    if (server?.field === 'email') return server.message;
    if (!attempted()) return null;
    if (!email().trim()) return 'Enter an email address';
    if (!EMAIL_PATTERN.test(email().trim())) return 'Enter a full email address, like name@example-org.com';
    return null;
  };
  const newPasswordError = () => (attempted() && method() === 'password' ? passwordError(password()) : null);

  const submit = async () => {
    setAttempted(true);
    setFailure(null);
    if (emailError()) return emailInput?.focus();
    if (newPasswordError()) return passwordInput?.focus();
    const chosen = method() === 'password' ? password() : undefined;
    try {
      const user = await create.mutateAsync({
        email: email().trim(),
        name: name().trim() || null,
        roles: roles(),
        password: chosen,
      });
      if (chosen) return setResult({ kind: 'password', email: user.email, password: chosen });
      const request = { id: user.id, purpose: 'invite' as const, environmentId: props.linkEnvironmentId };
      const send = props.canEmail && sendEmail();
      const link = await createLink.mutateAsync({ ...request, send });
      setEmailFailure(link.emailError ?? null);
      setResult({ kind: 'link', id: user.id, email: user.email, link });
    } catch (e) {
      const message = (e as Error).message;
      if (e instanceof ApiError && e.status === HTTP_CONFLICT) {
        setFailure({ field: 'email', message });
        emailInput?.focus();
      } else setFailure({ field: 'form', message });
    }
  };

  const methodOption = (value: Method, title: string, description: string) => (
    <label
      class={cn(
        'flex cursor-pointer gap-2.5 rounded-md border p-2.5 transition-colors',
        method() === value ? 'border-primary bg-primary/5' : 'border-border hover:border-foreground/30'
      )}
    >
      <input
        type="radio"
        name="invite-method"
        value={value}
        checked={method() === value}
        onChange={() => setMethod(value)}
        disabled={saving()}
        class="mt-0.5 accent-[var(--primary)]"
      />
      <span class="min-w-0">
        <span class="block text-sm font-medium">{title}</span>
        <span class="block text-xs text-muted-foreground leading-snug">{description}</span>
      </span>
    </label>
  );

  const form = () => (
    <>
      <DialogTitle>Invite User</DialogTitle>
      <DialogDescription>They sign in to this project’s App with their email and a password.</DialogDescription>
      <form
        class="mt-2 space-y-4"
        novalidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div class="grid gap-3 sm:grid-cols-2">
          <Field label="Email" error={emailError()}>
            {(control) => (
              <input
                ref={(el) => (emailInput = el)}
                id={control.id}
                type="email"
                name="app-user-email"
                autocomplete="off"
                autocapitalize="none"
                spellcheck={false}
                placeholder="name@example-org.com"
                value={email()}
                onInput={(e) => {
                  setEmail(e.currentTarget.value);
                  if (failure()?.field === 'email') setFailure(null);
                }}
                disabled={saving()}
                aria-invalid={control.invalid()}
                aria-describedby={control.describedBy()}
                class={INPUT_CLASS}
              />
            )}
          </Field>
          <Field label="Name" hint="Optional. Sent as X-Oidc-Name.">
            {(control) => (
              <input
                id={control.id}
                name="app-user-name"
                autocomplete="off"
                value={name()}
                onInput={(e) => setName(e.currentTarget.value)}
                disabled={saving()}
                aria-describedby={control.describedBy()}
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
            disabled={saving()}
            labelledBy={rolesLabel}
          />
        </div>
        <fieldset class="space-y-2">
          <legend class="mb-2 text-xs font-medium">Password</legend>
          {methodOption(
            'link',
            'Send an invite link',
            props.canEmail
              ? 'They choose their own password from a link that works for 7 days.'
              : 'They choose their own password. You copy the link and send it.'
          )}
          <Show when={method() === 'link' && props.canEmail}>
            <label class="flex items-center gap-2 pl-1 text-xs">
              <input
                type="checkbox"
                name="email-invite"
                checked={sendEmail()}
                onChange={(e) => setSendEmail(e.currentTarget.checked)}
                disabled={saving()}
                class="h-4 w-4 accent-[var(--primary)]"
              />
              Email the invite to them
            </label>
          </Show>
          {methodOption('password', 'Set a password now', 'You choose it and share it with them yourself.')}
          <Show when={method() === 'password'}>
            <PasswordField
              ref={(el) => (passwordInput = el)}
              label="Password"
              value={password()}
              onInput={setPassword}
              error={newPasswordError()}
              disabled={saving()}
            />
          </Show>
        </fieldset>
        <Show when={failure()?.field === 'form' && failure()?.message}>
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
          <Button type="submit" size="sm" loading={saving()}>
            {method() === 'password'
              ? 'Add User'
              : props.canEmail && sendEmail()
                ? 'Send Invite'
                : 'Create Invite Link'}
          </Button>
        </DialogFooter>
      </form>
    </>
  );

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent class="max-w-lg">
        <Show when={result()} fallback={form()}>
          {(done) => (
            <>
              <DialogTitle>
                {linkResult()?.link.emailed
                  ? 'Invite Sent'
                  : done().kind === 'link'
                    ? 'Invite Link Ready'
                    : 'User Added'}
              </DialogTitle>
              <DialogDescription>
                {linkResult()?.link.emailed
                  ? 'They choose their own password from the emailed link.'
                  : `Nothing is emailed. ${done().kind === 'link' ? 'Copy the link and send it' : 'Copy the sign-in details and send them'} to ${done().email}.`}
              </DialogDescription>
              <div class="mt-3">
                <Show when={emailFailure()}>
                  {(message) => (
                    <p role="alert" class="of-note of-tone-needs-you mb-2 text-xs leading-snug">
                      The invite email couldn’t be sent ({message()}). Copy the link and send it yourself.
                    </p>
                  )}
                </Show>
                <Show when={linkResult()}>
                  {(r) => (
                    <LinkDetails
                      link={r().link}
                      purpose="invite"
                      email={r().email}
                      onEmail={props.canEmail ? () => emailAgain(r()) : undefined}
                      emailing={createLink.isPending}
                    />
                  )}
                </Show>
                <Show when={passwordResult()}>
                  {(r) => <SignInDetails appUrl={props.appUrl} email={r().email} password={r().password} />}
                </Show>
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" size="sm" onClick={resetForm}>
                  Invite Another
                </Button>
                <Button type="button" size="sm" onClick={() => props.onOpenChange(false)}>
                  Done
                </Button>
              </DialogFooter>
            </>
          )}
        </Show>
      </DialogContent>
    </Dialog>
  );
}

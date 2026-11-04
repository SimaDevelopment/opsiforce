import { createFileRoute } from '@tanstack/solid-router';
import { SignInProvidersPage } from '~/pages/sign-in-providers/sign-in-providers-page';

export const Route = createFileRoute('/settings/sign-in-providers')({
  component: SignInProvidersPage,
});

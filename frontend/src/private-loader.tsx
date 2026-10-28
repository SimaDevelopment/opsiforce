import { createEffect, type Component } from 'solid-js';
import { useNavigate } from '@tanstack/solid-router';
import type { SettingsTab } from '~/constants/settings-tabs';

export interface PrivateExports {
  PRIVATE_ROOT_COMPONENTS: Component[];
  PRIVATE_TABS: SettingsTab[];
  PRIVATE_ROUTES: Partial<Record<PrivateRoute, Component>>;
}

export type PrivateRoute = '/settings/users';

const privateModules = import.meta.glob<PrivateExports>('./private/index.ts', { eager: true });

const privateModule = Object.values(privateModules)[0];

const MissingPrivateRoutePage: Component = () => {
  const navigate = useNavigate();

  createEffect(() => {
    navigate({ to: '/settings', replace: true });
  });

  return null;
};

export const PRIVATE_TABS = privateModule?.PRIVATE_TABS ?? [];
export const PRIVATE_ROOT_COMPONENTS = privateModule?.PRIVATE_ROOT_COMPONENTS ?? [];

export function privateRouteComponent(route: PrivateRoute): Component {
  return privateModule?.PRIVATE_ROUTES?.[route] ?? MissingPrivateRoutePage;
}

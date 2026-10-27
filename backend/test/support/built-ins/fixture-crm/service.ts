import { defineService, Secret } from '@opsiforce/external-service-sdk';

import manifest from './service.json';
import type { Manifest } from './service.types.ts';

const accounts = [
  { value: 'acc_1', label: 'Acme' },
  { value: 'acc_2', label: 'Globex' },
];

const recordedHooks = ((globalThis as Record<symbol, unknown>)[Symbol.for('opsiforce.test.fixture-crm.hooks')] ??=
  []) as unknown[];

function revealed(value: unknown): unknown {
  if (value instanceof Secret) return value.reveal();
  if (Array.isArray(value)) return value.map(revealed);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, revealed(entry)]));
  }
  return value;
}

interface Mailbox {
  id: string;
  label?: string;
}

function mailboxesOf(values: Record<string, unknown>): Mailbox[] {
  return Array.isArray(values.mailboxes) ? (values.mailboxes as Mailbox[]) : [];
}

export default defineService<Manifest>({
  manifest,
  routes: [],
  options: {
    listAccounts: ({ query }) =>
      accounts.filter((account) => account.label.toLowerCase().includes(query.toLowerCase())),
    listMembers: ({ values, item }) => {
      const teams = Array.isArray(values.teams) ? (values.teams as { id: string; team?: string }[]) : [];
      const team = teams.find((entry) => entry.id === item)?.team;
      return [{ value: `${String(team)}_1`, label: `First ${String(team)} member` }];
    },
  },
  info: {
    connectionStatus: ({ values }) => ({ text: `Region ${String(values.region)}`, level: 'success' }),
    accountsSummary: ({ values }) => {
      const picked = Array.isArray(values.accountIds) ? values.accountIds.length : 0;
      return { text: `${picked} accounts picked`, level: picked > 0 ? 'info' : 'warning' };
    },
  },
  buttons: {
    testMailbox: ({ values, item }) => {
      const mailboxes = mailboxesOf(values);
      const label = mailboxes.find((mailbox) => mailbox.id === item)?.label;
      return { message: `Mailbox ${String(label)} answered (${mailboxes.length} delivered)`, level: 'success' };
    },
    sendInvite: () => ({ link: 'https://invite.example.test/crm', label: 'Open the invite' }),
  },
  hooks: {
    onProjectConfigurationSaved: ({ previous, current }, ctx) => {
      recordedHooks.push({
        projectEnvironmentId: ctx.caller.projectEnvironmentId,
        previous: revealed(previous),
        current: revealed(current),
        mailboxes: revealed(ctx.serviceConfiguration.mailboxes),
      });
    },
  },
});

import { defineHandlers } from '@opsiforce/external-service-sdk';

import { manifestHash, type Manifest } from './service.types.ts';

const accounts = [
  { value: 'acc_1', label: 'Acme' },
  { value: 'acc_2', label: 'Globex' },
];

export default defineHandlers<Manifest>({
  manifestHash,
  operations: {
    get_account: (input, ctx) => ({
      id: input.accountId,
      name: accounts.find((account) => account.value === input.accountId)?.label ?? input.accountId,
      mailboxes: (ctx.serviceConfiguration.mailboxes ?? []).map((mailbox) => mailbox.label),
    }),
    update_account: (input) => ({ id: input.accountId, name: input.name, pipeline: input.pipeline }),
    delete_account: async (input, ctx) => ({
      deleted: input.accountId,
      stateRefusal: await ctx.state.set(`deleted/${input.accountId}`, true).then(
        () => null,
        (error: Error) => error.message
      ),
    }),
    get_member: (input) => ({ team: input.team, id: input.memberId }),
  },
  options: {
    listAccounts: ({ query }) =>
      accounts.filter((account) => account.label.toLowerCase().includes(query.toLowerCase())),
    listMembers: ({ values }) => [{ value: `${String(values.team)}_1`, label: `First ${String(values.team)} member` }],
  },
  info: {
    connectionStatus: ({ values }) => ({ text: `Region ${String(values.region)}`, level: 'success' }),
    accountsSummary: ({ values }) => {
      const picked = Array.isArray(values.accountIds) ? values.accountIds.length : 0;
      return { text: `${picked} accounts picked`, level: picked > 0 ? 'info' : 'warning' };
    },
  },
  buttons: {
    testMailbox: ({ values }, ctx) => ({
      message: `Mailbox ${String(values.label)} answered (${(ctx.serviceConfiguration.mailboxes ?? []).length} delivered)`,
      level: 'success',
    }),
    sendInvite: () => ({ link: 'https://invite.example.test/crm', label: 'Open the invite' }),
  },
});

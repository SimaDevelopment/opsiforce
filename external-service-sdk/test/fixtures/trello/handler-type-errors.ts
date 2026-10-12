import { defineHandlers, type Secret } from '@opsiforce/external-service-sdk';

import { manifestHash, type Manifest } from './service.types.ts';

const noop = () => ({});

export const missingOperation = defineHandlers<Manifest>({
  manifestHash,
  // @ts-expect-error delete_card has no handler
  operations: { list_cards: noop, create_card: noop },
  options: { listBoards: () => [] },
  buttons: { ping: () => ({ message: 'ok' }) },
  inbound: () => ({ events: [] }),
});

// @ts-expect-error Trello declares inbound, so it needs an inbound handler
export const missingInbound = defineHandlers<Manifest>({
  manifestHash,
  operations: { list_cards: noop, create_card: noop, delete_card: noop },
  options: { listBoards: () => [] },
  buttons: { ping: () => ({ message: 'ok' }) },
});

export const wrongTypes = defineHandlers<Manifest>({
  // @ts-expect-error the hash must be the generated literal
  manifestHash: 'stale',
  operations: {
    list_cards: (input, ctx) => {
      // @ts-expect-error boardId is a string
      const boardId: number = input.boardId;
      // @ts-expect-error "boards" is not a declared bound
      ctx.bounds.has('boards', boardId);
      // @ts-expect-error workspace is a string, not a Secret
      const workspace: Secret = ctx.projectConfiguration.workspace;
      const token: Secret | undefined = ctx.serviceConfiguration.workspaces?.[0]?.token;
      return { workspace, token };
    },
    create_card: (input) => {
      // @ts-expect-error CreateCard has no cardId
      return input.cardId;
    },
    delete_card: noop,
  },
  options: { listBoards: () => [] },
  // @ts-expect-error Trello has no button named refresh
  buttons: { ping: () => ({ message: 'ok' }), refresh: () => ({ message: 'ok' }) },
  inbound: () => ({
    // @ts-expect-error card.created is not a declared Event type
    events: [{ type: 'card.created', key: 'k', occurredAt: '2026-10-08T10:00:00Z', data: {} }],
  }),
});

import { ALL, defineHandlers, ServiceError } from '@opsiforce/external-service-sdk';

import { manifestHash, type Manifest } from './service.types.ts';

interface TrelloCard {
  id: string;
  idBoard: string;
  name: string;
}

function workspaceOf(ctx: { serviceConfiguration: Manifest['serviceConfiguration'] }, id: string) {
  const workspace = ctx.serviceConfiguration.workspaces?.find((candidate) => candidate.id === id);
  if (!workspace) throw new ServiceError({ status: 409, code: 'workspace-missing', detail: `No workspace ${id}` });
  return workspace;
}

export default defineHandlers<Manifest>({
  manifestHash,
  operations: {
    list_cards: (input, ctx) => {
      ctx.bounds.assert('board', input.boardId);
      const limit: number = input.limit;
      const workspace = workspaceOf(ctx, ctx.projectConfiguration.workspace);
      return { boardId: input.boardId, limit, workspace: workspace.label, token: workspace.token };
    },
    create_card: (input, ctx) => {
      const allowed = ctx.bounds.values('board');
      const boards = allowed === ALL ? 'all' : allowed.join(',');
      const card: TrelloCard = { id: '6523f1', idBoard: input.boardId, name: input.name };
      return { ...card, boards, labels: input.labels ?? [] };
    },
    delete_card: (input, ctx) => {
      const cards: TrelloCard[] = [{ id: input.cardId, idBoard: input.boardId, name: 'x' }];
      return { deleted: ctx.bounds.filter('board', cards, 'idBoard').map((card) => card.id) };
    },
  },
  options: {
    listBoards: ({ query, values }) => [
      { value: 'b1', label: `Board for ${String(values.workspace)} ${query}`.trim() },
    ],
  },
  buttons: {
    ping: () => ({ message: 'Trello answered', level: 'success' }),
  },
  hooks: {
    onProjectConfigurationSaved: ({ current }) => {
      if (current?.receive?.['card.moved'] === undefined) return;
    },
  },
  inbound: (request) => {
    const body = request.body as { action?: { data?: { board?: { id: string }; card?: { id: string } } } };
    const boardId = body.action?.data?.board?.id ?? '';
    const cardId = body.action?.data?.card?.id ?? '';
    return {
      events: [{ type: 'card.moved', key: cardId, occurredAt: '2026-10-08T10:00:00Z', data: { boardId, cardId } }],
    };
  },
});

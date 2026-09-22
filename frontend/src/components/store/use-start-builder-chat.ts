import { useNavigate } from '@tanstack/solid-router';
import { toast } from 'solid-sonner';
import { ApiError } from '~/api/client';
import { useCreateBuilderChat, type BuilderSeed, type ChatKind } from '~/api/builder';
import { opencodeMessageId } from '~/lib/opencode-id';

export function useStartBuilderChat() {
  const navigate = useNavigate();
  const create = useCreateBuilderChat();

  const open = async (kind: ChatKind, seed?: BuilderSeed) => {
    try {
      const chat = await create.mutateAsync(seed ? { kind, seed } : { kind });
      await navigate({
        to: '/store/builder/$id',
        params: { id: chat.id },
        search: chat.seedPrompt
          ? { prompt: chat.seedPrompt, promptId: opencodeMessageId() }
          : { prompt: undefined, promptId: undefined },
      });
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'The chat could not be started.');
    }
  };

  return {
    get isPending() {
      return create.isPending;
    },
    start: (kind: ChatKind) => void open(kind),
    startWithSeed: (kind: ChatKind, seed: BuilderSeed) => void open(kind, seed),
  };
}

import type { InitialPrompt } from './use-opencode-connection';

export interface InitialPromptSearch {
  prompt: string | undefined;
  promptId: string | undefined;
}

export function initialPromptSearchOf(search: Record<string, unknown>): InitialPromptSearch {
  return {
    prompt: typeof search.prompt === 'string' ? search.prompt : undefined,
    promptId: typeof search.promptId === 'string' ? search.promptId : undefined,
  };
}

export function initialPromptOf(search: Partial<InitialPromptSearch>): InitialPrompt | undefined {
  return search.prompt && search.promptId ? { id: search.promptId, text: search.prompt } : undefined;
}

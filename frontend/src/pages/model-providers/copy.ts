import type { BaseFormatId, ModelProviderKind, ModelProviderStatus } from '~/api/model-providers';

export const TIPS = {
  weight:
    'How much of this format’s requests this provider gets, compared with the others that are on. Weights are relative: 3 and 1 split requests 75% / 25%. 0 makes it a backup.',
  share:
    'The part of this format’s requests sent here first, worked out from the weights of the providers that are on.',
  backup:
    'Weight 0: it gets no requests of its own and is tried only when a request to another provider that is on fails.',
  off: 'Switched off: it gets no requests at all, not even as a backup.',
  notInTraffic:
    'It is on but gets no requests until its ChatGPT account is signed in, so the shares count only the providers taking requests.',
  onlyInTraffic:
    'It is the only provider of this format taking requests, so every request goes here whatever its weight.',
  builtIn:
    'Provided by Opsiforce. You decide whether it is on and how many requests it gets; Opsiforce manages its connection.',
  custom: 'Added by this organization. Only this organization can use it.',
  notMetered:
    'Not metered: the model gateway prices this provider’s requests at $0, so they count for nothing against any organization’s or project’s budget.',
  fixedBuiltIn:
    'Every organization has it and transcription depends on it, so it always points at the vendor’s API and can’t be deleted. Only its key can be replaced.',
  modelSplit:
    'A request for a model goes only to the model providers that serve it, split by their weights. A model provider that serves only some models takes no requests for the others.',
  newOrganizations:
    'Changing this keeps every organization’s current access as it is; it only decides whether an organization added later gets it.',
  applyToEveryOrganization:
    'Rewrites the model gateway keys of every Project in every organization from the switches and weights here. Every save already does this for its own organization; use it after model providers were changed outside this page, such as a Deployment config provider added to the database.',
  deploymentConfig:
    'Its key and endpoint come from this deployment’s config, not from this page. Organizations switch and weigh it like any Built-in model provider.',
  chosenDescription:
    'Only the organizations you tick get it, switched off at weight 1; their admins turn it on. Organizations added later don’t get it until you tick them under Organization access.',
  globalDescription:
    'Every organization gets it switched off at weight 1, and only its own admin can turn it on. Deleting it removes it from every organization.',
  format: (label: string) =>
    `Every ${label} model request goes to one of the model providers below that is on, chosen by weight. If it fails, it is retried on the others that are on.`,
  status: {
    working: 'The model gateway reports this provider as working.',
    failing:
      'The model gateway reports this provider as failing. Its failed requests are retried on this format’s other providers that are on.',
    'not-signed-in': 'No ChatGPT account is signed in yet, so it gets no requests. Sign in to put it in use.',
    'needs-sign-in':
      'OpenAI ended this ChatGPT sign-in, so it gets no requests until someone signs in again. The format’s other providers that are on take over.',
    missing: 'The model gateway no longer has this provider, so it gets no requests.',
    unknown: 'The model gateway can’t be reached, so this provider’s state is unknown and changes can’t be saved.',
  } satisfies Record<ModelProviderStatus, string>,
};

export const STATUS_LABEL: Record<ModelProviderStatus, string> = {
  working: 'Working',
  failing: 'Failing',
  'not-signed-in': 'Not signed in',
  'needs-sign-in': 'Needs sign-in again',
  missing: 'Missing',
  unknown: 'Unknown',
};

export const KIND_LABEL: Record<ModelProviderKind, string> = {
  'official-api-key': 'Official API key',
  'compatible-endpoint': 'Compatible endpoint',
  'linked-account': 'Linked account',
  'azure-foundry': 'Azure AI Foundry',
};

export const KIND_HINT: Record<ModelProviderKind, string> = {
  'official-api-key': 'A key for the vendor’s own API',
  'compatible-endpoint': 'A proxy or any gateway that speaks this format',
  'linked-account': 'A ChatGPT plan, signed in once',
  'azure-foundry': 'GPT and Claude deployments in your Azure resource',
};

export const BASE_URL_PLACEHOLDER: Record<BaseFormatId, string> = {
  openai: 'https://gateway.example.com/v1',
  anthropic: 'https://gateway.example.com',
};

export const BASE_URL_HINT: Record<BaseFormatId, string> = {
  openai:
    'An https:// URL, the one an OpenAI client takes as its base URL (usually ending in /v1). For Azure AI Foundry, connect with Azure AI Foundry instead.',
  anthropic: 'An https:// URL, the one an Anthropic client takes as its base URL. Requests go to …/v1/messages.',
};

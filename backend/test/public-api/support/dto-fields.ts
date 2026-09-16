export const PROJECT_FIELDS = [
  'id',
  'title',
  'description',
  'agent',
  'workspace',
  'folder',
  'disabled',
  'timezone',
  'agentStatus',
  'lastPromptAt',
  'createdAt',
  'updatedAt',
  'environments',
];

export const ENVIRONMENT_FIELDS = [
  'id',
  'name',
  'slug',
  'isDefault',
  'status',
  'hasApp',
  'appName',
  'lastActiveAt',
  'opencode',
];

export const OPENCODE_DESCRIPTOR_FIELDS = ['baseUrl', 'openapiUrl', 'sessionId'];

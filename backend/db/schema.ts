import { sql } from "drizzle-orm"

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }
import {
  pgTable,
  text,
  timestamp,
  date,
  pgEnum,
  bigint,
  boolean,
  jsonb,
  integer,
  index,
  uniqueIndex,
  unique,
  primaryKey,
  check,
  customType,
  type AnyPgColumn,
} from "drizzle-orm/pg-core"

const bytea = customType<{ data: Buffer; default: false }>({
  dataType: () => "bytea",
})

export type ProjectKindValue = "skill_builder_chat" | "agent_builder_chat" | "test"

export type GatewayKeyPurposeValue = "service" | "platform-api"

export type LimitKeyValue = "projects"

export const projectStatusEnum = pgEnum("project_status", [
  "starting",
  "active",
  "suspended",
  "disabled",
  "failed",
  "pending",
  "claiming",
  "publishing",
])

export const keyTypeEnum = pgEnum("key_type", ["chat", "backend"])

export const projectAuthModeEnum = pgEnum("project_auth_mode", ["public", "manual", "managed"])

export const requestLogModeEnum = pgEnum("request_log_mode", ["off", "metadata", "full"])

export const projectDuplicateStatusEnum = pgEnum("project_duplicate_status", [
  "queued",
  "committing",
  "cloning",
  "copying",
  "starting",
  "completed",
  "failed",
])

export const projectPublishStatusEnum = pgEnum("project_publish_status", [
  "queued",
  "committing",
  "building",
  "migrating",
  "swapping",
  "done",
  "failed",
])

export const projectTransferKindEnum = pgEnum("project_transfer_kind", ["export", "import"])

export const projectTransferStatusEnum = pgEnum("project_transfer_status", [
  "queued",
  "committing",
  "staging",
  "archiving",
  "unpacking",
  "starting",
  "completed",
  "failed",
])

export const agentUpdateStatusEnum = pgEnum("agent_update_status", [
  "pending",
  "running",
  "reload_pending",
  "applied",
  "conflict",
  "failed",
])

export const workspaceTypeEnum = pgEnum("workspace_type", ["private", "shared"])

export const podClassEnum = pgEnum("pod_class", ["small", "medium", "large", "custom"])

export const tenants = pgTable("tenants", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  displayName: text("display_name").notNull(),
  bifrostTenantId: text("bifrost_tenant_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
})

export const tenantSettings = pgTable("tenant_settings", {
  tenantId: text("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  externalTenantName: text("external_tenant_name").notNull().unique(),
  privateWorkspaceEnabled: boolean("private_workspace_enabled").notNull().default(true),
})

export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").references(() => tenants.id),
    name: text("name").notNull(),
    displayName: text("display_name"),
    description: text("description"),
    origin: text("origin").notNull().default("built_in"),
    visibility: text("visibility").notNull().default("public"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "restrict" }),
    version: text("version"),
    model: text("model"),
    variant: text("variant"),
    poolSize: integer("pool_size").notNull().default(0),
    builderChatId: text("builder_chat_id").references((): AnyPgColumn => projects.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("agents_tenant_id_name_unique")
      .on(table.tenantId, table.name)
      .where(sql`${table.tenantId} is not null`),
    uniqueIndex("agents_global_name_unique")
      .on(table.name)
      .where(sql`${table.tenantId} is null`),
    uniqueIndex("agents_builder_chat_id_unique").on(table.builderChatId),
    check("agents_origin_check", sql`${table.origin} in ('built_in', 'custom')`),
    check("agents_visibility_check", sql`${table.visibility} in ('private', 'public')`),
    check(
      "agents_custom_ownership_check",
      sql`${table.origin} = 'built_in' or (${table.tenantId} is not null and ${table.createdBy} is not null)`,
    ),
  ],
)

const tenantIdField = text("tenant_id")
  .references(() => tenants.id)
  .notNull()

export const userWorkspacePreferences = pgTable("user_workspace_preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  workspaceOrder: jsonb("workspace_order").$type<string[]>().notNull().default([]),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
})

export const workspaces = pgTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    tenantId: tenantIdField,
    type: workspaceTypeEnum("type").notNull().default("shared"),
    ownerId: text("owner_id").references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("workspaces_one_private_per_user_per_tenant")
      .on(t.tenantId, t.ownerId)
      .where(sql`${t.ownerId} is not null`),
  ],
)

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: text("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    userId: text("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    addedAt: timestamp("added_at").defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.userId] }),
  }),
)

export const FOLDERS_WORKSPACE_NAME_CI_UNIQUE = "folders_workspace_name_ci_unique"

export const folders = pgTable(
  "folders",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .references(() => workspaces.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex(FOLDERS_WORKSPACE_NAME_CI_UNIQUE).on(
      t.workspaceId,
      sql`lower(${t.name})`,
    ),
  ],
)

export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").references(() => tenants.id),
    workspaceId: text("workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    folderId: text("folder_id").references(() => folders.id, {
      onDelete: "set null",
    }),
    agentId: text("agent_id")
      .references((): AnyPgColumn => agents.id)
      .notNull(),
    title: text("title"),
    description: text("description"),
    disabled: boolean("disabled").notNull().default(false),
    bifrostProjectId: text("bifrost_project_id"),
    lastPromptAt: timestamp("last_prompt_at"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "restrict" }),
    createdByProjectId: text("created_by_project_id").references((): AnyPgColumn => projects.id, {
      onDelete: "set null",
    }),
    kind: text("kind").$type<ProjectKindValue>(),
    importedAgent: text("imported_agent"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_projects_created_by_project").on(table.createdByProjectId),
    index("idx_projects_tenant_kind").on(table.tenantId, table.kind),
    check(
      "projects_kind_check",
      sql`${table.kind} in ('skill_builder_chat', 'agent_builder_chat', 'test')`,
    ),
  ],
)

export const environments = pgTable(
  "environments",
  {
    id: text("id").primaryKey(),
    tenantId: tenantIdField,
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    shortName: text("short_name"),
    description: text("description"),
    color: text("color").default("#3B82F6").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    isProtected: boolean("is_protected").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    unique("environments_tenant_id_name_unique").on(table.tenantId, table.name),
    unique("environments_tenant_id_slug_unique").on(table.tenantId, table.slug),
    uniqueIndex("environments_one_default_per_tenant")
      .on(table.tenantId)
      .where(sql`${table.isDefault}`),
  ],
)

export const projectEnvironments = pgTable(
  "project_environments",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    environmentId: text("environment_id").references(() => environments.id),
    isDefault: boolean("is_default").notNull().default(false),
    directory: text("directory").notNull(),
    status: projectStatusEnum("status").notNull().default("starting"),
    podIp: text("pod_ip"),
    sessionId: text("session_id"),
    platformVersion: text("platform_version").notNull(),
    authMode: projectAuthModeEnum("auth_mode").notNull().default("public"),
    deployedCommitSha: text("deployed_commit_sha"),
    lastActiveAt: timestamp("last_active_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    unique("project_environments_project_id_environment_id_unique").on(
      table.projectId,
      table.environmentId,
    ),
    index("idx_project_environments_project").on(table.projectId),
    index("idx_project_environments_status").on(table.status),
    index("idx_project_environments_environment").on(table.environmentId),
  ],
)

export const projectSettings = pgTable("project_settings", {
  projectId: text("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  timeoutIdle: bigint("timeout_idle", { mode: "number" }).notNull(),
  appTimeoutIdle: bigint("app_timeout_idle", { mode: "number" }).notNull(),
  timezone: text("timezone").notNull().default("UTC"),
  requestLogMode: requestLogModeEnum("request_log_mode").notNull().default("full"),
  requestLogBodyLimit: integer("request_log_body_limit").notNull().default(256 * 1024),
})

export const projectPodSettings = pgTable("project_pod_settings", {
  projectId: text("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  podClass: podClassEnum("pod_class").notNull().default("small"),
  cpuMillicores: integer("cpu_millicores").notNull(),
  memoryRequestMib: integer("memory_request_mib").notNull(),
  memoryLimitMib: integer("memory_limit_mib").notNull(),
})

export const projectApps = pgTable(
  "project_app",
  {
    projectEnvironmentId: text("project_environment_id")
      .primaryKey()
      .references(() => projectEnvironments.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name"),
    description: text("description"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [index("idx_project_app_project").on(table.projectId)],
)

export const projectAgentUpdates = pgTable(
  "project_agent_updates",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    projectEnvironmentId: text("project_environment_id").references(() => projectEnvironments.id, {
      onDelete: "cascade",
    }),
    agentId: text("agent_id")
      .references(() => agents.id)
      .notNull(),
    fromVersion: text("from_version"),
    targetVersion: text("target_version").notNull(),
    status: agentUpdateStatusEnum("status").notNull().default("running"),
    requiresPodRecreate: boolean("requires_pod_recreate").notNull().default(false),
    reloadStatus: text("reload_status"),
    reloadAttempt: integer("reload_attempt").notNull().default(0),
    appliedMigrations: jsonb("applied_migrations").$type<string[]>().notNull().default([]),
    skippedMigrations: jsonb("skipped_migrations").$type<string[]>().notNull().default([]),
    conflicts: jsonb("conflicts")
      .$type<{ migrationId: string; path: string; reason: string }[]>()
      .notNull()
      .default([]),
    failedMigrations: jsonb("failed_migrations")
      .$type<{ migrationId: string; error: string }[]>()
      .notNull()
      .default([]),
    error: text("error"),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_project_agent_updates_project").on(table.projectId),
    index("idx_project_agent_updates_status").on(table.status),
    index("idx_project_agent_updates_project_agent").on(table.projectId, table.agentId),
  ],
)

export const projectVirtualKeys = pgTable("project_virtual_keys", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .references(() => projects.id, { onDelete: "cascade" })
    .notNull(),
  projectEnvironmentId: text("project_environment_id").references(() => projectEnvironments.id, {
    onDelete: "cascade",
  }),
  tenantId: text("tenant_id").references(() => tenants.id),
  keyType: keyTypeEnum("key_type").notNull().default("chat"),
  bifrostKeyId: text("bifrost_key_id").notNull(),
  bifrostKeyToken: text("bifrost_key_token").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [index("idx_project_virtual_keys_environment").on(table.projectEnvironmentId)])

export const deletedProjectEnvironments = pgTable("deleted_project_environments", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  tenantId: text("tenant_id"),
  directory: text("directory").notNull(),
  deletedAt: timestamp("deleted_at").defaultNow().notNull(),
})

export const projectDuplicateJobs = pgTable(
  "project_duplicate_jobs",
  {
    id: text("id").primaryKey(),
    sourceProjectId: text("source_project_id").notNull(),
    targetProjectId: text("target_project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    tenantId: text("tenant_id").notNull(),
    status: projectDuplicateStatusEnum("status").notNull().default("queued"),
    bytesTotal: bigint("bytes_total", { mode: "number" }).notNull().default(0),
    bytesCopied: bigint("bytes_copied", { mode: "number" }).notNull().default(0),
    error: text("error"),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    unique("project_duplicate_jobs_target_unique").on(table.targetProjectId),
    index("idx_project_duplicate_jobs_source").on(table.sourceProjectId),
    index("idx_project_duplicate_jobs_status").on(table.status),
  ],
)

export const projectPublishJobs = pgTable(
  "project_publish_jobs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    projectEnvironmentId: text("project_environment_id")
      .references(() => projectEnvironments.id, { onDelete: "cascade" })
      .notNull(),
    environmentId: text("environment_id")
      .references(() => environments.id)
      .notNull(),
    tenantId: text("tenant_id").notNull(),
    status: projectPublishStatusEnum("status").notNull().default("queued"),
    commitSha: text("commit_sha"),
    previousCommitSha: text("previous_commit_sha"),
    error: text("error"),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_project_publish_jobs_project").on(table.projectId),
    index("idx_project_publish_jobs_environment").on(table.projectEnvironmentId),
    index("idx_project_publish_jobs_status").on(table.status),
    uniqueIndex("uq_project_publish_jobs_one_active")
      .on(table.projectId, table.environmentId)
      .where(sql`${table.status} in ('queued', 'committing', 'swapping', 'building', 'migrating')`),
  ],
)

export const projectTransferJobs = pgTable(
  "project_transfer_jobs",
  {
    id: text("id").primaryKey(),
    kind: projectTransferKindEnum("kind").notNull(),
    projectId: text("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    tenantId: text("tenant_id").notNull(),
    status: projectTransferStatusEnum("status").notNull().default("queued"),
    bytesTotal: bigint("bytes_total", { mode: "number" }).notNull().default(0),
    bytesProcessed: bigint("bytes_processed", { mode: "number" }).notNull().default(0),
    fileName: text("file_name"),
    fileSize: bigint("file_size", { mode: "number" }),
    agentFallbackFrom: text("agent_fallback_from"),
    error: text("error"),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_project_transfer_jobs_project").on(table.projectId),
    index("idx_project_transfer_jobs_status").on(table.status),
    index("idx_project_transfer_jobs_kind").on(table.kind),
    uniqueIndex("uq_project_transfer_jobs_one_active")
      .on(table.kind, table.projectId)
      .where(sql`${table.status} not in ('completed', 'failed')`),
  ],
)

export const projectGatewayKeys = pgTable("project_gateway_keys", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .references(() => projects.id, { onDelete: "cascade" })
    .notNull(),
  projectEnvironmentId: text("project_environment_id").references(() => projectEnvironments.id, {
    onDelete: "cascade",
  }),
  tenantId: text("tenant_id").references(() => tenants.id),
  token: text("token").notNull().unique(),
  status: text("status").notNull().default("active"),
  purpose: text("purpose").$type<GatewayKeyPurposeValue>().notNull().default("service"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_project_gateway_keys_environment").on(table.projectEnvironmentId),
  check("project_gateway_keys_purpose_check", sql`${table.purpose} in ('service', 'platform-api')`),
])

export const gatewayAuditLogs = pgTable("gateway_audit_logs", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .references(() => projects.id, { onDelete: "cascade" })
    .notNull(),
  projectEnvironmentId: text("project_environment_id").references(() => projectEnvironments.id, {
    onDelete: "cascade",
  }),
  tenantId: text("tenant_id")
    .references(() => tenants.id)
    .notNull(),
  service: text("service").notNull(),
  status: text("status").notNull(),
  durationMs: bigint("duration_ms", { mode: "number" }),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
})

export const externalServiceResource = pgTable(
  "external_service_resource",
  {
    service: text("service").notNull(),
    resourceKey: text("resource_key").notNull(),
    value: jsonb("value").$type<JsonValue>().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.service, table.resourceKey] })],
)

export const externalServiceConfig = pgTable(
  "external_service_config",
  {
    service: text("service").notNull(),
    projectEnvironmentId: text("project_environment_id")
      .references(() => projectEnvironments.id, { onDelete: "cascade" })
      .notNull(),
    value: jsonb("value").$type<JsonValue>().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.service, table.projectEnvironmentId] }),
  ],
)

export const externalServiceUsage = pgTable(
  "external_service_usage",
  {
    id: text("id").primaryKey(),
    tenantId: tenantIdField,
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    projectEnvironmentId: text("project_environment_id").references(
      () => projectEnvironments.id,
      { onDelete: "set null" },
    ),
    service: text("service").notNull(),
    month: date("month").notNull(),
    count: bigint("count", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    unique("external_service_usage_bucket_unique").on(
      table.tenantId,
      table.projectId,
      table.projectEnvironmentId,
      table.service,
      table.month,
    ),
    index("idx_external_service_usage_month").on(table.month),
    index("idx_external_service_usage_tenant_month").on(
      table.tenantId,
      table.month,
    ),
  ],
)

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  keycloakId: text("keycloak_id").notNull().unique(),
  email: text("email"),
  displayName: text("display_name"),
  groups: text("groups"),
  lastAccessTime: timestamp("last_access_time"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
})

export const userTenants = pgTable(
  "user_tenants",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.tenantId] }),
    index("idx_user_tenants_tenant").on(table.tenantId),
  ],
)

export const projectSchedules = pgTable(
  "project_schedules",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    projectEnvironmentId: text("project_environment_id")
      .references(() => projectEnvironments.id, {
        onDelete: "cascade",
      })
      .notNull(),
    tenantId: text("tenant_id")
      .references(() => tenants.id)
      .notNull(),
    name: text("name").notNull(),
    cronPattern: text("cron_pattern").notNull(),
    timeZone: text("time_zone").notNull().default("UTC"),
    targetPath: text("target_path").notNull(),
    method: text("method").notNull().default("POST"),
    body: jsonb("body"),
    headers: jsonb("headers"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    unique("project_schedules_environment_id_name_unique").on(
      table.projectEnvironmentId,
      table.name,
    ),
  ],
)

export const scheduleExecutions = pgTable(
  "schedule_executions",
  {
    id: text("id").primaryKey(),
    scheduleId: text("schedule_id")
      .references(() => projectSchedules.id, { onDelete: "cascade" })
      .notNull(),
    trigger: text("trigger").notNull().default("cron"),
    firedAt: timestamp("fired_at").defaultNow().notNull(),
    statusCode: integer("status_code"),
    latencyMs: bigint("latency_ms", { mode: "number" }),
    error: text("error"),
  },
  (table) => [index("schedule_executions_schedule_id_fired_at_idx").on(table.scheduleId, table.firedAt)],
)

export const globalTimeoutDefaults = pgTable("global_timeout_defaults", {
  id: text("id").primaryKey(),
  defaultTimeoutIdle: bigint("default_timeout_idle", {
    mode: "number",
  }).notNull(),
  defaultAppTimeoutIdle: bigint("default_app_timeout_idle", {
    mode: "number",
  }).notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
})

export const globalBudgetDefaults = pgTable("global_budget_defaults", {
  id: text("id").primaryKey(),
  defaultTenantBudget: bigint("default_tenant_budget", {
    mode: "number",
  }).notNull(),
  defaultTenantBudgetDuration: text("default_tenant_budget_duration").notNull(),
  defaultProjectBudget: bigint("default_project_budget", {
    mode: "number",
  }).notNull(),
  defaultProjectBudgetDuration: text("default_project_budget_duration").notNull(),
  defaultChatBudget: bigint("default_chat_budget", {
    mode: "number",
  }).notNull(),
  defaultChatBudgetDuration: text("default_chat_budget_duration").notNull(),
  defaultBackendBudget: bigint("default_backend_budget", {
    mode: "number",
  }).notNull(),
  defaultBackendBudgetDuration: text("default_backend_budget_duration").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
})

export const tenantTimeoutDefaults = pgTable("tenant_timeout_defaults", {
  tenantId: text("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  defaultTimeoutIdle: bigint("default_timeout_idle", {
    mode: "number",
  }).notNull(),
  defaultAppTimeoutIdle: bigint("default_app_timeout_idle", {
    mode: "number",
  }).notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
})

export const tenantBudgetDefaults = pgTable("tenant_budget_defaults", {
  tenantId: text("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  defaultTenantBudget: bigint("default_tenant_budget", {
    mode: "number",
  }).notNull(),
  defaultTenantBudgetDuration: text("default_tenant_budget_duration").notNull(),
  defaultProjectBudget: bigint("default_project_budget", {
    mode: "number",
  }).notNull(),
  defaultProjectBudgetDuration: text("default_project_budget_duration").notNull(),
  defaultChatBudget: bigint("default_chat_budget", {
    mode: "number",
  }).notNull(),
  defaultChatBudgetDuration: text("default_chat_budget_duration").notNull(),
  defaultBackendBudget: bigint("default_backend_budget", {
    mode: "number",
  }).notNull(),
  defaultBackendBudgetDuration: text("default_backend_budget_duration").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
})

export const globalLimits = pgTable(
  "global_limits",
  {
    limitKey: text("limit_key").$type<LimitKeyValue>().primaryKey(),
    value: integer("value"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    check("global_limits_limit_key_check", sql`${table.limitKey} in ('projects')`),
    check("global_limits_value_check", sql`${table.value} >= 0`),
  ],
)

export const tenantLimits = pgTable(
  "tenant_limits",
  {
    tenantId: text("tenant_id")
      .references(() => tenants.id, { onDelete: "cascade" })
      .notNull(),
    limitKey: text("limit_key").$type<LimitKeyValue>().notNull(),
    value: integer("value"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.limitKey] }),
    check("tenant_limits_limit_key_check", sql`${table.limitKey} in ('projects')`),
    check("tenant_limits_value_check", sql`${table.value} >= 0`),
  ],
)

export const agentSettings = pgTable("agent_settings", {
  agentId: text("agent_id")
    .primaryKey()
    .references(() => agents.id, { onDelete: "cascade" }),
  defaultEnvironmentId: text("default_environment_id").references(() => environments.id, {
    onDelete: "restrict",
  }),
  platformApi: boolean("platform_api").notNull().default(false),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
})

export const agentProfiles = pgTable(
  "agent_profiles",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .references(() => agents.id, { onDelete: "cascade" })
      .notNull(),
    environmentId: text("environment_id")
      .references(() => environments.id, { onDelete: "restrict" })
      .notNull(),
    promptBody: text("prompt_body"),
    model: text("model"),
    variant: text("variant"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    unique("agent_profiles_agent_id_environment_id_unique").on(table.agentId, table.environmentId),
    index("idx_agent_profiles_environment").on(table.environmentId),
  ],
)

export const skills = pgTable(
  "skills",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").references(() => tenants.id),
    origin: text("origin").notNull().default("built_in"),
    name: text("name").notNull(),
    displayName: text("display_name"),
    description: text("description"),
    visibility: text("visibility").notNull().default("public"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "restrict" }),
    latestVersionId: text("latest_version_id").references((): AnyPgColumn => skillVersions.id, {
      onDelete: "set null",
    }),
    builderChatId: text("builder_chat_id").references((): AnyPgColumn => projects.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("skills_tenant_id_name_unique")
      .on(table.tenantId, table.name)
      .where(sql`${table.tenantId} is not null`),
    uniqueIndex("skills_global_name_unique")
      .on(table.name)
      .where(sql`${table.tenantId} is null`),
    uniqueIndex("skills_builder_chat_id_unique").on(table.builderChatId),
    check("skills_origin_check", sql`${table.origin} in ('built_in', 'custom')`),
    check("skills_visibility_check", sql`${table.visibility} in ('private', 'public')`),
    check(
      "skills_custom_ownership_check",
      sql`${table.origin} = 'built_in' or (${table.tenantId} is not null and ${table.createdBy} is not null)`,
    ),
  ],
)

export const tenantDisabledAgents = pgTable(
  "tenant_disabled_agents",
  {
    tenantId: text("tenant_id")
      .references(() => tenants.id, { onDelete: "cascade" })
      .notNull(),
    agentId: text("agent_id")
      .references(() => agents.id, { onDelete: "cascade" })
      .notNull(),
    disabledAt: timestamp("disabled_at").defaultNow().notNull(),
    disabledBy: text("disabled_by").references(() => users.id, { onDelete: "set null" }),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.agentId] })],
)

export const tenantDisabledSkills = pgTable(
  "tenant_disabled_skills",
  {
    tenantId: text("tenant_id")
      .references(() => tenants.id, { onDelete: "cascade" })
      .notNull(),
    skillId: text("skill_id")
      .references(() => skills.id, { onDelete: "cascade" })
      .notNull(),
    disabledAt: timestamp("disabled_at").defaultNow().notNull(),
    disabledBy: text("disabled_by").references(() => users.id, { onDelete: "set null" }),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.skillId] })],
)

export interface SkillFlags {
  has_executables: boolean
}

export const skillVersions = pgTable(
  "skill_versions",
  {
    id: text("id").primaryKey(),
    skillId: text("skill_id")
      .references(() => skills.id, { onDelete: "cascade" })
      .notNull(),
    version: integer("version").notNull(),
    description: text("description"),
    contentHash: text("content_hash").notNull(),
    flags: jsonb("flags").$type<SkillFlags>().notNull().default({ has_executables: false }),
    lints: jsonb("lints").$type<string[]>().notNull().default([]),
    createdVia: text("created_via").notNull(),
    sourceRef: text("source_ref"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("skill_versions_skill_id_version_unique").on(table.skillId, table.version),
    index("idx_skill_versions_skill").on(table.skillId),
    check(
      "skill_versions_created_via_check",
      sql`${table.createdVia} in ('form', 'builder', 'import', 'duplicate', 'reconciler')`,
    ),
  ],
)

export const skillVersionFiles = pgTable(
  "skill_version_files",
  {
    id: text("id").primaryKey(),
    versionId: text("version_id")
      .references(() => skillVersions.id, { onDelete: "cascade" })
      .notNull(),
    path: text("path").notNull(),
    content: bytea("content").notNull(),
    size: integer("size").notNull(),
    isBinary: boolean("is_binary").notNull(),
    isExecutable: boolean("is_executable").notNull().default(false),
  },
  (table) => [unique("skill_version_files_version_id_path_unique").on(table.versionId, table.path)],
)

export const agentProfileSkills = pgTable(
  "agent_profile_skills",
  {
    profileId: text("profile_id")
      .references(() => agentProfiles.id, { onDelete: "cascade" })
      .notNull(),
    skillId: text("skill_id")
      .references(() => skills.id, { onDelete: "restrict" })
      .notNull(),
    skillVersionId: text("skill_version_id")
      .references(() => skillVersions.id, { onDelete: "restrict" })
      .notNull(),
    addedAt: timestamp("added_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      name: "agent_profile_skills_profile_id_skill_id_pk",
      columns: [table.profileId, table.skillId],
    }),
    index("idx_agent_profile_skills_skill").on(table.skillId),
  ],
)

export const projectSkillDeliveries = pgTable(
  "project_skill_deliveries",
  {
    projectEnvironmentId: text("project_environment_id")
      .references(() => projectEnvironments.id, { onDelete: "cascade" })
      .notNull(),
    skillName: text("skill_name").notNull(),
    skillVersionId: text("skill_version_id").references(() => skillVersions.id, { onDelete: "set null" }),
    contentHash: text("content_hash").notNull(),
    deliveredAt: timestamp("delivered_at").defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      name: "project_skill_deliveries_project_environment_id_skill_name_pk",
      columns: [table.projectEnvironmentId, table.skillName],
    }),
  ],
)

export const projectSkillDeliveryState = pgTable("project_skill_delivery_state", {
  projectEnvironmentId: text("project_environment_id")
    .primaryKey()
    .references(() => projectEnvironments.id, { onDelete: "cascade" }),
  converged: boolean("converged").notNull().default(false),
  pendingSkills: jsonb("pending_skills").$type<string[]>().notNull().default([]),
  omittedSkills: jsonb("omitted_skills").$type<string[]>().notNull().default([]),
  attempt: integer("attempt").notNull().default(0),
  failedAt: timestamp("failed_at"),
  error: text("error"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
})

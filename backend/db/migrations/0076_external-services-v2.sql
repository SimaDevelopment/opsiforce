-- External Services v2: the registry with its Service and Project configurations (each holding its pending after-save hook, a Project configuration also its not-wired mark), the Call log, Service skills as Skills marked by their service, Usage counters, the Publish report and Skill switch-offs; retires the platform API, configures public-api for existing Skill & Agent Builder chats and moves v1 incoming-email addresses into Project configurations.
CREATE TABLE "external_service_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"via" text,
	"external_service_id" text,
	"slug" text NOT NULL,
	"manifest_hash" text,
	"service_environment_id" text,
	"tenant_id" text,
	"project_id" text,
	"project_title" text,
	"project_environment_id" text,
	"operation" text,
	"operation_kind" text,
	"decision" text NOT NULL,
	"status" integer NOT NULL,
	"code" text,
	"detail" text,
	"bounds" jsonb,
	"input_bytes" integer,
	"output_bytes" integer,
	"duration_ms" integer NOT NULL,
	"user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "external_service_calls_kind_check" CHECK ("external_service_calls"."kind" in ('operation', 'form', 'hook', 'inbound', 'delivery')),
	CONSTRAINT "external_service_calls_via_check" CHECK ("external_service_calls"."via" is null or "external_service_calls"."via" in ('agent', 'app', 'form')),
	CONSTRAINT "external_service_calls_decision_check" CHECK ("external_service_calls"."decision" in ('allowed', 'refused')),
	CONSTRAINT "external_service_calls_detail_length_check" CHECK ("external_service_calls"."detail" is null or char_length("external_service_calls"."detail") <= 500)
);
--> statement-breakpoint
CREATE TABLE "external_service_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"external_service_id" text NOT NULL,
	"tenant_id" text,
	"environment" text,
	"values" jsonb NOT NULL,
	"pending_hook" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "external_service_configs_owner_unique" UNIQUE NULLS NOT DISTINCT("external_service_id","tenant_id","environment"),
	CONSTRAINT "external_service_configs_environment_check" CHECK ("external_service_configs"."environment" is null or "external_service_configs"."environment" = 'development')
);
--> statement-breakpoint
CREATE TABLE "external_service_project_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"external_service_id" text NOT NULL,
	"project_environment_id" text NOT NULL,
	"values" jsonb NOT NULL,
	"notice" jsonb,
	"pending_hook" jsonb,
	"unwired_since" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "external_service_project_configs_owner_unique" UNIQUE("external_service_id","project_environment_id")
);
--> statement-breakpoint
CREATE TABLE "external_services" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"origin" text NOT NULL,
	"slug" text NOT NULL,
	"builder_chat_id" text,
	"default_environment_id" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "external_services_builder_chat_check" CHECK (("external_services"."origin" = 'custom') = ("external_services"."builder_chat_id" is not null)),
	CONSTRAINT "external_services_origin_check" CHECK (("external_services"."origin" = 'built_in' and "external_services"."tenant_id" is null) or ("external_services"."origin" = 'custom' and "external_services"."tenant_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "project_environment_skills_off" (
	"project_environment_id" text NOT NULL,
	"skill_name" text NOT NULL,
	"switched_off_by" text,
	"switched_off_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "project_environment_skills_off_pk" PRIMARY KEY("project_environment_id","skill_name")
);
--> statement-breakpoint
DELETE FROM "project_gateway_keys" WHERE "purpose" = 'platform-api';
--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_kind_check";--> statement-breakpoint
ALTER TABLE "skill_versions" DROP CONSTRAINT "skill_versions_created_via_check";--> statement-breakpoint
ALTER TABLE "skills" DROP CONSTRAINT "skills_custom_ownership_check";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "created_by_project_id" text;--> statement-breakpoint
ALTER TABLE "external_service_usage" RENAME COLUMN "count" TO "events";--> statement-breakpoint
ALTER TABLE "external_service_usage" ADD COLUMN "calls" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "external_service_usage" ADD COLUMN "refused" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "external_service_usage" ADD COLUMN "failed" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_publish_jobs" ADD COLUMN "report" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "created_by_project_id" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "external_service_id" text;--> statement-breakpoint
ALTER TABLE "external_service_calls" ADD CONSTRAINT "external_service_calls_external_service_id_external_services_id_fk" FOREIGN KEY ("external_service_id") REFERENCES "public"."external_services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_service_calls" ADD CONSTRAINT "external_service_calls_service_environment_id_environments_id_fk" FOREIGN KEY ("service_environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_service_calls" ADD CONSTRAINT "external_service_calls_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_service_calls" ADD CONSTRAINT "external_service_calls_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_service_calls" ADD CONSTRAINT "external_service_calls_project_environment_id_project_environments_id_fk" FOREIGN KEY ("project_environment_id") REFERENCES "public"."project_environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_service_calls" ADD CONSTRAINT "external_service_calls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_service_configs" ADD CONSTRAINT "external_service_configs_external_service_id_external_services_id_fk" FOREIGN KEY ("external_service_id") REFERENCES "public"."external_services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_service_configs" ADD CONSTRAINT "external_service_configs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_service_project_configs" ADD CONSTRAINT "external_service_project_configs_external_service_id_external_services_id_fk" FOREIGN KEY ("external_service_id") REFERENCES "public"."external_services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_service_project_configs" ADD CONSTRAINT "external_service_project_configs_project_environment_id_project_environments_id_fk" FOREIGN KEY ("project_environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_services" ADD CONSTRAINT "external_services_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_services" ADD CONSTRAINT "external_services_builder_chat_id_projects_id_fk" FOREIGN KEY ("builder_chat_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_services" ADD CONSTRAINT "external_services_default_environment_id_environments_id_fk" FOREIGN KEY ("default_environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_services" ADD CONSTRAINT "external_services_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_environment_skills_off" ADD CONSTRAINT "project_environment_skills_off_project_environment_id_project_environments_id_fk" FOREIGN KEY ("project_environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_environment_skills_off" ADD CONSTRAINT "project_environment_skills_off_switched_off_by_users_id_fk" FOREIGN KEY ("switched_off_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_external_service_calls_environment_service_created" ON "external_service_calls" USING btree ("project_environment_id","external_service_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_external_service_calls_tenant_created" ON "external_service_calls" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_external_service_calls_service_created" ON "external_service_calls" USING btree ("external_service_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_external_service_calls_created" ON "external_service_calls" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_external_service_project_configs_environment" ON "external_service_project_configs" USING btree ("project_environment_id");--> statement-breakpoint
CREATE INDEX "idx_external_service_project_configs_values" ON "external_service_project_configs" USING gin ("values" jsonb_path_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "external_services_builder_chat_id_unique" ON "external_services" USING btree ("builder_chat_id");--> statement-breakpoint
CREATE UNIQUE INDEX "external_services_built_in_slug_unique" ON "external_services" USING btree ("slug") WHERE "external_services"."tenant_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "external_services_tenant_id_slug_unique" ON "external_services" USING btree ("tenant_id","slug") WHERE "external_services"."tenant_id" is not null;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_created_by_project_id_projects_id_fk" FOREIGN KEY ("created_by_project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_created_by_project_id_projects_id_fk" FOREIGN KEY ("created_by_project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_external_service_id_external_services_id_fk" FOREIGN KEY ("external_service_id") REFERENCES "public"."external_services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skills_external_service_id_unique" ON "skills" USING btree ("external_service_id");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_kind_check" CHECK ("projects"."kind" in ('skill_builder_chat', 'agent_builder_chat', 'external_service_builder_chat', 'test'));--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_created_via_check" CHECK ("skill_versions"."created_via" in ('form', 'builder', 'import', 'duplicate', 'reconciler', 'service'));--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_custom_ownership_check" CHECK ("skills"."origin" = 'built_in' or ("skills"."tenant_id" is not null and ("skills"."created_by" is not null or "skills"."external_service_id" is not null)));--> statement-breakpoint
INSERT INTO "external_services" ("id", "origin", "slug")
VALUES (gen_random_uuid()::text, 'built_in', 'incoming-email')
ON CONFLICT ("slug") WHERE "tenant_id" IS NULL DO NOTHING;--> statement-breakpoint
WITH "service" AS (
	SELECT "id" FROM "external_services" WHERE "slug" = 'incoming-email' AND "tenant_id" IS NULL
), "addresses" AS (
	SELECT "project_environment_id", lower(split_part("value"->>'address', '@', 1)) AS "local_part"
	FROM "external_service_config"
	WHERE "service" = 'incoming-email' AND position('@' IN coalesce("value"->>'address', '')) > 1
)
INSERT INTO "external_service_project_configs" ("id", "external_service_id", "project_environment_id", "values")
SELECT gen_random_uuid()::text, "service"."id", "addresses"."project_environment_id",
	jsonb_build_object(
		'localPart', "addresses"."local_part",
		'operations', '{}'::jsonb,
		'receive', '{"email.received": true}'::jsonb,
		'_labels', '{}'::jsonb
	)
FROM "addresses" CROSS JOIN "service"
ON CONFLICT ("external_service_id", "project_environment_id") DO UPDATE
SET "values" = "external_service_project_configs"."values"
	|| jsonb_build_object(
		'localPart', excluded."values"->'localPart',
		'receive', coalesce("external_service_project_configs"."values"->'receive', '{}'::jsonb) || '{"email.received": true}'::jsonb
	),
	"updated_at" = now()
WHERE NOT ("external_service_project_configs"."values" ? 'localPart');--> statement-breakpoint
INSERT INTO "external_services" ("id", "origin", "slug")
VALUES (gen_random_uuid()::text, 'built_in', 'public-api')
ON CONFLICT ("slug") WHERE "tenant_id" IS NULL DO NOTHING;--> statement-breakpoint
INSERT INTO "external_service_project_configs" ("id", "external_service_id", "project_environment_id", "values")
SELECT gen_random_uuid()::text, "service"."id", "project_environments"."id",
	'{"operations": {"connect_project": true, "create_agent": false, "create_project": true, "create_skill": true, "create_skill_version": true, "delete_project": false, "duplicate_skill": true, "get_agent": true, "get_me": true, "get_project": true, "get_skill": true, "get_skill_files": true, "list_agent_skills": true, "list_agents": true, "list_projects": true, "list_skills": true, "remove_agent_skill": true, "reset_test_project": true, "restart_project": true, "save_agent_template": true, "set_agent_skill": true, "update_agent": true, "update_agent_profile": true, "update_skill": true, "update_test_project": true, "validate_skill": true}, "receive": {}, "_labels": {}}'::jsonb
FROM "project_environments"
JOIN "projects" ON "projects"."id" = "project_environments"."project_id"
JOIN "agents" ON "agents"."id" = "projects"."agent_id"
CROSS JOIN (SELECT "id" FROM "external_services" WHERE "slug" = 'public-api' AND "tenant_id" IS NULL) AS "service"
WHERE "agents"."origin" = 'built_in' AND "agents"."name" = 'skill-agent-builder'
ON CONFLICT ("external_service_id", "project_environment_id") DO NOTHING;

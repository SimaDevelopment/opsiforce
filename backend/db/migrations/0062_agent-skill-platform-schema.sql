CREATE TABLE "agent_profile_skills" (
	"profile_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"skill_version_id" text NOT NULL,
	"added_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_profile_skills_profile_id_skill_id_pk" PRIMARY KEY("profile_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "agent_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"prompt_body" text,
	"model" text,
	"variant" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_profiles_agent_id_environment_id_unique" UNIQUE("agent_id","environment_id")
);
--> statement-breakpoint
CREATE TABLE "agent_settings" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"default_environment_id" text,
	"platform_api" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_version_files" (
	"id" text PRIMARY KEY NOT NULL,
	"version_id" text NOT NULL,
	"path" text NOT NULL,
	"content" "bytea" NOT NULL,
	"size" integer NOT NULL,
	"is_binary" boolean NOT NULL,
	"is_executable" boolean DEFAULT false NOT NULL,
	CONSTRAINT "skill_version_files_version_id_path_unique" UNIQUE("version_id","path")
);
--> statement-breakpoint
CREATE TABLE "skill_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"skill_id" text NOT NULL,
	"version" integer NOT NULL,
	"description" text,
	"content_hash" text NOT NULL,
	"flags" jsonb DEFAULT '{"has_executables":false,"external_urls":[]}'::jsonb NOT NULL,
	"lints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_via" text NOT NULL,
	"source_ref" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "skill_versions_skill_id_version_unique" UNIQUE("skill_id","version"),
	CONSTRAINT "skill_versions_created_via_check" CHECK ("skill_versions"."created_via" in ('form', 'builder', 'import', 'duplicate', 'reconciler'))
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"origin" text DEFAULT 'built_in' NOT NULL,
	"name" text NOT NULL,
	"display_name" text,
	"description" text,
	"visibility" text DEFAULT 'public' NOT NULL,
	"created_by" text,
	"archived" boolean DEFAULT false NOT NULL,
	"latest_version_id" text,
	"created_in_chat_project_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "skills_origin_check" CHECK ("skills"."origin" in ('built_in', 'custom')),
	CONSTRAINT "skills_visibility_check" CHECK ("skills"."visibility" in ('private', 'public')),
	CONSTRAINT "skills_custom_ownership_check" CHECK ("skills"."origin" = 'built_in' or ("skills"."tenant_id" is not null and "skills"."created_by" is not null))
);
--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_name_unique";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "tenant_id" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "origin" text DEFAULT 'built_in' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "visibility" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "archived" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "version" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "variant" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "pool_size" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "created_in_chat_project_id" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_profile_skills" ADD CONSTRAINT "agent_profile_skills_profile_id_agent_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."agent_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profile_skills" ADD CONSTRAINT "agent_profile_skills_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profile_skills" ADD CONSTRAINT "agent_profile_skills_skill_version_id_skill_versions_id_fk" FOREIGN KEY ("skill_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_settings" ADD CONSTRAINT "agent_settings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_settings" ADD CONSTRAINT "agent_settings_default_environment_id_environments_id_fk" FOREIGN KEY ("default_environment_id") REFERENCES "public"."environments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_version_files" ADD CONSTRAINT "skill_version_files_version_id_skill_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."skill_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_latest_version_id_skill_versions_id_fk" FOREIGN KEY ("latest_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_created_in_chat_project_id_projects_id_fk" FOREIGN KEY ("created_in_chat_project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_profile_skills_skill" ON "agent_profile_skills" USING btree ("skill_id");--> statement-breakpoint
CREATE INDEX "idx_agent_profiles_environment" ON "agent_profiles" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "idx_skill_versions_skill" ON "skill_versions" USING btree ("skill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skills_tenant_id_name_unique" ON "skills" USING btree ("tenant_id","name") WHERE "skills"."tenant_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "skills_global_name_unique" ON "skills" USING btree ("name") WHERE "skills"."tenant_id" is null;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_created_in_chat_project_id_projects_id_fk" FOREIGN KEY ("created_in_chat_project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_tenant_id_name_unique" ON "agents" USING btree ("tenant_id","name") WHERE "agents"."tenant_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_global_name_unique" ON "agents" USING btree ("name") WHERE "agents"."tenant_id" is null;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_origin_check" CHECK ("agents"."origin" in ('built_in', 'custom'));--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_visibility_check" CHECK ("agents"."visibility" in ('private', 'public'));--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_custom_ownership_check" CHECK ("agents"."origin" = 'built_in' or ("agents"."tenant_id" is not null and "agents"."created_by" is not null));
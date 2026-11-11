-- Resource presets: named CPU and memory sizes for the platform and for one Organization, an Organization's own numbers for a platform preset, the default preset, a Built-in Agent's Resources per Organization, and Project and Agent rows that name their preset and hold the numbers their pods run at.
CREATE TABLE "resource_presets" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"name" text NOT NULL,
	"cpu_millicores" integer NOT NULL,
	"memory_request_mib" integer NOT NULL,
	"memory_limit_mib" integer NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "resource_presets_default_is_platform" CHECK (not "resource_presets"."is_default" or "resource_presets"."tenant_id" is null)
);
--> statement-breakpoint
CREATE TABLE "tenant_resource_preset_overrides" (
	"tenant_id" text NOT NULL,
	"preset_id" text NOT NULL,
	"cpu_millicores" integer NOT NULL,
	"memory_request_mib" integer NOT NULL,
	"memory_limit_mib" integer NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_resource_preset_overrides_tenant_id_preset_id_pk" PRIMARY KEY("tenant_id","preset_id")
);
--> statement-breakpoint
CREATE TABLE "tenant_agent_pod_settings" (
	"tenant_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"preset_id" text,
	"cpu_millicores" integer NOT NULL,
	"memory_request_mib" integer NOT NULL,
	"memory_limit_mib" integer NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_agent_pod_settings_tenant_id_agent_id_pk" PRIMARY KEY("tenant_id","agent_id")
);
--> statement-breakpoint
ALTER TABLE "resource_presets" ADD CONSTRAINT "resource_presets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_resource_preset_overrides" ADD CONSTRAINT "tenant_resource_preset_overrides_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_resource_preset_overrides" ADD CONSTRAINT "tenant_resource_preset_overrides_preset_id_resource_presets_id_fk" FOREIGN KEY ("preset_id") REFERENCES "public"."resource_presets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_agent_pod_settings" ADD CONSTRAINT "tenant_agent_pod_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_agent_pod_settings" ADD CONSTRAINT "tenant_agent_pod_settings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_agent_pod_settings" ADD CONSTRAINT "tenant_agent_pod_settings_preset_id_resource_presets_id_fk" FOREIGN KEY ("preset_id") REFERENCES "public"."resource_presets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "resource_presets_tenant_name_unique" ON "resource_presets" USING btree ("tenant_id",lower("name")) WHERE "resource_presets"."tenant_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "resource_presets_platform_name_unique" ON "resource_presets" USING btree (lower("name")) WHERE "resource_presets"."tenant_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "resource_presets_one_platform_default" ON "resource_presets" USING btree ("is_default") WHERE "resource_presets"."is_default";--> statement-breakpoint
INSERT INTO "resource_presets" ("id", "name", "cpu_millicores", "memory_request_mib", "memory_limit_mib", "is_default") VALUES
	('small', 'Small', 100, 2048, 4096, true),
	('medium', 'Medium', 1000, 4096, 8192, false),
	('large', 'Large', 2000, 8192, 16384, false);--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "default_resource_preset_id" text;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_default_resource_preset_id_resource_presets_id_fk" FOREIGN KEY ("default_resource_preset_id") REFERENCES "public"."resource_presets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_pod_settings" ADD COLUMN "preset_id" text;--> statement-breakpoint
ALTER TABLE "project_pod_settings" ADD CONSTRAINT "project_pod_settings_preset_id_resource_presets_id_fk" FOREIGN KEY ("preset_id") REFERENCES "public"."resource_presets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_pod_settings" ADD COLUMN "preset_id" text;--> statement-breakpoint
ALTER TABLE "agent_pod_settings" ADD CONSTRAINT "agent_pod_settings_preset_id_resource_presets_id_fk" FOREIGN KEY ("preset_id") REFERENCES "public"."resource_presets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
UPDATE "project_pod_settings" SET
	"preset_id" = "resource_presets"."id",
	"cpu_millicores" = "resource_presets"."cpu_millicores",
	"memory_request_mib" = "resource_presets"."memory_request_mib",
	"memory_limit_mib" = "resource_presets"."memory_limit_mib"
FROM "resource_presets"
WHERE "resource_presets"."id" = "project_pod_settings"."pod_class"::text;--> statement-breakpoint
DELETE FROM "agent_pod_settings" USING "agents"
WHERE "agents"."id" = "agent_pod_settings"."agent_id" AND "agents"."origin" = 'built_in';--> statement-breakpoint
UPDATE "agent_pod_settings" SET
	"preset_id" = "resource_presets"."id",
	"cpu_millicores" = "resource_presets"."cpu_millicores",
	"memory_request_mib" = "resource_presets"."memory_request_mib",
	"memory_limit_mib" = "resource_presets"."memory_limit_mib"
FROM "resource_presets"
WHERE "resource_presets"."id" = "agent_pod_settings"."pod_class"::text;

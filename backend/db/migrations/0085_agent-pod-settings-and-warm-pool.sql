-- Agent pod settings and warm pool: the Resources every new Project of an Agent starts at (no row means Small), how many of its Projects wait ready, and the Organization's Warm pool Limit over all of them.
CREATE TABLE "agent_pod_settings" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"pod_class" "pod_class" DEFAULT 'small' NOT NULL,
	"cpu_millicores" integer NOT NULL,
	"memory_request_mib" integer NOT NULL,
	"memory_limit_mib" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_pod_settings" ADD CONSTRAINT "agent_pod_settings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_settings" ADD COLUMN "warm_pool_size" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
INSERT INTO "agent_settings" ("agent_id", "warm_pool_size")
SELECT "id", "pool_size" FROM "agents" WHERE "pool_size" > 0
ON CONFLICT ("agent_id") DO UPDATE SET "warm_pool_size" = EXCLUDED."warm_pool_size";--> statement-breakpoint
ALTER TABLE "global_limits" DROP CONSTRAINT "global_limits_limit_key_check";--> statement-breakpoint
ALTER TABLE "tenant_limits" DROP CONSTRAINT "tenant_limits_limit_key_check";--> statement-breakpoint
ALTER TABLE "global_limits" ADD CONSTRAINT "global_limits_limit_key_check" CHECK ("global_limits"."limit_key" in ('projects', 'warm_pool'));--> statement-breakpoint
ALTER TABLE "tenant_limits" ADD CONSTRAINT "tenant_limits_limit_key_check" CHECK ("tenant_limits"."limit_key" in ('projects', 'warm_pool'));--> statement-breakpoint
INSERT INTO "global_limits" ("limit_key", "value") VALUES ('warm_pool', 3);

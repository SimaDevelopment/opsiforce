-- Custom domains: one row per address on a customer's own domain, owned by the ProjectEnvironment whose App it reaches, and the custom_domains Limit at a platform value of 50. Existing Organizations get no NULL row and follow that value, because none of them holds a Custom domain the Limit could strand.
CREATE TABLE "custom_domains" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"project_environment_id" text NOT NULL,
	"hostname" text NOT NULL,
	"bare" boolean NOT NULL,
	"zone_start" text NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"is_main" boolean DEFAULT false NOT NULL,
	"dns_answer" text,
	"failure_reason" text,
	"checked_at" timestamp,
	"connected_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "custom_domains_project_environment_id_hostname_unique" UNIQUE("project_environment_id","hostname"),
	CONSTRAINT "custom_domains_status_check" CHECK ("custom_domains"."status" in ('waiting', 'issuing', 'connected', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "custom_domains" ADD CONSTRAINT "custom_domains_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_domains" ADD CONSTRAINT "custom_domains_project_environment_id_project_environments_id_fk" FOREIGN KEY ("project_environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "custom_domains_one_holder_per_hostname" ON "custom_domains" USING btree ("hostname") WHERE "custom_domains"."status" in ('issuing', 'connected', 'failed');--> statement-breakpoint
CREATE UNIQUE INDEX "custom_domains_one_main_per_environment" ON "custom_domains" USING btree ("project_environment_id") WHERE "custom_domains"."is_main";--> statement-breakpoint
CREATE INDEX "idx_custom_domains_tenant" ON "custom_domains" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE "global_limits" DROP CONSTRAINT "global_limits_limit_key_check";--> statement-breakpoint
ALTER TABLE "tenant_limits" DROP CONSTRAINT "tenant_limits_limit_key_check";--> statement-breakpoint
ALTER TABLE "global_limits" ADD CONSTRAINT "global_limits_limit_key_check" CHECK ("global_limits"."limit_key" in ('projects', 'warm_pool', 'custom_domains'));--> statement-breakpoint
ALTER TABLE "tenant_limits" ADD CONSTRAINT "tenant_limits_limit_key_check" CHECK ("tenant_limits"."limit_key" in ('projects', 'warm_pool', 'custom_domains'));--> statement-breakpoint
INSERT INTO "global_limits" ("limit_key", "value") VALUES ('custom_domains', 50);

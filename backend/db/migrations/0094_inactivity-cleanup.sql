ALTER TABLE "global_timeout_defaults" ADD COLUMN "default_disable_after" bigint;--> statement-breakpoint
ALTER TABLE "global_timeout_defaults" ADD COLUMN "default_delete_after" bigint;--> statement-breakpoint
ALTER TABLE "tenant_timeout_defaults" ADD COLUMN "default_disable_after" bigint;--> statement-breakpoint
ALTER TABLE "tenant_timeout_defaults" ADD COLUMN "default_delete_after" bigint;--> statement-breakpoint
ALTER TABLE "project_settings" ADD COLUMN "disable_after" bigint;--> statement-breakpoint
ALTER TABLE "project_settings" ADD COLUMN "delete_after" bigint;--> statement-breakpoint
CREATE TABLE "agent_inactivity_cleanup" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"disable_after" bigint,
	"delete_after" bigint,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_agent_inactivity_cleanup" (
	"tenant_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"disable_after" bigint,
	"delete_after" bigint,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_agent_inactivity_cleanup_tenant_id_agent_id_pk" PRIMARY KEY("tenant_id","agent_id")
);
--> statement-breakpoint
ALTER TABLE "agent_inactivity_cleanup" ADD CONSTRAINT "agent_inactivity_cleanup_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_agent_inactivity_cleanup" ADD CONSTRAINT "tenant_agent_inactivity_cleanup_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_agent_inactivity_cleanup" ADD CONSTRAINT "tenant_agent_inactivity_cleanup_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;

-- An Organization with no tenant_limits row follows global_limits; a row overrides it, and a NULL value means no limit.
-- Organizations that exist today get a NULL row per limit so the platform value applies only to new ones.
CREATE TABLE "global_limits" (
	"limit_key" text PRIMARY KEY NOT NULL,
	"value" integer,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "global_limits_limit_key_check" CHECK ("global_limits"."limit_key" in ('projects')),
	CONSTRAINT "global_limits_value_check" CHECK ("global_limits"."value" >= 0)
);
--> statement-breakpoint
CREATE TABLE "tenant_limits" (
	"tenant_id" text NOT NULL,
	"limit_key" text NOT NULL,
	"value" integer,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_limits_tenant_id_limit_key_pk" PRIMARY KEY("tenant_id","limit_key"),
	CONSTRAINT "tenant_limits_limit_key_check" CHECK ("tenant_limits"."limit_key" in ('projects')),
	CONSTRAINT "tenant_limits_value_check" CHECK ("tenant_limits"."value" >= 0)
);
--> statement-breakpoint
ALTER TABLE "tenant_limits" ADD CONSTRAINT "tenant_limits_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "global_limits" ("limit_key", "value") VALUES ('projects', 5);--> statement-breakpoint
INSERT INTO "tenant_limits" ("tenant_id", "limit_key", "value") SELECT "id", 'projects', NULL FROM "tenants";

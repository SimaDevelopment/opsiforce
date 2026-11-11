ALTER TYPE "public"."project_auth_mode" ADD VALUE 'provider';--> statement-breakpoint
CREATE TABLE "sign_in_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"discovery_url" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text NOT NULL,
	"scope" text DEFAULT 'openid profile email' NOT NULL,
	"required_claim_name" text,
	"required_claim_values" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"groups_claim" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sign_in_providers_tenant_id_name_unique" UNIQUE("tenant_id","name")
);
--> statement-breakpoint
ALTER TABLE "project_environments" ADD COLUMN "sign_in_provider_id" uuid;--> statement-breakpoint
ALTER TABLE "sign_in_providers" ADD CONSTRAINT "sign_in_providers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_environments" ADD CONSTRAINT "project_environments_sign_in_provider_id_sign_in_providers_id_fk" FOREIGN KEY ("sign_in_provider_id") REFERENCES "public"."sign_in_providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_project_environments_sign_in_provider" ON "project_environments" USING btree ("sign_in_provider_id");--> statement-breakpoint
ALTER TABLE "project_environments" ADD CONSTRAINT "project_environments_sign_in_provider_check" CHECK (("project_environments"."auth_mode"::text = 'provider') = ("project_environments"."sign_in_provider_id" is not null));

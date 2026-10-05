-- A row with a NULL tenant_id is a platform provider, and its enabled and weight are every Organization's default for it; an Organization row of the same provider overrides that default.
-- An existing deployment (one with Organizations) is cut over to the providers Helm declares at 0 / 1 / 1, which route like the old 0 / 1 / 0.3.
-- A fresh install gets no rows here: the backend seeds its platform providers from env at first boot.
CREATE TABLE "model_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text,
	"bifrost_provider" text NOT NULL,
	"enabled" boolean NOT NULL,
	"weight" integer NOT NULL,
	CONSTRAINT "model_providers_tenant_id_bifrost_provider_unique" UNIQUE NULLS NOT DISTINCT("tenant_id","bifrost_provider"),
	CONSTRAINT "model_providers_weight_check" CHECK ("model_providers"."weight" between 0 and 100)
);
--> statement-breakpoint
ALTER TABLE "model_providers" ADD CONSTRAINT "model_providers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "model_providers" ("tenant_id", "bifrost_provider", "enabled", "weight") SELECT NULL, "cutover"."bifrost_provider", true, "cutover"."weight" FROM (VALUES ('openai', 0), ('anthropic', 1), ('custom-openai-1', 1)) AS "cutover"("bifrost_provider", "weight") WHERE EXISTS (SELECT 1 FROM "tenants");

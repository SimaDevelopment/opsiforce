-- Who may use a Built-in model provider, by its name. Mode 'every' makes it available to every Organization, new ones included, except the Organizations listed; mode 'chosen' makes it available only to the Organizations listed. A provider with no availability row is available to every Organization.
CREATE TABLE "model_provider_availability" (
	"name" text PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	CONSTRAINT "model_provider_availability_mode_check" CHECK ("model_provider_availability"."mode" in ('every', 'chosen'))
);
--> statement-breakpoint
CREATE TABLE "model_provider_availability_tenants" (
	"name" text NOT NULL,
	"tenant_id" text NOT NULL,
	CONSTRAINT "model_provider_availability_tenants_name_tenant_id_pk" PRIMARY KEY("name","tenant_id")
);
--> statement-breakpoint
ALTER TABLE "model_provider_availability_tenants" ADD CONSTRAINT "model_provider_availability_tenants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;

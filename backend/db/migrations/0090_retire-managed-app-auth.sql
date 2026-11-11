-- The platform-operated managed App Auth mode is retired without a replacement: its environments become public (the backend removes their gates at start), and the Makara organization name it read goes.
ALTER TABLE "tenant_settings" DROP CONSTRAINT "tenant_settings_external_tenant_name_unique";--> statement-breakpoint
ALTER TABLE "project_environments" DROP CONSTRAINT "project_environments_sign_in_provider_check";--> statement-breakpoint
ALTER TABLE "project_environments" ALTER COLUMN "auth_mode" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "project_environments" ALTER COLUMN "auth_mode" SET DEFAULT 'public'::text;--> statement-breakpoint
UPDATE "project_environments" SET "auth_mode" = 'public', "updated_at" = now() WHERE "auth_mode" = 'managed';--> statement-breakpoint
DROP TYPE "public"."project_auth_mode";--> statement-breakpoint
CREATE TYPE "public"."project_auth_mode" AS ENUM('public', 'manual', 'provider');--> statement-breakpoint
ALTER TABLE "project_environments" ALTER COLUMN "auth_mode" SET DEFAULT 'public'::"public"."project_auth_mode";--> statement-breakpoint
ALTER TABLE "project_environments" ALTER COLUMN "auth_mode" SET DATA TYPE "public"."project_auth_mode" USING "auth_mode"::"public"."project_auth_mode";--> statement-breakpoint
ALTER TABLE "project_environments" ADD CONSTRAINT "project_environments_sign_in_provider_check" CHECK (("project_environments"."auth_mode"::text = 'provider') = ("project_environments"."sign_in_provider_id" is not null));--> statement-breakpoint
ALTER TABLE "tenant_settings" DROP COLUMN "external_tenant_name";

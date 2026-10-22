ALTER TABLE "model_providers" RENAME COLUMN "enabled" TO "chat_enabled";--> statement-breakpoint
ALTER TABLE "model_providers" RENAME COLUMN "weight" TO "chat_weight";--> statement-breakpoint
ALTER TABLE "model_providers" RENAME CONSTRAINT "model_providers_weight_check" TO "model_providers_chat_weight_check";--> statement-breakpoint
ALTER TABLE "model_providers" ADD COLUMN "backend_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "model_providers" ADD COLUMN "backend_weight" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "model_providers" ADD CONSTRAINT "model_providers_backend_weight_check" CHECK ("model_providers"."backend_weight" between 0 and 100);--> statement-breakpoint
UPDATE "model_providers" SET "backend_enabled" = true WHERE "bifrost_provider" IN ('openai', 'anthropic');--> statement-breakpoint
ALTER TABLE "model_providers" ADD COLUMN "bifrost_key" text;--> statement-breakpoint
ALTER TABLE "model_providers" ADD COLUMN "base_format" text;--> statement-breakpoint
ALTER TABLE "model_providers" ADD CONSTRAINT "model_providers_base_format_check" CHECK ("model_providers"."base_format" in ('openai', 'anthropic'));--> statement-breakpoint
ALTER TABLE "model_providers" DROP CONSTRAINT "model_providers_tenant_id_bifrost_provider_unique";--> statement-breakpoint
ALTER TABLE "model_providers" ADD CONSTRAINT "model_providers_tenant_id_bifrost_provider_bifrost_key_base_format_unique" UNIQUE NULLS NOT DISTINCT("tenant_id","bifrost_provider","bifrost_key","base_format");

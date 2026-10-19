-- Built-ins records: the Call log gains the records-file shape (path, outcome + reason), and Usage keeps one row per counter (name, label, value) in place of the four fixed columns.
ALTER TABLE "external_service_calls" ALTER COLUMN "kind" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "external_service_calls" ALTER COLUMN "decision" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "external_service_calls" ADD COLUMN "request_id" text;--> statement-breakpoint
ALTER TABLE "external_service_calls" ADD COLUMN "caller_kind" text;--> statement-breakpoint
ALTER TABLE "external_service_calls" ADD COLUMN "environment" text;--> statement-breakpoint
ALTER TABLE "external_service_calls" ADD COLUMN "method" text;--> statement-breakpoint
ALTER TABLE "external_service_calls" ADD COLUMN "path" text;--> statement-breakpoint
ALTER TABLE "external_service_calls" ADD COLUMN "route" text;--> statement-breakpoint
ALTER TABLE "external_service_calls" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "external_service_calls" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "external_service_calls" ADD COLUMN "notes" jsonb;--> statement-breakpoint
UPDATE "external_service_calls" SET
	"request_id" = "id",
	"caller_kind" = CASE WHEN "kind" = 'operation' THEN 'call' ELSE 'platform' END,
	"method" = 'POST',
	"path" = CASE "kind"
		WHEN 'operation' THEN '/' || coalesce("operation", '')
		WHEN 'inbound' THEN '/.well-known/opsiforce/webhook'
		WHEN 'hook' THEN '/.well-known/opsiforce/hooks/' || coalesce("operation", '')
		WHEN 'form' THEN '/.well-known/opsiforce/' || coalesce("operation_kind", 'options') || '/' || coalesce("operation", '')
		ELSE '/'
	END,
	"route" = "operation",
	"outcome" = CASE
		WHEN "decision" = 'refused' AND "status" = 404 THEN 'not supported'
		WHEN "decision" = 'refused' THEN 'not allowed'
		WHEN "status" >= 400 OR "status" = 0 THEN 'failed'
		ELSE 'handled'
	END,
	"reason" = coalesce("detail", "code"),
	"notes" = '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "external_service_calls" ADD CONSTRAINT "external_service_calls_outcome_check" CHECK ("external_service_calls"."outcome" is null or "external_service_calls"."outcome" in ('handled', 'not supported', 'not allowed', 'failed'));--> statement-breakpoint
ALTER TABLE "external_service_calls" ADD CONSTRAINT "external_service_calls_caller_kind_check" CHECK ("external_service_calls"."caller_kind" is null or "external_service_calls"."caller_kind" in ('call', 'platform'));--> statement-breakpoint
ALTER TABLE "external_service_usage" DROP CONSTRAINT "external_service_usage_bucket_unique";--> statement-breakpoint
ALTER TABLE "external_service_usage" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "external_service_usage" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "external_service_usage" ADD COLUMN "value" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
INSERT INTO "external_service_usage" ("id", "tenant_id", "project_id", "project_environment_id", "service", "month", "name", "label", "value", "created_at", "updated_at")
SELECT gen_random_uuid()::text, u."tenant_id", u."project_id", u."project_environment_id", u."service", u."month", c."name", c."label", c."value", u."created_at", u."updated_at"
FROM "external_service_usage" u
CROSS JOIN LATERAL (VALUES
	('requests', 'Requests', u."calls"),
	('not_allowed', 'Not allowed', u."refused"),
	('failed', 'Failed', u."failed"),
	('events', 'Events', u."events")
) AS c ("name", "label", "value")
WHERE u."name" IS NULL AND c."value" > 0;--> statement-breakpoint
DELETE FROM "external_service_usage" WHERE "name" IS NULL;--> statement-breakpoint
ALTER TABLE "external_service_usage" ALTER COLUMN "name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "external_service_usage" ALTER COLUMN "label" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "external_service_usage" DROP COLUMN "calls";--> statement-breakpoint
ALTER TABLE "external_service_usage" DROP COLUMN "refused";--> statement-breakpoint
ALTER TABLE "external_service_usage" DROP COLUMN "failed";--> statement-breakpoint
ALTER TABLE "external_service_usage" DROP COLUMN "events";--> statement-breakpoint
ALTER TABLE "external_service_usage" ADD CONSTRAINT "external_service_usage_count_unique" UNIQUE("tenant_id","service","month","project_id","project_environment_id","name");

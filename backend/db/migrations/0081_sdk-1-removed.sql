-- The contract step of the transparent-proxy rework: Operations and the old Gate go. Project configurations lose the operations/receive switches, a public-api Agent's switches become its five settings (as 0080 did for Project configurations) and every other Agent's switches go, and external_service_calls keeps only the built-ins Call log written through the built-ins adapter.
UPDATE "external_service_project_configs" SET "values" = "values" - 'operations' - 'receive' WHERE "values" ?| array['operations', 'receive'];--> statement-breakpoint
UPDATE "agent_profile_skills" AS "profile_skill"
SET "service_settings" = jsonb_build_object(
	'authorSkillsAndAgents', coalesce("profile_skill"."service_settings"->'operations' ? 'create_skill' OR "profile_skill"."service_settings"->'operations' ? 'create_skill_version' OR "profile_skill"."service_settings"->'operations' ? 'update_skill' OR "profile_skill"."service_settings"->'operations' ? 'duplicate_skill' OR "profile_skill"."service_settings"->'operations' ? 'update_agent' OR "profile_skill"."service_settings"->'operations' ? 'update_agent_profile' OR "profile_skill"."service_settings"->'operations' ? 'save_agent_template' OR "profile_skill"."service_settings"->'operations' ? 'set_agent_skill' OR "profile_skill"."service_settings"->'operations' ? 'remove_agent_skill', false),
	'createAgents', coalesce("profile_skill"."service_settings"->'operations' ? 'create_agent', false),
	'createProjects', coalesce("profile_skill"."service_settings"->'operations' ? 'create_project', false),
	'driveCreatedProjects', coalesce("profile_skill"."service_settings"->'operations' ? 'connect_project' OR "profile_skill"."service_settings"->'operations' ? 'restart_project' OR "profile_skill"."service_settings"->'operations' ? 'update_test_project' OR "profile_skill"."service_settings"->'operations' ? 'reset_test_project', false),
	'deleteCreatedProjects', coalesce("profile_skill"."service_settings"->'operations' ? 'delete_project', false),
	'maxCreatedProjects', 5
)
FROM "skills" AS "skill", "external_services" AS "service"
WHERE "skill"."id" = "profile_skill"."skill_id"
	AND "service"."id" = "skill"."external_service_id"
	AND "service"."slug" = 'public-api'
	AND "service"."tenant_id" IS NULL
	AND jsonb_typeof("profile_skill"."service_settings"->'operations') = 'array';--> statement-breakpoint
UPDATE "agent_profile_skills" SET "service_settings" = NULL WHERE "service_settings" ?| array['operations', 'receive'];--> statement-breakpoint
DELETE FROM "external_service_calls" WHERE "kind" IS NOT NULL OR "outcome" IS NULL OR "caller_kind" IS NULL OR "request_id" IS NULL OR "method" IS NULL OR "path" IS NULL;--> statement-breakpoint
ALTER TABLE "external_service_calls" DROP CONSTRAINT "external_service_calls_kind_check";--> statement-breakpoint
ALTER TABLE "external_service_calls" DROP CONSTRAINT "external_service_calls_via_check";--> statement-breakpoint
ALTER TABLE "external_service_calls" DROP CONSTRAINT "external_service_calls_decision_check";--> statement-breakpoint
ALTER TABLE "external_service_calls" DROP CONSTRAINT "external_service_calls_detail_length_check";--> statement-breakpoint
ALTER TABLE "external_service_calls" DROP CONSTRAINT "external_service_calls_outcome_check";--> statement-breakpoint
ALTER TABLE "external_service_calls" DROP CONSTRAINT "external_service_calls_caller_kind_check";--> statement-breakpoint
ALTER TABLE "external_service_calls" DROP CONSTRAINT "external_service_calls_service_environment_id_environments_id_fk";--> statement-breakpoint
ALTER TABLE "external_service_calls" DROP CONSTRAINT "external_service_calls_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "external_service_calls" DROP COLUMN "kind";--> statement-breakpoint
ALTER TABLE "external_service_calls" DROP COLUMN "via";--> statement-breakpoint
ALTER TABLE "external_service_calls" DROP COLUMN "decision";--> statement-breakpoint
ALTER TABLE "external_service_calls" DROP COLUMN "code";--> statement-breakpoint
ALTER TABLE "external_service_calls" DROP COLUMN "detail";--> statement-breakpoint
ALTER TABLE "external_service_calls" DROP COLUMN "bounds";--> statement-breakpoint
ALTER TABLE "external_service_calls" DROP COLUMN "operation";--> statement-breakpoint
ALTER TABLE "external_service_calls" DROP COLUMN "operation_kind";--> statement-breakpoint
ALTER TABLE "external_service_calls" DROP COLUMN "project_title";--> statement-breakpoint
ALTER TABLE "external_service_calls" DROP COLUMN "service_environment_id";--> statement-breakpoint
ALTER TABLE "external_service_calls" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "external_service_calls" ALTER COLUMN "request_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "external_service_calls" ALTER COLUMN "caller_kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "external_service_calls" ALTER COLUMN "method" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "external_service_calls" ALTER COLUMN "path" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "external_service_calls" ALTER COLUMN "outcome" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "external_service_calls" ADD CONSTRAINT "external_service_calls_outcome_check" CHECK ("external_service_calls"."outcome" in ('handled', 'not supported', 'not allowed', 'failed'));--> statement-breakpoint
ALTER TABLE "external_service_calls" ADD CONSTRAINT "external_service_calls_caller_kind_check" CHECK ("external_service_calls"."caller_kind" in ('call', 'platform'));

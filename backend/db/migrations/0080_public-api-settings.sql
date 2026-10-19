-- Public API on the new shape: every stored public-api Operation map becomes the five Project-form settings, each on when any of its old Operations was on, with Max created Projects 5; the operations and receive keys go.
UPDATE "external_service_project_configs" AS "config"
SET "values" = ("config"."values" - 'operations' - 'receive')
	|| jsonb_build_object(
		'authorSkillsAndAgents', coalesce("config"."values"->'operations' @> '{"create_skill": true}' OR "config"."values"->'operations' @> '{"create_skill_version": true}' OR "config"."values"->'operations' @> '{"update_skill": true}' OR "config"."values"->'operations' @> '{"duplicate_skill": true}' OR "config"."values"->'operations' @> '{"update_agent": true}' OR "config"."values"->'operations' @> '{"update_agent_profile": true}' OR "config"."values"->'operations' @> '{"save_agent_template": true}' OR "config"."values"->'operations' @> '{"set_agent_skill": true}' OR "config"."values"->'operations' @> '{"remove_agent_skill": true}', false),
		'createAgents', coalesce("config"."values"->'operations' @> '{"create_agent": true}', false),
		'createProjects', coalesce("config"."values"->'operations' @> '{"create_project": true}', false),
		'driveCreatedProjects', coalesce("config"."values"->'operations' @> '{"connect_project": true}' OR "config"."values"->'operations' @> '{"restart_project": true}' OR "config"."values"->'operations' @> '{"update_test_project": true}' OR "config"."values"->'operations' @> '{"reset_test_project": true}', false),
		'deleteCreatedProjects', coalesce("config"."values"->'operations' @> '{"delete_project": true}', false),
		'maxCreatedProjects', 5
	),
	"updated_at" = now()
FROM "external_services" AS "service"
WHERE "service"."id" = "config"."external_service_id"
	AND "service"."slug" = 'public-api'
	AND "service"."tenant_id" IS NULL
	AND "config"."values" ? 'operations';

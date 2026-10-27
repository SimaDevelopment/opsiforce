-- Adds project_environments.short_id, the App Short ID (ADR-0012): an insert trigger assigns each new row the shortest free prefix of its id without dashes, 12 hex characters first, then 2 more at a time, and existing rows are backfilled oldest first.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE FUNCTION "free_project_environment_short_id"("project_environment_id" text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
	"hex" text := replace("project_environment_id", '-', '');
	"prefix_length" integer := 12;
BEGIN
	WHILE "prefix_length" < char_length("hex")
		AND EXISTS (SELECT 1 FROM "project_environments" WHERE "short_id" = left("hex", "prefix_length")) LOOP
		"prefix_length" := "prefix_length" + 2;
	END LOOP;
	RETURN left("hex", "prefix_length");
END
$$;--> statement-breakpoint
CREATE FUNCTION "assign_project_environment_short_id"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	PERFORM pg_advisory_xact_lock(hashtext('project_environments.short_id:' || left(replace(NEW."id", '-', ''), 12)));
	NEW."short_id" := "free_project_environment_short_id"(NEW."id");
	RETURN NEW;
END
$$;--> statement-breakpoint
ALTER TABLE "project_environments" ADD COLUMN "short_id" text;--> statement-breakpoint
ALTER TABLE "project_environments" ADD CONSTRAINT "project_environments_short_id_unique" UNIQUE("short_id");--> statement-breakpoint
DO $$
DECLARE
	"environment" record;
BEGIN
	FOR "environment" IN SELECT "id" FROM "project_environments" ORDER BY "created_at", "id" LOOP
		UPDATE "project_environments"
		SET "short_id" = "free_project_environment_short_id"("environment"."id")
		WHERE "id" = "environment"."id";
	END LOOP;
END
$$;--> statement-breakpoint
ALTER TABLE "project_environments" ALTER COLUMN "short_id" SET NOT NULL;--> statement-breakpoint
CREATE TRIGGER "project_environments_short_id" BEFORE INSERT ON "project_environments"
FOR EACH ROW EXECUTE FUNCTION "assign_project_environment_short_id"();

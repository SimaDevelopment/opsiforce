ALTER TABLE "agents" RENAME COLUMN "created_in_chat_project_id" TO "builder_chat_id";--> statement-breakpoint
ALTER TABLE "skills" RENAME COLUMN "created_in_chat_project_id" TO "builder_chat_id";--> statement-breakpoint
ALTER TABLE "agents" RENAME CONSTRAINT "agents_created_in_chat_project_id_projects_id_fk" TO "agents_builder_chat_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "skills" RENAME CONSTRAINT "skills_created_in_chat_project_id_projects_id_fk" TO "skills_builder_chat_id_projects_id_fk";--> statement-breakpoint
UPDATE "agents" AS "a" SET "builder_chat_id" = NULL
WHERE "a"."builder_chat_id" IS NOT NULL
  AND (
    NOT EXISTS (SELECT 1 FROM "projects" AS "p" WHERE "p"."id" = "a"."builder_chat_id" AND "p"."kind" = 'agent_builder_chat')
    OR EXISTS (
      SELECT 1 FROM "agents" AS "b"
      WHERE "b"."builder_chat_id" = "a"."builder_chat_id" AND ("b"."created_at", "b"."id") < ("a"."created_at", "a"."id")
    )
  );--> statement-breakpoint
UPDATE "skills" AS "a" SET "builder_chat_id" = NULL
WHERE "a"."builder_chat_id" IS NOT NULL
  AND (
    NOT EXISTS (SELECT 1 FROM "projects" AS "p" WHERE "p"."id" = "a"."builder_chat_id" AND "p"."kind" = 'skill_builder_chat')
    OR EXISTS (
      SELECT 1 FROM "skills" AS "b"
      WHERE "b"."builder_chat_id" = "a"."builder_chat_id" AND ("b"."created_at", "b"."id") < ("a"."created_at", "a"."id")
    )
  );--> statement-breakpoint
CREATE UNIQUE INDEX "agents_builder_chat_id_unique" ON "agents" USING btree ("builder_chat_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skills_builder_chat_id_unique" ON "skills" USING btree ("builder_chat_id");--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_chat_visibility_check";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "chat_visibility";

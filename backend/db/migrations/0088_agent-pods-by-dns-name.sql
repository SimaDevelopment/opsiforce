-- Agent pods are reached by DNS name, so the stored pod addresses go (the column itself is dropped in the next release), and a disabled Project's environments are suspended, as disabling now leaves them.
UPDATE "project_environments" SET "pod_ip" = NULL WHERE "pod_ip" IS NOT NULL;--> statement-breakpoint
UPDATE "project_environments" SET "status" = 'suspended', "updated_at" = now()
WHERE "status" = 'active' AND "project_id" IN (SELECT "id" FROM "projects" WHERE "disabled" = true);

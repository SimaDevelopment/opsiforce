CREATE TABLE "project_skill_deliveries" (
	"project_environment_id" text NOT NULL,
	"skill_name" text NOT NULL,
	"skill_version_id" text,
	"content_hash" text NOT NULL,
	"delivered_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "project_skill_deliveries_project_environment_id_skill_name_pk" PRIMARY KEY("project_environment_id","skill_name")
);
--> statement-breakpoint
ALTER TABLE "project_skill_deliveries" ADD CONSTRAINT "project_skill_deliveries_project_environment_id_project_environments_id_fk" FOREIGN KEY ("project_environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_skill_deliveries" ADD CONSTRAINT "project_skill_deliveries_skill_version_id_skill_versions_id_fk" FOREIGN KEY ("skill_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE set null ON UPDATE no action;
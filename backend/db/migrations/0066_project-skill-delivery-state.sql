CREATE TABLE "project_skill_delivery_state" (
	"project_environment_id" text PRIMARY KEY NOT NULL,
	"converged" boolean DEFAULT false NOT NULL,
	"pending_skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"omitted_skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"failed_at" timestamp,
	"error" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_skill_delivery_state" ADD CONSTRAINT "project_skill_delivery_state_project_environment_id_project_environments_id_fk" FOREIGN KEY ("project_environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;

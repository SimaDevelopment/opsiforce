ALTER TABLE "project_gateway_keys" ADD COLUMN "purpose" text DEFAULT 'service' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "created_by_project_id" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "imported_agent" text;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_project_id_projects_id_fk" FOREIGN KEY ("created_by_project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_projects_created_by_project" ON "projects" USING btree ("created_by_project_id");--> statement-breakpoint
CREATE INDEX "idx_projects_tenant_kind" ON "projects" USING btree ("tenant_id","kind");--> statement-breakpoint
ALTER TABLE "project_gateway_keys" ADD CONSTRAINT "project_gateway_keys_purpose_check" CHECK ("project_gateway_keys"."purpose" in ('service', 'platform-api'));--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_kind_check" CHECK ("projects"."kind" in ('skill_builder_chat', 'agent_builder_chat', 'test'));
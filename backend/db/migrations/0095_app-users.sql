-- App Users: a Project's own sign-in accounts for its Apps under the `app_users` App Auth mode, the Project's roles and who holds them, one-time invite and reset links, the provider's single-use authorization codes and its sealed signing key.
ALTER TYPE "public"."project_auth_mode" ADD VALUE IF NOT EXISTS 'app_users';--> statement-breakpoint
CREATE TABLE "app_users" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"password_hash" text,
	"disabled_at" timestamp,
	"tokens_valid_after" timestamp DEFAULT now() NOT NULL,
	"failed_sign_ins" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp,
	"last_sign_in_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_user_roles" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_user_role_members" (
	"app_user_id" text NOT NULL,
	"role_id" text NOT NULL,
	CONSTRAINT "app_user_role_members_app_user_id_role_id_pk" PRIMARY KEY("app_user_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "app_user_links" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"app_user_id" text NOT NULL,
	"purpose" text NOT NULL,
	"project_environment_id" text,
	"return_url" text,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "app_user_links_purpose_check" CHECK ("app_user_links"."purpose" in ('invite', 'reset'))
);
--> statement-breakpoint
CREATE TABLE "app_user_authorization_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"project_environment_id" text NOT NULL,
	"app_user_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"scope" text NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_user_signing_keys" (
	"kid" text PRIMARY KEY NOT NULL,
	"public_jwk" jsonb NOT NULL,
	"sealed_private_key" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_users" ADD CONSTRAINT "app_users_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_user_roles" ADD CONSTRAINT "app_user_roles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_user_role_members" ADD CONSTRAINT "app_user_role_members_app_user_id_app_users_id_fk" FOREIGN KEY ("app_user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_user_role_members" ADD CONSTRAINT "app_user_role_members_role_id_app_user_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."app_user_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_user_links" ADD CONSTRAINT "app_user_links_app_user_id_app_users_id_fk" FOREIGN KEY ("app_user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_user_links" ADD CONSTRAINT "app_user_links_project_environment_id_project_environments_id_fk" FOREIGN KEY ("project_environment_id") REFERENCES "public"."project_environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_user_authorization_codes" ADD CONSTRAINT "app_user_authorization_codes_project_environment_id_project_environments_id_fk" FOREIGN KEY ("project_environment_id") REFERENCES "public"."project_environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_user_authorization_codes" ADD CONSTRAINT "app_user_authorization_codes_app_user_id_app_users_id_fk" FOREIGN KEY ("app_user_id") REFERENCES "public"."app_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_users_project_id_email_unique" ON "app_users" USING btree ("project_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "app_user_roles_project_id_name_unique" ON "app_user_roles" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "idx_app_user_role_members_role" ON "app_user_role_members" USING btree ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "app_user_links_app_user_id_purpose_unique" ON "app_user_links" USING btree ("app_user_id","purpose");--> statement-breakpoint
CREATE INDEX "idx_app_user_links_expires" ON "app_user_links" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_app_user_authorization_codes_expires" ON "app_user_authorization_codes" USING btree ("expires_at");

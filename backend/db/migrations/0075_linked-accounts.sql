-- One row per Linked account, hanging off the owning model_providers row. credential and pending_sign_in are encrypted.
CREATE TABLE "linked_accounts" (
	"model_provider_id" uuid PRIMARY KEY NOT NULL,
	"vendor" text NOT NULL,
	"credential" text,
	"status_reason" text,
	"pending_sign_in" text,
	"caller_secret_hash" text NOT NULL,
	CONSTRAINT "linked_accounts_caller_secret_hash_unique" UNIQUE("caller_secret_hash")
);
--> statement-breakpoint
ALTER TABLE "linked_accounts" ADD CONSTRAINT "linked_accounts_model_provider_id_model_providers_id_fk" FOREIGN KEY ("model_provider_id") REFERENCES "public"."model_providers"("id") ON DELETE cascade ON UPDATE no action;

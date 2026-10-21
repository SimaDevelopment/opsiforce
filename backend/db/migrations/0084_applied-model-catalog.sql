CREATE TABLE "applied_model_catalog" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"served_models" jsonb NOT NULL,
	"applied_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "applied_model_catalog_single_row_check" CHECK ("applied_model_catalog"."id")
);

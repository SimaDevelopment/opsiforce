-- The model catalog's served models per Base format the Project keys were last rewritten from. At boot, a catalog that differs rewrites every Organization's keys, and the row is replaced only once every Organization's keys took it.
CREATE TABLE "applied_model_catalog" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"served_models" jsonb NOT NULL,
	"applied_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "applied_model_catalog_single_row_check" CHECK ("applied_model_catalog"."id")
);

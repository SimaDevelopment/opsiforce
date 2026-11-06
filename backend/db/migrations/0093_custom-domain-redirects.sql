-- A Custom domain other than the Main domain serves the App on its own host unless its owner turns on the redirect to the Main domain.
ALTER TABLE "custom_domains" ADD COLUMN "redirects_to_main" boolean DEFAULT false NOT NULL;

-- Adds the nullable project_app.slug, the App Slug (ADR-0012); an App without one answers on its legacy host.
ALTER TABLE "project_app" ADD COLUMN "slug" text;

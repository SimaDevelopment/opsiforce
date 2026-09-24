-- A Skill or an Agent taken out of use is Disabled, the same word a Project uses (ADR-0070).
ALTER TABLE "agents" RENAME COLUMN "archived" TO "disabled";--> statement-breakpoint
ALTER TABLE "skills" RENAME COLUMN "archived" TO "disabled";

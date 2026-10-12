-- Retired (Skill): a Built-in Skill the agent image no longer ships; hidden from the Store, never delivered, cleared when the image ships it again.
ALTER TABLE "skills" ADD COLUMN "retired_at" timestamp;

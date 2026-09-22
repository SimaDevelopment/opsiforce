-- `external_urls` is gone from SkillFlags: it was a regex over text files, so it described prose,
-- not behaviour, and an empty list read as an egress guarantee the platform never made.
-- `skill_versions` is append-only (ADR-0051), so existing rows keep the key they were published
-- with — a Version is a record of what was published, not a row to correct. Nothing reads it.
-- Only the default changes, so new rows stop carrying it.
ALTER TABLE "skill_versions" ALTER COLUMN "flags" SET DEFAULT '{"has_executables":false}'::jsonb;

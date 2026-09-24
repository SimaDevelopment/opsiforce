# scratch/

Your drafting space. Nothing here is published, read by the platform, or seen by anyone until you
send it through the API.

- One directory per Skill you are drafting, named exactly as the Skill's `name`:
  `scratch/release-notes/SKILL.md`, `scratch/release-notes/references/tone.md`.
- One file per Agent prompt you are drafting: `scratch/release-notes-writer.prompt.md`.
- `scratch/<agent>.expectations.md` — the Agent's test expectations; `agent-authoring` says how to
  keep them.
- `scratch/shots/` — screenshots you take of a child's App during a test run, so you can read them.

The loop:

```sh
node scripts/validate-skill.mjs scratch/release-notes --name release-notes   # ERRORS and LINTS, offline
node scripts/pack-skill.mjs --json scratch/release-notes > scratch/body.json
sh   scripts/api.sh call POST "/skills/$ID/versions" @scratch/body.json      # publish a Version
```

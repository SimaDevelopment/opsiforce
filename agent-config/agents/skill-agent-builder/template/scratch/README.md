# scratch/

Your drafting space. Nothing here is published, read by the platform, or seen by anyone until you
send it through the API.

- One directory per Skill you are drafting, named exactly as the Skill's `name`:
  `scratch/release-notes/SKILL.md`, `scratch/release-notes/references/tone.md`.
- One file per Agent prompt you are drafting: `scratch/release-notes-writer.prompt.md`.
- Keep expectations for a test run here too — `scratch/<agent>.expectations.md` — written **before**
  the run, so what you claim afterwards is checkable against something you wrote first.
- `scratch/shots/` — screenshots you take of a child's App during a test run, so you can read them.

The loop:

```sh
node scripts/validate-skill.mjs scratch/release-notes --name release-notes   # ERRORS and LINTS, offline
node scripts/pack-skill.mjs --json scratch/release-notes --name release-notes > scratch/body.json
sh   scripts/api.sh call POST /skills @scratch/body.json                     # publish a Version
```

`validate-skill.mjs` is a generated copy of the platform's own gate, so an offline pass means the API
will accept the tree. Re-read what you published (`GET /skills/{id}/versions/{n}/files`) rather than
trusting that the write landed as you meant it.

There is no `app/` here and no `startup.sh` to write: this project has no App, and the pod idles
quietly without one. Do not build one.

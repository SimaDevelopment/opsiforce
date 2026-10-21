# scratch/

Your drafting space. Nothing here is published, read by the platform, or seen by anyone until you
send it through the API.

- One directory per Skill you are drafting, named exactly as the Skill's `name`:
  `scratch/<skill>/SKILL.md`, `scratch/<skill>/references/<topic>.md`.
- `scratch/prompt.md` — the Agent prompt you are drafting.
- `scratch/expectations.md` — the Agent's test prompts, expectations and `## Fixes` log;
  `agent-authoring`'s test loop (§The contract) says how to keep them, and
  `scripts/check-expectations.mjs` checks their shape.
- `scratch/shots/` — screenshots you take during a test run, and the child's own, copied in by
  `scripts/evidence.sh`.
- `scratch/test-project.json` — the chat's Test Project and its Connection, kept by `scripts/tp.sh`.

The draft-to-Version loop is `skill-authoring`'s *The authoring loop*.

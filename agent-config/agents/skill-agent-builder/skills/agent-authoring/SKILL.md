---
name: agent-authoring
description: Custom Agent authoring — the prompt body, the Template and its save, the model and effort, the Skills to add, and testing in the chat's Test Project. Load it before drafting, saving or testing an Agent.
---

# Authoring a Custom Agent

A **Custom Agent** is a prompt body, a model pair, a list of pinned Skills and an optional
**Template** (§The Template). The runtime writes the body to `.opencode/agents/<slug>.md` and it
*replaces* the model's default system prompt — so the body is the whole prompt, with nothing
prepended, appended or templated in.

An Agent has one editable **Development** profile and Template plus a read-only copy per published
Environment. This chat writes Development. Publishing to Production is the Store's job, not this
chat's, and a new Agent cannot be picked for a Project until someone has published it.

## Two rules that are not negotiable

**1. Never restate anything the `platform` skill covers.** Every agent, including every Custom Agent,
carries `platform` — the App contract (`startup.sh`, `$APP_PORT`, `app.meta.json`), the pod restart,
files, configuration, the LLM gateway, the observability database. Read it once so you know what it
covers. A copy in a body goes stale the next time the platform changes. Write none of it.

**2. When the child builds, serves or delivers anything, tell it to load the skill and to check its
work.** A model does not always load a skill unprompted, and a child that never loads `platform`
writes a server nobody routes to. So put one line in the body — *"Load the `platform` skill before
you build, serve or deliver anything, and check your work the way it and `## Done looks like` say
before you call it done."* What finished means for this Agent goes in `## Done looks like`. Your test
run is what catches a child that skipped either.

## The Template

A Template is the files every new Project of the Agent starts with, copied into the root of its
workspace before the child first runs. Where each thing goes:

- **Template** — files the Project owns: copied into its git, changed by the child as it needs,
  shipped by Publish (App).
- **Skill** — know-how the child reads when it needs it, never copied into the Project, shared across
  Agents.
- **Body** — who the Agent is and the rules every Project keeps.

Put something in the Template when every Project should start with it and the child would otherwise
re-create or re-fetch it each time. With nothing like that, the Agent has no Template. You decide from
the brief and report; the author is not asked. Anything used in a browser starts from a snapshot of
App Builder's web-app starter unless the brief says otherwise. `references/template.md` has where it
lives, what may go in one, how to draft, check and save it, and how a starter snapshot takes later starter changes.

**Skills describe; the Template ships.** Every Skill you author for an Agent carries decisions and
contracts, never files for the child to copy — those belong in the Template.
`references/stack-skill.md` has what goes in one and what never does.

**Architecture rules live in the body.** The body is the one text every Project of the Agent is sure
to read, frozen into each Project at creation. When the Agent runs an App, give it a short
**Architecture** section: three to six rules that keep every Project the same shape as it grows —
what may never be added a second of, where new parts go, what every App of this Agent shares. They
are rules to keep, never changes to apply; the Template already holds the result. Write decisions,
not "use best practices". Know-how longer than a few lines is a stack Skill the body names, never a
long passage in the body.

Once a Project exists, its architecture is settled: the child changes the App the way its Template and
body organise it, keeping its frameworks, databases and layout even when a later request could be met
another way.

## What a good prompt body holds

Only what its author decided: who the Agent is, what it does and refuses, how it talks, the domain
rules and formats that matter, and the shape of a good answer. Take those from the brief; where it is
silent, decide and report. What should happen when the Agent cannot help, and what a finished piece of
work looks like, are the two things most briefs leave out — supply them.

A rule every piece of work must obey, such as a format, a required line or a limit, goes in the
body's `## Domain rules`, which every turn reads. An authored Skill holds know-how the child reads
when a task calls for it, and `## How to work` names when to load it.

It names every Template path the child must use, and, when the Agent runs an App, holds the
Architecture section (above).

What it must **not** hold: platform facts (rule 1); a restatement of a Skill it carries — add the
Skill instead; the stack's know-how, which lives in `web-app` or the stack skills; a description of
files the Template holds — name the path instead; or a list of tools, which is the runtime's policy
and not a prompt's business.

Write it in the sections `references/body-template.md` gives, in that order, and keep each the length
the job needs.

## Model and effort

The pair is a `model` string and an optional `variant` (reasoning effort). The catalogue is on disk:

```sh
jq -r 'to_entries[] | .key as $p | .value.models | to_entries[]
       | "\($p)/\(.key)\t\([.value.reasoning_options[]?.values // []] | flatten | join(","))"' \
  /opt/opencode/models.json
```

The Store gave the Agent App Builder's pair when the author named it, and `profiles[0]` of `GET
/agents/{id}` carries it. Every profile write sends a `model`, so send back the pair the profile
already has — an Agent nobody asked to be cheaper or smarter runs what App Builder runs. Change it
only when the author asks, name a `model` from that list, and only a `variant` the model offers;
anything else answers 422 `model-unknown`. A model with no `reasoning_options` takes no `variant` at
all.

## Skills

A Custom Agent starts with `platform` and nothing else; **every other capability is an explicit add**,
and Built-in Skills are Store rows like any other, so adding `sqlite` is the same act as adding an
authored Skill. Read the catalogue first (`GET /skills?filter=built_in`, and `GET /skills/{id}` for a
Skill's files). A stack skill goes only on an Agent with that stack.

On a starter snapshot, pin `web-app` and **every** Skill in its *Skills for this stack* table, minus
any whose layer the Template replaced, plus the Skill for what replaced it — the set App
Builder runs on. A carried Skill costs one line until it is loaded, and `web-app` already says when to
load each, so the body does not repeat that. Before pinning two Skills, check that their assumptions
agree; an Agent carrying two answers to one question has no answer.

Anything outside that table is added only when the brief implies it, and the body says when to reach
for it: `schedules` for recurring work, `incoming-email` or `whatsapp` for inbound messages, an
authored Skill for the job's own specifics — and, for an Agent with no starter, `llm-api` when the job
needs a model call and `document-generation` when it delivers office documents. In the report, name
what each one buys, not the skill.

The `skill-authoring` skill has the reuse / extend / fresh decision for a capability nothing covers.
`references/agent-api.md` has every call: describe, write the profile, add and pin Skills.

## Testing

Once you have written or meaningfully changed a definition, `references/test-loop.md` is next. It holds
testing end to end: the contract, the calls in order, the rounds and fixes, and the report.

## Changing an existing Agent

When this chat edits an existing Agent, read its Development profile, its pinned Skills and
`template/` first, change what the author asked, and leave its Template, architecture, model pair,
capabilities and behaviour as they were unless the request is about them. The author may have edited
`template/` from the Code tab since your last save: `references/template.md` §When `template/`
changed without you says how to tell and what to do.

Every Project keeps the prompt, Skills and Template it was created with. When the Agent has been
published (a later profile's `skills` is not `null`), say in your report that the change reaches
Projects created after the next Publish, and that existing ones keep what they have.

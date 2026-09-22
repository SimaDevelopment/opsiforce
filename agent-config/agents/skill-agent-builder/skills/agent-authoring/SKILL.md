---
name: agent-authoring
description: How to author a Custom Agent for the Opsiforce Store — what belongs in a prompt body and what must never be restated from the platform skill, how to choose its model and reasoning effort, which Skills to add, and the contract for testing the child in a throwaway test Project before reporting back. Load it before drafting, publishing or testing any Agent.
---

# Authoring a Custom Agent

A **Custom Agent** is a prompt body, a model pair, and a list of pinned Skills. The runtime writes the
body to `.opencode/agents/<slug>.md` and it *replaces* the model's default system prompt — so the body
is the whole prompt, with nothing prepended, appended or templated in. There is no base persona to
inherit and no rendered composite to inspect.

An Agent has one editable **Development** profile plus a read-only profile per published Environment.
This chat writes Development. Publishing to Production is the Store's job, not this chat's.

## Two rules that are not negotiable

**1. Never restate anything the `platform` skill covers.** Every agent, including every Custom Agent,
carries `platform`. It already states the App contract (`/workspace/app/startup.sh`, serving on
`$APP_PORT`, `app/app.meta.json` as go-live), uploads and generated files, `app/opsiforce.env.json`,
the platform environment variables, the LLM gateway and the ban on local models, and the two
read-only databases with the queries that read them. A copy in a prompt body is frozen the moment the
Agent's Project is created and goes stale the next time the platform changes. Write none of it.

**2. When the child builds or serves anything, tell it to load the skill and to check its work.** A
model does not always load a skill unprompted, and a child that never loads `platform` writes a server
nobody routes to. So put one line in the body — *"Load the `platform` skill before serving anything"* —
and, for an Agent that builds an App, one more: *check that the App booted and walk the page in the
browser before saying a feature is done*. Nothing else. Your test run is what catches a child that
skipped either.

## What a good prompt body holds

Only what its author decided: who the Agent is, what it does and refuses, how it talks, the domain
rules and formats that matter, and the shape of a good answer. Interview for those; do not invent a
mission. Ask what it should do when it cannot help, and what a finished piece of work looks like.

What it must **not** hold: platform facts (rule 1); a restatement of a Skill it carries — add the
Skill instead; App Builder's text, which is about a React/NestJS template this Agent does not have;
or a list of tools, which is the runtime's policy and not a prompt's business.

Keep it the length the job needs. A body is markdown with no required sections.

## Model and effort

The pair is a `model` string and an optional `variant` (reasoning effort). The catalogue is on disk:

```sh
jq -r 'to_entries[] | .key as $p | .value.models | to_entries[]
       | "\($p)/\(.key)\t\([.value.reasoning_options[]?.values // []] | flatten | join(","))"' \
  /opt/opencode/models.json
```

Default to the platform's own pair by omitting `model` on create — an Agent nobody asked to be
cheaper or smarter should run what App Builder runs. Change it only when the author asks, name a
`model` from that list, and only a `variant` the model offers; anything else answers 422
`model-unknown`. A model with no `reasoning_options` takes no `variant` at all.

## Skills

A Custom Agent starts with `platform` and nothing else; **every other capability is an explicit add**,
and Built-in Skills are Store rows like any other, so adding `sqlite` is the same act as adding an
authored Skill. Read the catalogue first (`GET /skills?filter=built_in`), add what the job actually
needs, and say in the body when to reach for each. Do not add a stack skill to an Agent with no stack.

An Agent that **builds an App** gets two adds without being asked, unless the author has said
otherwise: `sqlite`, because the App's data lives in the platform's SQLite file, and `agent-browser`,
so the child can walk its own page before it claims a feature works. Tell the author in a sentence; do
not make it a question. Beyond those two, **propose** the built-ins the brief implies and add them on
the author's yes: `llm-api` when the job needs a model call, `document-generation` for Word, PDF or
Excel deliverables, `schedules` for recurring work, `incoming-email` or `whatsapp` for inbound
messages. Name what each one buys, not the skill.

The `skill-authoring` skill has the reuse / extend / fresh offer for a capability nothing covers.
`references/agent-api.md` has every call: create, write the profile, add and pin Skills, duplicate.

## Testing: initiate, announce, then verify for yourself

After writing or meaningfully changing a definition, **test it without being asked**, the way a coding
agent runs the build without being asked. `references/test-loop.md` has the exact calls, in order.

- **Announce first, with the spend.** One line before you start: what you will run, roughly how long it
  takes (a test Project is always a cold create — tens of seconds), and that its LLM spend lands on this
  Organization like any Project. Then go; do not ask permission and do not wait.
- **A test Project is frozen at its creation.** It reports on the definition as it stood then, so
  editing the *definition* means a *new* test Project — and never re-test an unchanged one, which buys
  nothing but a bill. Prompting the child is not a definition change: every prompt of one run belongs
  in the Project you already have, and a new one throws that warm workspace away. Do not test a
  definition the author is still mid-sentence about.
- **Write expectations before the run**, into `scratch/<agent>.expectations.md`, in two lists:
  - **machine-checkable** — a file exists, a row is there, the page does not scroll sideways when
    narrow. One line each, ending in the command that decides it and the answer that counts as a pass.
  - **judgement** — tone, whether a refusal was graceful, whether the page is understandable.

  *If you cannot write the command, it is a judgement expectation.* Deciding that beforehand is the
  point; deciding it afterwards, against a confident report, is how a claim gets graded as a fact.
- **Several prompts, one warm workspace.** A child that builds something correct once and breaks it on
  the next instruction passes a single-prompt test and fails in use. Make the second prompt change what
  the first built, then re-run the first prompt's checks. A third prompt that asks for something the
  Agent should refuse is the only way to see the refusal under real conditions.

### Who checks what

Three parties, and the line between them is the whole point of testing.

- **The child** builds, and checks its own work the way the `platform` skill tells every agent to —
  the boot and crash queries, and a browser walk when it carries `agent-browser`. What it reports is a
  claim about itself. It is the thing under test, so its report is never your evidence.
- **You** grade every machine-checkable expectation by running its command yourself. Files, the App's
  own database, boot and crash records in the observability database: through the test Project's
  shell. The page: with **your own** `agent-browser`, run from this Project and pointed at the child's
  App — you reach it directly, and a screenshot you take lands in your workspace, where you can read it
  and see the page. Do not settle for a "layout checks passed". Carried is not used, either: a listing
  of the child's skills proves delivery, and only the artefact that Skill alone could produce — its
  script's bytes, its output — proves use.
- **The author** judges what needs a person's eye — whether the page is pleasant, whether a message
  helps — in the test Project's preview beside this chat, and decides publishing. Point them there
  rather than grading taste on their behalf.

- **Read the child's work, never edit it.** The shell is for looking: files, rows, logs. Change what
  the App holds only the way a user would — through its page or its API. A row you delete by hand is a
  state no user can reach, and it hides the bug that a user would have hit.

### When a check fails

Decide *whose* failure it is before touching anything. If the child slipped once — a typo, a missed
step — prompt it to fix that in the same test Project, and re-run the check. If the **definition** let
it happen — a rule the body never stated, a Skill it never carried, a refusal it was never told to
make — fix the definition, publish the change, and start a new test Project, because the old one is
frozen on the old definition. Say which of the two you did and why, in a sentence. Do not loop: two
definition changes without a passing run is the point to stop and bring the author in.

**Report honestly**, in plain language, against the expectations you wrote: what you expected, what
you saw, what you changed. Say which passes you saw for yourself and which you are relaying from the
child, and say when a check was not run. Results live in the conversation — there is no stored run.

### The four fidelity gaps — say them when they matter

1. A test Project is **always cold** — a Custom Agent keeps no warm pool, so create takes tens of
   seconds and the first prompt is slower than a real user's would be.
2. Its **spend lands on this Organization** like any Project, and it shows in Admin storage.
3. **External services it calls are the real ones** — if the child emails, posts or writes somewhere,
   that happened.
4. It reports on the definition **as of its creation moment**; an edit since then is not under test.

Nothing bounds a runaway test but the Project's ordinary budget and your own patience. If a child sits
working with nothing to show, interrupt it, say so, and do not start another run to see if it was a
fluke.

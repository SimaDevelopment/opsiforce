---
name: agent-authoring
description: How to author a Custom Agent for the Opsiforce Store — what belongs in a prompt body and what must never be restated from the platform skill, which template every building Agent lays first and how it is told to, how to choose its model and reasoning effort, which Skills to add, and the contract for testing the child in a throwaway test Project before reporting back. Load it before drafting, publishing or testing any Agent.
---

# Authoring a Custom Agent

A **Custom Agent** is a prompt body, a model pair, and a list of pinned Skills. The runtime
writes the body to `.opencode/agents/<slug>.md` and it *replaces* the model's default system prompt —
so the body is the whole prompt, with nothing prepended, appended or templated in. There is no base
persona to inherit and no rendered composite to inspect.

An Agent has one editable **Development** profile plus a read-only profile per published Environment.
This chat writes Development. Publishing to Production is the Store's job, not this chat's.

## Two rules that are not negotiable

**1. Never restate anything the `platform` skill covers.** Every agent, including every Custom Agent,
carries `platform` — the App contract (`startup.sh`, `$APP_PORT`, `app.meta.json`), the pod restart,
files, configuration, the LLM gateway, the observability database. Read it once so you know what it
covers. A copy in a body goes stale the next time the platform changes. Write none of it.

**2. When the child builds or serves anything, tell it to load the skill and to check its work.** A
model does not always load a skill unprompted, and a child that never loads `platform` writes a server
nobody routes to. So put one line in the body — *"Load the `platform` skill before serving anything"* —
and, for an Agent that builds an App, one more: *check that the App booted and walk the page in the
browser before saying a feature is done*. Nothing else. Your test run is what catches a child that
skipped either.

## Every Agent that builds starts from a template

A Custom Agent's Project opens on an empty `/workspace/app`, and two Projects that each start from
nothing end up as two different architectures. So every Agent that builds an App lays a **template**
first — never on an empty `app/` — and its body states the **architecture** every one of its Projects
follows. You decide both from the brief and report them; the author is not asked to choose between
stacks they cannot compare.

**The template.** The default is the platform's web-app starter: a React frontend, a NestJS backend
with its own database, and a `startup.sh` that already satisfies the App contract. The `web-app` skill
lays it as its first step, says what in it is fixed and what an App may change, and carries the
know-how for building on it. Read that skill and the starter it lays
(`/opt/agents/app-builder/template/app/`) before you promise the author anything. Anything used in a
browser takes the default unless the brief rules it out. When the default cannot fit — a CLI, a bot, a
service in another language, a web app on another framework — the Agent gets a **scaffold Skill** you
construct, which describes the skeleton the child creates on its first build.

**Skills frame the work; the child writes it.** Every Skill you author for an Agent — a scaffold, or
an addition the starter lacks — carries decisions and contracts, never an implementation for the child
to copy. `references/stack-skill.md` has what goes in one and what never does.

**The architecture lives in the body.** The body is the one text every Project of the Agent is sure
to read, and it is frozen into each Project at creation — which is exactly what a Project's
architecture should be. Give it a short **Architecture** section that settles what would otherwise
come out differently from one Project to the next:

- which template it lays — *"Load the `web-app` skill before touching the app"*, or *"Load
  `<agent>-scaffold` before the first build"*;
- what it changes about that template, each change naming what gives way — a replaced layer takes the
  starter's version of it, and the stack skill that teaches it, out of play;
- the services the App runs besides its server, which the child ensures in `startup.sh`;
- where the domain goes — the modules, pages or directories this kind of App always has, and what
  each is responsible for;
- anything else every App of this Agent must share — a data model, a layout, an integration.

Write decisions, not "use best practices". For the default starter used as it is, the section is a
few lines; it grows only as far as the Agent departs from it. A change whose know-how is more than a
few lines — how to work with a replacement layer, say — is a stack Skill the body names, reused from
the catalogue or authored, never a long passage in the body.

**Runtime dependencies are ensured by `startup.sh`, never by hand.** The body names a service; the
child ensures and starts it from `startup.sh` on the first build, the way the `platform` skill says.
The restart in your test run is what proves it.

An Agent that builds nothing — a writer, an analyst, an answerer — takes no template. It does not
need an HTTP server to exist; its pod idles without an App and answers in chat, and its deliverables,
if any, are files under `generated_files/` the way `document-generation` describes.

Once a Project exists, its architecture is settled: the child changes the App the way its template and
body organise it, and does not swap frameworks, databases or layout because a later request could be
met another way. The same holds for you: when this chat edits an existing Agent, read its Development
profile and its pinned Skills first, change what the author asked, and leave its architecture, model
pair, capabilities and behaviour as they were unless the request is about them.

## What a good prompt body holds

Only what its author decided: who the Agent is, what it does and refuses, how it talks, the domain
rules and formats that matter, and the shape of a good answer. Take those from the brief; where it is
silent, decide and report. What should happen when the Agent cannot help, and what a finished piece of
work looks like, are the two things most briefs leave out — supply them.

For an Agent that builds, that includes the Architecture section (above).

What it must **not** hold: platform facts (rule 1); a restatement of a Skill it carries — add the
Skill instead; the stack's know-how, which lives in `web-app`, the stack skills or the scaffold Skill;
or a list of tools, which is the runtime's policy and not a prompt's business.

Write it in the sections `references/body-template.md` gives, in that order, and keep each the length
the job needs. That file has a whole example body.

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
authored Skill. Read the catalogue first (`GET /skills?filter=built_in`). Do not add a stack skill to
an Agent with no stack.

On the default starter, pin `web-app` and **every** Skill in its *Skills for this stack* table, minus
any whose layer the Architecture section replaced, plus the Skill for what replaced it — the set App
Builder runs on. A carried Skill costs one line until it is loaded, and `web-app` already says when to
load each, so the body does not repeat that. Before pinning two Skills, check that their assumptions
agree; an Agent carrying two answers to one question has no answer.

Anything outside that table is added only when the brief implies it, and the body says when to reach
for it: `schedules` for recurring work, `incoming-email` or `whatsapp` for inbound messages, an
authored Skill for the job's own specifics — and, for an Agent with no starter, `llm-api` when the job
needs a model call and `document-generation` for Word, PDF or Excel deliverables. In the report, name
what each one buys, not the skill.

The `skill-authoring` skill has the reuse / extend / fresh decision for a capability nothing covers.
`references/agent-api.md` has every call: describe, write the profile, add and pin Skills.

## Testing: initiate, announce, then verify for yourself

After writing or meaningfully changing a definition, **test it without being asked**, the way a coding
agent runs the build without being asked. `references/test-loop.md` has the exact calls, in order.

- **Announce first, with the spend.** One line before you start: what you will run, roughly how long it
  takes and what it spends (the first two fidelity gaps below). Then go; do not ask permission and do
  not wait.
- **A test Project is frozen at its creation**, so editing the *definition* means a *new* test Project
  — and never re-test an unchanged one, which buys nothing but a bill. Prompting the child is not a
  definition change: every prompt of one run belongs in the Project you already have, and a new one
  throws that warm workspace away. Do not test a definition the author is still mid-sentence about.
- **Write expectations before the run**, into `scratch/<agent>.expectations.md`, in two lists:
  - **machine-checkable** — a file exists, a row is there, the page does not scroll sideways when
    narrow, the App answers again after its pod is restarted, the directories the Architecture section
    names are the ones on disk. One line each, ending in the command that decides it and the answer
    that counts as a pass.
  - **judgement** — tone, whether a refusal was graceful, whether the page is understandable.

  *If you cannot write the command, it is a judgement expectation.* Deciding that beforehand is the
  point; deciding it afterwards, against a confident report, is how a claim gets graded as a fact.
- **The expectations file is the Agent's, not the run's.** This chat is the only one that authors the
  Agent, so the file outlives every test Project. Add to it; never rewrite it. Each run grades every
  machine-checkable line still in it, plus the new ones for the change under test — a change that
  breaks what passed before is a failure of that change. When the author changes behaviour on purpose,
  delete the lines that no longer hold, and name them in your report.
- **Several prompts, one warm workspace.** A child that builds something correct once and breaks it on
  the next instruction passes a single-prompt test and fails in use. Make the second prompt change what
  the first built, then re-run the first prompt's checks. A third prompt that asks for something the
  Agent should refuse is the only way to see the refusal under real conditions.
- **Restart the child's pod once the App is live, and check again** — an App that serves before and
  not after is a definition failure, never a child slip. `references/test-loop.md` has the call.

### Who checks what

Three parties, and the line between them is the whole point of testing.

- **The child** builds, and checks its own work the way the `platform` skill tells every agent to —
  the boot and crash queries, and a browser walk when it carries `agent-browser`. What it reports is a
  claim about itself. It is the thing under test, so its report is never your evidence.
- **You** grade every machine-checkable expectation by running its command yourself. Files, the App's
  own database, boot and crash records in the observability database: through the test Project's
  shell. The page: with **your own** `agent-browser`, run from here and pointed at the child's App. Do
  not settle for a "layout checks passed".
- **The author** judges what needs a person's eye — whether the page is pleasant, whether a message
  helps — in the test Project's preview beside this chat, and decides publishing. Point them there
  rather than grading taste on their behalf.

**Read the child's work, never edit it.** The shell is for looking: files, rows, logs. Change what
the App holds only the way a user would — through its page or its API. A row you delete by hand is a
state no user can reach, and it hides the bug that a user would have hit.

### When a check fails

Decide *whose* failure it is before touching anything. If the child slipped once — a typo, a missed
step — prompt it to fix that in the same test Project, and re-run the check. If the **definition** let
it happen — a rule the body never stated, a Skill it never carried, a refusal it was never told to
make, a service the Architecture section never named — fix the definition, publish the change, and
start a new test Project. Say which of the two you did and why, in a sentence. Do not loop: two
definition changes without a passing run is the point to stop and bring the author in.

**Report** the way `references/test-loop.md` §7 says. Results live in the conversation — there is no
stored run.

### The four fidelity gaps — say them when they matter

- A test Project is **always cold** — a Custom Agent keeps no warm pool, so create takes tens of
  seconds and the first prompt is slower than a user's.
- Its **spend lands on this Organization** like any Project, and shows in Admin storage.
- **External services it calls are the real ones** — if the child emails, posts or writes somewhere,
  that happened.
- It tests the definition **as of its creation moment**.

Nothing bounds a runaway test but the Project's ordinary budget and your own patience. A long turn is
not a stuck one: wait for it, and interrupt only a genuine stall, the way `references/test-loop.md`
says.

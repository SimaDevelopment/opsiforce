# Stop 1 and the hand-over

A Custom External Service passes two human reviews. **Stop 1** is yours to hold: what the service will
let through, approved before any code exists. The second is the Publish review on the service's page,
which a human opens and you prepare for with `PUBLISH.md` and the test report.

## Contents

- Stop 1: what the person approves
- A Stop 1 example
- After Stop 1
- The hand-over
- `PUBLISH.md`

## Stop 1: what the person approves

Show the proposal in the chat as short tables and plain sentences, never raw JSON or code, then ask one
question. Every part below appears, even when its answer is "none":

1. **The upstream and its credential.** The API and its version with the docs link, the kind of
   credential to create and **exactly which permissions to grant it**, the narrowest that still covers
   the groups: an app installation limited to the chosen projects with no administration
   permission, a token scoped to one workspace, a read-only key when nothing writes. Where the upstream
   cannot narrow it (one token that can do everything its account can), say so plainly and what it
   means: "only this service's checks stand between an agent and every board this account sees". Say
   where it goes: the Service form, which the person fills in this chat's Development configuration.
2. **The upstream's own protections.** What the upstream itself can refuse whatever this service's code
   does: a protected main line that changes only through a reviewed change with no bypass for this
   credential, project roles, the token's account being a member of only the allowed boards, a key
   restricted to chosen projects or queues, IP or scope limits on the key. Propose the concrete ones the upstream offers, or say it offers none.
3. **The Service form**: each field with its key, type, whether it is required, its default and what it
   holds. Mark every `secret`, every generated value and every list (one item per account). The
   upstream's address follows where it runs: left blank, it is the upstream's public service, and an
   address is filled in only for a self-hosted, regional or sandbox instance; an upstream that exists
   only self-hosted makes the address required, accepting `http` too (`allowHttp`) when the person's
   server is reached that way on their network.
4. **The Project form, the settings**: each field with its default and what it allows. A target the
   service reaches (a project, a board, a queue, a namespace) comes with an access level per target, and
   every level that changes something starts off: the default is the narrowest (read, or nothing). The
   person **picks** each target from a live list: a `select` whose options come from an `options`
   handler that lists what the service's credential can see, labelled as people know them, storing the
   upstream's id (`references/handlers.md`). Targets differ per Organization and change upstream, so
   they are never typed in and never a fixed list in `service.json`.
5. **The pass-through groups**, one row each, in plain words:

   | Group | Lets through | Setting | Check | Filters or narrows |
   | --- | --- | --- | --- | --- |

   Then every `handle` row with its reason (a client shim, no HTTP upstream, or a convenience the
   person still wants after your push-back), the refuse rows (a part of a wider group blocked on
   purpose) and a last row, **Everything else: not supported**, with examples of
   what it covers (the upstream's settings, permissions, webhooks, deletions, anything the brief did not
   ask for). Say which client actions each group makes work (a CLI's create command, a push to a
   feature branch, the App's list call).
6. **Events**, when the upstream sends webhooks or can be polled: each Event type, when it arrives and
   the keys its `data` will carry, **how a Project chooses what it hears** (an opt-in field such as
   "Notify on", empty by default, for a chatty source), and how the upstream learns the Webhook address
   (`references/inbound.md`). When the upstream offers none, say "none" and why. When it offers Events
   the brief did not ask for, propose them and ask whether the person wants them now; if not, the row
   says "none in this version" and the Event types go under **Not in this version**, so the person knows
   they can be added later.
7. **Usage counters**: the counts worth keeping (cards created, emails sent), each with its label, or
   none. They are display only.
8. **Not in this version**: the upstream's next capabilities the brief did not ask for, one line each,
   so the person can pull one in now or ask for it later; and anything asked for that a service cannot
   do (an OAuth sign-in flow, a non-HTTP client).
9. **The Service skill's outline**: its headings with one line each (`references/service-skill.md`).
10. For a service already published: what the change does to stored configurations. A renamed field
    carries its value (`was`), a new field gets its default written into every stored configuration at
    Publish, a newly required field with no default makes those configurations *incomplete* until
    someone fills it, a removed field stays stored and unread.

End with one question: approve this, or say what to change. Change it as often as asked, and show the
changed rows each time.

## A Stop 1 example

A person asks for "our task tracker for our agents: read boards and move cards". Callers use `curl` and
App code; the tracker issues one API token per account, with no scopes.

> **Credential.** A token of a dedicated tracker account that is a member of only the boards Projects
> may use. The tracker cannot scope a token, so this account can do anything on those boards; the
> checks below and its board membership are what limit it.
>
> **Service form.** *Token* (secret, required), *Address* (blank = the tracker's public API; filled
> in only for a self-hosted tracker).
>
> **Project form.** *Boards*: a list of board (picked from the boards the token sees) + access, `Read`
> (default) or `Change cards`.
> *Notify on*: card created, card moved; empty by default.
>
> | Group | Lets through | Setting | Check | Filters or narrows |
> | --- | --- | --- | --- | --- |
> | reads | every read of a chosen board, its lists and cards | Boards | the board is in Boards; a card or list id is looked up to its board first | "my boards" keeps only chosen boards; search narrowed to them |
> | cards | create, edit, move and archive cards | Boards | the board's access is Change cards; a move checks the target list's board too | — |
> | everything else | board settings, members, deleting boards, other workspaces | — | *not supported* | — |
>
> **Events**: `card.moved` (board, card, from list, to list), heard by Projects that chose it in Notify
> on and have the board. **Counters**: Cards created. **Not in this version**: checklists, attachments,
> labels. Approve this, or say what to change?

## After Stop 1

- When the person's reply itself decides a change ("let people pick it from a list"), make it, show the
  changed rows and carry on; ask again only about what their reply left open.
- A change to a group, a check's rule, a form field or default, the credential's permissions, an Event
  type or a counter goes back to the person before you write it: show the changed rows, wait for yes.
- A bug fix inside an approved check does not. Name it in `PUBLISH.md`.

## The hand-over

Before you say the service is ready:

- `yarn check` reports no error and every warning is one the person agreed to; `yarn typecheck` and
  `yarn test` pass; everything is committed, `yarn.lock` and `service.types.ts` included.
- Development refuses a request with no Caller identity: `curl -si "localhost:$APP_PORT/"` answers `401`
  with `Opsiforce-Outcome: unidentified`. Publish probes this and a request from an unconnected Project
  (`403`, `not connected`) and blocks on anything else; serving the folder with `external-service-cli`
  is what makes both true.
- `SKILL.md` is delivered to the Test Project, and you showed the person its **full text**.
- The live lines and the consumer prompt ran (`references/testing.md`): you wrote the prompt, the person
  sent it in the Test Project's pane, and you judged it from Development's records. While it has not
  run, your hand-over is that prompt and the request to send it; say "ready" once you judged it or the
  person said to skip it.
- The test report is written for the last commit, and `PUBLISH.md` describes this version.
- Every form field's `help` and every refusal message describes the finished service: a line written
  for an earlier step ("used for discovery first") misleads the admin who reads it later.

Then tell the person, in plain words and in this order: what the service lets through and under which
setting (each group and the file in `src/groups/` that holds it), what you agreed with them after
Stop 1 and the bug fixes inside checks, what was tested and by which source, what was not and why, the upstream
protections still to set up on their side, and that someone with the permission publishes it from the
service's page in Store → External Services. The Publish review shows your test warnings first, then `PUBLISH.md`, the form and Event
changes, the new defaults written into stored configurations, the Service skill diff and the code diff.

## `PUBLISH.md`

`app/PUBLISH.md` is plain Markdown the reviewer reads first, rendered as is. Rewrite it before each
Publish request so it describes this version against the one callers use now (the first Publish:
against nothing). Keep it to what a reviewer decides on, about one screen: the test report beside it
holds the evidence, so name each source instead of retelling it.

```markdown
# <What this version does, in one line>

## What changed
- One line per change a reviewer should know: new or changed groups, settings and defaults, Event types,
  counters, bug fixes inside checks.

## What each group lets through
- **<group>** — <what passes, in plain words> — under <setting> (<default>).
- Everything else is not supported.

## Upstream credential and protections
- <credential kind and its permissions>; <the upstream's own protections, set or still to set>.

## Tested
- <what, by which source: unit tests, live calls as the Test Project, the consumer prompt>.

## Not tested
- <what, and why>.
```

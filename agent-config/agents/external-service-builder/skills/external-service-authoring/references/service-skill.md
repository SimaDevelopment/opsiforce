# The Service skill (`SKILL.md`)

`SKILL.md` in `/workspace/app` is what every consuming Agent reads about this service, as the skill
`service-<slug>`. Its reader is an Agent doing a user's task in a Project, or writing the App code that
does it; never the admin who configures the service. It outlives this chat: write it for every Agent
that will use the service for as long as it exists.

## What the Agent already has

Write the skill as the layer on top of these, which are always current:

- **The `platform` skill**: how to reach any service at `https://<slug>.$EXTERNAL_SERVICES_HOST` with
  `$SERVICE_GATEWAY_API_KEY` in a header, to read `/.well-known/opsiforce` before planning, and how to
  relay a refusal (what, why, the link, never retry a *not allowed*).
- **`/.well-known/opsiforce`**, served live from your code: the upstreams with their real addresses and
  mounts, every route with its summary and the settings that govern it, and this Project's settings
  with their labels.
- **A "Reaching it" footer** the platform appends to your skill, naming this service's host and its
  `/.well-known/opsiforce`.

So the skill **never lists routes**: the route table is served live and a copy goes stale. It never
repeats the platform skill's rules either: how to send the key, how to relay a refusal, and that App
code shows its own "not available" message are already there.

## What the skill holds

1. **Frontmatter**: `name` (any; the platform renames it `service-<slug>`) and a `description` saying
   what the upstream is and when to reach for this skill, in the words a user's task will use ("our task
   board", "move a card", "add a note to a ticket").
2. **What it is for**: the upstream in one paragraph, the thing a user names (a project, a board, a
   mailbox), and how this Project's settings decide which of them it reaches and how far.
3. **Setting up a client**, for each tool the brief named, as commands an Agent can paste, each one
   sending the key on the first request and never stopping at a prompt (an Agent's terminal has no one
   to answer it):

   ```sh
   # curl, an SDK or App code: the Service host as the base URL, the key in a header
   curl -s -H "Authorization: Bearer $SERVICE_GATEWAY_API_KEY" "https://<slug>.$EXTERNAL_SERVICES_HOST/v1/me/boards"
   # git: a credential helper that reads the key from the environment, so it never lands in a file or a remote URL
   git config --global credential."https://<slug>.$EXTERNAL_SERVICES_HOST".helper \
     '!f() { test "$1" = get && echo username=key && echo "password=$SERVICE_GATEWAY_API_KEY"; }; f'
   export GIT_TERMINAL_PROMPT=0
   ```

   A CLI that targets a self-hosted or enterprise instance by environment variables gets them, as its
   docs name them: the host variable set to `<slug>.$EXTERNAL_SERVICES_HOST`, its token variable to
   `$SERVICE_GATEWAY_API_KEY`, and its switch that turns prompts off. A vendor SDK gets its base URL
   with the mount and its token option. Never `https://user:key@…`. Write `<slug>` as the
   service's real slug, read from the lane when you write the skill, and keep `$EXTERNAL_SERVICES_HOST`
   as the variable: the lane's `serviceHost` is this deployment's value, and the skill also serves
   every other one. App code reads the key from
   `process.env` on its server only.
4. **The upstream API**: its name and version, the link to its docs, and that its paths and examples
   apply at the Service host as they are, the mount added (`/api/v1/boards/…`), minus any credential the
   docs put in a query or header, which the service adds. Link docs a caller can open: public docs by
   their public address; docs or an API description the upstream serves itself (a self-hosted
   instance's `/docs`, its OpenAPI file) through a read route at the Service host, agreed at Stop 1.
   A private address of the upstream never appears in the skill.
5. **Differences from the upstream**: what a request here cannot do, or does differently, each with the
   setting that decides it: lists that come back filtered, searches narrowed to the allowed targets,
   writes that need an access level, conventions the service enforces (a branch prefix, a co-author
   line), what is not supported at all.
6. **Conventions**: ids that mean something only inside a target, paging, eventual consistency, writes
   that are not idempotent (check before retrying), what people see upstream (notifications, mentions).
7. **Events**, when the service delivers them: each type, when it arrives, how a Project chooses to hear
   it, and the keys of its `data` with their meaning, as a table. App code reads them from
   `external-services.db` and nothing else documents them.
8. **Invented endpoints**, when the service has `handle` routes: each one's request (method, path,
   query, body) and answer, since no upstream docs cover them.
9. **Where the upstream's own record is**: where a person checks what was done through this service in
   the upstream itself (its audit log, the credential's activity page), since the Call log is the
   service's own account.

Aim for one page an Agent reads in one pass: about 300 to 800 words, a table only for Event `data`.

## Checking it

Run `test-project/update` after every change to `SKILL.md`, and set up each client in the Test Project
exactly as the skill says during the live calls (`references/testing.md`). Judge the consumer prompt
partly on it: an Agent that had to ask what an id means, guessed a client setup or worked around a
refusal points at a missing line. Show the person the full text at the hand-over.

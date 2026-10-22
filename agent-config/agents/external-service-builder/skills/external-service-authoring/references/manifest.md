# The Service manifest (`service.json`, SDK 2)

What the platform knows about the service without running it: its name, its two forms and its Event
types. The platform renders and stores the forms and knows the Event types; it never reads the routes,
which live in `service.ts`. `yarn check` runs every rule below and prints each problem with its path.

## Contents

- Header
- The two forms
- Designing the settings
- Field catalog
- Options
- Events
- Changing a manifest that is already published

## Header

```jsonc
{ "sdk": 2, "displayName": "Boards", "description": "Boards, lists and cards on the boards a Project is given.",
  "icon": "icon.svg", "inbound": true, "serviceForm": [], "projectForm": [], "events": {} }
```

- Required: `sdk` (always `2`), `displayName` (at most 80 characters), `description` (plain text, at
  most 300).
- Optional: `icon` (a relative `.svg` path), `inbound` (`true` when the service has a webhook handler,
  `references/inbound.md`), `serviceForm`, `projectForm`, `events`, `$schema`.
- Never `name` (the slug is the service's identity), `version` (Publish records the manifest hash), or
  `operations`, `bounds` and `$defs`: what a request may do is the routes' checks.
- The whole file is at most 256 KB. `yarn types` turns it into `service.types.ts`: both configurations
  typed (secrets as `Secret`), `Setting` (the Project-form keys, for `allowedBy` and `notAllowed`),
  `EventType` and the handler names.

## The two forms

- **`serviceForm`**: filled once for the Organization by its admin on the service's page, and
  separately for Development in this chat's Development configuration. The upstream's credentials,
  its address when it can differ, webhook signing secrets, Organization-wide choices. Every Project
  shares it.
- **`projectForm`**: filled per ProjectEnvironment from the chat bar, by whoever may configure that
  Project's External Services: the **settings** that decide what this environment's requests may do.
  Having one connects the environment; without one the SDK refuses it as *not connected*.

## Designing the settings

- **One setting per decision a person makes about a Project**, named for it: which targets, and how
  much on each. The usual shape is a `list` of target + access level, each level a `select` whose
  default is the narrowest ("Read"), so every change starts off:

  ```jsonc
  { "key": "boards", "type": "list", "label": "Boards", "item": [
      { "key": "boardId", "type": "select", "label": "Board", "required": true, "options": { "call": "listBoards", "searchable": true } },
      { "key": "access", "type": "select", "label": "Access", "default": "read", "options": [
          { "value": "read", "label": "Read" }, { "value": "cards", "label": "Change cards" } ] } ] }
  ```

- A `toggle` that widens reach defaults to `false`; a number that caps something defaults to a small
  value; "all targets" is a choice someone makes, never a default.
- Labels are what a refusal names ("Setting "Boards""), so write them as a person would look for them.
- Use `help` to say what each choice lets through, in the words of the groups at Stop 1.
- A Project-form `secret` is a per-Project upstream account (each Project's own token), read by the
  upstream's `credentials`.

## Field catalog

Common properties:

| Property | Rules |
| --- | --- |
| `key` | `^[a-zA-Z][a-zA-Z0-9_]{0,63}$`, unique at its level; a `section` has none |
| `label` | at most 120 characters |
| `help` | at most 1000, a Markdown subset: https links, bold, code, line breaks |
| `required` | value fields except `toggle` |
| `placeholder` | value fields except `toggle` |
| `visibleWhen` | `{field, equals}`, `{field, in: [...]}` or `{field, truthy: true}`, naming a value field at the same level; hidden values are dropped before validation, so a hidden required field is not required |
| `was` | the key this field had before a rename; the stored value moves on read |

| `type` | Holds | Own properties |
| --- | --- | --- |
| `text` | one line | `default`, `validate`, `generate` (not both `generate` and `default`) |
| `textarea` | several lines | `default`, `validate` |
| `number` | a number | `default`, `min`, `max`, `integer`, `step` |
| `toggle` | a boolean | `default`; no `required` |
| `radio` | one option | `options`, `default` |
| `select` | one option | `options`, `default` |
| `multiselect` | several options (chips) | `options`, `default`, `minItems`, `maxItems` (at most 500) |
| `secret` | a sealed string | `multiline`, `generate`; never a `default` |
| `list` | items of one level | `item` (1–50 fields, sections allowed, no list inside), `maxItems` (default 100, at most 1000) |
| `keyValue` | plain string pairs | `default`; at most 100 entries |
| `section` | a group of fields | `title`, `description`, `collapsed`, `visibleWhen`, `fields`; values stay flat, sections do not nest |
| `info` | a read-only line | exactly one of `text`, `template` or `call` |
| `button` | an action in the form | `label`, `call`, `confirm` (`true` or a question) |

There are no `oauth`, `file`, date or `json` fields: ask the person to paste a token instead of designing
a sign-in flow.

- **`validate`** on `text` and `textarea`: `minLength`, `maxLength`, and `format`, one of `email`,
  `emailOrDomain`, `url` (https only; `allowHttp: true` adds http), `hostname`, `e164`, `ipOrCidr`. There
  is no regex; check anything finer in the code that reads it.
- **`generate`** on `text` and `secret`: `{bytes: 16–64}` (base64url) or `{length: 8–64, alphabet}`,
  `alphabet` one of `base32lower`, `alphanumeric`, `lowercaseAlphanumeric`, `digits`, `hex`; on `text`
  add `unique: true` when two configurations must never share the value. The platform fills it when
  the configuration or list item is saved with the field empty, shows a generated secret once, and
  makes a new one on Rotate (which runs the save hook). Use it for values the service invents (a
  signing secret it gives the upstream, an inbound address), never for values the upstream issues.
- **`list` items** get a hidden `id` from the platform (`id` is reserved inside items).
- **`info`**: `text` is fixed; `template` fills `{{field}}` (a `text`, `textarea`, `number`, `toggle`,
  `radio` or `select` at the same level), `{{serviceConfiguration.<key>}}` (Project form only) and
  `{{webhookUrl}}`, never a secret or a list; `call` asks an `info` handler for a live line.

## Options

`radio`, `select` and `multiselect` take one source:

- a static list `[{value, label, description?}]` (1–500 entries, values at most 200 characters);
- `{call: "<handler>", searchable?, dependsOn?: ["<field>"]}`: an `options` handler answers at most 50
  `{value, label, description?}` (`references/handlers.md`); a change to a `dependsOn` field clears
  this one;
- `{serviceConfiguration: "<list key>", labelKey: "<item field>"}`, Project form only: offers the items
  of a Service-form list and stores the chosen item's `id`. Use it when the Organization holds several
  upstream accounts: the Service form has a `list` of accounts with their secrets, the Project picks
  one, and the routes use only that item.

## Events

With `"inbound": true`, each Event type is a dotted `snake_case` key with a `title` (at most 80) and a
`description` (at most 500) and nothing else; the `data` shape goes in the Service skill. Which Projects
receive an Event is the service's code (`references/inbound.md`).

## Changing a manifest that is already published

Stored configurations are read against the new manifest, so a new version must not strand them:

- Rename a field with `was: "<old key>"`; never reuse an old key for another meaning.
- A field added with a `default` gets that default written into every stored configuration when the
  version becomes the one callers use, and the Publish review lists it ("new setting X = default in N
  configurations"). So a new setting that widens reach defaults to off.
- A stored value that no longer fits counts as missing, and a required field with no value makes the
  configuration *incomplete*: the SDK refuses that Project's requests, naming the field, until someone
  fills it.
- Removed fields stay stored and are never delivered.

Say each of these consequences at Stop 1 when the change touches a published service.

# The Service manifest (`service.json`, SDK v1)

Everything the platform knows about the service without running it. `yarn check` runs every rule
below and prints each problem with its path (`error operations.create_card.input: …`). The editor
schema is `service.schema.json` in the SDK folder.

## Contents

- Header
- Forms and the field catalog
- Operations
- Input schemas
- Bounds
- Events
- Changing a manifest that is already published

## Header

```jsonc
{ "sdk": 1, "displayName": "Task Tracker", "description": "Read and update tasks on your boards.",
  "icon": "icon.svg", "inbound": true,
  "serviceForm": [], "projectForm": [], "operations": {}, "events": {}, "bounds": {}, "$defs": {} }
```

- Required: `sdk` (always `1`), `displayName` (≤80), `description` (plain text, ≤300).
- Optional: `icon` (a relative `.svg` path), `inbound` (`true` only when the service receives
  webhooks), `$schema`.
- Never `name` (the service's slug is its identity) or `version` (Publish records the manifest hash).
- The whole file is at most 256 KB.

## Forms and the field catalog

Two forms, both rendered by the platform's one form renderer:

- **`serviceForm`**: filled once per Organization by its admin on the service's page. Credentials,
  accounts, base URLs, webhook signing keys. Every handler sees it whole (lists trimmed, below).
- **`projectForm`**: filled per ProjectEnvironment from the chat bar. What this environment may reach:
  which account, which boards, which mailbox. Bounds read it.

The Service configuration callers use and Development's own are separate: testing never changes what
callers use.

### Common properties

| Property | Rules |
| --- | --- |
| `key` | `^[a-zA-Z][a-zA-Z0-9_]{0,63}$`, unique at its level; a `section` has none |
| `label` | ≤120 |
| `help` | ≤1000, Markdown subset: https links, bold, code, line breaks |
| `required` | value fields except `toggle` |
| `placeholder` | value fields except `toggle` |
| `visibleWhen` | `{field, equals}`, `{field, in: [...]}` or `{field, truthy: true}`, naming a value field at the same level; hidden values are dropped before validation, so a hidden required field is not required |
| `was` | the key this field had before a rename; the stored value moves on read |

### Field types

| `type` | Holds | Own properties |
| --- | --- | --- |
| `text` | one line | `default`, `validate`, `generate` (not both `generate` and `default`) |
| `textarea` | several lines | `default`, `validate` |
| `number` | a number | `default`, `min`, `max`, `integer`, `step` |
| `toggle` | a boolean | `default`; no `required` |
| `radio` | one option | `options`, `default` |
| `select` | one option | `options`, `default` |
| `multiselect` | several options (chips) | `options`, `default`, `minItems`, `maxItems` (≤500) |
| `secret` | a sealed string | `multiline`, `generate`; never a `default` |
| `list` | items of one level | `item` (1–50 fields, sections allowed, no list inside), `maxItems` (default 100, ≤1000) |
| `keyValue` | plain string pairs | `default`; ≤100 entries |
| `section` | a group of fields | `title`, `description`, `collapsed`, `visibleWhen`, `fields`; values stay flat, sections do not nest |
| `info` | a read-only line | exactly one of `text`, `template` or `call` |
| `button` | an action in the form | `label`, `call`, `confirm` (`true` or a question) |

Not in v1: `oauth`, `file`, date or time types, `json`. Ask the person to paste a token instead of
designing an OAuth flow.

**`validate`** on `text`/`textarea`: `minLength`, `maxLength`, and `format` ∈ `email`,
`emailOrDomain`, `url` (https only; `allowHttp: true` adds http), `hostname`, `e164`, `ipOrCidr`.
There is no regex; check anything finer in the handler.

**`generate`** on `text`/`secret`: `{bytes: 16–64}` (base64url) or `{length: 8–64, alphabet}` with
`alphabet` ∈ `base32lower`, `alphanumeric`, `lowercaseAlphanumeric`, `digits`, `hex`; on `text`
add `unique: true` when two configurations must never share the value (`secret` takes no `unique`:
a generated secret never collides). The platform fills it when the
configuration or list item is saved with the field empty (in a Project form of a service with Events,
once the configuration receives an Event type) and shows a generated secret once; Rotate makes a new
one and fires the save hook. A Publish never copies a `unique` value to the target. Use it for webhook
signing secrets and inbound addresses the service invents, never for values the outside system issues.

**`list` items** get a hidden `id` from the platform (`id` is reserved inside items). Use a list when
the Organization may hold several accounts, numbers or workspaces.

**`info`**: `text` is fixed; `template` interpolates `{{field}}` (a `text`, `textarea`, `number`,
`toggle`, `radio` or `select` at the same level), `{{serviceConfiguration.<key>}}` (Project form only)
and `{{webhookUrl}}`, never a secret or a list; `call` asks a handler for a live line.

### Options

`radio`, `select` and `multiselect` take one source:

- a static list `[{value, label, description?}]` (1–500, values ≤200);
- `{call: "<handler>", searchable?, dependsOn?: ["<field>"]}`: a handler answers at most 50
  `{value, label, description?}`; a change to a `dependsOn` field clears this one;
- `{serviceConfiguration: "<list key>", labelKey: "<item field>"}`: Project form only; offers the items
  of a Service form list and stores the chosen item's `id`.

The Project form reserves `operations` and `receive` (the platform's generated switches) and stores
`_labels` beside them; never declare those keys.

## Operations

```jsonc
"operations": {
  "list_tasks":  { "kind": "read", "description": "List the tasks on an allowed board.", "input": { "$ref": "#/$defs/ListTasks" } },
  "create_task": { "kind": "write", "title": "Create task", "description": "Create a task on an allowed board. Returns the new task.",
                   "input": { "$ref": "#/$defs/CreateTask" }, "outputExample": { "id": "t_81", "url": "https://…" } },
  "delete_task": { "kind": "destructive", "description": "Delete a task from an allowed board.",
                   "input": { "$ref": "#/$defs/DeleteTask" }, "limits": { "timeoutSeconds": 60 } }
}
```

- Names are snake_case: `^[a-z][a-z0-9_]{0,63}$`.
- `kind` is one of `read`, `write`, `destructive`:
  - `read` changes nothing outside;
  - `write` creates or changes something that can be changed back, including records the outside
    system shows or announces to its own users (an issue, a comment, a card);
  - `destructive` deletes, delivers a message to people outside the Organization (an email, a chat
    message), moves money, or cannot be undone. When unsure, take the stricter kind.
  A new Project configuration starts with reads on and every write and destructive Operation off; an
  Operation added later is off in every existing configuration.
- `description` (required, ≤500, Markdown subset) is the only per-Operation text the calling agent gets
  (through `openapi.json`): what it does, what it returns, what it refuses, its defaults and limits, and
  what a user sees upstream (a notification, a non-idempotent create). `title` (≤80) labels the switch.
- `outputExample` documents the answer in `openapi.json`; there are no output schemas.
- `limits`: `inputBytes` (default 1 MB, ≤25 MB) and `timeoutSeconds` (default 30, ≤300). Answers are at
  most 25 MB.
- Option lists, `info.call` and buttons are form calls, never Operations.

## Input schemas

Each Operation's `input` and each Event's `data` is a JSON Schema 2020-12 subset that resolves to
`type: "object"`. The Gate validates every input with it (`400 invalid-input`) and fills `default`s
before your handler runs.

- Every node has a `type`, or is a `$ref` with at most a `description` beside it.
- `$ref` points only to `#/$defs/<Name>`; `$defs` live only at the top level and never refer to each
  other in a cycle. Each `$defs` name becomes a TypeScript type in `service.types.ts`.
- Allowed: `type`, `title`, `description`, `default`, `examples`, `enum`, `const`, `properties`,
  `required`, `additionalProperties`, `minProperties`, `maxProperties`, `items`, `minItems`,
  `maxItems`, `uniqueItems`, `minLength`, `maxLength`, `format`, `minimum`, `maximum`,
  `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`, `anyOf`, `oneOf`, `boundTo`.
- Refused: `pattern`, `patternProperties`, `$id`, `allOf`, `not`, `if`/`then`/`else`, `contains`,
  `prefixItems`, `propertyNames`, `dependentSchemas`, `dependentRequired`, `unevaluated*`, remote
  refs. Check a pattern in the handler and answer `ServiceError` 400.
- `format` ∈ `date-time`, `date`, `email`, `uri`, `uuid`, `hostname`, `ipv4`.
- Caps: depth 8, 64 KB per schema, 200 properties, 500 `enum` values, 20 `anyOf`/`oneOf` alternatives.
- Write `additionalProperties: false`, `maxLength` on every id and string, and `required` for what the
  handler cannot do without; the agent reads them as the contract.

## Bounds

A bound ties an input value to what the caller's Project configuration allows. Declare each once:

```jsonc
"bounds": {
  "board":   { "path": "boardIds", "unless": { "boardsMode": "all" } },
  "account": { "path": "workspace" },
  "chat":    { "path": "channels[].chats", "where": { "channel": "/channel" } }
}
```

Then mark each input or Event property that carries such an id: `"boardId": {"type": "string",
"boundTo": "board"}`. An array of ids binds on its `items`. `boundTo` sits only on string schemas.

`path` takes one of four shapes, read from the Project form:

| Shape | Example | Allowed values |
| --- | --- | --- |
| a scalar field | `workspace` | equals the stored value |
| an array field | `boardIds` | any of the stored values |
| `list[].field` | `channels[].chats` | the field in any list item |
| `list[].field` + `where` | `channels[].chats` with `where: {"channel": "/channel"}` | the field in the item whose `channel` equals the input at the JSON Pointer `/channel` |

- The path's field is a `text`, `textarea`, `radio`, `select` or `multiselect`; a `where` key is a
  single-value field of the same items.
- `unless: {<project field>: <value>}` (one entry) means "all" only while that field holds exactly that
  value; the handler then sees the `ALL` sentinel from `ctx.bounds.values`.
- Empty means nothing: a Project configuration with no boards allows no board. Matching is exact.
- The Gate checks every bound input before the handler runs and answers `403 out-of-bounds` naming the
  bound, the pointer and the allowed values with their labels. Ids the input reaches only indirectly
  (a task id whose board is not in the input) and ids in the answer are yours to check:
  `references/handlers.md` §Bounds in code.
- `check` errors on an undeclared `boundTo` name or a path that is not a Project form field, and warns
  on a bound nothing uses and on every write or destructive Operation with no bound.

## Events

Only with `"inbound": true`. Each type is dotted snake_case (`task.moved`, ≤100 characters, up to four
segments):

```jsonc
"events": { "task.moved": { "title": "Task moved", "description": "A task moved to another list.",
  "data": { "type": "object", "properties": { "boardId": { "type": "string", "boundTo": "board" },
                                              "taskId": { "type": "string", "maxLength": 64 } },
            "required": ["boardId", "taskId"] } } }
```

`data` follows the input schema rules. A bound property decides which ProjectEnvironments receive the
Event; a Custom service may leave a type unbound, and then every environment of the Organization that
switched it on receives it. Bind every type that is about something a Project chose.
`references/inbound.md` has the rest.

## Changing a manifest that is already published

Stored configurations are read tolerantly, so a new version must not strand them:

- Rename a field with `was: "<old key>"`; never reuse an old key for a different meaning.
- A stored value that no longer fits counts as missing. A newly required field with no value makes the
  configuration "Needs attention" and every call `409 configuration-incomplete` until someone fills it;
  the Publish dialog asks for newly required Service form fields before it publishes.
- Removed keys stay stored but are never delivered.
- New Operations and new Event types are off in every existing Project configuration.

Say each of these consequences in Stop 1 when the design changes a published service.

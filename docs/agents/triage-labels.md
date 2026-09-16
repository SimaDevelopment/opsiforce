# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

Because the tracker is local markdown (see `issue-tracker.md`), a "label" is just the string written on the `Status:` line of an issue file — not a GitHub label.

| Role in mattpocock/skills | String in our tracker | Meaning                                  |
| ------------------------- | --------------------- | ---------------------------------------- |
| `needs-triage`            | `needs-triage`        | Maintainer needs to evaluate this issue  |
| `needs-info`              | `needs-info`          | Waiting on reporter for more information |
| `ready-for-agent`         | `ready-for-agent`     | Fully specified, ready for an AFK agent  |
| `ready-for-human`         | `ready-for-human`     | Requires human implementation            |
| `wontfix`                 | `wontfix`             | Will not be actioned                     |

We use the canonical defaults unchanged. When a skill mentions a role (e.g. "apply the AFK-ready triage label"), write the corresponding string on the issue file's `Status:` line.

Note: `to-prd` and `to-issues` produce issues that are already AFK-ready, so they apply only `ready-for-agent`. The other roles are used by `triage` when processing incoming/unevaluated issues.

Edit the right-hand column if you ever adopt a different vocabulary.

# Office documents are converted in-cluster by Gotenberg

A `.docx` or `.pptx` is a zip of XML that no browser renders, so File preview converts it to a PDF on one shared, stateless Gotenberg deployment per cluster, pinned to an exact image tag, reachable only as a ClusterIP with URL fetching disabled and private-address fetches denied. Conversion is a job (request returns an id, the panel polls, a third endpoint streams the PDF) because one converter converts one document at a time and a request-response endpoint would hang behind someone else's slide deck. Results are held transiently in the backend's memory for minutes and never cached, so reopening a document converts it again.

## Considered options

- **Client-side JavaScript renderers.** Rejected: no first-tier steward behind any of them.
- **A hosted conversion API.** Rejected: tenant documents would leave the deployment, and air-gapped and standalone installs could not run it.
- **A conversion cache.** Rejected for now: a second copy of a tenant's document to keep consistent, invalidate and clean up; caching is additive if repeat-open latency ever matters.

## Consequences

- The converter's reply maps to three outcomes: unconvertible (download, no retry), retryable and busy (download with Try again).
- Job results live in a single-replica backend's memory, so a job started just before a rolling restart is lost and surfaces as retryable.

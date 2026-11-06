---
kind: explanation
terms: [Custom domain]
---

# Custom domain

> How does an App owner add an address on their own domain to an App, and what does each domain's status mean?

## How it works

### Offering it

- A deployment offers [Custom domains](../../GLOSSARY.md) only when its backend's `CUSTOM_DOMAINS_CLUSTER_ISSUER` names the cert-manager cluster issuer that signs their certificates ([Domain routing](domain-routing.md)); the local stack and dev name one. With none, `GET /api/tenants/config` answers `customDomainsEnabled: false`, the UI shows no Domains entry and every domain route answers 404.
- Domains opens from the globe button in the App pane's toolbar and from Domains in an environment's ⋮ menu, both shown only when the deployment offers Custom domains and the environment has an [App](../../GLOSSARY.md) with a [Public URL](../../GLOSSARY.md). A Project that serves an [External Service](../../GLOSSARY.md) has none, so every domain route of its environments answers 404.

### The Domains dialog

- The dialog shows the environment's [Public URL](../../GLOSSARY.md) with a copy button, then its [Default address](../../GLOSSARY.md), which always reaches the App and is what every record points at ([Public URL](public-url.md)), then one row per domain. A row carries the domain with `+ www` on a bare one, a MAIN badge on the [Main domain](../../GLOSSARY.md) ([Main domain](main-domain.md)), its status, a Check icon whose tooltip says when it was last checked, and a ⋮ menu with Copy address, Make main on a connected domain that isn't main, Redirect to Main domain, checked while it is on, on any domain but the Main domain while the App has one ([Main domain](main-domain.md)), and Remove. When the list can't be loaded, the dialog says "Couldn't load the domains of this App." with a Retry button.
- A row that isn't connected opens by itself on three stages: "Add this record at your DNS provider" ("these records" for a bare domain), "Certificate for https" and "Serving at https://<domain>/". The first holds the records, for a bare domain "No ALIAS record at your DNS provider? Remove this domain, add www.<domain> instead, and forward <domain> to it with your provider’s URL redirect.", "DNS answers now:" with the last answer or "no record for this name yet", a labelled Check button and when it was last checked, then "Press Check after you add the record. DNS changes can take from minutes to a few hours." ([DNS check](dns-check.md)).
- Once DNS passes, the first stage reads "DNS points at this App" and the second says "Usually takes a minute. The domain starts working as soon as the certificate is ready.", adding "This updates on its own while this window is open." for a member with `can_manage_custom_domains`. Once failed, it shows cert-manager's reason after "Details:", then "Usually the record points somewhere else, a proxy in front of the domain is on, or something blocks port 80. Fix that, then Try again." and a Try again button.
- A connected row stays one line; opened, it shows its record and says it is the App's Public URL on the Main domain, that visitors are sent on to the Main domain on one set to redirect, or that the App is served there over https on any other, with the sign-in callback to register and a copy button on every domain that serves while [App Auth](../../GLOSSARY.md) is on. Any row opens and closes by hand. For a member with `can_manage_custom_domains` the dialog fetches the list through refresh, which checks as it goes, when it opens and every 10 seconds while a domain is waiting for DNS or issuing its certificate; anyone else reads it unchanged on the same schedule ([DNS check](dns-check.md)).
- The add form is open from the start while the App has no domain; after that an Add domain button opens it. Its input takes focus only on a device with a fine pointer, and submitting it empty says "Enter a domain, like app.example-org.com.". A member without `can_manage_custom_domains` sees "No custom domains yet. People who can manage custom domains can add one here." while there are none. A line under the list shows how many Custom domains the [Organization](../../GLOSSARY.md) uses of its [Limit](../../GLOSSARY.md), and at the Limit a note replaces the add button.

### Adding a domain

- The typed name loses its scheme, path, port and trailing dot and is lowercased, and an international name is stored as punycode and shown in Unicode. An IP address, a name without a dot such as `localhost`, a wildcard, characters other than letters, digits, dots and dashes, a domain the App already has, the `www` of a bare domain the App already has, and a bare domain whose `www` the App already has on its own are refused with the reason under the input, as is a domain under one of `CUSTOM_DOMAINS_REFUSED`, each of which refuses itself and its subdomains.
- DNS decides whether the name is a bare domain or a subdomain: walking up from the name and stopping below the top-level domain, the first name with an `SOA` record and no CNAME is where its zone starts, and the name is bare when it is that zone start. That is how `example-org.co.uk` and a subdomain run as its own zone come out bare.
- The walk asks the same public resolvers as Check ([DNS check](dns-check.md)). A name with no `SOA` at any level is refused as not in DNS yet, and resolvers that do not answer make the add answer 503 with nothing stored.
- A subdomain is shown one record, `CNAME <domain>` to the Default address, and a bare domain, which cannot hold a CNAME, `ALIAS <domain>` and `CNAME www.<domain>` to it. Each record also carries its `host`, the name relative to the zone start as a DNS provider's Host field wants it: `app` for `app.example-org.com`, `@` for a bare domain and `www` for its `www`.
- The dialog shows each record as a block with its type, the host (full name under it) and the value it points to, each with a copy button, under them the hint to enter only the part shown in the Host field and to turn off the provider's proxy for the record if it offers one.
- The domain is stored as one `custom_domains` row of the [ProjectEnvironment](../../GLOSSARY.md), with its zone start and bare-or-subdomain answer, in status Waiting for DNS, and checked once before the add answers, so a record that is already right moves it on at once. The add checks the App's other domains and the Limit inside the transaction that stores the row, under an advisory lock on the name without its `www`.

### Ownership, permission and Limit

- A Custom domain belongs to one ProjectEnvironment: deleting the environment or its Project deletes its domains with what the cluster holds for them ([Domain routing](domain-routing.md)), and [Publish](publish.md), [Duplicate](duplication.md) and [Import](export-import.md) never copy them.
- Everyone who can open the Project sees an environment's domains. Adding, checking, refreshing, making main and removing one need `can_manage_custom_domains`, which the `opsiforce_admin` bundle grants ([Permissions](../organization/permissions.md)).
- Every domain counts toward the Organization's `custom_domains` Limit whatever its status, a bare domain and its `www` as one ([Limit](../organization/limit.md)).
- Remove asks for confirmation, reminds the owner to delete the DNS record, and deletes the domain's route, Certificate and Secret, then its row; removing the Main domain hands that role on ([Main domain](main-domain.md)).

## States

Each Custom domain row has one status, shown as the pill on its row.

| State | What happens |
|---|---|
| Waiting for DNS | Stored on add. Check, and refreshing the list while Domains is open, look for the record ([DNS check](dns-check.md)). |
| Issuing certificate | Check passed: the domain's Certificate is ordered and its route written. Check, and refreshing the list while Domains is open, read the Certificate ([Domain routing](domain-routing.md)). |
| Connected | The Certificate was ready when someone last looked; the first to connect in an environment becomes its Main domain. |
| Certificate failed | cert-manager gave up and its reason is shown; Try again runs Check, whose pass orders the Certificate afresh. |

## Edge cases

- When a name still has a CNAME, for example to its old host, it counts as a subdomain, since a zone start cannot hold a CNAME.
- When a public resolver does not answer the first check of an add, the domain is stored unchecked in Waiting for DNS.
- When another App's Check passes for the same domain, because its owner re-pointed the record, the domain disappears from this App's list with its route and certificate ([DNS check](dns-check.md)).

## Code

- `backend/src/custom-domain/` — the domain routes, reading a typed name, the zone-start walk, and adding, listing and removing a domain.
- `custom_domains` in `backend/db/schema.ts` — one row per domain.
- `frontend/src/components/project/custom-domains/` — the Domains dialog.
- `frontend/src/api/custom-domains.ts` — the domain list, its refresh, and the add, check, make main and remove calls.

## Related

- [DNS check](dns-check.md) — the record's proof, when Check runs, and taking a domain from another App.
- [Domain routing](domain-routing.md) — each domain's certificate, route and sign-in.
- [Main domain](main-domain.md) — the one domain that is the Public URL, and the redirect the others carry.
- [Public URL](public-url.md) — the Default address every record names.
- [Limit](../organization/limit.md) — how the `custom_domains` Limit is set and enforced.
- [Permissions](../organization/permissions.md) — how `can_manage_custom_domains` is granted.

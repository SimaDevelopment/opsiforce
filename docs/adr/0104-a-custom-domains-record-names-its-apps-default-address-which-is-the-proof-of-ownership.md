# A Custom domain's record names its App's Default address, which is the proof of ownership

Before the platform routes `shop.example-org.com` to an App and orders a certificate for it, it has to know that whoever controls that domain chose this App. Otherwise any Organization could claim a domain that merely points at the platform. The usual record is a CNAME to one shared address per platform, as Base44 does with `base44.onrender.com`. That record only proves the domain points at the platform, so those platforms add TXT claim records and reserve the domains of deleted apps.

**The customer adds `CNAME <their host> → <the App's Default address>`, for example `CNAME shop → equipment-monitor-prod-6713b7a51450.apps.opsima.com`. Check asks public resolvers for that record and passes when its target is one of this ProjectEnvironment's own addresses: one of its Default addresses under the apps domain, or one of its connected Custom domains. A record that names one App is the proof that the domain's owner chose that App, so there is no TXT record and no shared target.** Concretely:

- **Traffic still ends at Traefik.** The Default address resolves through the `*.apps…` wildcard record to the Traefik load balancer, so the customer's record reaches it one DNS hop later than a CNAME straight to the load balancer would.
- **Any of the App's own addresses passes, and only those.** Check accepts the current Default address, every earlier one an App Slug gave it, its legacy address and its own connected Custom domains, so an Edit URL after connecting never disconnects a domain and a `www` may name the App's bare Main domain. The App's preview host does not pass, since it serves the in-product preview rather than visitors, and the instructions always show the current Default address.
- **A bare domain comes with its `www`.** A domain's apex cannot carry a CNAME, so the customer adds an ALIAS or ANAME record for it to the Default address, which answers with addresses rather than a name, plus `CNAME www → <Default address>`. The `www` record proves control of the zone. The apex passes when it resolves to at least one of the Default address's addresses, and `www` redirects to the [Main domain](../../GLOSSARY.md).
- **Check asks public resolvers directly,** `8.8.8.8` and `1.1.1.1` unless the deployment configures others, because the cluster's resolver may still cache the answer from before the customer's change.
- **Whoever DNS names wins.** When a domain held by one App passes Check for another, which only happens when the customer re-points the record, the new App takes it, and the old App's domain is deleted with its route and certificate.
- **Check runs when someone acts or looks, never in the background:** when the domain is added, when the owner presses Check, and while the Domains dialog is open, which asks again every 10 seconds while a domain is still settling. A record fixed while nobody looks is found at the next look.
- **Our own domains cannot be claimed.** The deployment configures a list of refused domains with their subdomains (`opsima.com`, `simaanalytics.co`, `simaanalytics.com` on ours). Our own records never name an App, so such domains would fail Check anyway. IP addresses, `localhost` and single-label names are refused, and international names are stored as punycode.

## Considered options

- **One shared target per deployment, the Traefik load balancer's address** (Base44's way, and the address CI already computes for external-dns). Rejected: Check would prove only that the domain points at the platform. A domain removed from one App while its record stays could then be added and connected by any Organization, a subdomain takeover, unless every domain also carried a TXT claim. The address also differs per cluster and comes from CI: on Cloudfleet the backend inside the cluster sees only the API server's Service IP, so it cannot compute the address at runtime.
- **A TXT verification record for every domain** (GitHub Pages' way). Rejected: a second record for every customer to add, where the CNAME can carry the proof itself.
- **A generated target per domain** (Heroku's `*.herokudns.com`). Rejected: it gives the same proof, but each domain would need its own record in our DNS zone, where the Default address and its wildcard record already exist.
- **A records to the load balancer's IP.** Rejected: dev and prod reach Traefik through a Cloudfleet hostname with no fixed IP, and an IP proves nothing about which App the customer chose.
- **A bare domain accepted on its ALIAS record alone.** Rejected: an ALIAS answers with addresses, so Check could see that the domain points at the platform but not at which App.

## Consequences

- The instructions differ per App, so a customer moving a domain to another App edits the record's value, not only the platform's settings.
- Every DNS provider can express the subdomain case. Bare domains need a provider with ALIAS, ANAME or CNAME flattening. Cloudflare must be set to "DNS only", or Check sees Cloudflare's addresses and the certificate cannot be issued.
- Locally the Default address resolves to `127.0.0.1` through `localtest.me`, so a real domain the developer owns can point at a local App, and Check runs unchanged.
- The proof rests on an App's Default addresses never reaching another App, since a removed domain's record keeps naming them. App Short IDs are 48-bit prefixes of random ids, so a deleted App's address is practically never issued again.

---
kind: explanation
terms: [Check]
adrs: [0104]
---

# DNS check

> How does the platform decide that a Custom domain's DNS names its App, when does it check, and what happens when another App passes?

## How it works

### The proof

- A [Custom domain](../../GLOSSARY.md)'s record names the App's [Default address](../../GLOSSARY.md), and that is the proof the domain's owner chose this App ([ADR-0104](../adr/0104-a-custom-domains-record-names-its-apps-default-address-which-is-the-proof-of-ownership.md)). [Check](../../GLOSSARY.md) asks the public resolvers `8.8.8.8` and `1.1.1.1`, never the cluster's resolver.
- A subdomain passes when its CNAME names one of the [ProjectEnvironment](../../GLOSSARY.md)'s own addresses the App address lookup resolves ([Public URL](public-url.md)): a Default address under the apps domain, current, from an earlier App Slug or legacy, or one of its Custom domains the lookup answers for it ([Main domain](main-domain.md)), such as the bare Main domain a `www` names. Its preview host never passes, though the lookup maps it to the App too.
- A bare domain passes when its `www` passes that rule and the apex's A and AAAA addresses include at least one of the Default address's.
- Each check stores what DNS answered and when: `CNAME → <target>` for a name with a CNAME, otherwise its `A → …` and `AAAA → …` addresses, and for a bare domain the apex's addresses followed by the `www` name's answer. Nothing found stores no answer.

### Running it

- A pass moves a Waiting for DNS or Certificate failed domain to Issuing certificate, orders its certificate and writes its route at once ([Domain routing](domain-routing.md)). Otherwise a domain keeps its status and only gets the new answer.
- Nothing checks in the background: Check runs when the domain is added, when someone presses Check, and when Domains is open. `POST /api/projects/<id>/environments/<envId>/domains/<domainId>/check`, from the labelled Check button, the row's Check icon and Try again, checks a Waiting for DNS, Certificate failed or Connected domain and reads the Certificate of an Issuing certificate one instead ([Domain routing](domain-routing.md)), then answers the domain. Unreachable resolvers make it answer 503 with nothing stored.
- `POST /api/projects/<id>/environments/<envId>/domains/refresh` takes that same step for every Waiting for DNS and Issuing certificate domain of the environment, then answers the list; a resolver that doesn't answer leaves that domain as it was. The Domains dialog calls it when it opens and every 10 seconds while a domain is in either status, for a member with `can_manage_custom_domains`, which both calls need; everyone else only reads the list with `GET`, which checks nothing ([Custom domain](custom-domain.md)).

### Taking a domain from another App

- On a pass, under the App Auth lock of every environment involved, taken in id order before anything is deleted (the passing one and each one holding the domain), and an advisory lock on the name without its `www`, any other environment's domain holding the same host, its `www` or its bare parent in Issuing certificate, Connected or Certificate failed is deleted, of the same or another [Organization](../../GLOSSARY.md), with its route, Certificate and Secret. Its environment's [Main domain](../../GLOSSARY.md) role is handed on as on Remove, and its routes are rewritten ([Main domain](main-domain.md)). A rewrite of a losing environment already holding its lock finishes first, so nothing it writes outlives the takeover; a holder that appears after the environments were read makes the pass give up, and the next Check or refresh tries again.
- All of that, and the new domain's certificate and route, happen in the one transaction that moves it to Issuing certificate, with the old App's objects deleted first. When a cluster write fails the transaction rolls back: the old App keeps the domain and its route, the new one stays Waiting for DNS, and the next Check or refresh tries again. So the old App's sign-in or marker never fronts the new App.
- A partial unique index on `hostname` keeps two rows with one name from holding it at once. Another environment's domain still Waiting for DNS for the same name stays as it is.

## Edge cases

- When a bare domain's apex has a plain A record with the Default address's own addresses instead of an ALIAS, Check passes too, since the `www` CNAME is what names the App; that record stops reaching the App if the load balancer's address ever changes, which an ALIAS follows. A provider with no ALIAS can connect `www.<domain>` as a subdomain and forward the bare domain to it instead.

- When another App of any Organization is waiting on the same domain, adding it is still allowed, and a pass on either leaves the other waiting.
- When a DNS provider proxies a record, Check sees the proxy's addresses instead of the CNAME, and the domain stays Waiting for DNS.
- When a connected domain's record is later deleted or re-pointed outside the platform, the domain stays Connected, since only Check looks at it again and a pass is all it acts on.
- When nobody opens Domains or presses Check after the record is added, the domain stays Waiting for DNS, however long ago DNS became right.
- When a certificate fails, refreshing the list leaves the domain Certificate failed, so only Try again orders it afresh and resets cert-manager's back-off.

## Code

- `backend/src/custom-domain/dns-check.ts` — the pass rules for a subdomain and a bare domain, and the stored answer.
- `backend/src/custom-domain/public-dns.ts` — the public resolvers and which errors mean no record.
- `CustomDomainService` in `backend/src/custom-domain/custom-domain.service.ts` — what a pass does, refreshing the list, and taking a domain from another environment.
- `backend/src/custom-domain/custom-domain.controller.ts` — the Check and refresh routes and their permission.
- `backend/src/proxy/app-address.ts` — the App address lookup a CNAME target must map to this App.

## Related

- [Custom domain](custom-domain.md) — adding a domain, the records it is shown and each status.
- [Domain routing](domain-routing.md) — the certificate a pass orders and the route it writes.
- [Public URL](public-url.md) — the App address lookup and the Default address.
- [Main domain](main-domain.md) — the role a taken domain hands on.

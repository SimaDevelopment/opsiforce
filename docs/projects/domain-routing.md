---
kind: explanation
adrs: [0103, 0105]
---

# Domain routing

> How does a Custom domain get its certificate and its route, and how do visitors sign in on it?

## How it works

### Certificate

- Each [Custom domain](../../GLOSSARY.md) gets its own cert-manager `Certificate`, `opsiforce-domain-<id>` in the backend's namespace, ordered only once Check passes ([DNS check](dns-check.md)) and naming the domain and, for a bare domain, its `www` ([ADR-0103](../adr/0103-custom-domain-certificates-come-from-cert-manager-one-per-domain-requested-only-after-check-passes.md)). The cluster issuer in `CUSTOM_DOMAINS_CLUSTER_ISSUER` issues it into the Secret `opsiforce-domain-<id>-tls`, with a fresh private key at each renewal.
- Every object of a domain carries the labels `opsiforce.io/custom-domain` and `opsiforce.io/environment`, and the environment's redirect and sign-in copy carry the second. Ordering deletes any Certificate of that name and creates it again, which also resets cert-manager's back-off when Try again passes.
- An Issuing certificate domain settles when someone looks: Check on it, or refreshing the list while Domains is open ([DNS check](dns-check.md)), reads its Certificate and orders it again when it is missing. `Ready` true connects the domain; an `Issuing` condition gone false moves it to Certificate failed with that condition's message; anything else leaves it Issuing certificate.

### Route

- A pass writes the domain's IngressRoute `opsiforce-domain-<id>` on `websecure` at once, before its certificate exists: one exact `Host()` rule per host, the domain and a bare domain's `www`, sending to the App proxy's Service with the certificate's Secret as its TLS ([ADR-0105](../adr/0105-each-custom-domain-gets-its-own-route-carrying-its-apps-gate-or-the-unprotected-marker-and-signs-in-on-its-own-host.md)). Traefik serves the host with that certificate as soon as cert-manager writes the Secret, with no route change. Each pass, connect, Make main and Remove routes every Issuing certificate and Connected domain of the environment again, writing only what changed, inside the transaction that changes the domain and under the environment's App Auth lock. A failed cluster write rolls the change back, so a domain is never Connected or the Main domain without its routes, and the next look or press tries again.
- No rule sets a priority, so cert-manager's HTTP-01 solver Ingress for the same host, whose rule also matches the challenge path and so is longer, wins at issuance and at every renewal.
- One function builds every route, and every rule carries exactly one Middleware: the environment's redirect from `www` to the bare domain on a bare domain's `www`, the redirect to its [Main domain](../../GLOSSARY.md) on a domain set to redirect while the environment has one ([Main domain](main-domain.md)), otherwise the App's sign-in when [App Auth](../../GLOSSARY.md) is on, otherwise the unprotected marker `opsiforce-custom-domain-unprotected`. The backend writes the marker in its own namespace before the routes.
- The App address lookup serves the App on its Main domain, or on every host of an Issuing certificate or Connected domain while the environment has no Main domain, and tells the app proxy whether the App is protected, as on its [Default address](../../GLOSSARY.md) ([Public URL](public-url.md)), so a protected App reached through a route carrying the marker answers 403.
- At backend start, and once more five minutes later, every Issuing certificate and Connected domain's route and its environment's redirect and sign-in copy are rewritten where they differ from what its Main domain and App Auth need, and the marker is written back ([Environments](environments.md)).
- Remove deletes the domain's row, routes the environment again, which deletes the redirect and the sign-in copy once nothing needs them, and only then deletes the domain's route, Certificate and Secret, all in one transaction; a failed step keeps the row, so Remove can be pressed again. Every rewrite of an environment's routes also orders a routed domain's Certificate again when it is missing, so a deletion that a rolled-back Remove already made is restored at the next rewrite, the start-up one included. Deleting an environment or its Project does the same for each of its domains and deletes the environment's redirect and sign-in copy, even when it has no domain left. The backend's Role may get and delete Secrets for that, since cert-manager leaves a deleted Certificate's Secret behind.

### Signing in

- Every domain that serves, the Main domain and any other not set to redirect, signs visitors in on its own host, at `https://<domain>/oidc/callback`, with a session cookie for that host alone. `manual` App Auth's middleware `opsiforce-project-<envId>-oidc` already does, so those routes carry it as it is.
- For a [Sign-in provider](../../GLOSSARY.md), whose middleware sends every apps-domain host to the provider's callback on the sign-in host, those routes carry a copy, `opsiforce-project-<envId>-oidc-domains`, with the relative callback and no cookie domain ([Sign-in provider](../organization/sign-in-provider.md)). It is written with the routes from the environment's middleware and deleted when the environment leaves `provider` or keeps no Issuing certificate or Connected domain.
- Changing the environment's [Auth mode](../../GLOSSARY.md), inheriting App Auth at a first publish or Duplicate, and saving its Sign-in provider rewrite every Issuing certificate and Connected domain's route and that copy inside the same App Auth write, so public and protected swap marker and sign-in at once. Every other rewrite of the routes, on a pass, connect, Make main, Remove, a takeover by another App or the start-up rewrite, reads the Auth mode under the environment's App Auth lock, so it waits for that write and routes for the new mode.
- With App Auth on, the list gives every domain its `signInCallback`, `https://<domain>/oidc/callback`, and the dialog shows it on every domain that serves, which the identity provider's admin must register before sign-in on that domain works.

## Edge cases

- When the identity provider doesn't allow the Main domain's callback yet, sign-in on the domain fails at the identity provider, while the Default address keeps signing visitors in.
- When a visitor signed in on the App's Default address through a Sign-in provider opens its Custom domain, they sign in again there, since the domain's session is its own.
- When a provider App's environment middleware is missing, the Main domain's route names a copy that cannot be written, and Traefik serves nothing on it until App Auth is saved again.
- When a connected domain's DNS record is later deleted, its certificate stays until it expires and its renewal then fails quietly.
- When a domain's certificate fails, its route stays until the domain is removed or passes again, and the lookup answers 404 on it.
- When nobody looks once its certificate is ready, the domain already answers through its route while the list still shows Issuing certificate, and it can become the Main domain and the Public URL only once Check or a refresh connects it.

## Code

- `backend/src/custom-domain/custom-domain-objects.ts` — the Certificate, IngressRoute, marker, redirect and sign-in copy a domain and its environment get, and reading a Certificate's progress.
- `CustomDomainCluster` in `backend/src/custom-domain/custom-domain-cluster.ts` — the one writer of those objects, writing only what changed.
- `CustomDomainService` in `backend/src/custom-domain/custom-domain.service.ts` — settling an Issuing certificate domain, and changing a domain together with its routes.
- `signInOnEachHost` in `backend/src/project/project-auth.service.ts` — the provider middleware's copy for the Main domain.
- `AppAuthRouteReconciler` in `backend/src/project/app-auth-route.reconciler.ts` — the start-up rewrite of the domain routes.
- `helm/opsiforce/templates/rbac.yaml` — the backend's Role over Certificates and Secrets.

## Related

- [Custom domain](custom-domain.md) — the statuses the certificate moves a domain through.
- [Main domain](main-domain.md) — which host serves, and the redirect every other host carries.
- [Environments](environments.md) — App Auth's gate and the start-up rewrite of its routes.
- [Sign-in provider](../organization/sign-in-provider.md) — the provider settings the domains' sign-in copies.
- [Public URL](public-url.md) — the App address lookup a domain's host goes through.
- [Turn on Custom domains](../operations/turn-on-custom-domains.md) — the cluster issuers a deployment needs.

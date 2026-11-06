---
kind: explanation
terms: [Main domain]
---

# Main domain

> Which of an App's Custom domains is its Public URL, how does that role move, and when do the others send visitors to it?

## How it works

- The first [Custom domain](../../GLOSSARY.md) of an environment to connect becomes its [Main domain](../../GLOSSARY.md), and the [Public URL](../../GLOSSARY.md) becomes `https://<Main domain>/` everywhere the platform hands it out ([Public URL](public-url.md)). A partial unique index keeps one Main domain per environment.
- Every other Issuing certificate or Connected domain of the environment serves the App on its own host by default. Its `redirects_to_main` setting, off for a new domain, sends it on to the Main domain instead: `PATCH /api/projects/<id>/environments/<envId>/domains/<domainId>` with `{ "redirectsToMain": true | false }`, gated by `can_manage_custom_domains`, answers 400 for anything but a boolean and rewrites the environment's routes in the same transaction. The dialog's ⋮ menu offers it on every domain but the Main domain while the App has one, as Redirect to Main domain with a check mark while it is on.
- While a host is sent on to the Main domain, the environment has one redirect Middleware, `opsiforce-project-<envId>-to-main`, a permanent `redirectRegex` to `https://<Main domain>` with the request's path and query, labelled with its environment, so visitors land on the Main domain before any sign-in ([Domain routing](domain-routing.md)). It is deleted when no host needs it.
- The `www` of every bare domain is sent on to that bare domain by `opsiforce-project-<envId>-without-www`, which exists while the environment has a bare domain; the bare domain then serves or redirects as its own setting says.
- While the environment has no Main domain, every domain serves on its own host whatever its setting, so a domain that passed Check before any connected works at once. When the first connects and becomes main, the domains set to redirect switch to it.
- Make main, `POST /api/projects/<id>/environments/<envId>/domains/<domainId>/main` gated by `can_manage_custom_domains`, works only on a connected domain and answers 409 on any other. It moves the role, rewrites the redirect and every domain route of the environment, and the Public URL follows.
- The dialog's Make main asks for confirmation only when [App Auth](../../GLOSSARY.md) is on, naming the new Main domain's sign-in callback to register, since visitors then sign in there.
- Removing the Main domain, or another App taking it ([DNS check](dns-check.md)), hands the role to the environment's oldest other connected domain and rewrites the redirect and the routes, or, with none, deletes the redirect and the Public URL goes back to the [Default address](../../GLOSSARY.md). Remove's confirmation says which.
- The App address lookup answers as the routes do, through the same rule, `redirectTargetOf`: a `www` is redirected to its bare domain, a domain set to redirect to the Main domain while the App has one, and every other host is served, which catches a route that has drifted.

## Edge cases

- When a domain set to redirect becomes the Main domain, it serves, since the Main domain never redirects; if it later loses the role, it redirects again.
- When a domain serves on its own host with App Auth on, visitors sign in there separately, and its own callback must be registered ([Domain routing](domain-routing.md)).

## Code

- `backend/src/custom-domain/main-domain.ts` — the connected Main domain each environment's context carries.
- `CustomDomainService` in `backend/src/custom-domain/custom-domain.service.ts` — choosing the Main domain at connect, Make main and handing the role on.
- `redirectToMainMiddleware` in `backend/src/custom-domain/custom-domain-objects.ts` — the redirect to the Main domain.
- `redirectTargetOf` and `customDomainIngressRoute` in `backend/src/custom-domain/custom-domain-objects.ts` — which hosts serve and which redirect, and where.
- `backend/src/proxy/app-address.ts` — serving or redirecting a Custom domain's host by the same rule.
- `backend/src/project-environment/public-url.service.ts` — the Main domain as the Public URL.

## Related

- [Custom domain](custom-domain.md) — adding a domain and the statuses before it connects.
- [Domain routing](domain-routing.md) — the routes the role decides, and signing in on the Main domain.
- [Public URL](public-url.md) — the Default address the Public URL falls back to.

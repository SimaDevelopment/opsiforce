# Custom domain certificates come from cert-manager, one per domain, requested only after Check passes

A visitor's browser opens its encrypted connection to whatever a [Custom domain](../../GLOSSARY.md)'s DNS record leads to, and that is our Traefik, never the customer's DNS provider. So the certificate for `shop.example-org.com` has to sit on our Traefik, and only we can obtain it. Without it every visitor sees a certificate error. The certificates the platform holds today cannot cover customer domains: the `*.apps…` wildcard names only our own domain, and Traefik's resolver on dev and prod proves control through DNS-01 records in our own Google Cloud DNS zone.

**Each Custom domain gets its own cert-manager `Certificate`, issued by Let's Encrypt over HTTP-01 through a cluster issuer the deployment names. The platform creates it only once Check has found the domain's DNS pointing at the App. The domain's route names the resulting Secret and is written when Check passes, so Traefik serves the domain as soon as the Secret exists; the domain shows as connected once the Certificate is ready.** Concretely:

- **cert-manager, not Traefik's resolver.** cert-manager already runs on dev, prod and cabka. It answers HTTP-01 through its own solver Ingress, which every Traefik replica serves, and it reports each certificate's progress and failure reason in the `Certificate`'s `Ready` and `Issuing` conditions, which the domain's status shows.
- **One certificate per domain.** Adding, renewing or removing one domain never reissues another's, and one domain whose DNS breaks never blocks its neighbours' renewals.
- **Only after Check.** All Organizations on a deployment share one Let's Encrypt account. That account allows 300 new orders per 3 hours and 5 failed validations per domain per hour, and cert-manager backs off for hours after a failure. Requesting before the DNS is right would spend those allowances on a domain that cannot pass yet, and would delay it once it can.
- **Renewal is cert-manager's.** It renews well before the 90-day expiry into the same Secret, and Traefik picks the new certificate up with no route change. The domain's route sets no priority, so cert-manager's solver Ingress for the same host, whose rule also matches the challenge path, outranks it at issuance and at every renewal.
- **Removing a domain deletes its route, its `Certificate` and its Secret.** cert-manager leaves the Secret behind on its own.
- **A Limit bounds the shared account.** The `custom_domains` Limit counts an Organization's Custom domains whatever their status, with a bare domain and its `www` counting as one.

## Considered options

- **Traefik's own ACME resolver on each custom-domain route.** Rejected: in open-source Traefik the HTTP-01 challenge lives in the memory of the one replica that ordered it, so with two replicas about half the validations land on the other replica and fail. It also reports nothing back to Kubernetes, so the dialog could not tell "issuing" from "failed".
- **The customer uploads a certificate and key.** Rejected: few customers have one, every upload expires within months, and the App goes dark on the day nobody re-uploads. Vercel offers this only on its Enterprise plan.
- **Plain http on Custom domains.** Rejected: browsers mark such pages unsafe, `.app` and `.dev` domains refuse http outright, and App Auth's session cookie needs `Secure`.
- **One certificate per App listing all its domains.** Rejected: every add or remove reissues every name on it, and one domain whose DNS broke fails the renewal for all of them.
- **Requesting the certificate when the domain is added.** Rejected: before the record exists every attempt fails against the shared account's per-domain failure limit, and cert-manager's back-off then delays the domain after the record is fixed.
- **A second edge proxy that issues certificates on demand.** Rejected: a second component in front of every App, for something cert-manager does next to the Traefik we already run.

## Consequences

- A deployment offers Custom domains only once cert-manager and an HTTP-01 cluster issuer exist there and the backend is told the issuer's name. dev and prod need the issuer added, cabka needs one beside its DNS-01 issuer, and the local stack installs cert-manager with an issuer signing from the mkcert CA, so Check, issuing and connecting run locally the same way as on dev.
- HTTP-01 reaches the solver through the `web` entrypoint's redirect to `websecure`. Let's Encrypt follows that redirect and accepts any certificate on the way, so the redirect stays as it is. Real issuance is first proven on dev, since Let's Encrypt cannot reach a laptop.
- A connected domain whose customer later deletes the record keeps its certificate until it expires. The renewal then fails quietly, because connected domains are not re-checked.
- Let's Encrypt allows 50 certificates per registered domain per week, so a customer adding dozens of subdomains of one domain at once can be held back by Let's Encrypt, whatever the Limit says.

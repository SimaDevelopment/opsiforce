---
kind: operations
---

# Test Custom domains locally

> Point a domain you own at an App on the local stack, watch it go from Waiting for DNS to Connected, and find out why when it doesn't.

Check asks public resolvers whether a [Custom domain](../../GLOSSARY.md)'s record names the App's [Default address](../../GLOSSARY.md) ([ADR-0104](../adr/0104-a-custom-domains-record-names-its-apps-default-address-which-is-the-proof-of-ownership.md)), and those resolvers answer every `*.apps.opsiforce.localtest.me` name with `127.0.0.1`. So a CNAME from a real domain to a local App's Default address passes Check unchanged and leads your browser to the local Traefik through the tunnel. The certificate comes from the `opsiforce-local-ca` cluster issuer, which signs it at once with your mkcert root CA, so the browser trusts it like the `*.opsiforce.localtest.me` wildcard ([ADR-0103](../adr/0103-custom-domain-certificates-come-from-cert-manager-one-per-domain-requested-only-after-check-passes.md), [Domain routing](../projects/domain-routing.md)).

## Prerequisites

- A domain you own at a DNS provider whose records you can edit; the steps use Namecheap. A subdomain of it is the quickest test, and a bare domain needs a provider with ALIAS, ANAME or CNAME flattening.
- A local stack from the [Quickstart](quickstart.md), with `minikube tunnel` up so `https://opsiforce.localtest.me` opens. It runs a build that includes Custom domains, with `customDomainsClusterIssuer: "opsiforce-local-ca"` in `helm/opsiforce-backend/values.local.yaml`, and its migrations are applied (`yarn workspace @opsiforce/backend run db:migrate`, which Tilt never runs).
- cert-manager and its issuer in the cluster: `kubectl get clusterissuer opsiforce-local-ca` shows `READY True`. Otherwise run `sh scripts/install-cert-manager.sh` from the package root, after `mkcert -install` once ([Local orchestration](local-orchestration.md)).
- A Project whose App has gone live in the environment you test, since Domains appears only for an environment with an App.

## Steps

1. Add a subdomain. Open the App pane's globe button (Domains), type `shop.<your domain>` and press Add. The row shows Waiting for DNS and one record, `CNAME shop.<your domain>` with the Default address as its value, such as `my-app-dev-6713b7a51450.apps.opsiforce.localtest.me`; copy it with the copy button beside it.
2. Create the record. In Namecheap, open Domain List, Manage on your domain, then Advanced DNS, and add a `CNAME Record` with Host `shop`, the copied Default address as Value, and the shortest TTL offered.
3. Watch it connect. `dig +short CNAME shop.<your domain> @8.8.8.8` prints the Default address and `dig +short shop.<your domain> @8.8.8.8` prints `127.0.0.1`. Press Check, or keep Domains open, which checks again every 10 seconds: the first stage reads "DNS points at this App" and the row goes to Issuing certificate, and since the local issuer signs at once, the next refresh turns it Connected with a MAIN badge. Nothing checks while Domains is closed.
4. Open `https://shop.<your domain>/`. The App answers with no certificate warning, and the dialog's Public URL line now reads `https://shop.<your domain>/`.
5. Add the bare domain. Type `<your domain>` and press Add: the row shows `+ www` and two records, `ALIAS <your domain>` and `CNAME www.<your domain>`, both with the Default address as value. In Advanced DNS, first delete whatever record already sits on Host `@` or `www`, such as a parking page CNAME or a URL Redirect Record a new Namecheap domain starts with, then add an `ALIAS Record` with Host `@` and a `CNAME Record` with Host `www`, both with the Default address as value.
6. Watch the bare domain connect. Check passes once `dig +short <your domain> @8.8.8.8` includes `127.0.0.1` and `dig +short CNAME www.<your domain> @8.8.8.8` prints the Default address. Once Connected, `https://<your domain>/` serves the App on its own host and `https://www.<your domain>/` redirects to it; Redirect to Main domain in its ⋮ menu sends it on to the Main domain, `shop.<your domain>`, instead, and Make main swaps the two.
7. When a status doesn't move, look where it points:
   - **Waiting for DNS.** "DNS answers now:" in the dialog is what the public resolvers returned at the last check; compare it with `dig +short CNAME <domain> @8.8.8.8` and `@1.1.1.1`. A changed record shows only after its old TTL runs out, a name asked about before its record existed stays cached as missing for at most the last number of `dig +short SOA <your domain>` in seconds, a record the DNS provider proxies must have its proxy turned off, and nothing checks while Domains is closed, so open it or press Check.
   - **Issuing certificate.** `kubectl -n local get certificates -o custom-columns=NAME:.metadata.name,HOSTS:.spec.dnsNames` maps each domain to its `opsiforce-domain-<id>` Certificate, and `kubectl -n local get certificates -o wide` shows each one's READY state, issuer and last message. `kubectl -n local describe certificate opsiforce-domain-<id>` shows its conditions and events, `kubectl -n cert-manager logs deploy/cert-manager` shows what cert-manager did, and a Certificate already `READY True` turns the domain Connected at the next Check or the dialog's next refresh. The domain's route already exists in this status, so `https://<domain>/` may answer before the row says Connected.
   - **Certificate failed.** The dialog shows the Certificate's `Issuing` message. Locally it almost always means the issuer isn't ready: `kubectl get clusterissuer opsiforce-local-ca` must show `READY True`, else re-run `scripts/install-cert-manager.sh`; then press Try again.
   - **The row is gone.** Another environment's Check passed for the same host while its record named that App, which deletes the domain here with its route and certificate. Point the record back at this App's Default address and add the domain again.
   - **Connected, but the page fails.** `kubectl -n local get ingressroute opsiforce-domain-<id> -o yaml` shows the route's hosts, its one Middleware and its TLS Secret. A 403 from the app proxy means a protected App reached through a route carrying the unprotected marker, and a Traefik 404 on the Main domain of a Sign-in provider App means its sign-in copy is missing; saving App Auth again or restarting the backend rewrites the routes.
   - **The backend log.** The `opsiforce-backend` resource in the Tilt UI, or `kubectl -n local logs deploy/opsiforce-backend`, carries a warning for every failed step, starting "Refreshing custom domain", "Ordering the certificate and route of custom domain" or "Failed to reconcile the custom domain routes".
8. Clean up. Remove both domains in the dialog, then delete their records at Namecheap.

## Verify

- The subdomain's row shows Connected with a MAIN badge, and `https://shop.<your domain>/` opens the App with no certificate warning.
- `kubectl -n local get certificates -o wide` shows a `READY True` Certificate issued by `opsiforce-local-ca` for each connected domain.
- After Remove, `kubectl -n local get certificate,ingressroute,secret -l opsiforce.io/custom-domain=<id>` finds nothing.

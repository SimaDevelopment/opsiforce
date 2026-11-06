---
kind: operations
---

# Turn on Custom domains

> Give a dev or prod deployment the cluster issuer Custom domains need, name it in the backend values, and prove issuance with a real domain.

A deployment offers [Custom domains](../../GLOSSARY.md) once its backend's `config.customDomainsClusterIssuer` names a cert-manager cluster issuer, and each domain's certificate comes from that issuer over HTTP-01 after Check passes ([ADR-0103](../adr/0103-custom-domain-certificates-come-from-cert-manager-one-per-domain-requested-only-after-check-passes.md), [Domain routing](../projects/domain-routing.md)). general-infra defines two such issuers on the Cloudfleet clusters in `packages/infra/pulumi/general-infra/cert-manager-issuers.ts`: `letsencrypt-http01`, which deployments use, and `letsencrypt-http01-staging`, Let's Encrypt's untrusted test CA with far higher limits, for debugging issuance. Both answer the challenge through the `traefik` ingress class, reached through the `web` entrypoint's redirect to `websecure`, and register their ACME account with no email, since Let's Encrypt no longer sends expiry notices.

## Prerequisites

- Access to the `general-infra` Pulumi stacks `dev` and `prod`, and `kubectl` access to the deployment's cluster, with its namespace written `$NS` below. `<backend>` is what `kubectl -n $NS get deploy -o name | grep opsiforce-backend` prints.
- cert-manager already running there: `kubectl -n cert-manager get deploy cert-manager` answers. general-infra's `cert-manager.ts` installs it.
- `can_manage_custom_domains` in the deployment's realm, in the `opsiforce_admin` bundle: the Keycloak Configurator workflow applies it to the development realm on merge to `main`, and to production when `production-keycloak-configurator` is promoted ([Add a permission](add-a-permission.md)). Without it no member can add a domain.
- A domain you own with a subdomain you can point at a dev App, for the issuance test.

## Steps

1. Preview the issuer. From `packages/infra/pulumi/general-infra`, run `pulumi preview -s dev`, without `--diff`. Check that it creates the `kubernetes:cert-manager.io/v1:ClusterIssuer`s `letsencrypt-http01` and `letsencrypt-http01-staging`, and look into any other change it lists before applying.
2. Apply them with `pulumi up -s dev`. `kubectl get clusterissuer letsencrypt-http01 letsencrypt-http01-staging` then shows both `READY True`, and their `-account-key` Secrets appear in namespace `cert-manager`.
3. Name the issuer in the backend values. `helm/opsiforce-backend/values.<stack>.yaml`, which `.github/workflows/opsiforce.yml` passes to the backend chart for the stack, sets under `config`:

   ```yaml
   customDomainsClusterIssuer: "letsencrypt-http01"
   customDomainsRefused: "opsima.com,simaanalytics.co,simaanalytics.com"
   ```

   The refused list names the platform's own domains, each refusing itself and its subdomains.
4. Deploy ([Deployment](deployment.md)): a push to `main` for dev, to `production-opsiforce` for prod. The same run upgrades the `opsiforce` infra chart, whose Role in `helm/opsiforce/templates/rbac.yaml` lets the backend manage Certificates and get and delete Secrets.
5. Prove issuance. Add your subdomain to a dev App, create its CNAME to the App's Default address, and keep Domains open, or press Check, until it reaches Connected, since nothing checks while the dialog is closed; [Test Custom domains locally](test-custom-domains-locally.md) has the DNS steps and where to look for each status. The page opens with no certificate warning, and `kubectl -n $NS get certificates -o wide` shows its `opsiforce-domain-<id>` Certificate `READY True`. While testing, mind Let's Encrypt's limits: five certificates a week for the same set of names, and five failed validations an hour for one name, so use a fresh subdomain rather than adding and removing the same one many times. To debug a domain that keeps failing without spending those limits, name `letsencrypt-http01-staging` in the values for a while; a Certificate keeps the issuer it was ordered with, so remove and add the domain again after switching back.
6. Prod. Once dev has proven issuance, repeat steps 1 to 5 with `-s prod`, `values.prod.yaml` and the `production-opsiforce` branch.

## Verify

- `kubectl get clusterissuer letsencrypt-http01 letsencrypt-http01-staging` shows both `READY True`.
- `GET /api/tenants/config` answers `customDomainsEnabled: true`, and the App pane's toolbar shows the globe button.
- A domain reaches Connected and opens in the browser with no warning, and `kubectl -n $NS get certificates -o wide` shows its Certificate `READY True` with issuer `letsencrypt-http01`.
- `kubectl -n $NS logs <backend> | grep -i "custom domain"` shows no warning for it.

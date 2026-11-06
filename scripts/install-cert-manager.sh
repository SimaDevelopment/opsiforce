#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
package_dir=$(dirname "$script_dir")
namespace=cert-manager
issuer=opsiforce-local-ca
version=$(node -p "require('${package_dir}/versions.json').exact.charts.certManager")

ca_root=$(mkcert -CAROOT)
if [ ! -f "${ca_root}/rootCA.pem" ] || [ ! -f "${ca_root}/rootCA-key.pem" ]; then
  echo "No mkcert root CA in ${ca_root}. Run \`mkcert -install\` first." >&2
  exit 1
fi

helm upgrade --install cert-manager cert-manager \
  --repo https://charts.jetstack.io \
  --version "${version}" \
  --namespace "${namespace}" --create-namespace \
  --set crds.enabled=true \
  --wait --timeout 5m

kubectl create secret tls "${issuer}" --namespace "${namespace}" \
  --cert "${ca_root}/rootCA.pem" --key "${ca_root}/rootCA-key.pem" \
  --dry-run=client -o yaml |
  kubectl apply --server-side --force-conflicts -f -

kubectl apply -f "${package_dir}/helm/local-infra/cluster-issuer.yaml"
kubectl wait clusterissuer "${issuer}" --for=condition=Ready --timeout=60s

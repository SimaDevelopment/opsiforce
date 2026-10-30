#!/bin/sh
set -eu

namespace=${1:-local}
configmap=opsiforce-local-ca

public_roots=
for file in /etc/ssl/cert.pem /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt; do
  if [ -f "$file" ]; then
    public_roots=$file
    break
  fi
done
if [ -z "$public_roots" ]; then
  echo "No system CA bundle found." >&2
  exit 1
fi

bundle=$(mktemp)
trap 'rm -f "$bundle"' EXIT
sed -e '$a\' "$public_roots" > "$bundle"
if command -v mkcert >/dev/null 2>&1 && [ -f "$(mkcert -CAROOT)/rootCA.pem" ]; then
  cat "$(mkcert -CAROOT)/rootCA.pem" >> "$bundle"
fi

kubectl create configmap "$configmap" --namespace "$namespace" --from-file=ca-certificates.crt="$bundle" --dry-run=client -o yaml |
  kubectl apply --server-side --force-conflicts -f -

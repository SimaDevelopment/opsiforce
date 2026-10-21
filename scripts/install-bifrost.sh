#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
package_dir=$(dirname "$script_dir")

if [ -f "${package_dir}/.env" ]; then
  set -a
  . "${package_dir}/.env"
  set +a
fi

if ! helm repo list | grep -q "^bifrost[[:space:]]"; then
  helm repo add bifrost https://maximhq.github.io/bifrost/helm-charts
fi
helm repo update bifrost

sh "${script_dir}/upsert-bifrost-secrets.sh" local

set -- -f "${package_dir}/helm/bifrost/values.local.yaml"
n=1
for provider in custom-openai-1; do
  eval "base_url=\"\${OPSIFORCE_BIFROST_CUSTOM_PROVIDER${n}_BASE_URL:-}\""
  if [ -n "${base_url}" ]; then
    set -- "$@" --set-string "bifrost.providers.${provider}.network_config.base_url=${base_url}"
  fi
  n=$((n + 1))
done

helm upgrade --install --wait --namespace local --create-namespace \
  opsiforce-bifrost bifrost/bifrost \
  --version 2.1.45 \
  "$@"

kubectl apply --namespace local -f "${package_dir}/helm/bifrost/networkpolicy.yaml"

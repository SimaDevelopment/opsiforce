#!/bin/sh
set -eu

namespace="${1:?usage: store-bifrost-provider-keys.sh <namespace>}"
local_port="${BIFROST_LOCAL_PORT:-18080}"
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

secret_value() {
  kubectl get secret "$1" --namespace "${namespace}" -o "jsonpath={.data.$2}" | base64 -d
}

BIFROST_ADMIN_USERNAME=$(secret_value opsiforce-bifrost-admin-auth username)
BIFROST_ADMIN_PASSWORD=$(secret_value opsiforce-bifrost-admin-auth password)
OPENAI_API_KEY=$(secret_value opsiforce-bifrost-provider-keys openai-api-key)
ANTHROPIC_API_KEY=$(secret_value opsiforce-bifrost-provider-keys anthropic-api-key)
BIFROST_URL="http://127.0.0.1:${local_port}"
export BIFROST_ADMIN_USERNAME BIFROST_ADMIN_PASSWORD OPENAI_API_KEY ANTHROPIC_API_KEY BIFROST_URL

kubectl port-forward --namespace "${namespace}" svc/opsiforce-bifrost "${local_port}:8080" >/dev/null &
forward_pid=$!
trap 'kill "${forward_pid}" 2>/dev/null || true' EXIT INT TERM

attempt=0
until curl -s -o /dev/null "${BIFROST_URL}/health"; do
  attempt=$((attempt + 1))
  if [ "${attempt}" -ge 30 ]; then
    echo "Bifrost did not answer on ${BIFROST_URL} through the port-forward" >&2
    exit 1
  fi
  sleep 1
done

node "${script_dir}/store-bifrost-provider-keys.mjs"

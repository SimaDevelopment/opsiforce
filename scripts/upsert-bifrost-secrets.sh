#!/bin/sh
set -eu

namespace="${1:-local}"

: "${BIFROST_ADMIN_USERNAME:?BIFROST_ADMIN_USERNAME is required}"
: "${BIFROST_ADMIN_PASSWORD:?BIFROST_ADMIN_PASSWORD is required}"
: "${BIFROST_ENCRYPTION_KEY:?BIFROST_ENCRYPTION_KEY is required}"
: "${BIFROST_POSTGRES_PASSWORD:?BIFROST_POSTGRES_PASSWORD is required}"

kubectl create secret generic opsiforce-bifrost-provider-keys \
  --namespace "${namespace}" \
  --from-literal=openai-api-key="${OPENAI_API_KEY:-}" \
  --from-literal=anthropic-api-key="${ANTHROPIC_API_KEY:-}" \
  --from-literal=azure-api-key="${AZURE_FOUNDRY_API_KEY:-}" \
  --from-literal=azure-endpoint="${AZURE_FOUNDRY_ENDPOINT:-}" \
  --dry-run=client \
  -o yaml | kubectl apply -f -

kubectl create secret generic opsiforce-bifrost-admin-auth \
  --namespace "${namespace}" \
  --from-literal=username="${BIFROST_ADMIN_USERNAME}" \
  --from-literal=password="${BIFROST_ADMIN_PASSWORD}" \
  --dry-run=client \
  -o yaml | kubectl apply -f -

kubectl create secret generic opsiforce-bifrost-encryption \
  --namespace "${namespace}" \
  --from-literal=key="${BIFROST_ENCRYPTION_KEY}" \
  --dry-run=client \
  -o yaml | kubectl apply -f -

kubectl create secret generic opsiforce-bifrost-postgres \
  --namespace "${namespace}" \
  --from-literal=password="${BIFROST_POSTGRES_PASSWORD}" \
  --dry-run=client \
  -o yaml | kubectl apply -f -

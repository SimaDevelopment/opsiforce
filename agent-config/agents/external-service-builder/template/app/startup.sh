#!/bin/bash
set -e
cd "$(dirname "$0")"

if [ "$OPSIFORCE_ENV" = "production" ]; then
  yarn install --immutable
  guard service yarn serve &
else
  yarn install
  guard service yarn dev &
fi
wait -n

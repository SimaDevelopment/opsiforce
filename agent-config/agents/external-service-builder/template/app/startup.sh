#!/bin/bash
set -e
cd "$(dirname "$0")"

if [ "$OPSIFORCE_ENV" = "production" ]; then
  yarn install --immutable
  exec yarn serve
else
  yarn install
  exec yarn dev
fi

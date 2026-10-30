#!/bin/sh
set -eu

profile=${MINIKUBE_PROFILE:-minikube}
runtime=$(kubectl --context "$profile" get nodes -o jsonpath='{.items[0].status.nodeInfo.containerRuntimeVersion}' 2>/dev/null) || exit 0

case "$runtime" in
  "" | containerd://*) ;;
  *)
    echo "warning: minikube runs the ${runtime%%://*} runtime; production runs containerd." >&2
    echo "It still works. To match production, recreate the cluster: minikube delete, then yarn dev-opsiforce (standalone: yarn dev --reset, then yarn dev)." >&2
    ;;
esac

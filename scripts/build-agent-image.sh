#!/bin/sh
set -eu

package_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
profile=${MINIKUBE_PROFILE:-minikube}
version=$(node -p 'require(process.argv[1]).version' "$package_dir/agent-config/agent-image-version.json")
tag="opsiforce-agent:$version"

if [ "${1:-}" != "--force" ]; then
  images=$(minikube -p "$profile" image ls)
  if printf '%s\n' "$images" | grep -Fxq -e "$tag" -e "docker.io/library/$tag"; then
    echo "Image $tag already exists, skipping build"
    exit 0
  fi
fi

docker build -t "$tag" -f "$package_dir/docker/Dockerfile.agent" \
  --build-arg OPENCODE_CONFIG=agent-config/opencode.local.json "$package_dir"
MINIKUBE_PROFILE=$profile sh "$package_dir/scripts/minikube-load-image.sh" "$tag"

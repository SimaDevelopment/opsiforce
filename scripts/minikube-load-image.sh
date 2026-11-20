#!/bin/sh
# Load a host Docker image into minikube, then delete the copies minikube leaves behind.
#
# `minikube image load --daemon` saves the image as a tarball in the host cache
# (~/.minikube/cache/images/<arch>/) and copies it into the node
# (/var/lib/minikube/images/) before importing it into containerd. It never deletes
# either tarball, so every Tilt build adds two full copies of the image to the disk.
#
# Tags named tilt-build-* are throwaway: for those, older tags of the same image are
# also removed from minikube (the newest MINIKUBE_KEEP_TILT_BUILDS stay, default 3),
# and the tag is dropped from the host Docker after loading.
set -eu

ref=${1:?usage: minikube-load-image.sh IMAGE:TAG}
profile=${MINIKUBE_PROFILE:-minikube}
keep=${MINIKUBE_KEEP_TILT_BUILDS:-3}

minikube -p "$profile" image load --daemon "$ref"

name=${ref%:*}
tag=${ref##*:}
cache_file=$(printf '%s' "$ref" | tr ':' '_')

# Same rule minikube uses to find its home folder.
case "${MINIKUBE_HOME:-}" in
  "") minikube_dir=$HOME/.minikube ;;
  */.minikube) minikube_dir=$MINIKUBE_HOME ;;
  *) minikube_dir=$MINIKUBE_HOME/.minikube ;;
esac
rm -f "$minikube_dir"/cache/images/*/"$cache_file" ||
  echo "warning: could not delete the cached image tarball in $minikube_dir/cache/images" >&2

minikube -p "$profile" ssh -- sudo rm -f "/var/lib/minikube/images/$(basename "$cache_file")" >/dev/null ||
  echo "warning: could not delete the image tarball inside minikube" >&2

case "$tag" in
  tilt-build-*) ;;
  *) exit 0 ;;
esac

docker rmi "$ref" >/dev/null 2>&1 || true

# Tags end in a build timestamp, so a numeric sort puts the newest first.
# containerd names images in full (docker.io/library/<name>:<tag>).
old_refs=$(
  minikube -p "$profile" image ls |
    grep -E "^(docker\.io/library/)?$name:tilt-build-[0-9]+\$" |
    sed 's#^\([^/]*\)$#docker.io/library/\1#' |
    sed 's/.*:tilt-build-\([0-9]*\)$/\1 &/' |
    sort -rn |
    cut -d' ' -f2 |
    tail -n +"$((keep + 1))"
) || true
if [ -n "$old_refs" ]; then
  # Rebuilds with unchanged sources give a new tag the same image ID as an old one.
  # `minikube image rm` (crictl rmi) deletes every tag of that ID, including the one
  # just loaded; `ctr images rm` deletes only the named tags.
  # shellcheck disable=SC2086 # one argument per image reference
  minikube -p "$profile" ssh -- sudo ctr -n k8s.io images rm $old_refs >/dev/null ||
    echo "warning: could not remove old $name builds from minikube" >&2
fi

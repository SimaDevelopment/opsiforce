#!/bin/bash
set -e

export OPENAI_API_KEY="${OPENAI_API_KEY:-}"
export APP_PORT="${APP_PORT:-3000}"
export VSCODE_PORT="${VSCODE_PORT:-8080}"
export DB_VIEWER_PORT="${DB_VIEWER_PORT:-8081}"
export DB_VIEWER_SQL_TIME_LIMIT_MS="${DB_VIEWER_SQL_TIME_LIMIT_MS:-5000}"
export DISPLAY=:99

mkdir -p /workspace/app/data /workspace/data/logs

guard desktop agent-desktop &
desktop_ready=""
for attempt in {1..100}; do
  if curl -fsS http://127.0.0.1:6080/sessions >/dev/null 2>&1; then desktop_ready=1; break; fi
  sleep 0.1
done
[ -n "${desktop_ready}" ] || echo "entrypoint: the desktop is not ready yet; the agent starts without waiting for it" >&2

EXTERNAL_SERVICES_DB=/workspace/data/external-services.db
[ -f "${EXTERNAL_SERVICES_DB}" ] || sqlite3 "${EXTERNAL_SERVICES_DB}" "VACUUM;"

DOCKER_IMAGE_FILE=/var/lib/docker-storage/docker.img

mount_docker_storage() {
  [ -e /dev/loop-control ] || mknod -m 660 /dev/loop-control c 10 237 || return 1
  for i in 0 1 2 3 4 5 6 7; do
    [ -e "/dev/loop${i}" ] || mknod -m 660 "/dev/loop${i}" b 7 "${i}" || return 1
  done
  mkdir -p /var/lib/docker || return 1
  if [ -f "${DOCKER_IMAGE_FILE}" ]; then
    e2fsck -p "${DOCKER_IMAGE_FILE}" >/dev/null 2>&1
    mount -o loop,discard "${DOCKER_IMAGE_FILE}" /var/lib/docker && return 0
    rm -f "${DOCKER_IMAGE_FILE}"
  fi
  truncate -s 20G "${DOCKER_IMAGE_FILE}" \
    && mkfs.ext4 -q "${DOCKER_IMAGE_FILE}" \
    && mount -o loop,discard "${DOCKER_IMAGE_FILE}" /var/lib/docker
}

nest_cgroups() {
  [ -f /sys/fs/cgroup/cgroup.controllers ] || return 0
  mkdir -p /sys/fs/cgroup/init || :
  xargs -rn1 < /sys/fs/cgroup/cgroup.procs > /sys/fs/cgroup/init/cgroup.procs || :
  sed -e 's/ / +/g' -e 's/^/+/' < /sys/fs/cgroup/cgroup.controllers > /sys/fs/cgroup/cgroup.subtree_control || :
}

if [ "${OPSIFORCE_DOCKER:-}" = "1" ]; then
  nest_cgroups
  if docker_storage_errors=$(mount_docker_storage 2>&1); then
    {
      guard docker dockerd \
        --data-root /var/lib/docker \
        --storage-driver overlay2 \
        --log-driver local \
        --mtu "$(cat /sys/class/net/eth0/mtu 2>/dev/null || echo 1500)" || true
      exec sleep infinity
    } &
  else
    printf '%s\n' "Docker is not running: its storage could not be prepared." "${docker_storage_errors}" \
      | log-writer --name docker || true
  fi
fi

guard webapp sh -c 'while [ ! -x /workspace/app/startup.sh ]; do sleep 2; done; exec /workspace/app/startup.sh' &

export OPENCODE_PASSWORD="${OPENCODE_PASSWORD:-${OPSIFORCE_CONTROL_TOKEN:-opencode-pod-local}}"
guard opencode opencode2 serve --port "${OPENCODE_INTERNAL_PORT:-4106}" --hostname 127.0.0.1 &

guard vscode code-server \
  --host 0.0.0.0 --port "${VSCODE_PORT}" \
  --auth none \
  --user-data-dir /workspace/.xdg/code-server/user-data \
  --extensions-dir /workspace/.xdg/code-server/extensions \
  --disable-telemetry \
  --disable-workspace-trust \
  /workspace &

guard dbviewer datasette serve \
  /workspace/app/data/app.db \
  /workspace/data/database.db \
  "${EXTERNAL_SERVICES_DB}" \
  --host 0.0.0.0 --port "${DB_VIEWER_PORT}" \
  --cors --create \
  --setting sql_time_limit_ms "${DB_VIEWER_SQL_TIME_LIMIT_MS}" \
  --metadata /opt/opencode/datasette-metadata.yml &

guard control agent-control &

wait -n

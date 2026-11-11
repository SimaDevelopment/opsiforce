---
name: docker
description: Docker in this pod (Docker in Docker) — running containers from images, a Dockerfile or a compose file, whatever they hold. Load it before the first `docker` command, and whenever a container's data has disappeared or Docker does not answer.
---

# Docker

This pod is a Kata Containers virtual machine with its own Docker daemon: Docker in Docker. Anything that ships as an image, a Dockerfile or a compose file runs here as containers, whether that is the App itself, a service it uses or a whole product. Containers run inside this VM, so root, `--privileged` and extra capabilities in a container reach only the VM, never the host.

The daemon is the platform's: `dockerd`, under `guard docker`, already running, with the `docker` CLI, Compose and Buildx installed. Its installation, start and settings stay as they are. When `docker` cannot reach it, `process-logs docker` shows why. The `platform` skill's App contract and `startup.sh` rules hold for containers too.

## Running containers

`startup.sh` runs containers in the foreground under one `guard`. A container that serves the App publishes `$APP_PORT` on all addresses, because the platform reaches the App through the pod's address.

With `app/compose.yaml`:

```bash
guard app sh -c 'until docker info >/dev/null 2>&1; do sleep 1; done
  exec docker compose up --build --abort-on-container-failure' &
```

```yaml
services:
  web:
    build: .
    ports: ["${APP_PORT}:<container port>"]
```

With a single image:

```bash
guard app sh -c 'until docker info >/dev/null 2>&1; do sleep 1; done
  docker rm -f app >/dev/null 2>&1
  exec docker run --rm --name app -p "$APP_PORT:<container port>" <image>:<tag>' &
```

- The `docker info` loop waits for the daemon, which starts alongside `startup.sh`. `docker rm -f` clears a container left behind when the last `docker run` was killed.
- `--abort-on-container-failure` stops every container when one crashes, so `guard` restarts them all. A one-shot service, such as a migration, simply ends when it succeeds. `--build` keeps images on current source.
- Their output is in `process-logs app`, and restarting the App stops them. The detached forms (`-d`, `--restart`) would hand them to Docker instead, outside `guard` and the logs.
- A dependency such as a database can restart once during its first start, so connect with retries, as the `platform` skill's rule on surviving a dependency restart says.

## Docker's storage is disposable

Images, build cache, containers and Docker volumes live in the pod, not in `/workspace`. Every new pod — a wake from idle, a Restart, a Publish — starts without them:

- Images are pulled and built again before the App answers, so prefer images you can pull to builds that install dependencies.
- Pin full version tags (`<image>:<version>`), as the `platform` skill's §Dependencies says. `latest` or a bare major tag can pull a different image after a wake.
- `toomanyrequests` means Docker Hub's anonymous pull limit, shared by the whole cluster, is reached for now. `guard` retries until it clears; tell the user if it persists.
- The storage holds about 20 GB. On `no space left on device`, `docker system prune -af` frees it, since everything it removes comes back.

## Durable data lives in `/workspace`, bind-mounted

`/workspace` is the one place that outlives the pod. So a container keeps whatever must survive in a directory of it, bind-mounted in, and above all that means a database's data directory. The `platform` skill puts state under `/workspace/app/data/`:

```bash
-v /workspace/app/data/<name>:<the container's data directory>   # compose: ./data/<name>:<…>
```

That data survives every restart, git ignores it, Publish never copies it (a published environment starts with its own, empty), and Duplicate and Export carry it.

A Docker volume lives in the disposable storage, and the next wake erases it. That covers `-v <name>:<path>`, and also the anonymous volume Docker creates for any directory an image declares as a `VOLUME`, as many database images do. The data is durable once every container lists each directory that holds state as `bind`, and none as `volume`:

```bash
docker inspect <container> --format '{{range .Mounts}}{{.Type}} {{.Destination}}{{println}}{{end}}'
```

## Ports, networking and environment

- Only the container serving the App publishes on all addresses. Any other publishes on `127.0.0.1` or not at all, since compose services reach each other by name. A port on all addresses is open to other pods in the cluster.
- `localhost` in a container is the container. A container that calls something in the pod outside Docker runs with `--network host`, and keeps its own ports on `127.0.0.1`.
- Containers see none of the pod's environment variables. Pass what each one needs, such as the `platform` skill's gateway variables, with `-e <NAME>` or compose's `environment:`.

## Resources

Containers share the pod's CPU and memory with you and the App. When they need more than the Project's Resources give, tell the user they can raise them.

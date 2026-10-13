# Air-Gapped Single-Node Client Requirements

Client-provided infrastructure, artifacts, and configuration required for an Opsiforce deployment on one disconnected machine.

## Host

| Item | Requirement |
|---|---|
| Architecture | `amd64` |
| Operating system | Ubuntu Server 24.04 LTS |
| CPU | 16 cores minimum |
| RAM | 64 GiB minimum |
| Disk | 2 TiB NVMe minimum |
| Network | Static IP address, hostname, and default route |
| Backup | Separate disk or client backup target |

The deployment is single-node and is not highly available.

## Host Packages

These packages must be available from the Ubuntu 24.04 installation media or an internal APT repository:

```text
ca-certificates
curl
openssl
python3
python3-pip
python3-venv
rsync
tar
zstd
```

## k3s Artifacts

| Artifact | Requirement | Source |
|---|---|---|
| k3s binary | `v1.32.0+k3s1`, `amd64` | [Official release](https://github.com/k3s-io/k3s/releases/tag/v1.32.0%2Bk3s1) |
| k3s installer | Checksum-recorded copy of `install.sh` | [`get.k3s.io`](https://get.k3s.io) |
| k3s image archive | `k3s-airgap-images-amd64.tar.zst` for `v1.32.0+k3s1` | [Official release](https://github.com/k3s-io/k3s/releases/tag/v1.32.0%2Bk3s1) |

The client-provided k3s image archive contains these images:

```text
docker.io/rancher/klipper-helm:v0.9.3-build20241008
docker.io/rancher/klipper-lb:v0.4.9
docker.io/rancher/local-path-provisioner:v0.0.30
docker.io/rancher/mirrored-coredns-coredns:1.12.0
docker.io/rancher/mirrored-library-busybox:1.36.1
docker.io/rancher/mirrored-library-traefik:2.11.10
docker.io/rancher/mirrored-metrics-server:v0.7.2
docker.io/rancher/mirrored-pause:3.6
```

The authoritative image inventory is the official [`k3s-images.txt`](https://github.com/k3s-io/k3s/releases/download/v1.32.0%2Bk3s1/k3s-images.txt). Its SHA-256 checksum is `46c9c5393c0e6485e7dd78fa11b4df4800a7a66f6ace7eecd23011eebe5611bf`.

## Opsiforce Images

| Image | Dockerfile |
|---|---|
| Opsiforce backend | <https://github.com/SimaDevelopment/sima/blob/main/packages/opsiforce/docker/Dockerfile.backend> |
| Opsiforce frontend | <https://github.com/SimaDevelopment/sima/blob/main/packages/opsiforce/docker/Dockerfile.frontend> |
| Opsiforce agent | <https://github.com/SimaDevelopment/sima/blob/main/packages/opsiforce/docker/Dockerfile.agent> |
| Opsiforce runtime proxy | <https://github.com/SimaDevelopment/sima/blob/main/packages/opsiforce/docker/Dockerfile.runtime-proxy> |

## Third-Party Images

```text
docker.io/library/postgres:16-alpine
docker.io/valkey/valkey:9.0.1
docker.io/maximhq/bifrost:v2.0.0
docker.io/traefik:v3.6.13
docker.io/alpine/git:2.49.1
docker.io/library/nginx:1.30.1
quay.io/oauth2-proxy/oauth2-proxy:v7.13.0
docker.io/gotenberg/gotenberg:8.36.0-libreoffice
```

## Internal Package Repositories

| Repository | Requirement | Purpose |
|---|---|---|
| npm-compatible registry | Required | Agent package installation and App builds |
| PyPI mirror | Optional | Python dependencies installed by Agents |
| Debian package mirror | Optional | Debian packages installed by Agents |
| Git mirror | Optional | Source dependencies |
| Go proxy | Optional | Go dependencies |
| Rust/crates mirror | Optional | Rust dependencies |
| Container registry | Optional | Alternative to local image archives |

Private repository URLs and CA certificates are required when applicable.

## Identity And External Services

| Item | Requirement |
|---|---|
| OIDC | Issuer URL, client ID, client secret, and group/role mapping |
| OpenAI | API key and outbound HTTPS access to `api.openai.com:443` |
| Artifact transfer | Approved transfer method for the disconnected network |

## DNS And TLS

All records resolve to the host's static IP:

```text
opsiforce.<domain>
*.apps.opsiforce.<domain>
*.preview.apps.opsiforce.<domain>
*.code.opsiforce.<domain>
*.db.opsiforce.<domain>
bifrost.opsiforce.<domain>
```

A TLS certificate and private key trusted by client browsers must cover the same names. `*.apps.opsiforce.<domain>` does not cover `*.preview.apps.opsiforce.<domain>`.

## Network Access

| Direction | Port or endpoint | Source or destination | Purpose |
|---|---|---|---|
| Inbound | 22/TCP | Management network | SSH/Ansible |
| Inbound | 80/TCP | User network | HTTP redirect |
| Inbound | 443/TCP | User network | Opsiforce HTTPS |
| Inbound | 6443/TCP | Management network | Kubernetes API |
| Outbound | `api.openai.com:443` | OpenAI | Model access |
| Outbound | Client-defined | Internal package repositories | Agent and App dependencies |

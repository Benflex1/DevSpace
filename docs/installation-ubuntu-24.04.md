# Fresh installation on Ubuntu 24.04

This guide installs the DevSpace Web application and workspace Agent directly on a dedicated
Ubuntu 24.04 LTS `amd64` host. The Agent runs as its own unprivileged account beside its dedicated
rootless Docker daemon. The Web application has a separate account and persistent database. The
browser reaches Web through an owner-only Cloudflare Access application.

DevSpace does not manage the public ingress or Cloudflare account, and it does not receive the
host/Coolify Docker socket. The optional Preview Gateway is deployed separately using the existing
contract below.

## Supported prerequisites

- Ubuntu Server 24.04 LTS, `linux/amd64` (`x86_64`), with systemd and a sudo-capable setup account.
- Node.js `24.18.0` and pnpm `11.13.0`, matching `.nvmrc` and `package.json`.
- Git, HTTPS egress to GitHub, the npm registry, the configured Cloudflare Access issuer, and the
  chosen workspace image registries; plus Ubuntu build tools for native dependencies and Agent
  helpers.
- Docker Engine from Docker's Ubuntu repository, including `docker-ce-rootless-extras`, `uidmap`,
  `dbus-user-session`, `slirp4netns`, and `fuse-overlayfs`.
- A Cloudflare Access team and a hostname with HTTPS ingress. Cloudflare Tunnel is one supported
  way to route that hostname to the loopback Web listener; an existing equivalent ingress is also
  suitable.

This guide assumes a new dedicated host. Do not disable or stop Docker services that carry other
workloads. Do not add either DevSpace service account to the `docker` group.

## 1. Install host packages and pinned Node.js

Install build and source-control prerequisites:

```bash
sudo apt update
sudo apt install -y ca-certificates curl git xz-utils build-essential python3
```

Install the exact Node.js release pinned by this repository from the official binary archive. The
release-specific checksum file is verified before extraction. The archive is published in the
[official Node.js distribution directory](https://nodejs.org/dist/v24.18.0/).

```bash
NODE_VERSION=24.18.0
NODE_ARCHIVE="node-v${NODE_VERSION}-linux-x64.tar.xz"
cd /tmp
curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}"
curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
awk -v file="$NODE_ARCHIVE" '$2 == file { print }' SHASUMS256.txt | sha256sum --check --strict

sudo install -d -m 0755 "/opt/node-v${NODE_VERSION}"
sudo tar --strip-components=1 -xJf "$NODE_ARCHIVE" -C "/opt/node-v${NODE_VERSION}"
sudo ln -sfn "/opt/node-v${NODE_VERSION}/bin/node" /usr/local/bin/node
sudo ln -sfn "/opt/node-v${NODE_VERSION}/bin/npm" /usr/local/bin/npm
sudo ln -sfn "/opt/node-v${NODE_VERSION}/bin/npx" /usr/local/bin/npx
sudo npm install --global --prefix /usr/local pnpm@11.13.0

node --version
pnpm --version
```

The version checks must print `v24.18.0` and `11.13.0`.

## 2. Install Docker Engine and prepare the rootless daemon

Add Docker's official Ubuntu `noble` repository and install the Engine, Compose plugin, and
rootless prerequisites. These packages follow Docker's [Ubuntu Engine installation](https://docs.docker.com/engine/install/ubuntu/)
and [rootless mode guide](https://docs.docker.com/engine/security/rootless/) for the selected host
release:

```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

cat <<'EOF' | sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: amd64
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin \
  docker-compose-plugin docker-ce-rootless-extras uidmap dbus-user-session \
  slirp4netns fuse-overlayfs
```

Create distinct service identities. The Web account joins the Agent group only so it can connect
to the Agent's mode-`0660` private API socket; it cannot access the Agent's mode-`0700` state or
rootless Docker socket.

```bash
sudo groupadd --system devspace-agent
sudo useradd --create-home --home-dir /var/lib/devspace-agent \
  --shell /usr/sbin/nologin --gid devspace-agent devspace-agent
sudo groupadd --system devspace-web
sudo useradd --create-home --home-dir /var/lib/devspace-web \
  --shell /usr/sbin/nologin --gid devspace-web devspace-web
sudo usermod --append --groups devspace-agent devspace-web

sudo install -d -o devspace-agent -g devspace-agent -m 0700 \
  /var/lib/devspace-agent /var/lib/devspace-agent/managed \
  /var/lib/devspace-agent/managed/projects \
  /var/lib/devspace-agent/managed/workspaces \
  /var/lib/devspace-agent/managed/state \
  /var/lib/devspace-agent/managed/state/operations
sudo install -d -o devspace-web -g devspace-web -m 0700 /var/lib/devspace-web
```

The Agent requires subordinate UID/GID mappings for rootless containers. Allocate a free range of
65,536 IDs in both files if the account does not already have enough. This chooses a range that
does not overlap entries in either file:

```bash
SUBUID_START="$(python3 - <<'PY'
import pathlib, pwd
user = 'devspace-agent'
uid = str(pwd.getpwnam(user).pw_uid)
needed = 65536
all_ranges = []
complete = True
for path in (pathlib.Path('/etc/subuid'), pathlib.Path('/etc/subgid')):
    assigned = 0
    for line in path.read_text().splitlines() if path.exists() else []:
        fields = line.split(':')
        if len(fields) != 3:
            continue
        try:
            start, count = int(fields[1]), int(fields[2])
        except ValueError:
            continue
        all_ranges.append((start, start + count))
        if fields[0] in (user, uid):
            assigned += count
    complete = complete and assigned >= needed
if complete:
    print('existing')
else:
    candidate = 1_000_000
    while any(candidate < end and start < candidate + needed for start, end in all_ranges):
        candidate += needed
    print(candidate)
PY
)"
if [[ "$SUBUID_START" != existing ]]; then
  SUBUID_END=$((SUBUID_START + 65535))
  sudo usermod --add-subuids "$SUBUID_START-$SUBUID_END" \
    --add-subgids "$SUBUID_START-$SUBUID_END" devspace-agent
fi
grep '^devspace-agent:' /etc/subuid /etc/subgid
```

On this dedicated host, stop the package-installed rootful daemon before installing the dedicated
rootless one. This keeps DevSpace from selecting a rootful Docker endpoint:

```bash
sudo systemctl disable --now docker.service docker.socket containerd.service
if sudo test -S /var/run/docker.sock; then sudo rm /var/run/docker.sock; fi
```

Delegate resource controllers only to the Agent user's systemd manager. This is needed by the
rootless Engine on Ubuntu's cgroup v2 host. Start that manager and run Docker's prerequisite check:

```bash
AGENT_UID="$(id -u devspace-agent)"
sudo install -d -m 0755 "/etc/systemd/system/user@${AGENT_UID}.service.d"
printf '[Service]\nDelegate=cpu cpuset io memory pids\n' \
  | sudo tee "/etc/systemd/system/user@${AGENT_UID}.service.d/devspace-rootless.conf" >/dev/null
sudo systemctl daemon-reload
sudo loginctl enable-linger devspace-agent
sudo systemctl start "user@${AGENT_UID}.service"
sudo -u devspace-agent env -i \
  HOME=/var/lib/devspace-agent \
  PATH=/usr/local/bin:/usr/bin:/bin \
  XDG_RUNTIME_DIR="/run/user/${AGENT_UID}" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${AGENT_UID}/bus" \
  /usr/bin/dockerd-rootless-setuptool.sh check
```

Install and enable the Agent user's Docker service. `loginctl enable-linger` keeps the user service
available after logout and at boot.

```bash
AGENT_UID="$(id -u devspace-agent)"
sudo -u devspace-agent env -i \
  HOME=/var/lib/devspace-agent \
  PATH=/usr/local/bin:/usr/bin:/bin \
  XDG_RUNTIME_DIR="/run/user/${AGENT_UID}" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${AGENT_UID}/bus" \
  /usr/bin/dockerd-rootless-setuptool.sh install
sudo -u devspace-agent env -i \
  HOME=/var/lib/devspace-agent \
  PATH=/usr/local/bin:/usr/bin:/bin \
  XDG_RUNTIME_DIR="/run/user/${AGENT_UID}" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${AGENT_UID}/bus" \
  systemctl --user enable --now docker.service

sudo -u devspace-agent env \
  DOCKER_HOST="unix:///run/user/${AGENT_UID}/docker.sock" \
  docker info --format '{{json .SecurityOptions}}'
```

The output must include `"name=rootless"`. The Agent will use this exact socket path. Do not set
`DEVSPACE_DOCKER_SOCKET_PATH` to `/var/run/docker.sock`, mount any Docker socket into Web, or add
the Web account to the `docker` group.

## 3. Check out and build a fixed source revision

DevSpace is installed from source. For repeatable installations, choose the full commit SHA you
reviewed and keep it with your deployment record; do not use a moving branch name when repeating
the same installation.

```bash
DEVSPACE_REF='<40-character-reviewed-commit-sha>'
sudo install -d -o "$(id -u)" -g "$(id -g)" -m 0755 /opt/devspace
git clone --no-checkout https://github.com/Benflex1/DevSpace.git /opt/devspace
git -C /opt/devspace checkout --detach "$DEVSPACE_REF"
test "$(git -C /opt/devspace rev-parse HEAD)" = "$DEVSPACE_REF"

cd /opt/devspace
pnpm install --frozen-lockfile
pnpm build
```

The checkout owner may be the setup account. Grant the service accounts read access without write
access to application code:

```bash
sudo groupadd --system devspace-code
sudo usermod --append --groups devspace-code devspace-agent
sudo usermod --append --groups devspace-code devspace-web
sudo chgrp -R devspace-code /opt/devspace
sudo chmod -R g+rX /opt/devspace
```

The workspace remains writable only beneath Agent-owned state. Do not put application source,
SQLite, or Agent state in a project worktree.

## 4. Configure Cloudflare Access and DevSpace

### External Cloudflare setup

Before starting Web, configure the external Cloudflare account and ingress:

1. Route one hostname, such as `devspace.example.com`, to `http://127.0.0.1:3000`. With Cloudflare
   Tunnel, use a public hostname whose service is that loopback URL. Keep port `3000` bound to
   loopback; do not publish it directly to the Internet.
2. In Cloudflare Zero Trust, create a **Self-hosted** Access application for that exact hostname.
3. Add an **Allow** policy for the owner's exact email address. Do not add an Everyone, Bypass, or
   unauthenticated policy.
4. Copy the application's **AUD tag** and the team's Access issuer origin, for example
   `https://team-name.cloudflareaccess.com`.

Cloudflare owns DNS, TLS, ingress, identity provider setup, the Access policy, and the AUD tag.
DevSpace validates the `Cf-Access-Jwt-Assertion` JWT at its origin using the configured issuer and
audience. The audience is not a secret. Do not use development authentication on a public host.
See Cloudflare's [self-hosted application guide](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/).

### DevSpace environment files

Create environment files from the checked-in examples. The example values contain no credentials;
replace the hostname, Access issuer, audience, and Agent UID with values for this host.

```bash
sudo install -d -o root -g root -m 0755 /etc/devspace
AGENT_UID="$(id -u devspace-agent)"
sed "s/@AGENT_UID@/${AGENT_UID}/g" deploy/ubuntu/agent.env.example | sudo tee /etc/devspace/agent.env >/dev/null
sudo chown root:devspace-agent /etc/devspace/agent.env
sudo chmod 0640 /etc/devspace/agent.env
sudo install -o root -g devspace-web -m 0640 \
  deploy/ubuntu/web.env.example /etc/devspace/web.env
sudoedit /etc/devspace/agent.env /etc/devspace/web.env
```

Keep these values aligned:

- `DEVSPACE_APP_ORIGIN` is the exact public `https://` origin in the browser, with no path.
- `DEVSPACE_ACCESS_ISSUER` is the exact Cloudflare Access team `https://` origin.
- `DEVSPACE_ACCESS_AUDIENCE` is the Access application's AUD tag.
- `DEVSPACE_AGENT_SOCKET_PATH` is `/run/devspace-agent/agent.sock` in both files.
- `DEVSPACE_DOCKER_SOCKET_PATH` is `/run/user/<devspace-agent-uid>/docker.sock` in `agent.env`.
- `DEVSPACE_DATABASE_PATH` is under the Web-only `/var/lib/devspace-web` state directory.
- `DEVSPACE_MANAGED_ROOT` is under the Agent-only `/var/lib/devspace-agent` state directory.

The systemd units create `/var/lib/devspace-web` and `/var/lib/devspace-agent` as mode `0700`.
The Agent requires its `managed/projects`, `managed/workspaces`, `managed/state`, and
`managed/state/operations` directories to exist before its first start; the commands above
provision them with Agent ownership and mode `0700`.

### Private GitHub repositories

Public HTTPS repositories can be onboarded without a GitHub App. Private repository access and
GitHub App-backed Push use DevSpace's existing GitHub App flow. Configure the App for the expected
owner with repository selection set to **Only select repositories**, Metadata read-only, and
Contents read/write. App configuration and the PEM key belong only in Agent-private state, never in
the Web environment file, SQLite, or a browser field.

The runtime configuration shape is in [`deploy/ubuntu/github-app-config.example.json`](../deploy/ubuntu/github-app-config.example.json).
Create the example config with your App's decimal App ID, the expected owner's decimal account ID,
account type, and installation URL. Then install the config and downloaded PEM key before the
Agent starts (or restart Agent after replacing them):

```bash
APP_STATE=/var/lib/devspace-agent/managed/state/github-app
sudo install -d -o devspace-agent -g devspace-agent -m 0700 "$APP_STATE"
sudo install -o devspace-agent -g devspace-agent -m 0600 \
  /path/to/your-github-app-config.json "$APP_STATE/config.json"
sudo install -o devspace-agent -g devspace-agent -m 0600 \
  /path/to/your-downloaded-private-key.pem "$APP_STATE/private-key.pem"
```

Do not substitute a PAT, OAuth token, or Git credential.

## 5. Install and start the systemd services

Install the checked-in units and start Agent before Web:

```bash
sudo install -m 0644 deploy/ubuntu/devspace-agent.service /etc/systemd/system/devspace-agent.service
sudo install -m 0644 deploy/ubuntu/devspace-web.service /etc/systemd/system/devspace-web.service
sudo systemctl daemon-reload
sudo systemctl enable --now devspace-agent.service
sudo systemctl enable --now devspace-web.service
```

Web binds to `127.0.0.1:3000`. Its service account can reach the Agent socket through the
`devspace-agent` group. The Agent account and rootless daemon share the same host filesystem and
the same absolute `/var/lib/devspace-agent/managed/...` paths. Do not run Agent in a container or
translate those paths to a container-only mount: Docker must see the exact host paths written by
Agent when it creates workspace bind mounts.

Both systemd units run the matching preflight as `ExecStartPre` with the exact service identity and
environment file. You can also rerun it manually after changing configuration:

```bash
sudo -u devspace-agent env -i \
  HOME=/var/lib/devspace-agent PATH=/usr/local/bin:/usr/bin:/bin \
  /usr/local/bin/node --env-file=/etc/devspace/agent.env \
  /opt/devspace/tooling/install-preflight.mjs agent

sudo -u devspace-web env -i \
  HOME=/var/lib/devspace-web PATH=/usr/local/bin:/usr/bin:/bin \
  /usr/local/bin/node --env-file=/etc/devspace/web.env \
  /opt/devspace/tooling/install-preflight.mjs web
```

The Agent check verifies Ubuntu/architecture and pinned tool versions, private Agent directories,
the per-user Docker socket, and Docker's rootless security option. The Web check verifies production
Cloudflare Access settings, private SQLite state, and actual connection access to the Agent socket.
It reports no environment values or credentials.

Check services and logs. A failed preflight prevents the corresponding service from starting; the
reason is recorded in its journal:

```bash
sudo systemctl --no-pager --full status devspace-agent.service devspace-web.service
sudo journalctl -u devspace-agent.service -n 100 --no-pager
sudo journalctl -u devspace-web.service -n 100 --no-pager
stat -c '%a %U:%G %n' \
  /var/lib/devspace-web \
  /var/lib/devspace-agent/managed/projects \
  /var/lib/devspace-agent/managed/workspaces \
  /var/lib/devspace-agent/managed/state
```

## 6. First project workflow

Open `https://devspace.example.com` and complete Cloudflare Access sign-in as the allowed owner.
Then:

1. Add a project from a public HTTPS Git repository URL, or use the configured GitHub App selector
   for an installed private repository.
2. Create its primary workspace. Review Project Options and select a valid development image for
   that repository.
3. Start the workspace and wait for the runtime to become ready.
4. Open Terminal and confirm `pwd` is `/workspace`.
5. In Terminal, create a small file under `/workspace` so you can check that workspace data
   survives the next steps.
6. Stop the workspace from the Workbench.
7. Open Project Options, add the default **Check workspace** task, then Save Draft and Apply the
   saved revision. Project Options Apply requires the workspace to be stopped.
8. Start the workspace again and run **Check workspace** from the Workbench. It prints
   `configured-task-ok` and exits successfully.
9. Open Terminal and confirm the file created before Stop is still present.

The first step may use a public HTTPS repository without GitHub credentials. Private source
inspection, private fetch, and Push require the existing Agent-owned GitHub App configuration and
an installation with the required repository permissions. AI sessions require a configured
provider profile/credentials. These credentials are configured through their existing DevSpace
flows; they are not prerequisites for starting a public workspace.

## 7. Optional Preview Gateway

Previews require an independently deployed Preview Gateway and administrator-owned ingress. The
Web/Agent install does not create gateway containers, DNS, TLS, an ingress route, or Cloudflare
Access policy for previews.

Use the provider-neutral [Preview Gateway deployment contract](preview-gateway-deployment.md) to
provision the external runtime and private sockets. For the existing Coolify/Traefik adapter, use
[`deploy/preview-gateway/compose.coolify.yaml`](../deploy/preview-gateway/compose.coolify.yaml)
with the Raw Compose settings in the [Coolify runbook](integrations/coolify-traefik-preview-ingress.md).
Keep that gateway deployment separate from the Agent's dedicated rootless Docker daemon. When the
gateway shares this host, set its `DEVSPACE_GATEWAY_UID` and `DEVSPACE_GATEWAY_GID` to the Agent
account's numeric UID/GID and provision the shared runtime and ingress directories as mode `0700`
with the ownership required by the deployment contract. The Agent and gateway must see the same
host paths for their private Unix sockets; do not make those directories world-writable.

After the gateway is reachable, replace `[]` in both environment files with the same reserved base,
for example:

```ini
DEVSPACE_PREVIEW_BASES='[{"id":"main","domain":"preview.example.com","labelSuffix":"-preview"}]'
```

Set `DEVSPACE_CADDY_ADMIN_SOCKET`, `DEVSPACE_PREVIEW_PROBE_SOCKET`, and
`DEVSPACE_PREVIEW_LEASE_RESOLVER_SOCKET` in `agent.env` to the corresponding private gateway
sockets, then restart Agent and Web. The outer ingress must preserve the original Host header,
support WebSocket upgrades, and route only the administrator-reserved preview namespace. DNS,
certificates, ingress, and any preview Access policy remain external setup.

## Routine operations

Stop Web before Agent for planned service maintenance. Stop active workspaces in the browser first;
their project files and Agent state remain on disk.

```bash
sudo systemctl stop devspace-web.service
sudo systemctl stop devspace-agent.service
```

Start them in dependency order:

```bash
sudo systemctl start devspace-agent.service
sudo systemctl start devspace-web.service
```

After rebuilding a pinned revision, restart Agent and then Web:

```bash
sudo systemctl restart devspace-agent.service
sudo systemctl restart devspace-web.service
```

Follow logs with `sudo journalctl -fu devspace-agent.service` or
`sudo journalctl -fu devspace-web.service`. Inspect the dedicated Docker user service with:

```bash
AGENT_UID="$(id -u devspace-agent)"
sudo -u devspace-agent env \
  XDG_RUNTIME_DIR="/run/user/${AGENT_UID}" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${AGENT_UID}/bus" \
  systemctl --user status docker.service
```

The workspace Docker daemon is separate from the system `docker.service` and `containerd.service`.

## Troubleshooting

- **Agent preflight reports no Docker socket:** check `loginctl show-user devspace-agent`, the
  rootless user service with `systemctl --user status docker`, and that the configured path is
  `/run/user/<devspace-agent-uid>/docker.sock`.
- **Agent reports the wrong Docker mode:** inspect the rootless service log and confirm
  `docker info --format '{{json .SecurityOptions}}'` includes `name=rootless`. Do not point it at
  `/var/run/docker.sock`.
- **Web preflight cannot connect to Agent:** confirm Web is a member of `devspace-agent`, restart
  Web after the group change, and check `/run/devspace-agent` is `0750` and the Agent socket is
  `0660`.
- **Cloudflare sign-in loops or returns an authentication error:** check the exact public origin,
  Access team issuer, and application's AUD tag. Confirm the Access app covers the Web hostname
  and allows only the owner. Keep the origin reachable only through the protected ingress.
- **Workspace bind mount fails:** run Agent directly on the host, check ownership/modes beneath
  `/var/lib/devspace-agent/managed`, and confirm the rootless daemon and Agent use the same host
  mount namespace. Do not run Agent inside a container or use a translated container path.
- **Build fails in a native dependency or helper:** confirm `build-essential`, `python3`, and
  `ca-certificates` are installed, then rerun `pnpm install --frozen-lockfile` and `pnpm build`.

The Web database is `/var/lib/devspace-web/devspace.sqlite`. Agent repositories, worktrees,
operation state, and GitHub App credentials are beneath `/var/lib/devspace-agent/managed`; the
rootless Docker engine stores its data beneath the Agent account's home. Keep these paths persistent
across service restarts and host upgrades.

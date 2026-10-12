#!/usr/bin/env bash
set -Eeuo pipefail

mode="${1:-}"
runner_temp="$(realpath -e "${RUNNER_TEMP:?RUNNER_TEMP is required}")"
run_id="${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
run_attempt="${GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT is required}"
root="$runner_temp/devspace-install-acceptance-$run_id-$run_attempt"
install_root=/opt/devspace
agent_user=devspace-agent
web_user=devspace-web
agent_home=/var/lib/devspace-agent
web_home=/var/lib/devspace-web
managed_root="$agent_home/managed"
agent_socket=/run/devspace-agent/agent.sock
agent_env=/etc/devspace/agent.env
web_env=/etc/devspace/web.env
test_ca=/etc/devspace/installation-test-ca.pem
agent_uid=""
agent_gid=""

fail() { printf 'installation acceptance: %s\n' "$1" >&2; exit 1; }

assert_owned_directory() {
  local directory="$1" user="$2" expected_mode="$3"
  test -d "$directory" && test ! -L "$directory"
  test "$(stat -c '%U' "$directory")" = "$user"
  test "$(stat -c '%a' "$directory")" = "$expected_mode"
}

prepare_host() {
  local ref="${2:?full source commit is required}" node_version=24.18.0 pnpm_version=11.13.0
  [[ "$ref" =~ ^[0-9a-f]{40}$ ]] || fail "the source ref must be a full commit SHA"
  [[ "$root" == "$runner_temp/devspace-install-acceptance-$run_id-$run_attempt" ]] || fail "unsafe temporary root"
  [[ ! -e "$root" && ! -L "$root" ]] || fail "refusing to reuse a prior acceptance root: $root"
  [[ ! -e "$install_root" && ! -L "$install_root" ]] || fail "refusing to overwrite $install_root"
  getent passwd "$agent_user" >/dev/null && fail "$agent_user already exists"
  getent passwd "$web_user" >/dev/null && fail "$web_user already exists"
  getent group devspace-agent >/dev/null && fail "devspace-agent group already exists"
  getent group devspace-web >/dev/null && fail "devspace-web group already exists"
  getent group devspace-code >/dev/null && fail "devspace-code group already exists"
  [[ ! -e "$agent_home" && ! -e "$web_home" ]] || fail "refusing to overwrite DevSpace state paths"
  [[ ! -e /etc/devspace ]] || fail "refusing to overwrite /etc/devspace"
  [[ ! -e /etc/systemd/system/devspace-agent.service && ! -L /etc/systemd/system/devspace-agent.service ]] \
    || fail "refusing to overwrite an existing DevSpace Agent unit"
  [[ ! -e /etc/systemd/system/devspace-web.service && ! -L /etc/systemd/system/devspace-web.service ]] \
    || fail "refusing to overwrite an existing DevSpace Web unit"
  [[ ! -e /run/devspace-agent ]] || fail "refusing to reuse an existing DevSpace Agent runtime directory"
  [[ ! -e "/opt/node-v${node_version}" && ! -L "/opt/node-v${node_version}" ]] || fail "refusing to overwrite the pinned Node.js directory"

  install -d -m 0700 "$root"
  printf '%s\n' "$root" >"$root/root-marker"
  printf 'INSTALL_ACCEPTANCE_ROOT=%s\n' "$root" >>"$GITHUB_ENV"
  printf 'INSTALL_ACCEPTANCE_RESULT_FILE=%s/acceptance-result.json\n' "$root" >>"$GITHUB_ENV"

  for executable in node npm npx pnpm; do
    executable_path="/usr/local/bin/$executable"
    if [[ -e "$executable_path" || -L "$executable_path" ]]; then
      cp -a "$executable_path" "$root/original-bin-$executable"
      printf 'present\n' >"$root/original-bin-$executable.state"
    else
      printf 'absent\n' >"$root/original-bin-$executable.state"
    fi
  done
  if [[ -d /usr/local/lib/node_modules/pnpm ]]; then
    cp -a /usr/local/lib/node_modules/pnpm "$root/original-pnpm-global"
    touch "$root/original-pnpm-global.state"
  fi

  for unit in docker.service docker.socket containerd.service; do
    active="$(sudo systemctl is-active "$unit" 2>/dev/null || true)"
    enabled="$(sudo systemctl is-enabled "$unit" 2>/dev/null || true)"
    printf '%s %s %s\n' "$unit" "$active" "$enabled" >>"$root/rootful-unit-state"
  done
  touch "$root/rootful-state-saved"

  sudo apt-get update
  sudo apt-get install -y ca-certificates curl git xz-utils build-essential python3 openssl
  curl -fsSLO --output-dir "$root" "https://nodejs.org/dist/v${node_version}/node-v${node_version}-linux-x64.tar.xz"
  curl -fsSLO --output-dir "$root" "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt"
  (cd "$root" && awk -v file="node-v${node_version}-linux-x64.tar.xz" '$2 == file { print }' SHASUMS256.txt | sha256sum --check --strict)
  touch "$root/node-install-created"
  sudo install -d -m 0755 "/opt/node-v${node_version}"
  sudo tar --strip-components=1 -xJf "$root/node-v${node_version}-linux-x64.tar.xz" -C "/opt/node-v${node_version}"
  sudo ln -sfn "/opt/node-v${node_version}/bin/node" /usr/local/bin/node
  sudo ln -sfn "/opt/node-v${node_version}/bin/npm" /usr/local/bin/npm
  sudo ln -sfn "/opt/node-v${node_version}/bin/npx" /usr/local/bin/npx
  sudo npm install --global --prefix /usr/local "pnpm@${pnpm_version}"
  test "$(node --version)" = "v${node_version}"
  test "$(pnpm --version)" = "$pnpm_version"

  sudo install -m 0755 -d /etc/apt/keyrings
  [[ ! -e /etc/apt/keyrings/devspace-install-acceptance.asc ]] || fail "Docker key path already exists"
  [[ ! -e /etc/apt/sources.list.d/devspace-install-acceptance.sources ]] || fail "Docker apt source path already exists"
  touch "$root/docker-key-created" "$root/docker-source-created"
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo tee /etc/apt/keyrings/devspace-install-acceptance.asc >/dev/null
  sudo chmod a+r /etc/apt/keyrings/devspace-install-acceptance.asc
  cat >"$root/docker.sources" <<'EOF'
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: noble
Components: stable
Architectures: amd64
Signed-By: /etc/apt/keyrings/devspace-install-acceptance.asc
EOF
  sudo install -m 0644 "$root/docker.sources" /etc/apt/sources.list.d/devspace-install-acceptance.sources
  sudo apt-get update
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
    docker-ce-rootless-extras uidmap dbus-user-session slirp4netns fuse-overlayfs

  sudo groupadd --system devspace-agent
  sudo useradd --create-home --home-dir "$agent_home" --shell /usr/sbin/nologin --gid devspace-agent "$agent_user"
  sudo groupadd --system devspace-web
  sudo useradd --create-home --home-dir "$web_home" --shell /usr/sbin/nologin --gid devspace-web "$web_user"
  sudo groupadd --system devspace-code
  sudo usermod --append --groups devspace-agent "$web_user"
  sudo usermod --append --groups devspace-code "$agent_user"
  sudo usermod --append --groups devspace-code "$web_user"
  sudo install -d -o "$agent_user" -g devspace-agent -m 0700 \
    "$agent_home" "$managed_root" "$managed_root/projects" "$managed_root/workspaces" \
    "$managed_root/state" "$managed_root/state/operations"
  sudo install -d -o "$web_user" -g devspace-web -m 0700 "$web_home"

  local subuid_start
  subuid_start="$(python3 - "$agent_user" <<'PY'
import pathlib, pwd, sys
user = sys.argv[1]
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
  if [[ "$subuid_start" != existing ]]; then
    subuid_end=$((subuid_start + 65535))
    sudo usermod --add-subuids "$subuid_start-$subuid_end" --add-subgids "$subuid_start-$subuid_end" "$agent_user"
  fi
  grep "^${agent_user}:" /etc/subuid /etc/subgid || true

  agent_uid="$(id -u "$agent_user")"
  agent_gid="$(id -g "$agent_user")"
  printf '%s\n' "$agent_uid" >"$root/agent-uid"
  local delegation_dropin="/etc/systemd/system/user@${agent_uid}.service.d/devspace-install-acceptance-${run_id}-${run_attempt}.conf"
  local delegation_directory="$(dirname "$delegation_dropin")"
  [[ ! -e "$delegation_dropin" && ! -L "$delegation_dropin" ]] || fail "rootless delegation drop-in already exists"
  [[ ! -e "$delegation_directory" || -d "$delegation_directory" ]] || fail "rootless delegation path is not a directory"
  if [[ ! -e "$delegation_directory" ]]; then touch "$root/delegation-directory-created"; fi
  sudo install -d -m 0755 "$delegation_directory"
  printf '[Service]\nDelegate=cpu cpuset io memory pids\n' >"$root/user-manager-delegation.conf"
  sudo install -m 0644 "$root/user-manager-delegation.conf" "$delegation_dropin"
  printf '%s\n' "$delegation_dropin" >"$root/delegation-dropin-path"
  touch "$root/delegation-dropin-created"
  sudo systemctl daemon-reload

  sudo systemctl disable --now docker.service docker.socket containerd.service
  if sudo test -S /var/run/docker.sock; then sudo rm /var/run/docker.sock; fi
  sudo loginctl enable-linger "$agent_user"
  touch "$root/agent-linger-enabled"
  sudo systemctl start "user@${agent_uid}.service"
  local agent_runtime="/run/user/${agent_uid}"
  assert_owned_directory "$agent_runtime" "$agent_user" 700
  sudo -u "$agent_user" env XDG_RUNTIME_DIR="$agent_runtime" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=${agent_runtime}/bus" systemctl --user show-environment \
    | grep '^XDG_RUNTIME_DIR=' || printf 'User manager does not export XDG_RUNTIME_DIR; Docker unit drop-in will pin it.\n'
  printf 'User manager sandbox: '
  sudo systemctl show "user@${agent_uid}.service" \
    --property=ProtectHome,ProtectSystem,PrivateUsers,ReadOnlyPaths,ReadWritePaths --value
  sudo -u "$agent_user" env XDG_RUNTIME_DIR="$agent_runtime" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=${agent_runtime}/bus" \
    systemd-run --user --wait --pipe --collect \
      --unit="devspace-runtime-write-check-${run_id}-${run_attempt}" \
      --property="Environment=XDG_RUNTIME_DIR=${agent_runtime}" \
      /bin/sh -ec 'id; printf "XDG_RUNTIME_DIR=%s\\n" "$XDG_RUNTIME_DIR"; stat -c "runtime owner=%u mode=%a" "$XDG_RUNTIME_DIR"; test -w "$XDG_RUNTIME_DIR"; probe="$XDG_RUNTIME_DIR/.devspace-runtime-write-check"; : >"$probe"; rm -f "$probe"'
  local docker_dropin_dir="$agent_home/.config/systemd/user/docker.service.d"
  local docker_dropin="$docker_dropin_dir/devspace-runtime.conf"
  [[ ! -e "$docker_dropin" && ! -L "$docker_dropin" ]] || fail "Docker runtime drop-in already exists"
  sudo -u "$agent_user" install -d -m 0700 "$docker_dropin_dir"
  test "$(sudo -u "$agent_user" stat -c '%U' "$docker_dropin_dir")" = "$agent_user"
  test "$(sudo -u "$agent_user" stat -c '%a' "$docker_dropin_dir")" = 700
  printf '[Service]\nEnvironment=XDG_RUNTIME_DIR=%s\n' "$agent_runtime" \
    | sudo -u "$agent_user" tee "$docker_dropin" >/dev/null
  sudo chmod 0600 "$docker_dropin"
  sudo -u "$agent_user" env -i HOME="$agent_home" PATH=/usr/local/bin:/usr/bin:/bin \
    XDG_RUNTIME_DIR="$agent_runtime" DBUS_SESSION_BUS_ADDRESS="unix:path=${agent_runtime}/bus" \
    /usr/bin/dockerd-rootless-setuptool.sh check
  sudo -u "$agent_user" env -i HOME="$agent_home" PATH=/usr/local/bin:/usr/bin:/bin \
    XDG_RUNTIME_DIR="$agent_runtime" DBUS_SESSION_BUS_ADDRESS="unix:path=${agent_runtime}/bus" \
    /usr/bin/dockerd-rootless-setuptool.sh install
  sudo -u "$agent_user" env -i HOME="$agent_home" PATH=/usr/local/bin:/usr/bin:/bin \
    XDG_RUNTIME_DIR="$agent_runtime" DBUS_SESSION_BUS_ADDRESS="unix:path=${agent_runtime}/bus" \
    systemctl --user enable --now docker.service
  sudo -u "$agent_user" env XDG_RUNTIME_DIR="$agent_runtime" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=${agent_runtime}/bus" systemctl --user show docker.service \
    --property=Environment --value

  local docker_socket="${agent_runtime}/docker.sock"
  for attempt in $(seq 1 60); do
    if sudo -u "$agent_user" env DOCKER_HOST="unix://${docker_socket}" docker info >/dev/null 2>&1; then break; fi
    sleep 1
  done
  [[ -S "$docker_socket" ]] || fail "rootless Docker did not create its socket"
  local socket_uid socket_gid socket_mode runtime_uid runtime_mode security_options
  socket_uid="$(stat -c '%u' "$docker_socket")"
  socket_gid="$(stat -c '%g' "$docker_socket")"
  socket_mode="$(stat -c '%a' "$docker_socket")"
  runtime_uid="$(stat -c '%u' "$agent_runtime")"
  runtime_mode="$(stat -c '%a' "$agent_runtime")"
  printf 'Rootless Docker socket: %s owner=%s group=%s mode=%s\n' "$docker_socket" "$socket_uid" "$socket_gid" "$socket_mode"
  printf 'Rootless Docker socket parent: %s owner=%s mode=%s\n' "$agent_runtime" "$runtime_uid" "$runtime_mode"
  [[ "$socket_uid" = "$agent_uid" && "$socket_gid" = "$agent_gid" ]] || fail "rootless socket has unexpected ownership"
  [[ "$socket_mode" = 600 || "$socket_mode" = 660 ]] || fail "rootless socket mode is not 0600 or 0660"
  [[ "$runtime_uid" = "$agent_uid" && "$runtime_mode" = 700 ]] || fail "rootless socket parent is not private to the Agent"
  security_options="$(sudo -u "$agent_user" env DOCKER_HOST="unix://${docker_socket}" docker info --format '{{json .SecurityOptions}}')"
  grep -q 'name=rootless' <<<"$security_options" || fail "Docker did not report rootless mode"
  if sudo -u "$web_user" curl --silent --max-time 2 --unix-socket "$docker_socket" http://localhost/_ping >/dev/null 2>&1; then
    fail "Web account unexpectedly reached the rootless Docker socket through its private parent"
  fi
  printf 'PASS: Web account cannot reach the private rootless Docker socket\n'

  touch "$root/install-root-created"
  sudo install -d -o "$(id -u)" -g "$(id -g)" -m 0755 "$install_root"
  git clone --no-checkout https://github.com/Benflex1/DevSpace.git "$install_root"
  git -C "$install_root" checkout --detach "$ref"
  [[ "$(git -C "$install_root" rev-parse HEAD)" = "$ref" ]] || fail "checkout did not match requested commit"
  cd "$install_root"
  pnpm install --frozen-lockfile
  pnpm build
  sudo chgrp -R devspace-code "$install_root"
  sudo chmod -R g+rX "$install_root"

  touch "$root/etc-devspace-created"
  sudo install -d -o root -g root -m 0755 /etc/devspace
  sudo install -d -o "$(id -u)" -g "$(getent group devspace-code | cut -d: -f3)" -m 0755 "$install_root/.acceptance"
  install -d -m 0700 "$root/fixtures"
  nohup /usr/local/bin/node "$install_root/tooling/acceptance/installation-fixture-server.mjs" \
    "$root/fixtures" "$root/fixtures.ready" >"$root/fixtures.log" 2>&1 </dev/null &
  local fixture_pid=$!
  printf '%s\n' "$fixture_pid" >"$root/fixtures.pid"
  for attempt in $(seq 1 45); do
    [[ -f "$root/fixtures.ready" ]] && break
    kill -0 "$fixture_pid" 2>/dev/null || { cat "$root/fixtures.log" >&2; fail "local HTTPS fixture server exited"; }
    sleep 1
  done
  [[ -f "$root/fixtures.ready" ]] || fail "local HTTPS fixture server did not become ready"
  sudo install -o root -g root -m 0644 "$root/fixtures/tls-cert.pem" "$test_ca"

  sed "s/@AGENT_UID@/${agent_uid}/g" "$install_root/deploy/ubuntu/agent.env.example" >"$root/agent.env"
  printf 'DEVSPACE_GIT_CA_FILE=%s\n' "$test_ca" >>"$root/agent.env"
  sudo install -o root -g devspace-agent -m 0640 "$root/agent.env" "$agent_env"
  sed -e 's|https://devspace.example.com|https://127.0.0.1:3444|g' \
      -e 's|https://team-name.cloudflareaccess.com|https://127.0.0.1:3443|g' \
      -e 's|replace-with-access-application-aud-tag|devspace-installation-acceptance|g' \
      "$install_root/deploy/ubuntu/web.env.example" >"$root/web.env"
  printf 'NODE_EXTRA_CA_CERTS=%s\n' "$test_ca" >>"$root/web.env"
  sudo install -o root -g devspace-web -m 0640 "$root/web.env" "$web_env"

  touch "$root/devspace-units-created"
  sudo install -m 0644 "$install_root/deploy/ubuntu/devspace-agent.service" /etc/systemd/system/devspace-agent.service
  sudo install -m 0644 "$install_root/deploy/ubuntu/devspace-web.service" /etc/systemd/system/devspace-web.service
  sudo systemctl daemon-reload
  sudo systemctl enable --now devspace-agent.service
  sudo systemctl enable --now devspace-web.service

  sudo -u "$agent_user" env -i HOME="$agent_home" PATH=/usr/local/bin:/usr/bin:/bin \
    /usr/local/bin/node --env-file="$agent_env" "$install_root/tooling/install-preflight.mjs" agent
  sudo -u "$web_user" env -i HOME="$web_home" PATH=/usr/local/bin:/usr/bin:/bin \
    /usr/local/bin/node --env-file="$web_env" "$install_root/tooling/install-preflight.mjs" web
  sudo -u "$agent_user" env XDG_RUNTIME_DIR="$agent_runtime" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=${agent_runtime}/bus" systemctl --user --no-pager --full status docker.service
  sudo systemctl --no-pager --full status devspace-agent.service devspace-web.service

  local http_status=
  for attempt in $(seq 1 90); do
    http_status="$(curl --silent --output /dev/null --write-out '%{http_code}' http://127.0.0.1:3000/api/projects || true)"
    [[ "$http_status" = 403 ]] && break
    sleep 1
  done
  [[ "$http_status" = 403 ]] || fail "production Web did not reject unauthenticated API access (status $http_status)"
  printf 'PASS: production Web rejected unauthenticated access with HTTP %s\n' "$http_status"

  sudo systemctl restart devspace-agent.service
  for attempt in $(seq 1 30); do
    if curl --silent --fail --unix-socket "$agent_socket" http://localhost/v1/health >/dev/null; then break; fi
    sleep 1
  done
  curl --silent --fail --unix-socket "$agent_socket" http://localhost/v1/health
  sudo systemctl restart devspace-web.service
  for attempt in $(seq 1 90); do
    http_status="$(curl --silent --output /dev/null --write-out '%{http_code}' http://127.0.0.1:3000/api/projects || true)"
    [[ "$http_status" = 403 ]] && break
    sleep 1
  done
  [[ "$http_status" = 403 ]] || fail "Web service did not return after restart"
  printf 'PASS: Web and Agent services restarted; unauthenticated access remains rejected\n'
}

verify_workspace() {
  [[ -f "$root/root-marker" && "$(cat "$root/root-marker")" = "$root" ]] || fail "acceptance root marker is absent"
  local result_file="$root/acceptance-result.json"
  [[ -f "$result_file" && ! -L "$result_file" ]] || fail "browser acceptance result is missing"
  local workspace_id project_id expected_workspace_path agent_runtime docker_socket container_id container_mount
  project_id="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).projectId)' "$result_file")"
  workspace_id="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).workspaceId)' "$result_file")"
  [[ "$project_id" =~ ^[0-9a-f-]{36}$ && "$workspace_id" =~ ^[0-9a-f-]{36}$ ]] || fail "browser acceptance returned invalid IDs"
  agent_uid="$(id -u "$agent_user")"
  agent_gid="$(id -g "$agent_user")"
  agent_runtime="/run/user/${agent_uid}"
  docker_socket="${agent_runtime}/docker.sock"
  expected_workspace_path="$managed_root/workspaces/${workspace_id}/source"
  sudo -u "$agent_user" test -d "$expected_workspace_path" || fail "workspace bind source is absent from Agent's host filesystem"
  sudo -u "$agent_user" test -f "$expected_workspace_path/install-acceptance.txt" || fail "workspace file did not persist after Stop/Start"
  [[ "$(sudo -u "$agent_user" cat "$expected_workspace_path/install-acceptance.txt")" = "fresh-host-persistence-ok" ]] \
    || fail "workspace persistence file content changed"

  local found=false
  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] || continue
    container_mount="$(sudo -u "$agent_user" env DOCKER_HOST="unix://${docker_socket}" docker inspect \
      --format '{{range .Mounts}}{{if eq .Destination "/workspace"}}{{.Source}}{{end}}{{end}}' "$candidate" 2>/dev/null || true)"
    if [[ "$container_mount" = "$expected_workspace_path" ]]; then
      container_id="$candidate"
      found=true
      break
    fi
  done < <(sudo -u "$agent_user" env DOCKER_HOST="unix://${docker_socket}" docker ps -aq)
  [[ "$found" = true ]] || fail "rootless Docker did not retain the exact Agent host workspace bind path"
  printf 'PASS: container %s binds host workspace path %s at /workspace\n' "$container_id" "$expected_workspace_path"

  local socket_mode socket_uid socket_gid runtime_mode runtime_uid web_db
  socket_mode="$(stat -c '%a' "$docker_socket")"
  socket_uid="$(stat -c '%u' "$docker_socket")"
  socket_gid="$(stat -c '%g' "$docker_socket")"
  runtime_mode="$(stat -c '%a' "$agent_runtime")"
  runtime_uid="$(stat -c '%u' "$agent_runtime")"
  [[ "$socket_uid" = "$agent_uid" && "$socket_gid" = "$agent_gid" ]] || fail "rootless socket ownership changed"
  [[ "$socket_mode" = 600 || "$socket_mode" = 660 ]] || fail "rootless socket permissions are not owner-only or owner-group"
  [[ "$runtime_uid" = "$agent_uid" && "$runtime_mode" = 700 ]] || fail "rootless runtime directory is not private to Agent"
  web_db="$web_home/devspace.sqlite"
  [[ -f "$web_db" && "$(stat -c '%U' "$web_db")" = "$web_user" ]] || fail "Web database did not persist with Web ownership"
  [[ "$(stat -c '%a' "$web_db")" = 600 ]] || fail "Web database permissions changed across restarts"
  assert_owned_directory "$agent_home" "$agent_user" 700
  assert_owned_directory "$managed_root" "$agent_user" 700
  assert_owned_directory "$managed_root/projects" "$agent_user" 700
  assert_owned_directory "$managed_root/workspaces" "$agent_user" 700
  assert_owned_directory "$managed_root/state" "$agent_user" 700
  assert_owned_directory "$web_home" "$web_user" 700
  printf 'PASS: persistent Web and Agent state ownership and modes remain private\n'
  printf 'Acceptance IDs: project=%s workspace=%s\n' "$project_id" "$workspace_id"
}

cleanup_host() {
  if [[ ! -f "$root/root-marker" || "$(cat "$root/root-marker")" != "$root" ]]; then
    printf 'No owned installation acceptance root; cleanup skipped.\n'
    return
  fi
  if [[ -f "$root/devspace-units-created" ]]; then sudo systemctl stop devspace-web.service devspace-agent.service >/dev/null 2>&1 || true; fi
  if getent passwd "$agent_user" >/dev/null; then
    agent_uid="$(id -u "$agent_user")"
    agent_runtime="/run/user/${agent_uid}"
    sudo -u "$agent_user" env XDG_RUNTIME_DIR="$agent_runtime" \
      DBUS_SESSION_BUS_ADDRESS="unix:path=${agent_runtime}/bus" systemctl --user stop docker.service >/dev/null 2>&1 || true
    if [[ -f "$root/agent-linger-enabled" ]]; then sudo loginctl disable-linger "$agent_user" >/dev/null 2>&1 || true; fi
    sudo systemctl stop "user@${agent_uid}.service" >/dev/null 2>&1 || true
  fi
  if [[ -f "$root/fixtures.pid" ]]; then
    fixture_pid="$(cat "$root/fixtures.pid")"
    if [[ "$fixture_pid" =~ ^[0-9]+$ ]] && kill -0 "$fixture_pid" 2>/dev/null \
      && tr '\0' ' ' </proc/"$fixture_pid"/cmdline | grep -Fq "$install_root/tooling/acceptance/installation-fixture-server.mjs"; then
      kill -TERM "$fixture_pid" 2>/dev/null || true
    fi
  fi
  if [[ -f "$root/devspace-units-created" ]]; then
    sudo systemctl disable devspace-web.service devspace-agent.service >/dev/null 2>&1 || true
    sudo rm -f /etc/systemd/system/devspace-web.service /etc/systemd/system/devspace-agent.service
  fi
  sudo rm -f "$agent_env" "$web_env" "$test_ca"
  if [[ -f "$root/etc-devspace-created" ]]; then sudo rmdir /etc/devspace 2>/dev/null || true; fi
  sudo systemctl daemon-reload

  if [[ -f "$root/delegation-dropin-created" && -f "$root/delegation-dropin-path" ]]; then
    dropin="$(cat "$root/delegation-dropin-path")"
    expected_agent_uid="$(cat "$root/agent-uid")"
    [[ "$expected_agent_uid" =~ ^[0-9]+$ \
      && "$dropin" = "/etc/systemd/system/user@${expected_agent_uid}.service.d/devspace-install-acceptance-${run_id}-${run_attempt}.conf" ]] \
      || fail "refusing to remove an unexpected user-manager delegation drop-in"
    sudo rm -f -- "$dropin"
    sudo systemctl daemon-reload
  fi
  if [[ -f "$root/delegation-directory-created" && -f "$root/agent-uid" ]]; then
    expected_agent_uid="$(cat "$root/agent-uid")"
    if [[ "$expected_agent_uid" =~ ^[0-9]+$ ]]; then
      sudo rmdir "/etc/systemd/system/user@${expected_agent_uid}.service.d" 2>/dev/null || true
    fi
  fi
  if getent passwd "$agent_user" >/dev/null; then sudo userdel --remove "$agent_user" >/dev/null 2>&1 || true; fi
  if getent passwd "$web_user" >/dev/null; then sudo userdel --remove "$web_user" >/dev/null 2>&1 || true; fi
  for group in devspace-code devspace-web devspace-agent; do sudo groupdel "$group" >/dev/null 2>&1 || true; done
  if [[ -f "$root/install-root-created" && -d "$install_root" && ! -L "$install_root" \
    && "$(realpath -e "$install_root")" = "$install_root" ]]; then
    sudo rm -rf --one-file-system -- "$install_root"
  fi
  if [[ -f "$root/node-install-created" ]]; then
    if [[ -x /opt/node-v24.18.0/bin/npm ]]; then
      sudo /opt/node-v24.18.0/bin/npm uninstall --global --prefix /usr/local pnpm >/dev/null 2>&1 || true
    fi
    sudo rm -rf --one-file-system -- /opt/node-v24.18.0
  fi
  for executable in node npm npx pnpm; do
    executable_path="/usr/local/bin/$executable"
    [[ -f "$root/original-bin-$executable.state" ]] || continue
    sudo rm -f -- "$executable_path"
    if [[ "$(cat "$root/original-bin-$executable.state")" = present ]]; then
      sudo cp -a "$root/original-bin-$executable" "$executable_path"
    fi
  done
  if [[ -f "$root/original-pnpm-global.state" ]]; then
    sudo rm -rf -- /usr/local/lib/node_modules/pnpm
    sudo cp -a "$root/original-pnpm-global" /usr/local/lib/node_modules/pnpm
  fi
  if [[ -f "$root/docker-source-created" ]]; then sudo rm -f /etc/apt/sources.list.d/devspace-install-acceptance.sources; fi
  if [[ -f "$root/docker-key-created" ]]; then sudo rm -f /etc/apt/keyrings/devspace-install-acceptance.asc; fi
  sudo systemctl daemon-reload

  if [[ -f "$root/rootful-state-saved" ]]; then
    while read -r unit active enabled; do
      [[ -n "$unit" ]] || continue
      if [[ "$enabled" = enabled ]]; then sudo systemctl enable "$unit" >/dev/null 2>&1 || true
      elif [[ "$enabled" = disabled ]]; then sudo systemctl disable "$unit" >/dev/null 2>&1 || true
      fi
      if [[ "$active" = active ]]; then sudo systemctl start "$unit" >/dev/null 2>&1 || true
      elif [[ "$active" = inactive || "$active" = failed ]]; then sudo systemctl stop "$unit" >/dev/null 2>&1 || true
      fi
    done <"$root/rootful-unit-state"
  fi
  sudo apt-get update >/dev/null 2>&1 || true
  [[ "$(realpath -e "$root")" = "$runner_temp/devspace-install-acceptance-$run_id-$run_attempt" ]] || fail "temporary acceptance root changed"
  sudo rm -rf --one-file-system -- "$root"
  printf 'Installation acceptance services and fixture resources cleaned up.\n'
}

case "$mode" in
  prepare) prepare_host "$@" ;;
  verify) verify_workspace ;;
  cleanup) cleanup_host ;;
  *) fail "Usage: ubuntu-installation-acceptance.sh <prepare|verify|cleanup> [commit-sha]" ;;
esac

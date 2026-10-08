#!/usr/bin/env bash
set -euo pipefail
runner_temp="$(realpath -e "$RUNNER_TEMP")"
root="$runner_temp/devspace-rootless-git-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
runtime="$root/runtime"
data="$root/data"
exec_root="$root/exec"
socket="$runtime/docker.sock"
install -d -m 0700 "$runtime" "$data" "$exec_root"
case "$runtime" in /tmp|/tmp/*) echo "XDG_RUNTIME_DIR must not be under /tmp" >&2; exit 1 ;; esac
user_runtime="/run/user/$(id -u)"
export XDG_RUNTIME_DIR="$user_runtime"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$user_runtime/bus"
for attempt in $(seq 1 30); do
  if [[ -S "$user_runtime/bus" ]] && systemctl --user show-environment >/dev/null 2>&1; then break; fi
  sleep 1
done
if [[ ! -S "$user_runtime/bus" ]] || ! systemctl --user show-environment >/dev/null 2>&1; then
  echo "The hosted VM did not provide a usable rootless systemd user bus" >&2
  exit 1
fi
if ! systemctl --user is-active --quiet dbus; then
  systemctl --user start dbus
  touch "$root/dbus-started"
fi
cgroup_controllers="/sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/cgroup.controllers"
test -r "$cgroup_controllers"
available_controllers="$(cat "$cgroup_controllers")"
for controller in cpu cpuset io memory pids; do
  if ! grep -qw "$controller" <<<"$available_controllers"; then
    echo "Rootless systemd user scope lacks delegated $controller controller: $available_controllers" >&2
    exit 1
  fi
done
export XDG_RUNTIME_DIR="$runtime"
rootless_script="$(command -v dockerd-rootless.sh)"
rootless_bin="$(dirname "$rootless_script")"
daemon_pid="$(python3 - "$root" "$runtime" "$socket" "$data" "$exec_root" "$rootless_script" "$rootless_bin" <<'PY'
import os, sys
root, runtime, socket, data, exec_root, script, binary_dir = sys.argv[1:]
pid = os.fork()
if pid == 0:
    os.setsid()
    log = os.open(os.path.join(root, 'daemon.log'), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    null = os.open('/dev/null', os.O_RDONLY)
    os.dup2(null, 0)
    os.dup2(log, 1)
    os.dup2(log, 2)
    os.close(null)
    os.close(log)
    env = dict(os.environ, XDG_RUNTIME_DIR=runtime,
               DBUS_SESSION_BUS_ADDRESS=os.environ['DBUS_SESSION_BUS_ADDRESS'],
               PATH=binary_dir + os.pathsep + os.environ['PATH'],
               DOCKERD_ROOTLESS_ROOTLESSKIT_NET='slirp4netns')
    argv = [script, '--host=unix://' + socket, '--data-root=' + data,
            '--exec-root=' + exec_root, '--pidfile=' + runtime + '/dockerd.pid',
            '--max-concurrent-downloads=2']
    os.execve(script, argv, env)
print(pid)
PY
)"
printf '%s\n' "$daemon_pid" >"$root/daemon-session.pid"
for attempt in $(seq 1 90); do
  if ! kill -0 "$daemon_pid" 2>/dev/null; then
    cat "$root/daemon.log" >&2
    echo "Rootless daemon launcher exited before creating its socket" >&2
    exit 1
  fi
  process_state="$(ps -o pgid=,sid= -p "$daemon_pid" | xargs || true)"
  if [[ "$process_state" != "$daemon_pid $daemon_pid" ]]; then
    echo "Rootless daemon did not start in its own process group/session: $process_state" >&2
    exit 1
  fi
  if [[ -S "$socket" ]] && env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
    DOCKER_CONFIG="$root/docker-config" docker --host="unix://$socket" info >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
if [[ ! -S "$socket" ]]; then
  cat "$root/daemon.log" >&2
  echo "The dedicated rootless Docker socket was not created" >&2
  exit 1
fi
test -f "$runtime/dockerd.pid"
test ! -L "$runtime/dockerd.pid"
test "$(stat -c '%u' "$socket")" = "$(id -u)"
security_options="$(env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
  DOCKER_CONFIG="$root/docker-config" docker --host="unix://$socket" info --format '{{json .SecurityOptions}}')"
printf '%s\n' "$security_options" | node --input-type=module -e '
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const options = JSON.parse(input);
  if (!Array.isArray(options) || !options.some((option) => option.includes("name=rootless"))) {
    throw new Error(`Docker did not report rootless mode: ${input.trim()}`);
  }
'
actual_data_root="$(env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
  DOCKER_CONFIG="$root/docker-config" docker --host="unix://$socket" info --format '{{.DockerRootDir}}')"
if [[ "$(realpath -m "$actual_data_root")" != "$(realpath -m "$data")" ]]; then
  echo "Docker data root is outside the disposable test root: $actual_data_root" >&2
  exit 1
fi
cgroup_driver="$(env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
  DOCKER_CONFIG="$root/docker-config" docker --host="unix://$socket" info --format '{{.CgroupDriver}}')"
cgroup_version="$(env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
  DOCKER_CONFIG="$root/docker-config" docker --host="unix://$socket" info --format '{{.CgroupVersion}}')"
if [[ "$cgroup_driver" != systemd || "$cgroup_version" != 2 ]]; then
  echo "Rootless resource limits require systemd with cgroup v2; got $cgroup_driver / v$cgroup_version" >&2
  exit 1
fi
printf 'socket=%s\ndata-root=%s\nsecurity-options=%s\ncgroup-driver=%s\ncgroup-version=%s\n' \
  "$socket" "$actual_data_root" "$security_options" "$cgroup_driver" "$cgroup_version"
printf 'DEVSPACE_TEST_DOCKER_SOCKET_PATH=%s\n' "$socket" >>"$GITHUB_ENV"

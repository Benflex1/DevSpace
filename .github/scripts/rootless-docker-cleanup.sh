#!/usr/bin/env bash
runner_temp="$(realpath -e "$RUNNER_TEMP")"
root="$runner_temp/devspace-rootless-git-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
if [[ ! -d "$root" || -L "$root" ]]; then
  echo "Disposable daemon root is absent or is a symlink; nothing to remove."
  exit 0
fi
if [[ "$(stat -c '%u' "$root")" != "$(id -u)" ]]; then
  echo "Refusing to clean a test root owned by another user: $root" >&2
  exit 1
fi
pid_file="$root/daemon-session.pid"
if [[ -f "$pid_file" ]]; then
  daemon_pid="$(cat "$pid_file")"
  if [[ "$daemon_pid" =~ ^[0-9]+$ ]] && kill -0 "$daemon_pid" 2>/dev/null; then
    session="$(ps -o pgid=,sid= -p "$daemon_pid" | xargs || true)"
    if [[ "$session" != "$daemon_pid $daemon_pid" ]]; then
      echo "Refusing to signal a process outside the recorded daemon session: $session" >&2
      exit 1
    fi
    /bin/kill -TERM -- "-$daemon_pid"
    for attempt in $(seq 1 20); do
      if ! kill -0 -- "-$daemon_pid" 2>/dev/null; then break; fi
      sleep 1
    done
    if kill -0 -- "-$daemon_pid" 2>/dev/null; then
      /bin/kill -KILL -- "-$daemon_pid"
    fi
  fi
fi
expected_prefix="$runner_temp/devspace-rootless-git-"
case "$root" in "$expected_prefix"*) ;; *) echo "Unsafe cleanup path: $root" >&2; exit 1 ;; esac
if [[ "$(realpath -e "$root")" != "$root" ]]; then
  echo "Refusing to remove a non-canonical test root: $root" >&2
  exit 1
fi
if [[ -f "$root/apt-source-created" ]]; then
  sudo rm -f -- /etc/apt/sources.list.d/devspace-rootless-ci.list
fi
if [[ -f "$root/apt-key-created" ]]; then
  sudo rm -f -- /etc/apt/keyrings/devspace-rootless-ci.asc
fi
if [[ -f "$root/dbus-started" ]]; then
  user_runtime="/run/user/$(id -u)"
  XDG_RUNTIME_DIR="$user_runtime" DBUS_SESSION_BUS_ADDRESS="unix:path=$user_runtime/bus" \
    systemctl --user stop dbus || true
fi
if [[ -f "$root/systemd-delegate-created" ]]; then
  sudo rm -f -- "/etc/systemd/system/user@.service.d/devspace-rootless-ci-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT.conf"
  sudo systemctl daemon-reload
fi
if [[ -f "$root/linger-enabled" ]]; then sudo loginctl disable-linger "$USER"; fi
# Rootless overlay layers contain host files owned by the configured subordinate IDs.
# The daemon is stopped and the exact private root was verified above, so remove only
# this test-owned tree as root to clean those shifted-UID files as well.
sudo rm -rf --one-file-system -- "$root"

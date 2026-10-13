# Persistent terminal feasibility — 2026-10-13

Recommendation: [ADR 017](../decisions/017-persistent-workspace-terminals.md), tmux native
attachment inside the exact workspace container. The bounded rootless-Docker feasibility gate
passed on the two target Debian images. Full DevSpace Agent/Web restart and Native Codex acceptance
remain outstanding. No product code or provider requests were run.

## Current loss points at f38a832

| Component | What survives and what is lost |
| --- | --- |
| `execution-manager.ts`: `LiveExecution`, `attachStream` | JSON retains execution/container/exec/Native identity. `stream`, attachment reservation/socket, replay and expiry timers exist only in memory. The output tail is capped at 64 KiB, not a terminal screen model. |
| `ExecutionManager.shutdownTransports`, `initialize` | Shutdown destroys the Docker stream. Startup reconstructs `stream: null` and empty replay, then marks ordinary terminals lost. |
| `reconcileRecoveredHarness`, `reconcileHarnessAdmission` | A running exact exec without its original stream remains a running orphan with lost terminal. Startup polls that exec; it cannot reconstruct the attachment. |
| `docker-runtime.ts`: `createExec`, `startExecAttached`, `inspectExec`, `resizeExec` | Structured argv and a hijacked TTY stream exist already. Inspection preserves process evidence, not terminal screen/output or a reusable exec attachment. Fresh exec can run a tmux client instead. |
| `harness-runtime.ts`: `recoverAfterAgentRestart`; `harness-home.ts` | Private process/session generation, lease and dirty-slot identity survive. Recovery marks the session lost and retains its home while the exact process is running/unproven. Settlement only follows exact exit or owning-container stop. |
| `terminal-relay.ts`, `terminal-tab.tsx` | Web relays only through the Agent socket; browser/Web loss closes the attachment. Agent normally keeps the child stream alive. Reload disposes xterm, losing its screen/history; reconnect appends the raw tail to an existing xterm, potentially duplicating output. Resize deduplication also spans reconnects. |
| `contracts/terminal.ts`; Web `database.ts` | v1 carries ready/output/exit and input/resize/detach with one attachment. No attachment epoch or screen-reset contract. Web projects Agent lost/closed states into Native rows, refuses to revive terminalized rows, and prunes lost terminals after 30 seconds. |

Reviewed ADRs 002, 003, 005, 006, 009, 016 and the Native harness/Agent API specifications.
ADR 006 currently means independent workspace Git metadata, not a shared Git store mount.

## Probe and observed results

Executor: UID 1000; Python 3.12; local tmux 3.4. No `docker` binary, `dockerd` process,
`/var/run/docker.sock` or `/run/user/1000/docker.sock`; no managed-environment status tool was
exposed. The cloud network-policy file was also absent. No production or remote daemon was used.
The requested fresh **Docker exec** and container Stop probes therefore could not run.

A throwaway Python PTY driver used a private socket/config, detached `/bin/sh -i`, native tmux
attach clients on fresh PTYs, and a real `top -d 1` TUI. It sent shell input, generated 150 history
lines, detached normally, killed another client with SIGKILL, and reattached. It queried exact
pane IDs, cursor, geometry, history and dead-pane exit evidence. It also resized the outer PTY
with `TIOCSWINSZ` and SIGWINCH. Temporary driver/results stayed outside the repository.

| Check | Actual local result |
| --- | --- |
| Process continuity | Shell PID 1492830 before/after normal detach and abrupt client loss; its background `sleep 600` remained alive. |
| Screen/cursor | Fresh client emitted 740 bytes including ANSI redraw and the prompt marker. Tmux cursor stayed `(15,23)` at 80×24 through detach/reattach. Browser pixel/cursor-style fidelity was not tested. |
| Resize/input | Pane became 100×32, shell `stty size` returned `32 100`, and subsequent input printed `INPUT_OK`. |
| History | Numbered lines from the beginning were still captured; copy mode reported `1\|copy-mode`. History size changed 132→126 on resize/reflow, as expected for physical lines. |
| Interactive TUI | `top` PID 1492881 stayed the same and its screen redrew after SIGKILL of the client. Sending `q` left the retained pane dead with status 0. No Codex/provider request was needed. |
| Fast exit | A command printed `FAST_EXIT` and exited 7; retained pane preserved both output and `pane_dead_status=7`. |
| Explicit shell close | Killing its tmux session did not immediately remove the background sleep PID. Session death is not proof of descendant quiescence; the driver explicitly terminated its own child. |
| Docker reattachment / container Stop | Passed in the bounded rootless-Docker gate for `node:24-bookworm` and `node:24-bookworm-slim`; see the recorded run evidence below. |

## Real rootless-Docker feasibility results

[Hosted run 38428192241](https://github.com/Benflex1/DevSpace/actions/runs/38428192241) reported all
four tests in the probe file as passed, including both real Docker cases. Its post-test workflow
guard incorrectly expected two total tests and marked the step failed; that guard is corrected in
this PR. The Docker assertions themselves passed.

| Image | Container ID | User | Session / pane | Stable shell PID | Test duration |
| --- | --- | --- | --- | --- | --- |
| `node:24-bookworm` | `8c0a0e24626acc2ee4afb76fee09f40837d25d4e915a02ec01ff431f1ae482d5` | `1000:1000` | `$0` / `%0` | `104` | 12.2 s |
| `node:24-bookworm-slim` | `4105a32b5e1a57b523ecec7d07a52e169e1dddd5c0e799aa86496b1ff334a314` | `1000:1000` | `$0` / `%0` | `107` | 15.7 s |

The first/second attachment exec IDs were `14fdec3ae73b2c75d01dbf644b24d2c6b09a7d78ffde44fee309fe361b8fa14d` /
`7fed4f1b49364c2755e9c8db1e201b0ab6436a6a6d10324d8d8688b21385cfaa` for bookworm, and
`15995cc0dba7db4df238d77a6c3bbda17b5071fa1f7aeb2037e87c36db9e69ed` /
`2f24e6b9ace4923e272bc9de76c9024261c1e9ccc908d47a4adfa4bdb5c949ca` for bookworm-slim.

Both cases created tmux sessions inside their respective running containers, terminated the first
Docker exec attachment, and attached through a distinct exec ID. The shell PID remained unchanged.
The second attachment redrew `DEVSPACE_SCREEN_MARKER`, accepted input and printed
`REATTACHED_INPUT_OK`. Resizing changed the pane from 80×24 to 100×32, and the shell reported
`stty size` as `32 100`. Tmux retained and recaptured all 100 generated history lines after
reattachment. Container Stop ended the attachment, inspection reported the container stopped, and
a later exec was rejected with Docker status 409. Stop took 10.065 s for bookworm and 10.060 s for
slim.

This proves tmux persistence across disposable Docker exec clients in these two rootless test
containers. The probe does not restart DevSpace Agent or Web and does not exercise browser reload
or the browser History UI. Native Codex process survival, lease continuity and recovery remain
unverified.

Initial driver attempts used a session-only selector for pane commands; explicit
`=session:0.0` fixed targeting. A malformed empty exit-message config obscured the shell until
corrected. The default dead-pane banner replaced a short final line; setting
`remain-on-exit-format ""` preserved it. These findings inform the controlled config.

## Providing tmux without changing images' mounts

Upstream [installation guidance](https://github.com/tmux/tmux/wiki/Installing) offers static
builds. Downloaded the official `tmux/tmux-builds` Linux x86_64 **v3.7c** archive; it contains one
`tmux` executable. `-V` returned 3.7c and `ldd` reported “not a dynamic executable”. The same local
probe passed with the absolute artifact path for both server and clients (shell PID 1493733;
`top` PID 1493777). Accidentally mixing system 3.4 clients with the 3.7c server failed attachment;
version consistency is required.

Archive SHA-256: `cc56bd1cc873eb6089c615f0496b072385bda8a6d944069f38564a5d49c128aa`.
Binary SHA-256: `7d0f1e85c5b11df7fe127ab90674c6a15663ad72a25fcf7fabadba6bbb0b29d5`.
These identify the observed artifact, not an implemented release supply chain.

The executor already supplied both terminfo entries. The rootless-Docker gate verified the
staged static tmux binary and terminfo in both target images, plus UID/GID 1000 ownership and
permissions for the artifact directory and tmux socket. It also verified the tmux argv launcher.
Static delivery avoids assuming image libevent/ncurses libraries exist. Debian also
[publishes tmux packages](https://packages.debian.org/bookworm/tmux), but in-place package setup
is not currently a supported DevSpace runtime operation. The gate exercised `node:24-bookworm`
and `node:24-bookworm-slim` as UID/GID 1000 without changing production mount topology. Additional
image families are capabilities to validate, not assumed support.

## Architectural feasibility and comparison

The [Docker Engine v1.47 schema](https://raw.githubusercontent.com/docker/docs/main/_vendor/github.com/moby/moby/api/docs/v1.47.yaml)
and current adapter support the needed exec/create/start/resize/inspect and archive operations.
The rootless-Docker gate confirmed a fresh structured exec can attach a tmux client to its
in-container Unix socket while the tmux-owned shell survives loss of the previous client. The
outer Docker PTY is disposable; this requires no new network endpoint or arbitrary shell request.

[tmux native attachment](https://github.com/tmux/tmux/wiki/Getting-Started) supplies screen redraw
and persistent pane history; [copy mode](https://man.openbsd.org/tmux.1) makes that history usable
without injecting an independently captured snapshot ahead of live bytes. Plain attach does
**not** refill xterm scrollback. A custom daemon would need a PTY supervisor, terminal emulator,
snapshot ordering and its own recovery protocol; the evidence does not justify that cost.

Inspected MIT-licensed `pingdotgg/t3code` at
[`6524a8d`](https://github.com/pingdotgg/t3code/tree/6524a8d43795dc543f7cfb572388cdea3662ad48):
[`Manager.ts`](https://github.com/pingdotgg/t3code/blob/6524a8d43795dc543f7cfb572388cdea3662ad48/apps/server/src/terminal/Manager.ts)
uses bounded history persistence and snapshot-before-live attachment buffering;
[`NodePtyAdapter.ts`](https://github.com/pingdotgg/t3code/blob/6524a8d43795dc543f7cfb572388cdea3662ad48/apps/server/src/terminal/NodePtyAdapter.ts)
uses server-owned node-pty processes. The inspected path starts a shell when its in-memory
session is absent; persisted history alone does not establish live-process survival. Its
browser recovery ideas are useful, but moving host PTYs into DevSpace would cross the existing
execution boundary. No upstream code was copied.

Stop the spike here. Remaining acceptance is full DevSpace Agent/Web restart and browser reload,
browser History usability, and Native Codex compatibility/lease continuity. Container Stop
stopped the probe containers, ended their attachments and prevented later exec creation; it
deliberately ends persistence. Only observed Stop/absence may authorize recovery writeback when
pane liveness is unproven.

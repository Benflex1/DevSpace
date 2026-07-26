# Lifecycle State Machines

Invalid transitions are rejected by pure domain functions and are never implemented as unconstrained string updates. Desired state records requested end state; observed state records the most recent agent observation. Updating desired state does not imply that observed state has already changed.

The graphs below are the complete Milestone 0 transition sets. A recovery observation uses an explicit listed edge; implementations must not infer additional edges from similarly named database values.

## Project

```text
registering -> ready
registering -> invalid
invalid -> registering
ready -> archived
archived -> ready
```

A project can enter `ready` only after the future web-owned creation transaction has installed an active configuration revision and a non-removed primary workspace.

## Configuration revision

```text
draft -> active
draft -> rejected
active -> superseded
```

All three writes needed to activate a draft—superseding the former active revision, activating the draft, and updating the project pointer—belong to one future web-owned transaction.

## Operation

```text
accepted -> running | succeeded | failed | cancelled
running  -> succeeded | failed | cancelled
```

`succeeded`, `failed`, and `cancelled` are terminal. Direct completion from `accepted` covers operations whose work finishes before a running observation is persisted. Cancellation is permitted only for an operation type that declares it; otherwise the transition is rejected.

The web creates and owns the SQLite operation row before sending a mutation, and only the web writes its lifecycle transitions. The agent durably accepts execution in its narrow runtime idempotency journal before beginning side effects; that journal does not own the control-plane lifecycle. After agent restart or loss of history, the web resolves a non-terminal operation from the fresh agent snapshot and the agent journal's replayable result metadata. If the outcome cannot be recovered after the required reconciliation/recovery flow, the web transitions the operation to `failed` with a stable lost-outcome error; v1 does not invent an operation `lost` state.

## Workspace

Desired state:

```text
stopped <-> running
stopped -> archived
archived -> stopped
archived -> removed
```

`removed` is terminal. A running workspace must be requested to stop before archive.

Observed state:

```text
provisioning -> stopped | failed | lost
stopped      -> starting | archived | lost
starting     -> running | degraded | failed | lost
running      -> stopping | degraded | failed | lost
stopping     -> stopped | failed | lost
degraded     -> running | stopping | failed | lost
failed       -> starting | stopping | archived | lost
lost         -> provisioning | stopped | running | degraded | failed | archived | removed
archived     -> provisioning | stopped | removed | lost
```

The broad edges out of `lost` are recovery observations, not user intent: reconciliation must positively rediscover the corresponding condition. It cannot assume `stopped` merely because a resource is missing from one observation. `removed` is terminal.

An isolated workspace cannot be archived or removed while dirty unless the user explicitly chooses a dirty-state handling action.

## Runtime stack

Desired state:

```text
absent <-> stopped <-> running
```

A requested removal goes through desired `stopped` before desired `absent`. Recovery may reassert the existing desired value without treating that as a transition.

Observed state:

```text
absent   -> creating
creating -> stopped | degraded | failed | lost
stopped  -> starting | removing | lost
starting -> running | degraded | failed | lost
running  -> stopping | degraded | failed | lost
stopping -> stopped | degraded | failed | lost
degraded -> starting | running | stopping | removing | failed | lost
failed   -> creating | starting | stopping | removing | lost
removing -> absent | failed | lost
lost     -> absent | creating | stopped | starting | running | stopping | degraded | failed | removing
```

Edges out of `lost` require a fresh positive observation or an explicit recovery/removal operation. `absent` can be concluded only after the agent verifies that no owned runtime resources remain.

## Workspace service

Desired state:

```text
absent <-> stopped <-> running
```

Observed state:

```text
absent   -> creating
creating -> stopped | degraded | failed | lost
stopped  -> starting | removing | lost
starting -> running | degraded | failed | lost
running  -> stopping | degraded | failed | lost
stopping -> stopped | degraded | failed | lost
degraded -> starting | running | stopping | removing | failed | lost
failed   -> creating | starting | stopping | removing | lost
removing -> absent | failed | lost
lost     -> absent | creating | stopped | starting | running | stopping | degraded | failed | removing
```

Service desired and observed state use the same values as runtime stacks because a service is a reconciled child resource. A service may not be observed `running` when its owning stack is confirmed `absent`. Health is a separate observation:

```text
unknown -> starting | healthy | unhealthy
starting -> healthy | unhealthy | unknown
healthy <-> unhealthy
healthy | unhealthy -> unknown
```

Health returns to `unknown` whenever the service is not observed running or the prior observation is no longer trustworthy.

## Process

Desired state:

```text
running <-> stopped
```

Observed state:

```text
queued -> starting -> running
queued -> killed | failed
starting -> stopping | failed | killed | lost
running -> stopping | exited | failed | lost
stopping -> exited | killed | failed | lost
lost -> exited | killed | failed
```

`exited`, `failed`, and `killed` are terminal. An edge out of `lost` records a positively recovered terminal outcome; a process cannot return from `lost` to `running` in v1. M1 does not signal individual task or terminal processes: `process.stop` fails closed with a state conflict, while stopping the whole workspace runtime uses the exact container lifecycle. Exact descendant ownership and individual termination are deferred to M2.

## Terminal

```text
creating -> active
active <-> disconnected
active | disconnected -> closing -> closed
creating | active | disconnected | closing -> failed | lost
```

`closed`, `failed`, and `lost` are terminal. A replacement attachment is a new connection to an `active` or `disconnected` session, not recovery from terminal `lost`.

## Preview

Desired state:

```text
inactive <-> active
```

Observed state:

```text
inactive -> starting -> healthy
starting -> unhealthy | failed | lost
healthy -> unhealthy | stopping | lost
unhealthy -> starting | stopping | failed | lost
stopping -> inactive | failed | lost
failed -> starting | inactive
lost -> starting | inactive
```

Recovery from `lost` requires snapshot/reconciliation confirmation and route recreation. No route may exist in `inactive`, `failed`, or `lost`.

## Dormant database-v1 AI session

The historical `creating | active | waiting_for_input | interrupted | stopped | failed | lost`
vocabulary remains only because the unimplemented database-v1 table has not yet received its
forward migration. It is not the lifecycle authority for AI Session Foundation and F10 no longer
publishes its dormant snapshot/event projection.

## Structured AI session v1

The authoritative complete session, provider-process, turn, and interaction graphs are defined in
`ai-sessions-v1.md` and executable in `@devspace/domain`. They are intentionally separate:

```text
session: creating | ready | running | waiting-for-approval | waiting-for-input |
         interrupting | stopping | stopped | unavailable | lost

provider process: creating | exec-created | identity-confirming | running |
                  stopping | exited | failed | lost

turn: accepted | starting | running | waiting-for-approval | waiting-for-input |
      interrupting | provider-completed | quiesced | completed | interrupted |
      failed | lost

interaction request: pending | responded | cancelled | expired | lost
```

Only one nonterminal turn exists per session. Session waiting states are derived projections of
that turn and its exact pending interaction, not a second independently writable authority.
`provider-completed` is not final. `turn.quiesced` is committed only after all prior canonical
events and interactions are durable, and is the turn's deterministic final receipt.

## Task run

```text
queued -> starting -> running
queued -> cancelled
starting -> failed | cancelled | lost
running -> passed | failed | cancelled | timed_out | lost
```

`passed`, `failed`, `cancelled`, `timed_out`, and `lost` are terminal.

## Lost-state and recovery rule

`lost` means the agent can no longer make a trustworthy observation about a previously known resource. It is not equivalent to stopped, absent, failed, or removed. Entering `lost` requires an observation gap such as agent restart, runtime loss, or identity mismatch. Leaving `lost` is allowed only where a graph explicitly lists a recovery edge and requires a fresh resource snapshot or reconciliation result. Domain functions model these transitions and guards only; Milestone 0 adds no supervisor, timer, or reconciliation implementation.

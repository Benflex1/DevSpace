# Lifecycle State Machines

Invalid transitions are rejected by domain functions and never implemented as unconstrained string updates.

## Project

```text
registering → ready
registering → invalid
invalid → registering
ready → archived
archived → ready
```

## Configuration revision

```text
draft → active
draft → rejected
active → superseded
```

Activating a draft supersedes the former active revision in the same transaction.

## Workspace

Desired state:

```text
stopped ↔ running
stopped → archived
archived → stopped
archived → removed
```

Observed state:

```text
provisioning → stopped | failed
stopped → starting
starting → running | degraded | failed | lost
running → stopping | degraded | failed | lost
stopping → stopped | failed | lost
failed → starting | stopping | archived
lost → stopped | archived
archived → stopped | removed
```

An isolated workspace cannot be archived or removed while dirty unless the user explicitly chooses a dirty-state handling action.

## Runtime stack

```text
absent → creating → stopped
stopped → starting → running
running → stopping → stopped
stopped → removing → absent
creating|starting|running|stopping → degraded|failed|lost
lost → removing|absent
```

## Process

```text
queued → starting → running
running → stopping → exited|killed|failed
starting → failed|lost
running → exited|failed|lost
lost → killed|exited
```

A stop operation verifies container identity and process token before signaling.

## Terminal

```text
creating → active
active ↔ disconnected
active|disconnected → closing → closed
creating|active|disconnected → failed|lost
```

## Preview

```text
inactive → starting → healthy
starting → unhealthy|failed
healthy → unhealthy|stopping|lost
unhealthy → starting|stopping|failed
stopping → inactive|failed|lost
lost → inactive
```

No route may exist in `inactive`, `failed`, or `lost` state.

## AI session

```text
creating → active
active ↔ waiting_for_input
active|waiting_for_input → interrupted → active|stopped
active|waiting_for_input|interrupted → stopped|failed|lost
```

## Task run

```text
queued → starting → running
running → passed|failed|cancelled|timed_out|lost
starting → failed|cancelled|lost
```

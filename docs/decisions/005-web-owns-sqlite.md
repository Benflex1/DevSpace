# ADR 005: Make the web application the sole SQLite writer

- Status: Accepted


## Context
Independent web and agent writes would complicate transactions, migrations, idempotency, and audit ordering.

## Decision
The web application owns all SQLite writes. The agent reports observations and events.

## Consequences
Database ownership is simple. The web must persist agent events and run reconciliation after disconnects.

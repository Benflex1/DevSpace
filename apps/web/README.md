# Web application

Future ownership:

- Cloudflare Access integration and browser sessions;
- Project Options UI;
- browser-facing REST/WebSocket APIs;
- orchestration, SQLite writes, application transactions, and audit events;
- terminal rendering and event-stream relaying.

The `@devspace/database` package owns SQLite schema definitions, migrations, and narrow migration utilities. The web application owns runtime database writes and repositories.

Prohibited:

- Git commands;
- shell commands;
- Docker or Caddy administration;
- direct workspace filesystem reads.

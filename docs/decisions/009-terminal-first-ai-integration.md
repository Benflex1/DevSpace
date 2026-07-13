# ADR 009: Start AI integration through container PTYs

- Status: Accepted


## Context
A native provider abstraction and chat UI would delay the useful product and duplicate mature CLI behavior.

## Decision
Run approved AI coding CLIs inside the workspace development container through terminal/PTY sessions.

## Consequences
Approvals and authentication reuse existing CLI workflows. Native structured AI remains a later milestone.

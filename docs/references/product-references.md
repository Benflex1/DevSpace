# Product references

DevSpace's product and UX references are ordered by authority:

## Primary: Orca

[`stablyai/orca`](https://github.com/stablyai/orca) is the primary reference for:

- product direction and the agent-centric Workbench;
- AI/session UX;
- files, editor, terminal, and browser interaction;
- approval and structured-question presentation; and
- activity, review, and changed-file workflow.

Orca is a product/UX reference only. DevSpace's Web/Agent authority, SQLite ownership,
managed-workspace, Docker, filesystem, process, credentials, Git, preview, and provider
boundaries remain authoritative.

## Secondary: T3 Code

[`pingdotgg/t3code`](https://github.com/pingdotgg/t3code) was inspected at revision
`d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3` as a secondary technical/conceptual reference for
isolated mechanics, implementation ideas, and session/orchestration patterns where Orca does not
cover a detail.

Checkpoint 2 used conceptual T3 patterns only. No T3 source was copied or substantially adapted,
so this document is not a source-attribution record and no additional MIT notice is required for
that work. If a future change copies or substantially adapts T3 Code source, record the exact
source files/revision and preserve the required license notice before merging it.

# AI Workbench reference note

DevSpace's primary product and UX reference for the Workbench is
[`stablyai/orca`](https://github.com/stablyai/orca).
[`pingdotgg/t3code`](https://github.com/pingdotgg/t3code) is a secondary technical/conceptual reference, inspected at commit
`d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3`.

Checkpoint 2 uses conceptual T3 UX inspiration only: compact AI-session navigation, inline
approval and structured-question cards, quieter activity presentation, changed-file links, and
reconnect/loading/empty states. No T3 Code source was copied or substantially adapted, so this
repository does not contain copied T3 code and no additional MIT source notice is required for
that implementation. DevSpace retains its own Web/Agent, workspace, persistence, transport,
and authentication boundaries.

Inspected source paths:

- `AGENTS.md`
- `docs/architecture/providers.md`
- `apps/server/src/persistence/Services/ProjectionThreadSessions.ts`
- `apps/server/src/persistence/Layers/ProviderSessionRuntime.ts`
- `packages/effect-codex-app-server/src/client.ts`
- `packages/effect-codex-app-server/src/protocol.ts`
- `apps/web/src/routes/_chat.tsx`
- `apps/web/src/routes/_chat.$environmentId.$threadId.tsx`
- `apps/web/src/composer-logic.ts`
- `packages/shared/src/chatList.ts`
- `packages/shared/src/toolActivity.ts`

This file is a neutral reference record, not a claim of copied-code attribution. If a future
change copies or substantially adapts T3 Code source, record the exact source files/revision and
retain the required MIT notice at that time.

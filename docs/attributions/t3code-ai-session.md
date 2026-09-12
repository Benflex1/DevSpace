# T3 Code AI-session attribution

DevSpace inspected `pingdotgg/t3code` at commit
`d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3` under the MIT license.

Checkpoint 2 uses conceptual UX inspiration only: compact AI-session navigation, inline approval
and structured-question cards, quieter activity presentation, changed-file links, and reconnect /
loading / empty states. No T3 Code source was copied or substantially adapted, so no additional
MIT source attribution is required for the implementation. DevSpace retains its own Web/Agent,
workspace, persistence, transport, and authentication boundaries.

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

Copyright (c) T3 Code contributors. Licensed under the MIT License. The upstream license text was
retained in the inspected repository at `LICENSE`.

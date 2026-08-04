# T3 Code AI-session attribution

DevSpace inspected `pingdotgg/t3code` at commit
`887dd6e455bb969c1a0c9659a6bdf2baceac030d` under the MIT license.

The implementation adapts interaction and presentation patterns; it does not copy T3 Code’s host
filesystem, process authority, persistence, transport, or authentication assumptions. Adapted
patterns are represented in `apps/web/src/app/ai-session-tab.tsx` and the Workbench tab integration
in `apps/web/src/app/project-workbench.tsx`.

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

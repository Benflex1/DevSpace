import { NextResponse } from "next/server";
import { authenticateHeaders, AuthenticationError } from "../../../../../server/auth.js";
import { readWebRuntimeConfig } from "../../../../../server/config.js";
import { createAgentClient } from "../../../../../server/agent-client.js";
import { getProjectDatabase } from "../../../../../server/database.js";

export const dynamic = "force-dynamic";
function pendingAttemptView(value: unknown): { connectionId: string; lifecycleGeneration: number; status: string; expiresAt: string } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.connectionId !== "string" || typeof row.status !== "string" || typeof row.expiresAt !== "string") return null;
  return { connectionId: row.connectionId, lifecycleGeneration: typeof row.targetGeneration === "number" ? row.targetGeneration : 1,
    status: row.status, expiresAt: row.expiresAt };
}
export async function GET(request: Request) {
  try {
    const config = readWebRuntimeConfig(); const actor = await authenticateHeaders(request.headers, config.auth);
    const database = getProjectDatabase(config.databasePath);
    const state = database.getGithubConnectionState(actor.identity);
    if (state?.connection !== undefined && state?.connection !== null) {
      database.assertGithubConnectionOwned(actor.identity, state.connection.connectionId);
      const lifecycle = state.connection.lifecycleState;
      if (lifecycle !== "enabled") {
        if (lifecycle === "disconnect-pending") {
          try {
            const cleanup = await createAgentClient(config.agentSocketPath).disconnectGithubInstallation(
              state.connection.connectionId, state.connection.lifecycleGeneration
            );
            if (cleanup.connectionId === state.connection.connectionId
              && cleanup.lifecycleGeneration === state.connection.lifecycleGeneration
              && cleanup.lifecycleState === "disconnected"
              && (cleanup.cleanupState === "settled" || cleanup.cleanupState === "degraded")) {
              const completed = database.completeGithubDisconnect({ actor: actor.identity,
                connectionId: state.connection.connectionId, lifecycleGeneration: state.connection.lifecycleGeneration,
                cleanupState: cleanup.cleanupState });
              return NextResponse.json({ status: completed.lifecycleState, connectionId: completed.connectionId,
                lifecycleGeneration: completed.lifecycleGeneration, cleanupState: completed.cleanupState,
                lastAuthorityFailureCode: completed.lastAuthorityFailureCode,
                pendingAttempt: pendingAttemptView(state.pendingAttempt) }, { headers: { "cache-control": "no-store" } });
            }
          } catch { /* the durable Web fence remains visible until the Agent can reconcile it */ }
        }
        return NextResponse.json({
          status: lifecycle, connectionId: state.connection.connectionId,
          lifecycleGeneration: state.connection.lifecycleGeneration, cleanupState: state.connection.cleanupState,
          lastAuthorityFailureCode: state.connection.lastAuthorityFailureCode,
          pendingAttempt: pendingAttemptView(state.pendingAttempt)
        }, { headers: { "cache-control": "no-store" } });
      }
      const inspected = await createAgentClient(config.agentSocketPath).inspectGithubInstallation(
        state.connection.connectionId, state.connection.lifecycleGeneration
      );
      return NextResponse.json({ ...inspected, lifecycleState: lifecycle, lifecycleGeneration: state.connection.lifecycleGeneration,
        cleanupState: state.connection.cleanupState, pendingAttempt: pendingAttemptView(state.pendingAttempt) }, { headers: { "cache-control": "no-store" } });
    }
    const app = await createAgentClient(config.agentSocketPath).inspectGithubApp();
    const status = state?.attempt?.status === "claimed" ? "pending" : state?.attempt?.status;
    return NextResponse.json({ status: app.configured ? status ?? "disconnected" : "unconfigured",
      connectionId: state?.attempt?.connectionId ?? null, expiresAt: state?.attempt?.expiresAt ?? null,
      pendingAttempt: pendingAttemptView(state?.pendingAttempt) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof AuthenticationError) return NextResponse.json({ message: "Authentication is required." }, { status: 403 });
    return NextResponse.json({ status: "failed" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}

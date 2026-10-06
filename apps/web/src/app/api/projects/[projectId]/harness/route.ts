import { NextResponse } from "next/server";
import { uuidV7Schema } from "@devspace/contracts";
import { AgentResponseError, createAgentClient } from "../../../../../server/agent-client.js";
import { AuthenticationError, assertCsrf, authenticateHeaders } from "../../../../../server/auth.js";
import { readWebRuntimeConfig } from "../../../../../server/config.js";
import { getProjectDatabase, ProjectSetupConflictError } from "../../../../../server/database.js";
import { listCustomHarnessDefinitions, saveCustomHarnessDefinition } from "../../../../../server/harness-definitions.js";
import {
  createNativeHarnessSession,
  listProjectedHarnessSessions,
  parseHarnessAction,
  resumeNativeHarnessSession
} from "../../../../../server/harness-sessions.js";
import { readBoundedJsonBody } from "../../../../../server/request-body.js";

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const config = readWebRuntimeConfig();
    await authenticateHeaders(request.headers, config.auth);
    const { projectId } = await context.params;
    if (!uuidV7Schema.safeParse(projectId).success) return json({ message: "The project identity is invalid." }, 422);
    const query = new URL(request.url).searchParams;
    const workspaceId = query.get("workspaceId");
    if (workspaceId === null || !uuidV7Schema.safeParse(workspaceId).success) {
      return json({ message: "The workspace identity is invalid." }, 422);
    }
    const database = getProjectDatabase(config.databasePath);
    const agent = createAgentClient(config.agentSocketPath);
    return json({
      definitions: [{ id: "codex", displayName: "Codex", origin: "builtin" }, ...listCustomHarnessDefinitions(database)],
      sessions: await listProjectedHarnessSessions(workspaceId, { database, agent })
    });
  } catch (error) {
    if (error instanceof AuthenticationError) return json({ message: "Authentication is required." }, 403);
    return json({ message: "The harness list could not be loaded." }, 500);
  }
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const config = readWebRuntimeConfig();
    const actor = await authenticateHeaders(request.headers, config.auth);
    assertCsrf(request, config.appOrigin);
    const { projectId } = await context.params;
    const parsed = parseHarnessAction(await readBoundedJsonBody(request));
    if (parsed === null) return json({ message: "The harness request is malformed." }, 422);
    const database = getProjectDatabase(config.databasePath);
    const agent = createAgentClient(config.agentSocketPath);
    if (parsed.action === "save-definition") {
      return json({ definition: saveCustomHarnessDefinition(database, parsed.definition) });
    }
    if (parsed.action === "create-native") {
      return json(await createNativeHarnessSession(projectId, actor.identity, parsed.workspaceId, parsed.harnessId, { database, agent }));
    }
    return json(await resumeNativeHarnessSession(projectId, actor.identity, parsed.workspaceId, parsed.sessionId, { database, agent }));
  } catch (error) {
    if (error instanceof AuthenticationError) return json({ message: "Authentication is required." }, 403);
    if (error instanceof ProjectSetupConflictError) return json({ message: error.message }, 409);
    if (error instanceof AgentResponseError) return json({ message: error.message, code: error.code }, error.code === "HARNESS_HOME_IN_USE" ? 409 : 422);
    if (error instanceof Error && error.message === "CSRF_REJECTED") return json({ message: "Request origin could not be verified." }, 403);
    return json({ message: "The harness action failed safely." }, 500);
  }
}

import { NextResponse } from "next/server";
import { performance } from "node:perf_hooks";
import { uuidV7Schema } from "@devspace/contracts";
import { createLogger } from "@devspace/diagnostics";
import { AgentResponseError, AgentUnavailableError, createAgentClient } from "../../../../../server/agent-client.js";
import { AuthenticationError, assertCsrf, authenticateHeaders } from "../../../../../server/auth.js";
import { readWebRuntimeConfig } from "../../../../../server/config.js";
import { getProjectDatabase, ProjectSetupConflictError } from "../../../../../server/database.js";
import { listCustomHarnessDefinitions, saveCustomHarnessDefinition } from "../../../../../server/harness-definitions.js";
import {
  createNativeHarnessSession,
  listProjectedHarnessSessions,
  parseHarnessAction,
  retryNativeHarnessSession,
  resumeNativeHarnessSession
} from "../../../../../server/harness-sessions.js";
import { readBoundedJsonBody } from "../../../../../server/request-body.js";

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
const harnessAdmissionLogger = createLogger({ component: "web", subsystem: "harness-admission" });

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
  const requestReceivedAt = performance.now();
  let admissionOperation: string | undefined;
  let admissionSessionId: string | undefined;
  let admissionWorkspaceId: string | undefined;
  let admissionHarnessId: string | undefined;
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
      admissionOperation = "native-harness.start";
      admissionWorkspaceId = parsed.workspaceId;
      admissionHarnessId = parsed.harnessId;
      const result = await createNativeHarnessSession(projectId, actor.identity, parsed.workspaceId, parsed.harnessId, { database, agent });
      admissionSessionId = result.sessionId;
      try {
        harnessAdmissionLogger.info("web.harness.admission.completed", "Native harness admission response is ready.", {
          phase: "web-request", operationName: admissionOperation, outcome: "success", sessionId: result.sessionId,
          terminalId: result.terminalId, workspaceId: result.workspaceId, harnessId: result.harnessId,
          durationMs: Math.max(0, performance.now() - requestReceivedAt)
        });
      } catch { /* diagnostics must not affect admission */ }
      return json(result);
    }
    if (parsed.action === "retry-native") {
      admissionOperation = "native-harness.retry";
      admissionSessionId = parsed.sessionId;
      admissionWorkspaceId = parsed.workspaceId;
      const result = await retryNativeHarnessSession(projectId, actor.identity, parsed.workspaceId, parsed.sessionId,
        parsed.processGeneration, { database, agent });
      try {
        harnessAdmissionLogger.info("web.harness.admission.completed", "Native harness admission reconciliation response is ready.", {
          phase: "web-request", operationName: admissionOperation, outcome: "success", sessionId: result.sessionId,
          terminalId: result.terminalId, workspaceId: result.workspaceId, harnessId: result.harnessId,
          durationMs: Math.max(0, performance.now() - requestReceivedAt)
        });
      } catch { /* diagnostics must not affect admission */ }
      return json(result);
    }
    admissionOperation = "native-harness.resume";
    admissionSessionId = parsed.sessionId;
    admissionWorkspaceId = parsed.workspaceId;
    const result = await resumeNativeHarnessSession(projectId, actor.identity, parsed.workspaceId, parsed.sessionId, { database, agent });
    try {
      harnessAdmissionLogger.info("web.harness.admission.completed", "Native harness admission response is ready.", {
        phase: "web-request", operationName: admissionOperation, outcome: "success", sessionId: result.sessionId,
        terminalId: result.terminalId, workspaceId: result.workspaceId,
        durationMs: Math.max(0, performance.now() - requestReceivedAt)
      });
    } catch { /* diagnostics must not affect admission */ }
    return json(result);
  } catch (error) {
    if (admissionOperation !== undefined) {
      const uncertain = error instanceof AgentUnavailableError
        || error instanceof AgentResponseError && (error.code === "HARNESS_ADMISSION_UNCERTAIN" || error.retryable);
      const errorCode = error instanceof AgentResponseError || error instanceof AgentUnavailableError
        ? error.code : error instanceof ProjectSetupConflictError ? "PROJECT_SETUP_CONFLICT" : "ADMISSION_FAILED";
      const requestId = error instanceof AgentResponseError || error instanceof AgentUnavailableError ? error.requestId : undefined;
      try {
        harnessAdmissionLogger.warn("web.harness.admission.failed", "Native harness admission response is a failure or uncertain.", {
          phase: "web-request", operationName: admissionOperation, outcome: uncertain ? "uncertain" : "failure",
          errorCode, durationMs: Math.max(0, performance.now() - requestReceivedAt),
          ...(typeof requestId === "string" ? { requestId } : {}),
          ...(admissionSessionId === undefined ? {} : { sessionId: admissionSessionId }),
          ...(admissionWorkspaceId === undefined ? {} : { workspaceId: admissionWorkspaceId }),
          ...(admissionHarnessId === undefined ? {} : { harnessId: admissionHarnessId })
        });
      } catch { /* diagnostics must not affect admission */ }
    }
    if (error instanceof AuthenticationError) return json({ message: "Authentication is required." }, 403);
    if (error instanceof ProjectSetupConflictError) return json({ message: error.message }, 409);
    if (error instanceof AgentUnavailableError) return json({ message: error.message, code: error.code }, 503);
    if (error instanceof AgentResponseError) return json({ message: error.message, code: error.code }, error.code === "HARNESS_HOME_IN_USE" ? 409 : error.retryable ? 503 : 422);
    if (error instanceof Error && error.message === "CSRF_REJECTED") return json({ message: "Request origin could not be verified." }, 403);
    return json({ message: "The harness action failed safely." }, 500);
  }
}

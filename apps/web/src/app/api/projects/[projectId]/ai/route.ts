import { NextResponse } from "next/server";
import { aiTurnContentSchema, uuidV7Schema } from "@devspace/contracts";
import { createAgentClient } from "../../../../../server/agent-client.js";
import { AuthenticationError, assertCsrf, authenticateHeaders } from "../../../../../server/auth.js";
import { readWebRuntimeConfig } from "../../../../../server/config.js";
import { getProjectDatabase } from "../../../../../server/database.js";
import { createAiSession, inspectAiWorkbench, interruptAiTurn, sendAiTurn, stopAiSession, toAiActionError } from "../../../../../server/ai-sessions.js";
import { readBoundedJsonBody } from "../../../../../server/request-body.js";

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
type AiAction = { action: "create"; workspaceId: string } | { action: "send"; workspaceId: string; sessionId: string; content: { kind: "text"; text: string } }
  | { action: "interrupt"; workspaceId: string; sessionId: string; turnId: string } | { action: "stop"; workspaceId: string; sessionId: string };
function parseAction(input: unknown): AiAction | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>; const action = value.action; const workspaceId = value.workspaceId;
  if (typeof action !== "string" || typeof workspaceId !== "string" || !uuidV7Schema.safeParse(workspaceId).success) return null;
  if (action === "create" && Object.keys(value).length === 2) return { action, workspaceId };
  if (action === "stop" && typeof value.sessionId === "string" && Object.keys(value).length === 3 && uuidV7Schema.safeParse(value.sessionId).success) return { action, workspaceId, sessionId: value.sessionId };
  if (action === "interrupt" && typeof value.sessionId === "string" && typeof value.turnId === "string" && Object.keys(value).length === 4
    && uuidV7Schema.safeParse(value.sessionId).success && uuidV7Schema.safeParse(value.turnId).success) return { action, workspaceId, sessionId: value.sessionId, turnId: value.turnId };
  if (action === "send" && typeof value.sessionId === "string" && uuidV7Schema.safeParse(value.sessionId).success && aiTurnContentSchema.safeParse(value.content).success) {
    return { action, workspaceId, sessionId: value.sessionId, content: value.content as { kind: "text"; text: string } };
  }
  return null;
}

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  let projectId: string | undefined;
  try {
    const config = readWebRuntimeConfig(); await authenticateHeaders(request.headers, config.auth); ({ projectId } = await context.params);
    const workspaceId = new URL(request.url).searchParams.get("workspaceId");
    if (workspaceId === null || !uuidV7Schema.safeParse(workspaceId).success) return json({ message: "The workspace identity is invalid." }, 422);
    const data = await inspectAiWorkbench(projectId, workspaceId, { database: getProjectDatabase(config.databasePath), agent: createAgentClient(config.agentSocketPath) });
    return json(data);
  } catch (error) {
    if (error instanceof AuthenticationError) return json({ message: "Authentication is required." }, 403);
    const safe = toAiActionError(error); return json({ message: safe.message, code: safe.code }, safe.code === "AI_PROFILE_UNAVAILABLE" ? 503 : 409);
  }
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  let projectId: string | undefined;
  try {
    const config = readWebRuntimeConfig(); const actor = await authenticateHeaders(request.headers, config.auth); assertCsrf(request, config.appOrigin);
    ({ projectId } = await context.params); const parsed = parseAction(await readBoundedJsonBody(request));
    if (parsed === null) return json({ message: "Choose a valid AI session action." }, 422);
    const dependencies = { database: getProjectDatabase(config.databasePath), agent: createAgentClient(config.agentSocketPath) };
    if (parsed.action === "create") return json(await createAiSession(projectId, parsed.workspaceId, actor.identity, dependencies));
    if (parsed.action === "send") return json(await sendAiTurn(projectId, parsed.workspaceId, parsed.sessionId, parsed.content.text, dependencies));
    if (parsed.action === "interrupt") return json(await interruptAiTurn(projectId, parsed.workspaceId, parsed.sessionId, parsed.turnId, dependencies));
    return json(await stopAiSession(projectId, parsed.workspaceId, parsed.sessionId, dependencies));
  } catch (error) {
    if (error instanceof AuthenticationError) return json({ message: "Authentication is required." }, 403);
    if (error instanceof Error && error.message === "CSRF_REJECTED") return json({ message: "Request origin could not be verified." }, 403);
    const safe = toAiActionError(error); return json({ message: safe.message, code: safe.code }, safe.code === "AI_PROFILE_UNAVAILABLE" ? 503 : 409);
  }
}

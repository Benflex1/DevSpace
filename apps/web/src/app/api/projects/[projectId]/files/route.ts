import { NextResponse } from "next/server";
import {
  WORKSPACE_FILE_MAX_BYTES,
  saveWorkspaceFileDataSchema,
  workspaceRelativePathSchema
} from "@devspace/contracts";
import { AgentResponseError, AgentUnavailableError, createAgentClient } from "../../../../../server/agent-client.js";
import { AuthenticationError, assertCsrf, authenticateHeaders } from "../../../../../server/auth.js";
import { readWebRuntimeConfig } from "../../../../../server/config.js";
import { ProjectSetupConflictError, getProjectDatabase } from "../../../../../server/database.js";
import { RequestBodyMalformedError, RequestBodyTooLargeError, readBoundedJsonBody } from "../../../../../server/request-body.js";
import { normalizeUserFacingFailure } from "../../../../../server/user-facing-failure.js";

export const dynamic = "force-dynamic";
const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

function fileFailureStatus(code: string): number {
  return code === "WORKSPACE_FILE_NOT_FOUND" ? 404
    : code === "WORKSPACE_FILE_TOO_LARGE" || code === "WORKSPACE_DIRECTORY_TOO_LARGE" ? 413
      : code === "WORKSPACE_FILE_CHANGED" ? 409
        : code === "WORKSPACE_PATH_INVALID" || code === "WORKSPACE_FILE_UNSUPPORTED" ? 422 : 503;
}

function primaryWorkspaceId(projectId: string, database: ReturnType<typeof getProjectDatabase>): string {
  const project = database.getManagedProject(projectId);
  if (project === undefined) throw new ProjectSetupConflictError("The project was not found.");
  if (project.state !== "ready" || project.primaryWorkspace === null) {
    throw new ProjectSetupConflictError("A ready project with a managed primary workspace is required.");
  }
  return project.primaryWorkspace.id;
}

function actionPath(request: Request): { action: "list" | "read"; path: string } | null {
  const query = new URL(request.url).searchParams;
  const action = query.get("action");
  const relativePath = query.get("path") ?? "";
  if ((action !== "list" && action !== "read") || !workspaceRelativePathSchema.safeParse(relativePath).success) return null;
  return { action, path: relativePath };
}

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  let projectId: string | undefined;
  try {
    const config = readWebRuntimeConfig();
    await authenticateHeaders(request.headers, config.auth);
    ({ projectId } = await context.params);
    const action = actionPath(request);
    if (action === null) return json({ message: "Choose a valid file action and workspace-relative path." }, 422);
    const database = getProjectDatabase(config.databasePath);
    const workspaceId = primaryWorkspaceId(projectId, database);
    const agent = createAgentClient(config.agentSocketPath);
    const result = action.action === "list"
      ? await agent.listWorkspaceDirectory(projectId, workspaceId, action.path)
      : await agent.readWorkspaceFile(projectId, workspaceId, action.path);
    return json(result, 200);
  } catch (error) {
    if (error instanceof AuthenticationError) return json({ message: "Authentication is required." }, 403);
    if (error instanceof ProjectSetupConflictError) return json({ message: error.message }, error.message === "The project was not found." ? 404 : 409);
    if (error instanceof AgentResponseError || error instanceof AgentUnavailableError) {
      const failure = normalizeUserFacingFailure(error, {
        fallbackMessage: "Workspace files are temporarily unavailable.", event: "web.workspace_files.read.failed",
        logMessage: "User-facing workspace file read failed", context: { ...(projectId === undefined ? {} : { projectId }) }
      });
      return json(failure, fileFailureStatus(failure.code));
    }
    return json({ message: "Workspace files are temporarily unavailable." }, 503);
  }
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  let projectId: string | undefined;
  try {
    const config = readWebRuntimeConfig();
    await authenticateHeaders(request.headers, config.auth);
    assertCsrf(request, config.appOrigin);
    ({ projectId } = await context.params);
    const body = await readBoundedJsonBody(request, WORKSPACE_FILE_MAX_BYTES + 64 * 1024);
    if (body === null || typeof body !== "object" || Array.isArray(body)) return json({ message: "Choose a file action." }, 422);
    const record = body as Record<string, unknown>;
    if (Object.keys(record).length !== 4 || record.action !== "save"
      || typeof record.path !== "string" || typeof record.content !== "string" || typeof record.expectedRevision !== "string") {
      return json({ message: "Choose a valid save action." }, 422);
    }
    const database = getProjectDatabase(config.databasePath);
    const workspaceId = primaryWorkspaceId(projectId, database);
    const parsed = saveWorkspaceFileDataSchema.safeParse({ projectId, workspaceId, path: record.path,
      content: record.content, expectedRevision: record.expectedRevision });
    if (!parsed.success) return json({ message: "The file path, content, or revision is invalid." }, 422);
    const result = await createAgentClient(config.agentSocketPath).saveWorkspaceFile(
      projectId, workspaceId, parsed.data.path, parsed.data.content, parsed.data.expectedRevision
    );
    return json(result, 200);
  } catch (error) {
    if (error instanceof AuthenticationError) return json({ message: "Authentication is required." }, 403);
    if (error instanceof Error && error.message === "CSRF_REJECTED") return json({ message: "Request origin could not be verified." }, 403);
    if (error instanceof RequestBodyTooLargeError) return json({ message: "The workspace file is too large to edit." }, 413);
    if (error instanceof RequestBodyMalformedError) return json({ message: "Request body must be valid JSON." }, 400);
    if (error instanceof ProjectSetupConflictError) return json({ message: error.message }, error.message === "The project was not found." ? 404 : 409);
    if (error instanceof AgentResponseError || error instanceof AgentUnavailableError) {
      const failure = normalizeUserFacingFailure(error, {
        fallbackMessage: "The workspace file could not be saved safely.", event: "web.workspace_file.save.failed",
        logMessage: "User-facing workspace file save failed", context: { ...(projectId === undefined ? {} : { projectId }) }
      });
      return json(failure, fileFailureStatus(failure.code));
    }
    return json({ message: "The workspace file could not be saved safely." }, 500);
  }
}

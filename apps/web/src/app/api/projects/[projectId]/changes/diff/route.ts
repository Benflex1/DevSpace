import { NextResponse } from "next/server";
import { gitPathSchema } from "@devspace/contracts";
import { AgentResponseError, AgentUnavailableError, createAgentClient } from "../../../../../../server/agent-client.js";
import { AuthenticationError, authenticateHeaders } from "../../../../../../server/auth.js";
import { readWebRuntimeConfig } from "../../../../../../server/config.js";
import { getProjectDatabase, ProjectSetupConflictError } from "../../../../../../server/database.js";
import { primaryWorkspaceId } from "../../../../../../server/project-git.js";
import { normalizeUserFacingFailure } from "../../../../../../server/user-facing-failure.js";

export const dynamic = "force-dynamic";
const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
function safeGitPath(value: string): boolean {
  return gitPathSchema.safeParse(value).success && !value.startsWith("/") && !value.includes("\\") && !value.includes("\0")
    && ![...value].some((character) => (character.codePointAt(0) ?? 0) <= 31 || ((character.codePointAt(0) ?? 0) >= 127 && (character.codePointAt(0) ?? 0) <= 159))
    && value.split("/").every((component) => component !== "" && component !== "." && component !== ".." && component !== ".git");
}

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  let projectId: string | undefined;
  try {
    const config = readWebRuntimeConfig();
    await authenticateHeaders(request.headers, config.auth);
    ({ projectId } = await context.params);
    const query = new URL(request.url).searchParams;
    const path = query.get("path");
    const kind = query.get("kind");
    if (path === null || !safeGitPath(path) || (kind !== "staged" && kind !== "unstaged")) {
      return json({ message: "Choose a valid changed file and diff kind." }, 422);
    }
    const database = getProjectDatabase(config.databasePath);
    const workspaceId = primaryWorkspaceId(projectId, database);
    const result = await createAgentClient(config.agentSocketPath).diffGit(projectId, workspaceId, path, kind);
    return json(result, 200);
  } catch (error) {
    if (error instanceof AuthenticationError) return json({ message: "Authentication is required." }, 403);
    if (error instanceof ProjectSetupConflictError) return json({ message: error.message }, error.message === "The project was not found." ? 404 : 409);
    if (error instanceof AgentResponseError || error instanceof AgentUnavailableError) {
      const failure = normalizeUserFacingFailure(error, {
        fallbackMessage: "The Git diff is temporarily unavailable.", event: "web.project_git_diff.failed",
        logMessage: "User-facing project Git diff failed", context: { ...(projectId === undefined ? {} : { projectId }) }
      });
      const status = failure.code === "WORKSPACE_FILE_NOT_FOUND" ? 404 : failure.code === "WORKSPACE_PATH_INVALID" ? 422 : 503;
      return json(failure, status);
    }
    return json({ message: "The Git diff is temporarily unavailable." }, 503);
  }
}

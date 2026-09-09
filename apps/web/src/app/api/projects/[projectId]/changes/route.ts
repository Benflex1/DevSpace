import { NextResponse } from "next/server";
import * as z from "zod";
import {
  GIT_COMMIT_MESSAGE_MAX_BYTES,
  GIT_IDENTITY_MAX_BYTES,
  gitPathSchema
} from "@devspace/contracts";
import { AgentResponseError, AgentUnavailableError, createAgentClient } from "../../../../../server/agent-client.js";
import { AuthenticationError, assertCsrf, authenticateHeaders } from "../../../../../server/auth.js";
import { readWebRuntimeConfig } from "../../../../../server/config.js";
import { getProjectDatabase, ProjectSetupConflictError } from "../../../../../server/database.js";
import { mutateProjectGit, inspectProjectGit, ProjectGitError, type GitMutationInput } from "../../../../../server/project-git.js";
import { RequestBodyMalformedError, RequestBodyTooLargeError, readBoundedJsonBody } from "../../../../../server/request-body.js";
import { normalizeUserFacingFailure } from "../../../../../server/user-facing-failure.js";

export const dynamic = "force-dynamic";
const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
const safeGitPathSchema = gitPathSchema.refine((value) => !value.startsWith("/") && !value.includes("\\") && !value.includes("\0")
  && ![...value].some((character) => (character.codePointAt(0) ?? 0) <= 31 || ((character.codePointAt(0) ?? 0) >= 127 && (character.codePointAt(0) ?? 0) <= 159))
  && value.split("/").every((component) => component !== "" && component !== "." && component !== ".." && component !== ".git"), "The workspace-relative path is invalid.");

const identityField = z.string().min(1).max(GIT_IDENTITY_MAX_BYTES).superRefine((value, context) => {
  if ([...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159));
  })) context.addIssue({ code: "custom", message: "Identity contains a control character." });
});
const commitMessage = z.string().min(1).max(GIT_COMMIT_MESSAGE_MAX_BYTES).superRefine((value, context) => {
  if (Buffer.byteLength(value, "utf8") > GIT_COMMIT_MESSAGE_MAX_BYTES) context.addIssue({ code: "custom", message: "Commit message is too large." });
});
const mutationSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("stage"), path: safeGitPathSchema }),
  z.strictObject({ action: z.literal("unstage"), path: safeGitPathSchema }),
  z.strictObject({ action: z.literal("commit"), message: commitMessage, userName: identityField.optional(), userEmail: identityField.optional() })
]);

function gitFailureStatus(code: string): number {
  if (code === "WORKSPACE_FILE_NOT_FOUND" || code === "RESOURCE_NOT_FOUND" || code === "PROJECT_NOT_FOUND") return 404;
  if (code === "WORKSPACE_FILE_TOO_LARGE") return 413;
  if (code === "WORKSPACE_PATH_INVALID" || code === "WORKSPACE_FILE_UNSUPPORTED" || code === "GIT_COMMIT_MESSAGE_INVALID" || code === "GIT_IDENTITY_REQUIRED") return 422;
  if (code === "GIT_NOTHING_TO_COMMIT" || code === "GIT_OPERATION_FAILED") return 409;
  return 503;
}

function safeFailure(error: unknown, fallbackMessage: string, projectId: string) {
  return normalizeUserFacingFailure(error, {
    fallbackMessage, event: "web.project_git.failed", logMessage: "User-facing project Git operation failed", context: { projectId }
  });
}

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  let projectId: string | undefined;
  try {
    const config = readWebRuntimeConfig();
    await authenticateHeaders(request.headers, config.auth);
    ({ projectId } = await context.params);
    const database = getProjectDatabase(config.databasePath);
    const result = await inspectProjectGit(projectId, database, createAgentClient(config.agentSocketPath));
    return json(result, 200);
  } catch (error) {
    if (error instanceof AuthenticationError) return json({ message: "Authentication is required." }, 403);
    if (error instanceof ProjectSetupConflictError) return json({ message: error.message }, error.message === "The project was not found." ? 404 : 409);
    if (error instanceof AgentResponseError || error instanceof AgentUnavailableError) return json(safeFailure(error, "Git changes are temporarily unavailable.", projectId ?? "unknown"), 503);
    return json({ message: "Git changes are temporarily unavailable." }, 503);
  }
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  let projectId: string | undefined;
  try {
    const config = readWebRuntimeConfig();
    await authenticateHeaders(request.headers, config.auth);
    assertCsrf(request, config.appOrigin);
    ({ projectId } = await context.params);
    const parsed = mutationSchema.safeParse(await readBoundedJsonBody(request, 128 * 1024));
    if (!parsed.success) return json({ message: "Choose a valid Git changes action." }, 422);
    const result = await mutateProjectGit(projectId, parsed.data as GitMutationInput, {
      database: getProjectDatabase(config.databasePath), agent: createAgentClient(config.agentSocketPath)
    });
    return json(result, result.state === "succeeded" ? 200 : 202);
  } catch (error) {
    if (error instanceof AuthenticationError) return json({ message: "Authentication is required." }, 403);
    if (error instanceof Error && error.message === "CSRF_REJECTED") return json({ message: "Request origin could not be verified." }, 403);
    if (error instanceof RequestBodyTooLargeError) return json({ message: "The Git request is too large." }, 413);
    if (error instanceof RequestBodyMalformedError) return json({ message: "Request body must be valid JSON." }, 400);
    if (error instanceof ProjectSetupConflictError) return json({ message: error.message }, error.message === "The project was not found." ? 404 : 409);
    if (error instanceof ProjectGitError || error instanceof AgentResponseError || error instanceof AgentUnavailableError) {
      const failure = safeFailure(error, "The Git operation could not be completed safely.", projectId ?? "unknown");
      return json(failure, gitFailureStatus(failure.code));
    }
    return json({ message: "The Git operation could not be completed safely." }, 500);
  }
}

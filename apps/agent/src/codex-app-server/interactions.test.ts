import { describe, expect, test } from "vitest";
import { AI_MAX_PRESENTATION_PATHS } from "@devspace/contracts";
import {
  encodeCodexApprovalResponse,
  encodeCodexInputResponse,
  parseCodexServerInteractionRequest,
  projectCodexApprovalRequest,
  projectCodexFileChangeItem,
  projectCodexInputRequest
} from "./interactions.js";

const commandRequest = (overrides: Record<string, unknown> = {}) => ({
  id: 91,
  method: "item/commandExecution/requestApproval",
  params: {
    itemId: "item-command-1",
    startedAtMs: 1,
    threadId: "native-thread-1",
    turnId: "native-turn-1",
    command: "npm test && curl https://example.invalid",
    cwd: "/workspace/apps/web",
    reason: "The task needs to verify and fetch the fixture.",
    ...overrides
  }
});

const devspaceTurnId = "0190c6f0-0000-7000-8000-000000000010";

describe("Codex interaction projection", () => {
  test("creates a DevSpace approval identity without exposing the native request id", () => {
    const request = parseCodexServerInteractionRequest(commandRequest());
    expect(request).not.toBeNull();

    const projected = projectCodexApprovalRequest(request!, devspaceTurnId, () => "0190c6f0-0000-7000-8000-000000000001");
    expect(projected).not.toBeNull();
    if (projected === null) throw new Error("Expected approval projection");
    expect(projected).toEqual(expect.objectContaining({
      requestId: "0190c6f0-0000-7000-8000-000000000001",
      turnId: devspaceTurnId,
      kind: "approval"
    }));
    expect(projected?.presentation).toEqual({
      kind: "command",
      summary: "The task needs to verify and fetch the fixture.",
      commandText: "npm test && curl https://example.invalid",
      workingDirectory: "apps/web",
      risk: "mixed",
      redacted: true
    });
    expect(projected?.binding.nativeRequestId).toBe(91);
    expect(JSON.stringify(projected?.public)).not.toContain("91");
    expect(JSON.stringify(projected.public)).not.toContain("native-thread-1");
    expect(JSON.stringify(projected.public)).not.toContain("native-turn-1");
  });

  test("projects file-change approval into bounded safe paths", () => {
    const request = parseCodexServerInteractionRequest({
      id: 92,
      method: "item/fileChange/requestApproval",
      params: {
        itemId: "item-file-1",
        startedAtMs: 1,
        threadId: "native-thread-1",
        turnId: "native-turn-1",
        grantRoot: "/workspace/packages/contracts",
        reason: "Codex needs to update the contract fixture."
      }
    });
    expect(request?.params).not.toHaveProperty("paths");
    const projected = projectCodexApprovalRequest(request!, devspaceTurnId, () => "0190c6f0-0000-7000-8000-000000000002");
    expect(projected).toBeNull();
  });

  test("redacts secret-like provider text before public projection while retaining safe context", () => {
    const secret = "devspace-super-secret-token";
    const command = parseCodexServerInteractionRequest(commandRequest({
      command: "pnpm test && curl -H 'Authorization: Bearer devspace-super-secret-token' https://example.invalid",
      reason: `Authorization: Bearer ${secret}`
    }));
    const commandProjection = projectCodexApprovalRequest(command!, devspaceTurnId, () => "0190c6f0-0000-7000-8000-000000000006");
    expect(commandProjection).not.toBeNull();
    expect(commandProjection?.public.presentation.kind).toBe("command");
    expect(JSON.stringify(commandProjection?.public)).not.toContain(secret);
    expect(commandProjection?.public.presentation).toMatchObject({ risk: "mixed" });

    const input = parseCodexServerInteractionRequest({
      id: 97,
      method: "item/tool/requestUserInput",
      params: {
        itemId: "item-input-secret",
        questions: [{
          header: "Authorization",
          id: "token",
          question: `Authorization: Bearer ${secret}`,
          isOther: true,
          options: [{ label: "Use token", description: `Authorization: Bearer ${secret}` }]
        }],
        threadId: "native-thread-1",
        turnId: "native-turn-1"
      }
    });
    const inputProjection = projectCodexInputRequest(input!, devspaceTurnId, () => "0190c6f0-0000-7000-8000-000000000007");
    expect(inputProjection).not.toBeNull();
    expect(JSON.stringify(inputProjection?.public)).not.toContain(secret);
    expect(inputProjection?.public.questions[0]?.options[0]?.label).toBe("Use token");
  });

  test("rejects secret user-input requests before creating a public projection", () => {
    const request = parseCodexServerInteractionRequest({
      id: 93,
      method: "item/tool/requestUserInput",
      params: {
        itemId: "item-input-1",
        questions: [{ header: "Token", id: "token", question: "Enter a token", isSecret: true, isOther: true,
          options: [{ label: "Use token", description: "Use the supplied token" }] }],
        threadId: "native-thread-1",
        turnId: "native-turn-1"
      }
    });
    expect(request).toBeNull();
  });

  test("maps all input options to exact public question and option identities", () => {
    const request = parseCodexServerInteractionRequest({
      id: 94,
      method: "item/tool/requestUserInput",
      params: {
        itemId: "item-input-2",
        questions: [
          { header: "Mode", id: "mode", question: "Choose a mode", isOther: true, options: [
            { label: "Fast", description: "Run quickly" },
            { label: "Safe", description: "Prefer safety" }
          ] },
          { header: "Reason", id: "reason", question: "Why?", isOther: true, options: [
            { label: "Continue", description: "Continue with the bounded task" }
          ] }
        ],
        threadId: "native-thread-1",
        turnId: "native-turn-1"
      }
    });
    const projected = projectCodexInputRequest(request!, devspaceTurnId, () => "0190c6f0-0000-7000-8000-000000000004");
    expect(projected?.public.questions).toEqual([
      {
        questionId: "question-1",
        header: "Mode",
        question: "Choose a mode",
        responseKind: "single-select",
        allowOther: true,
        secret: false,
        options: [
          { optionId: "option-1", label: "Fast", description: "Run quickly" },
          { optionId: "option-2", label: "Safe", description: "Prefer safety" }
        ]
      },
      {
        questionId: "question-2",
        header: "Reason",
        question: "Why?",
        responseKind: "single-select",
        allowOther: true,
        secret: false,
        options: [{ optionId: "option-1", label: "Continue", description: "Continue with the bounded task" }]
      }
    ]);
    expect(projected?.mapping.questions.map((question) => question.nativeQuestionId)).toEqual(["mode", "reason"]);
    expect(JSON.stringify(projected?.public)).not.toContain("native-thread-1");
    expect(JSON.stringify(projected?.public)).not.toContain("94");
  });

  test("encodes approval decisions and structured answers for the provider only", () => {
    const approval = parseCodexServerInteractionRequest(commandRequest({ id: 95 }));
    expect(encodeCodexApprovalResponse(approval!, "approve-once")).toEqual({ decision: "accept" });
    expect(encodeCodexApprovalResponse(approval!, "approve-for-session")).toEqual({ decision: "acceptForSession" });
    expect(encodeCodexApprovalResponse(approval!, "deny")).toEqual({ decision: "decline" });
    expect(encodeCodexApprovalResponse(approval!, "cancel")).toEqual({ decision: "cancel" });

    const input = parseCodexServerInteractionRequest({
      id: 96,
      method: "item/tool/requestUserInput",
      params: {
        itemId: "item-input-3",
        questions: [{ header: "Mode", id: "mode", question: "Choose", isOther: true,
          options: [{ label: "Fast", description: "" }] }],
        threadId: "native-thread-1",
        turnId: "native-turn-1"
      }
    });
    const projected = projectCodexInputRequest(input!, devspaceTurnId, () => "0190c6f0-0000-7000-8000-000000000005");
    expect(encodeCodexInputResponse(projected!.mapping, [
      { questionId: "question-1", kind: "selected", optionId: "option-1" }
    ])).toEqual({ answers: { mode: { answers: ["Fast"] } } });
  });

  test("keeps the native option label private while mapping a public redacted option exactly", () => {
    const secret = "devspace-super-secret-token";
    const request = parseCodexServerInteractionRequest({
      id: 98,
      method: "item/tool/requestUserInput",
      params: {
        itemId: "item-input-private-option",
        threadId: "native-thread-1",
        turnId: "native-turn-1",
        questions: [{
          id: "mode", header: "Mode", question: "Choose a mode", isOther: true,
          options: [{ label: `Authorization: Bearer ${secret}`, description: "Bounded option" }]
        }]
      }
    });
    const projected = projectCodexInputRequest(request!, devspaceTurnId, () => "0190c6f0-0000-7000-8000-000000000008");
    expect(projected).not.toBeNull();
    if (projected === null) throw new Error("Expected input projection");
    expect(projected.public.questions[0]?.options[0]?.label).toBe("[REDACTED]");
    expect(JSON.stringify(projected.public)).not.toContain(secret);
    expect(projected.mapping.questions[0]?.options[0]?.nativeOptionLabel).toBe(`Authorization: Bearer ${secret}`);
    expect(encodeCodexInputResponse(projected.mapping, [
      { questionId: "question-1", kind: "selected", optionId: "option-1" }
    ])).toEqual({ answers: { mode: { answers: [`Authorization: Bearer ${secret}`] } } });
  });

  test("encodes the pinned Codex Other answer without exposing the native option values", () => {
    const request = parseCodexServerInteractionRequest({
      id: 99,
      method: "item/tool/requestUserInput",
      params: {
        itemId: "item-input-other",
        threadId: "native-thread-1",
        turnId: "native-turn-1",
        questions: [{ id: "mode", header: "Mode", question: "Choose a mode", isOther: true,
          options: [{ label: "Safe", description: "Use safe mode" }] }]
      }
    });
    const projected = projectCodexInputRequest(request!, devspaceTurnId, () => "0190c6f0-0000-7000-8000-000000000009");
    expect(projected).not.toBeNull();
    expect(encodeCodexInputResponse(projected!.mapping, [
      { questionId: "question-1", kind: "other", text: "a bounded custom answer" }
    ])).toEqual({ answers: { mode: { answers: ["user_note: a bounded custom answer"] } } });
  });

  test.each([null, 0, 15_000])("accepts the pinned autoResolutionMs value %s without projecting it", (autoResolutionMs) => {
    const request = parseCodexServerInteractionRequest({
      id: 102,
      method: "item/tool/requestUserInput",
      params: {
        itemId: "item-input-timeout",
        threadId: "native-thread-1",
        turnId: "native-turn-1",
        autoResolutionMs,
        questions: [{ id: "mode", header: "Mode", question: "Choose a mode", isOther: true,
          options: [{ label: "Safe", description: "Use safe mode" }] }]
      }
    });
    expect(request).not.toBeNull();
    const projected = projectCodexInputRequest(request!, devspaceTurnId, () => "0190c6f0-0000-7000-8000-00000000000b");
    expect(projected?.public).not.toHaveProperty("autoResolutionMs");
  });

  test.each([
    { label: "empty options", options: [], isOther: true },
    { label: "other disabled", options: [{ label: "Safe", description: "Use safe mode" }], isOther: false },
    { label: "invalid auto-resolution", options: [{ label: "Safe", description: "Use safe mode" }], isOther: true, autoResolutionMs: -1 },
    { label: "invalid secret flag", options: [{ label: "Safe", description: "Use safe mode" }], isOther: true, isSecret: "false" }
  ])("rejects a malformed pinned structured-input request with $label", ({ options, isOther, autoResolutionMs, isSecret }) => {
    const request = parseCodexServerInteractionRequest({
      id: 100,
      method: "item/tool/requestUserInput",
      params: {
        itemId: "item-input-invalid",
        threadId: "native-thread-1",
        turnId: "native-turn-1",
        ...(autoResolutionMs === undefined ? {} : { autoResolutionMs }),
        questions: [{ id: "mode", header: "Mode", question: "Choose a mode", isOther, ...(isSecret === undefined ? {} : { isSecret }),
          options }]
      }
    });
    expect(request).toBeNull();
  });

  test("preserves native file-change truncation through the public approval projection", () => {
    const item = projectCodexFileChangeItem({
      id: "native-file-item-many",
      type: "fileChange",
      changes: Array.from({ length: AI_MAX_PRESENTATION_PATHS + 44 }, (_, index) => ({
        path: `/workspace/src/changed-${index}.ts`,
        kind: { type: "update" },
        diff: `private diff ${index}`
      }))
    }, "native-thread-1", "native-turn-1");
    expect(item).not.toBeNull();
    expect(item?.paths).toHaveLength(AI_MAX_PRESENTATION_PATHS);
    expect(item?.truncated).toBe(true);
    const request = parseCodexServerInteractionRequest({
      id: 101,
      method: "item/fileChange/requestApproval",
      params: {
        itemId: "native-file-item-many", startedAtMs: 1, threadId: "native-thread-1", turnId: "native-turn-1",
        grantRoot: "/workspace", reason: "The bounded file-change request needs approval."
      }
    });
    const projected = projectCodexApprovalRequest(request!, devspaceTurnId, () => "0190c6f0-0000-7000-8000-00000000000a",
      new Map([["native-file-item-many", item!]]));
    expect(projected?.presentation).toMatchObject({ kind: "file-change", truncated: true });
    if (projected?.presentation.kind !== "file-change") throw new Error("Expected file-change presentation");
    expect(projected.presentation.paths).toHaveLength(AI_MAX_PRESENTATION_PATHS);
    expect(projected.presentation.paths).not.toContain("src/changed-256.ts");
    expect(projected.presentation.paths).not.toContain(".");
    expect(JSON.stringify(projected.public)).not.toContain("private diff");
  });
});

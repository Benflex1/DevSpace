import {
  AI_MAX_PRESENTATION_PATHS,
  AI_MAX_STRUCTURED_INPUT_OPTIONS,
  AI_MAX_STRUCTURED_INPUT_QUESTIONS,
  AI_PRESENTATION_TEXT_MAX_BYTES,
  aiApprovalDecisionSchema,
  aiApprovalPresentationSchema,
  aiStructuredInputAnswersSchema,
  aiStructuredInputQuestionsSchema
} from "@devspace/contracts";
import { redactSensitiveText } from "@devspace/diagnostics";
import { v7 as uuidv7 } from "uuid";
import * as z from "zod";

const INTERACTION_METHODS = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput"
] as const;
const WORKSPACE_ROOT = "/workspace";
const FALLBACK_SUMMARY = "Codex requested an interaction.";
const FALLBACK_COMMAND = "(command details unavailable)";
const FALLBACK_HEADER = "Input";
const FALLBACK_QUESTION = "Codex is asking for input.";

type InteractionMethod = typeof INTERACTION_METHODS[number];
type NativeRequestId = string | number;
type NativeParams = Record<string, unknown>;

export type CodexServerInteractionRequest = Readonly<{
  nativeRequestId: NativeRequestId;
  method: InteractionMethod;
  params: NativeParams;
}>;

type ApprovalPresentation = z.infer<typeof aiApprovalPresentationSchema>;
type StructuredInputQuestions = z.infer<typeof aiStructuredInputQuestionsSchema>;
type StructuredInputAnswers = z.infer<typeof aiStructuredInputAnswersSchema>;
type ApprovalDecision = z.infer<typeof aiApprovalDecisionSchema>;

type CommonInteractionBinding = Readonly<{
  nativeRequestId: NativeRequestId;
  nativeThreadId: string;
  nativeTurnId: string;
  nativeItemId: string;
}>;

export type CodexFileChangeItem = Readonly<{
  nativeThreadId: string;
  nativeTurnId: string;
  nativeItemId: string;
  paths: ReadonlyArray<string>;
  truncated: boolean;
}>;

type ApprovalProjection = Readonly<{
  requestId: string;
  turnId: string;
  kind: "approval";
  presentation: ApprovalPresentation;
  public: Readonly<{
    requestId: string;
    turnId: string;
    kind: "approval";
    presentation: ApprovalPresentation;
  }>;
  binding: CommonInteractionBinding;
}>;

export type CodexInputQuestionMapping = Readonly<{
  publicQuestionId: string;
  nativeQuestionId: string;
  responseKind: "single-select" | "text";
  allowOther: boolean;
  options: ReadonlyArray<Readonly<{
    publicOptionId: string;
    nativeOptionLabel: string;
  }>>;
}>;

export type CodexInputMapping = Readonly<{
  requestId: string;
  turnId: string;
  questions: ReadonlyArray<CodexInputQuestionMapping>;
  binding: CommonInteractionBinding;
}>;

type InputProjection = Readonly<{
  requestId: string;
  turnId: string;
  kind: "input";
  questions: StructuredInputQuestions;
  public: Readonly<{
    requestId: string;
    turnId: string;
    kind: "input";
    questions: StructuredInputQuestions;
  }>;
  mapping: CodexInputMapping;
}>;

export type CodexInteractionProjection = ApprovalProjection | InputProjection;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nativeRequestId(value: unknown): NativeRequestId | null {
  if (typeof value === "string" && value.length > 0 && value.length <= 256) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  return null;
}

function scalarSafe(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0) {
      result += "�";
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += (value[index] ?? "") + (value[index + 1] ?? "");
        index += 1;
      } else {
        result += "�";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      result += "�";
    } else {
      result += value[index];
    }
  }
  return result;
}

function clipUtf8(value: string, maxBytes: number): string {
  const safe = scalarSafe(value);
  let result = "";
  let bytes = 0;
  for (const character of safe) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function safeText(value: unknown, fallback: string, maxBytes: number, allowEmpty = false): string {
  const source = typeof value === "string" ? redactSensitiveText(value) : fallback;
  const clipped = clipUtf8(source, maxBytes);
  return clipped.length > 0 || allowEmpty ? clipped : fallback;
}

function workspacePath(value: unknown): string | null {
  const source = stringValue(value);
  if (source === null) return null;
  const safe = scalarSafe(source);
  let relative = safe;
  if (safe === WORKSPACE_ROOT) {
    relative = ".";
  } else if (safe.startsWith(`${WORKSPACE_ROOT}/`)) {
    relative = safe.slice(WORKSPACE_ROOT.length + 1);
  } else if (safe.startsWith("/") || safe.startsWith("\\")) {
    return null;
  }
  if (relative === "") return ".";
  if (relative.includes("\\") || relative.includes("\0")) return null;
  if ([...relative].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 31 || (code >= 127 && code <= 159));
  })) return null;
  const components = relative.split("/");
  if (components.some((component) => component.length === 0 || component === "." || component === ".." || component === ".git")) {
    return null;
  }
  const bounded = clipUtf8(relative, 4_096);
  return bounded === relative ? relative : null;
}

function commonBinding(request: CodexServerInteractionRequest): CommonInteractionBinding | null {
  const params = request.params;
  const threadId = stringValue(params.threadId);
  const turnId = stringValue(params.turnId);
  const itemId = stringValue(params.itemId);
  if (threadId === null || turnId === null || itemId === null
    || threadId.length === 0 || turnId.length === 0 || itemId.length === 0) return null;
  return Object.freeze({
    nativeRequestId: request.nativeRequestId,
    nativeThreadId: threadId,
    nativeTurnId: turnId,
    nativeItemId: itemId
  });
}

function approvalRisk(command: string): Extract<ApprovalPresentation, { kind: "command" }>["risk"] {
  const normalized = command.toLowerCase();
  const network = /\b(?:curl|wget|ssh|scp|nc|netcat|git\s+(?:fetch|pull|push)|npm\s+publish|pnpm\s+publish|yarn\s+publish)\b/u.test(normalized)
    || /https?:\/\//u.test(normalized);
  const write = /(?:^|[;&|])\s*(?:rm|mv|cp|mkdir|touch|chmod|chown|install|npm|pnpm|yarn|git\s+(?:add|commit|checkout|reset|restore)|cargo\s+(?:add|install|publish))\b/u.test(normalized)
    || /(?:>|>>|\btee\b|\bapply_patch\b)/u.test(normalized);
  if (network && write) return "mixed";
  if (network) return "network";
  if (write) return "write";
  if (normalized.trim().length === 0) return "unknown";
  return "read";
}

function approvalSummary(params: NativeParams): string {
  return safeText(params.reason, FALLBACK_SUMMARY, 4_096);
}

function filePaths(item: CodexFileChangeItem): { paths: string[]; truncated: boolean } {
  const candidates = item.paths;
  const paths: string[] = [];
  let truncated = item.truncated || candidates.length > AI_MAX_PRESENTATION_PATHS;
  for (const candidate of candidates.slice(0, AI_MAX_PRESENTATION_PATHS)) {
    const path = workspacePath(candidate);
    if (path === null) {
      truncated = true;
      continue;
    }
    if (path === ".") return { paths: [], truncated: true };
    if (!paths.includes(path)) paths.push(path);
  }
  return { paths, truncated };
}

function fileChangeItemPaths(item: Record<string, unknown>, threadId: string, turnId: string): CodexFileChangeItem | null {
  if (item.type !== "fileChange" || typeof item.id !== "string" || !Array.isArray(item.changes) || item.changes.length === 0) return null;
  const changes = item.changes as unknown[];
  const truncated = changes.length > AI_MAX_PRESENTATION_PATHS;
  const paths: string[] = [];
  for (const change of changes.slice(0, AI_MAX_PRESENTATION_PATHS)) {
    if (!isRecord(change) || typeof change.path !== "string") return null;
    const path = workspacePath(change.path);
    if (path === null || path === ".") return null;
    if (!paths.includes(path)) paths.push(path);
    const kind = change.kind;
    if (isRecord(kind) && kind.type === "update" && kind.move_path !== null && kind.move_path !== undefined) {
      if (typeof kind.move_path !== "string") return null;
      const oldPath = workspacePath(kind.move_path);
      if (oldPath === null || oldPath === ".") return null;
      if (!paths.includes(oldPath)) paths.push(oldPath);
    }
  }
  return paths.length === 0 ? null : { nativeThreadId: threadId, nativeTurnId: turnId, nativeItemId: item.id, paths, truncated };
}

export function projectCodexFileChangeItem(value: unknown, threadId: string, turnId: string): CodexFileChangeItem | null {
  if (!isRecord(value)) return null;
  return fileChangeItemPaths(value, threadId, turnId);
}

function projectApproval(
  request: CodexServerInteractionRequest,
  turnId: string,
  createId: () => string,
  fileChangeItems: ReadonlyMap<string, CodexFileChangeItem>
): ApprovalProjection | null {
  const binding = commonBinding(request);
  if (binding === null) return null;
  if (request.method === "item/commandExecution/requestApproval") {
    const command = safeText(request.params.command, FALLBACK_COMMAND, AI_PRESENTATION_TEXT_MAX_BYTES);
    const presentation = aiApprovalPresentationSchema.parse({
      kind: "command",
      summary: approvalSummary(request.params),
      commandText: command,
      workingDirectory: workspacePath(request.params.cwd),
      risk: approvalRisk(command),
      redacted: true
    });
    const requestId = createId();
    return {
      requestId,
      turnId,
      kind: "approval",
      presentation,
      public: { requestId, turnId, kind: "approval", presentation },
      binding
    };
  }
  if (request.method !== "item/fileChange/requestApproval") return null;
  const threadId = stringValue(request.params.threadId);
  const nativeTurnId = stringValue(request.params.turnId);
  const nativeItemId = stringValue(request.params.itemId);
  if (threadId === null || nativeTurnId === null || nativeItemId === null) return null;
  const item = fileChangeItems.get(nativeItemId);
  if (item === undefined || item.nativeThreadId !== threadId || item.nativeTurnId !== nativeTurnId || item.nativeItemId !== nativeItemId) return null;
  const paths = filePaths(item);
  if (paths.paths.length === 0) return null;
  const presentation = aiApprovalPresentationSchema.parse({
    kind: "file-change",
    summary: approvalSummary(request.params),
    paths: paths.paths,
    truncated: paths.truncated,
    redacted: true
  });
  const requestId = createId();
  return {
    requestId,
    turnId,
    kind: "approval",
    presentation,
    public: { requestId, turnId, kind: "approval", presentation },
    binding
  };
}

function inputQuestions(params: NativeParams): {
  questions: StructuredInputQuestions;
  mapping: ReadonlyArray<CodexInputQuestionMapping>;
} | null {
  const rawQuestions = Array.isArray(params.questions) ? params.questions as unknown[] : null;
  if (rawQuestions === null || rawQuestions.length === 0
    || rawQuestions.length > AI_MAX_STRUCTURED_INPUT_QUESTIONS) return null;
  const autoResolutionMs = params.autoResolutionMs;
  if (autoResolutionMs !== undefined && autoResolutionMs !== null
    && (typeof autoResolutionMs !== "number" || !Number.isSafeInteger(autoResolutionMs) || autoResolutionMs < 0)) return null;
  const questions: StructuredInputQuestions = [];
  const mapping: CodexInputQuestionMapping[] = [];
  for (let questionIndex = 0; questionIndex < rawQuestions.length; questionIndex += 1) {
    const rawQuestion: unknown = rawQuestions[questionIndex];
    if (!isRecord(rawQuestion) || rawQuestion.isSecret === true
      || (rawQuestion.isSecret !== undefined && typeof rawQuestion.isSecret !== "boolean")
      || rawQuestion.isOther !== true) return null;
    const nativeQuestionId = stringValue(rawQuestion.id);
    const nativeHeader = stringValue(rawQuestion.header);
    const nativeQuestion = stringValue(rawQuestion.question);
    if (nativeQuestionId === null || nativeQuestionId.length === 0 || nativeHeader === null || nativeQuestion === null) return null;
    const rawOptions = rawQuestion.options;
    if (!Array.isArray(rawOptions) || rawOptions.length === 0 || rawOptions.length > AI_MAX_STRUCTURED_INPUT_OPTIONS) return null;
    const optionValues = rawOptions as unknown[];
    const questionId = `question-${questionIndex + 1}`;
    const options: Array<{ optionId: string; label: string; description: string }> = [];
    const optionMapping: Array<{ publicOptionId: string; nativeOptionLabel: string }> = [];
    for (let optionIndex = 0; optionIndex < optionValues.length; optionIndex += 1) {
      const rawOption: unknown = optionValues[optionIndex];
      if (!isRecord(rawOption)) return null;
      const nativeOptionLabel = stringValue(rawOption.label);
      const nativeOptionDescription = stringValue(rawOption.description);
      if (nativeOptionLabel === null || nativeOptionDescription === null) return null;
      const label = safeText(nativeOptionLabel, `Option ${optionIndex + 1}`, 256);
      const description = safeText(nativeOptionDescription, "", 2_048, true);
      const optionId = `option-${optionIndex + 1}`;
      options.push({ optionId, label, description });
      optionMapping.push({ publicOptionId: optionId, nativeOptionLabel });
    }
    const question = {
      questionId,
      header: safeText(nativeHeader, FALLBACK_HEADER, 256),
      question: safeText(nativeQuestion, FALLBACK_QUESTION, 4_096),
      responseKind: "single-select" as const,
      allowOther: true,
      secret: false as const,
      options
    };
    questions.push(question);
    mapping.push({ publicQuestionId: questionId, nativeQuestionId, responseKind: "single-select", allowOther: true, options: optionMapping });
  }
  const parsed = aiStructuredInputQuestionsSchema.safeParse(questions);
  return parsed.success ? { questions: parsed.data, mapping } : null;
}

export function parseCodexServerInteractionRequest(value: unknown): CodexServerInteractionRequest | null {
  if (!isRecord(value)) return null;
  const id = nativeRequestId(value.id);
  const method = value.method;
  const params = value.params;
  if (id === null || typeof method !== "string" || !(INTERACTION_METHODS as readonly string[]).includes(method)
    || !isRecord(params)) return null;
  const binding = commonBinding({ nativeRequestId: id, method: method as InteractionMethod, params });
  if (binding === null) return null;
  if (method === "item/tool/requestUserInput") {
    if (inputQuestions(params) === null) return null;
  }
  return { nativeRequestId: id, method: method as InteractionMethod, params };
}

export function projectCodexApprovalRequest(
  request: CodexServerInteractionRequest,
  turnId: string,
  createId: () => string = uuidv7,
  fileChangeItems: ReadonlyMap<string, CodexFileChangeItem> = new Map()
): ApprovalProjection | null {
  if (request.method === "item/tool/requestUserInput") return null;
  return projectApproval(request, turnId, createId, fileChangeItems);
}

export function projectCodexInputRequest(
  request: CodexServerInteractionRequest,
  turnId: string,
  createId: () => string = uuidv7
): InputProjection | null {
  if (request.method !== "item/tool/requestUserInput") return null;
  const binding = commonBinding(request);
  const projected = inputQuestions(request.params);
  if (binding === null || projected === null) return null;
  const requestId = createId();
  const mapping: CodexInputMapping = { requestId, turnId, questions: projected.mapping, binding };
  return {
    requestId,
    turnId,
    kind: "input",
    questions: projected.questions,
    public: { requestId, turnId, kind: "input", questions: projected.questions },
    mapping
  };
}

export function encodeCodexApprovalResponse(
  request: CodexServerInteractionRequest,
  decision: ApprovalDecision
): Readonly<{ decision: "accept" | "acceptForSession" | "decline" | "cancel" }> {
  if (request.method === "item/tool/requestUserInput") throw new Error("Not an approval request");
  aiApprovalDecisionSchema.parse(decision);
  return {
    decision: decision === "approve-once" ? "accept"
      : decision === "approve-for-session" ? "acceptForSession"
        : decision === "deny" ? "decline" : "cancel"
  };
}

export function encodeCodexInputResponse(
  mapping: CodexInputMapping,
  answers: ReadonlyArray<StructuredInputAnswers[number]>
): Readonly<{ answers: Record<string, Readonly<{ answers: string[] }>> }> {
  const parsedAnswers = aiStructuredInputAnswersSchema.parse(answers);
  if (parsedAnswers.length !== mapping.questions.length) throw new Error("Every question needs an answer");
  const byQuestion = new Map(parsedAnswers.map((answer) => [answer.questionId, answer]));
  const encoded: Record<string, Readonly<{ answers: string[] }>> = {};
  for (const question of mapping.questions) {
    const answer = byQuestion.get(question.publicQuestionId);
    if (answer === undefined) throw new Error("Every question needs an answer");
    if (question.responseKind === "single-select") {
      if (answer.kind === "selected") {
        const option = question.options.find((candidate) => candidate.publicOptionId === answer.optionId);
        if (option === undefined) throw new Error("Option does not belong to question");
        encoded[question.nativeQuestionId] = { answers: [option.nativeOptionLabel] };
      } else if (answer.kind === "other" && question.allowOther) {
        encoded[question.nativeQuestionId] = { answers: [`user_note: ${answer.text}`] };
      } else {
        throw new Error("Select question needs an option or Other answer");
      }
    } else {
      if (answer.kind !== "text") throw new Error("Text question needs text");
      encoded[question.nativeQuestionId] = { answers: [answer.text] };
    }
  }
  return { answers: encoded };
}

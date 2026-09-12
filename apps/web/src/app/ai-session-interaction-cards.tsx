"use client";

import { useEffect, useState } from "react";
import type {
  BrowserAiApprovalDecision,
  BrowserAiInteraction,
  BrowserAiInputQuestion
} from "./ai-session-projection.js";

type InteractionCardProps = {
  interaction: BrowserAiInteraction;
  approvalsSupported: boolean;
  structuredInputSupported: boolean;
  responding: boolean;
  onApproval: (decision: BrowserAiApprovalDecision) => void;
  onInput: (answers: unknown[]) => void;
};

const OTHER_OPTION_ID = "__other__";

const approvalLabels: ReadonlyArray<readonly [BrowserAiApprovalDecision, string]> = [
  ["approve-once", "Approve once"],
  ["approve-for-session", "Approve for session"],
  ["deny", "Deny"],
  ["cancel", "Cancel"]
];

function InteractionStatus({ interaction }: { interaction: BrowserAiInteraction }) {
  if (interaction.state === "responded") {
    const response = interaction.response;
    const label = response !== null && "decision" in response ? response.decision : "answered";
    return <div className="ai-interaction-resolved" role="status"><strong>Resolved</strong><span>{label}</span></div>;
  }
  if (interaction.state !== "pending") {
    return <div className="ai-interaction-resolved" role="status"><strong>Interaction {interaction.state}</strong><span>No response can be submitted.</span></div>;
  }
  return null;
}

function ApprovalCard({ interaction, supported, responding, onApproval }: {
  interaction: BrowserAiInteraction;
  supported: boolean;
  responding: boolean;
  onApproval: (decision: BrowserAiApprovalDecision) => void;
}) {
  const presentation = interaction.request !== null && "presentation" in interaction.request ? interaction.request.presentation : null;
  return <section className="ai-interaction-card" aria-label="Codex approval request">
    <div className="ai-interaction-heading"><strong>Codex needs approval</strong><span>{responding ? "Submitting…" : interaction.state === "pending" ? "Action required" : "Resolved"}</span></div>
    {presentation === null ? <p className="ai-interaction-muted">The safe approval presentation is unavailable.</p> : <>
      <p className="ai-interaction-summary">{presentation.summary}</p>
      {presentation.kind === "command" ? <div className="ai-interaction-command"><code>{presentation.commandText}</code>{presentation.workingDirectory !== null && <small>Working directory: {presentation.workingDirectory}</small>}<small>Risk: {presentation.risk}</small></div>
        : <div className="ai-interaction-paths"><ul>{presentation.paths.map((path) => <li key={path}><code>{path}</code></li>)}</ul>{presentation.truncated && <small>Additional paths omitted.</small>}</div>}
    </>}
    {!supported && interaction.state === "pending" && <p className="ai-interaction-muted">Approvals are not supported by the current Codex profile.</p>}
    <InteractionStatus interaction={interaction} />
    {supported && interaction.state === "pending" && presentation !== null && <div className="ai-interaction-actions">
      {approvalLabels.map(([decision, label]) => <button key={decision} type="button" disabled={responding} onClick={() => onApproval(decision)}>{label}</button>)}
    </div>}
  </section>;
}

function InputQuestion({ question, value, otherText, onChange, onOtherTextChange, disabled }: {
  question: BrowserAiInputQuestion;
  value: string;
  otherText: string;
  onChange: (value: string) => void;
  onOtherTextChange: (value: string) => void;
  disabled: boolean;
}) {
  return <fieldset className="ai-input-question" disabled={disabled}>
    <legend><strong>{question.header}</strong><span>{question.question}</span></legend>
    {question.responseKind === "single-select" ? <div className="ai-input-options">
      {question.options.map((option) => <label key={option.optionId}><input type="radio" name={`ai-${question.questionId}`} value={option.optionId}
        checked={value === option.optionId} onChange={(event) => onChange(event.target.value)} />
        <span><strong>{option.label}</strong><small>{option.description}</small></span></label>)}
      {question.allowOther && <label><input type="radio" name={`ai-${question.questionId}`} value={OTHER_OPTION_ID}
        checked={value === OTHER_OPTION_ID} onChange={(event) => onChange(event.target.value)} />
        <span><strong>Other</strong><small>Provide a different answer.</small></span></label>}
      {question.allowOther && value === OTHER_OPTION_ID && <textarea value={otherText} onChange={(event) => onOtherTextChange(event.target.value)} rows={3}
        aria-label={`${question.header} other`} />}
    </div> : <textarea value={value} onChange={(event) => onChange(event.target.value)} rows={3} aria-label={question.header} />}
  </fieldset>;
}

function InputCard({ interaction, supported, responding, onInput }: {
  interaction: BrowserAiInteraction;
  supported: boolean;
  responding: boolean;
  onInput: (answers: unknown[]) => void;
}) {
  const questions = interaction.request !== null && "questions" in interaction.request ? interaction.request.questions : [];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [otherAnswers, setOtherAnswers] = useState<Record<string, string>>({});
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { setAnswers({}); setOtherAnswers({}); setInvalid(false); }, [interaction.id, interaction.state]);
  const submit = () => {
    if (questions.some((question) => answers[question.questionId] === undefined || answers[question.questionId] === ""
      || (question.responseKind === "single-select" && question.allowOther && answers[question.questionId] === OTHER_OPTION_ID
        && (otherAnswers[question.questionId] ?? "") === ""))) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onInput(questions.map((question) => question.responseKind === "single-select"
      ? answers[question.questionId] === OTHER_OPTION_ID
        ? { questionId: question.questionId, kind: "other", text: otherAnswers[question.questionId] ?? "" }
        : { questionId: question.questionId, kind: "selected", optionId: answers[question.questionId] }
      : { questionId: question.questionId, kind: "text", text: answers[question.questionId] ?? "" }));
  };
  return <section className="ai-interaction-card" aria-label="Codex structured questions">
    <div className="ai-interaction-heading"><strong>Codex has questions</strong><span>{responding ? "Submitting…" : interaction.state === "pending" ? "Action required" : "Resolved"}</span></div>
    {questions.length === 0 ? <p className="ai-interaction-muted">The safe question presentation is unavailable.</p> : <div className="ai-input-questions">
      {questions.map((question) => <InputQuestion key={question.questionId} question={question} value={answers[question.questionId] ?? ""}
        otherText={otherAnswers[question.questionId] ?? ""}
        onChange={(value) => setAnswers((current) => ({ ...current, [question.questionId]: value }))}
        onOtherTextChange={(value) => setOtherAnswers((current) => ({ ...current, [question.questionId]: value }))}
        disabled={responding || !supported || interaction.state !== "pending"} />)}
    </div>}
    {!supported && interaction.state === "pending" && <p className="ai-interaction-muted">Structured input is not supported by the current Codex profile.</p>}
    {invalid && <p className="ai-interaction-error" role="alert">Answer every question before continuing.</p>}
    <InteractionStatus interaction={interaction} />
    {supported && interaction.state === "pending" && questions.length > 0 && <div className="ai-interaction-actions"><button type="button" disabled={responding} onClick={submit}>Submit answers</button></div>}
  </section>;
}

export function AiSessionInteractionCard(props: InteractionCardProps) {
  return props.interaction.kind === "approval"
    ? <ApprovalCard interaction={props.interaction} supported={props.approvalsSupported} responding={props.responding} onApproval={props.onApproval} />
    : <InputCard interaction={props.interaction} supported={props.structuredInputSupported} responding={props.responding} onInput={props.onInput} />;
}

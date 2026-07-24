export const LOST_TERMINAL_DISMISSED_SESSION_KEY = "devspace:lost-terminal-dialog:dismissed";

export type LostTerminalDialogStep = "warning" | "confirmation";

export interface LostTerminalDialogCopy {
  readonly warningStatement: string;
  readonly warningSupporting: string;
  readonly confirmationTitle: string;
  readonly confirmationBody: string;
}

export function lostTerminalSetKey(ids: readonly string[]): string {
  return [...new Set(ids)].sort().join(",");
}

export function lostTerminalDialogCopy(count: number): LostTerminalDialogCopy {
  if (count === 1) return {
    warningStatement: "This terminal cannot be recovered.",
    warningSupporting: "Processes started from it may still be running.",
    confirmationTitle: "Continue without restarting?",
    confirmationBody: "Processes started from the lost terminal may continue running. To guarantee cleanup later, stop and start the workspace manually."
  };
  return {
    warningStatement: "These terminal sessions cannot be recovered.",
    warningSupporting: "Processes started from them may still be running.",
    confirmationTitle: "Continue without restarting?",
    confirmationBody: "Processes started from the lost terminals may continue running. To guarantee cleanup later, stop and start the workspace manually."
  };
}

export function lostTerminalDialogStepAfter(step: LostTerminalDialogStep, action: "dismiss" | "go-back"): LostTerminalDialogStep {
  if (step === "warning" && action === "dismiss") return "confirmation";
  if (step === "confirmation" && action === "go-back") return "warning";
  return step;
}

export function shouldShowLostTerminalDialog(ids: readonly string[], dismissedKey: string | null): boolean {
  const key = lostTerminalSetKey(ids);
  return key !== "" && key !== dismissedKey;
}

export class LostTerminalDialogSession {
  private shownKey: string | null = null;

  constructor(private dismissedKey: string | null = null) {}

  observe(ids: readonly string[]): readonly string[] {
    const key = lostTerminalSetKey(ids);
    if (key === "") {
      this.shownKey = null;
      return [];
    }
    if (key === this.dismissedKey || key === this.shownKey) return [];
    this.shownKey = key;
    return [...new Set(ids)].sort();
  }

  dismiss(ids: readonly string[]): void {
    this.dismissedKey = lostTerminalSetKey(ids);
    this.shownKey = this.dismissedKey;
  }
}

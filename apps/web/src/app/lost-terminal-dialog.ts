export const LOST_TERMINAL_DISMISSED_SESSION_KEY = "devspace:lost-terminal-dialog:dismissed";

export function lostTerminalSetKey(ids: readonly string[]): string {
  return [...new Set(ids)].sort().join(",");
}

export function lostTerminalDialogBody(count: number): string {
  if (count === 1) return "A terminal could not be restored after DevSpace restarted. Processes started from it may still be running.";
  return `${count} terminal sessions could not be restored after DevSpace restarted.`;
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

import { describe, expect, test } from "vitest";
import { LostTerminalDialogSession, lostTerminalDialogCopy, lostTerminalDialogStepAfter, lostTerminalSetKey, shouldShowLostTerminalDialog } from "./lost-terminal-dialog.js";

describe("lost terminal dialog", () => {
  test("uses prominent singular first-dialog warning and separate confirmation copy", () => {
    expect(lostTerminalDialogCopy(1)).toEqual({
      warningStatement: "This terminal cannot be recovered.",
      warningSupporting: "Processes started from it may still be running.",
      confirmationTitle: "Continue without restarting?",
      confirmationBody: "Processes started from the lost terminal may continue running. To guarantee cleanup later, stop and start the workspace manually."
    });
  });

  test("uses prominent plural first-dialog warning and separate confirmation copy", () => {
    expect(lostTerminalDialogCopy(2)).toEqual({
      warningStatement: "These terminal sessions cannot be recovered.",
      warningSupporting: "Processes started from them may still be running.",
      confirmationTitle: "Continue without restarting?",
      confirmationBody: "Processes started from the lost terminals may continue running. To guarantee cleanup later, stop and start the workspace manually."
    });
  });

  test("requires confirmation before dismissing and supports going back", () => {
    expect(lostTerminalDialogStepAfter("warning", "dismiss")).toBe("confirmation");
    expect(lostTerminalDialogStepAfter("confirmation", "go-back")).toBe("warning");
  });

  test("shows one dialog for one lost terminal and suppresses polling rerenders", () => {
    const session = new LostTerminalDialogSession();
    expect(session.observe(["terminal-1"])).toEqual(["terminal-1"]);
    expect(session.observe(["terminal-1"])).toEqual([]);
    expect(session.observe(["terminal-1"])).toEqual([]);
  });

  test("shows one dialog for multiple lost terminals", () => {
    const session = new LostTerminalDialogSession();
    expect(session.observe(["terminal-2", "terminal-1", "terminal-2"])).toEqual(["terminal-1", "terminal-2"]);
  });

  test("persists dismissal for the same set but allows a changed set", () => {
    const session = new LostTerminalDialogSession();
    session.observe(["terminal-1"]);
    session.dismiss(["terminal-1"]);
    expect(session.observe(["terminal-1"])).toEqual([]);
    expect(session.observe(["terminal-1", "terminal-2"])).toEqual(["terminal-1", "terminal-2"]);
  });

  test("allows a genuinely reappearing set after all lost terminals disappear", () => {
    const session = new LostTerminalDialogSession();
    expect(session.observe(["terminal-1"])).toEqual(["terminal-1"]);
    expect(session.observe([])).toEqual([]);
    expect(session.observe(["terminal-1"])).toEqual(["terminal-1"]);
  });

  test("keys sets independently of ordering and duplicate rows", () => {
    expect(lostTerminalSetKey(["terminal-2", "terminal-1", "terminal-2"])).toBe("terminal-1,terminal-2");
    expect(shouldShowLostTerminalDialog(["terminal-1"], "terminal-2")).toBe(true);
    expect(shouldShowLostTerminalDialog(["terminal-1"], "terminal-1")).toBe(false);
  });
});

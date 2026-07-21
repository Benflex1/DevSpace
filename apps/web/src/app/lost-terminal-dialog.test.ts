import { describe, expect, test } from "vitest";
import { LostTerminalDialogSession, lostTerminalDialogBody, lostTerminalSetKey, shouldShowLostTerminalDialog } from "./lost-terminal-dialog.js";

describe("lost terminal dialog", () => {
  test("uses concise singular and plural copy", () => {
    expect(lostTerminalDialogBody(1)).toBe("A terminal could not be restored after DevSpace restarted. Processes started from it may still be running.");
    expect(lostTerminalDialogBody(2)).toBe("2 terminal sessions could not be restored after DevSpace restarted.");
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

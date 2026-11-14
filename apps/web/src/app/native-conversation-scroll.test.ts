import { expect, test } from "vitest";
import {
  nativeConversationAtLive, nativeConversationShouldLoadOlder, nativeConversationWheelDelta, nativeConversationWheelTarget
} from "./native-conversation-scroll.js";

const live = { scrollTop: 600, scrollHeight: 1_200, clientHeight: 600 };
const history = { scrollTop: 120, scrollHeight: 1_200, clientHeight: 600 };

test("wheel-up at the live terminal reveals bounded semantic history", () => {
  expect(nativeConversationAtLive(live)).toBe(true);
  expect(nativeConversationWheelTarget(live, -120, true)).toBe(480);
  expect(nativeConversationWheelTarget(live, -120, false)).toBeNull();
});

test("the live terminal keeps wheel input that does not reveal history", () => {
  expect(nativeConversationWheelTarget(live, 120, true)).toBeNull();
  expect(nativeConversationWheelTarget(live, 0, true)).toBeNull();
});

test("wheel input in history scrolls the shared surface and clamps at the live edge", () => {
  expect(nativeConversationWheelTarget(history, 120, true)).toBe(240);
  expect(nativeConversationWheelTarget(history, -400, true)).toBe(0);
  expect(nativeConversationWheelTarget({ ...history, scrollTop: 590 }, 120, true)).toBe(600);
  expect(nativeConversationWheelTarget(history, 0, true)).toBe(120);
});

test("older history pages load only near the top boundary", () => {
  expect(nativeConversationShouldLoadOlder({ ...history, scrollTop: 0 }, true)).toBe(true);
  expect(nativeConversationShouldLoadOlder({ ...history, scrollTop: 160 }, true)).toBe(true);
  expect(nativeConversationShouldLoadOlder({ ...history, scrollTop: 161 }, true)).toBe(false);
  expect(nativeConversationShouldLoadOlder({ ...history, scrollTop: 0 }, false)).toBe(false);
});

test("line-mode wheel deltas are scaled to the pixel scroller", () => {
  expect(nativeConversationWheelDelta({ deltaY: -3 })).toBe(-3);
  expect(nativeConversationWheelDelta({ deltaY: -3, deltaMode: 1 })).toBe(-48);
});

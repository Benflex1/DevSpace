export type ConversationScrollGeometry = {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
};

const LIVE_EDGE_PX = 2;
const OLDER_LOAD_THRESHOLD_PX = 160;

export function nativeConversationAtLive(geometry: ConversationScrollGeometry): boolean {
  return geometry.scrollHeight - geometry.scrollTop - geometry.clientHeight <= LIVE_EDGE_PX;
}

/**
 * The live terminal owns wheel input until the conversation is scrolled into
 * history. Once history is engaged, wheel input belongs to the shared scroller
 * so scrolling down lands back on the live terminal.
 */
export function nativeConversationWheelTarget(
  geometry: ConversationScrollGeometry,
  deltaY: number,
  historyAvailable: boolean
): number | null {
  const atLive = nativeConversationAtLive(geometry);
  if (atLive && deltaY < 0) {
    return historyAvailable ? Math.max(0, geometry.scrollTop + deltaY) : null;
  }
  if (atLive) return null;
  const maximum = Math.max(0, geometry.scrollHeight - geometry.clientHeight);
  return Math.max(0, Math.min(maximum, geometry.scrollTop + deltaY));
}

export function nativeConversationShouldLoadOlder(geometry: ConversationScrollGeometry, hasOlderCursor: boolean): boolean {
  return hasOlderCursor && geometry.scrollTop <= OLDER_LOAD_THRESHOLD_PX;
}

export function nativeConversationWheelDelta(event: { readonly deltaY: number; readonly deltaMode?: number }): number {
  // deltaMode 1 is DOM_DELTA_LINE; scale to the pixel-ish step used by the scroller.
  return event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
}
